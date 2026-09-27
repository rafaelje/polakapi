use std::ffi::{c_char, c_void, CStr, CString, OsString};
use std::io;
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

use fsevent_sys::core_foundation::{
    kCFAllocatorDefault, kCFRunLoopDefaultMode, kCFStringEncodingUTF8, kCFTypeArrayCallBacks,
    Boolean, CFArrayAppendValue, CFArrayCreateMutable, CFArrayRef, CFRelease, CFRunLoopGetCurrent,
    CFRunLoopRef, CFRunLoopStop, CFStringCreateWithCString, CFStringRef, CFTimeInterval,
};
use fsevent_sys::{
    kFSEventStreamCreateFlagFileEvents, kFSEventStreamCreateFlagNoDefer,
    kFSEventStreamEventFlagKernelDropped, kFSEventStreamEventFlagMustScanSubDirs,
    kFSEventStreamEventFlagUserDropped, kFSEventStreamEventIdSinceNow, FSEventStreamContext,
    FSEventStreamCreate, FSEventStreamEventFlags, FSEventStreamEventId, FSEventStreamInvalidate,
    FSEventStreamRef, FSEventStreamRelease, FSEventStreamScheduleWithRunLoop, FSEventStreamStart,
    FSEventStreamStop,
};

use super::{Activity, Backend};

const LATENCY: CFTimeInterval = 0.05;
const RUN_SLICE: CFTimeInterval = 0.1;

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRunLoopRunInMode(
        mode: CFStringRef,
        seconds: CFTimeInterval,
        return_after_source_handled: Boolean,
    ) -> i32;
}

enum Batch {
    Paths(Vec<PathBuf>),
    Overflow,
}

struct Shared {
    root: PathBuf,
    sender: Sender<Batch>,
}

struct RunLoop(CFRunLoopRef);

// SAFETY: a CFRunLoop may be stopped from any thread; the reference is only
// used while the owning thread is still running (see `Drop`).
unsafe impl Send for RunLoop {}

pub(crate) struct PlatformBackend {
    receiver: Receiver<Batch>,
    run_loop: RunLoop,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Backend for PlatformBackend {
    fn open(root: &Path) -> io::Result<Self> {
        let root = root.canonicalize()?;
        let (sender, receiver) = channel();
        let (ready_sender, ready_receiver) = channel();
        let stop = Arc::new(AtomicBool::new(false));
        let thread = std::thread::Builder::new()
            .name("polakapi-fsevents".into())
            .spawn({
                let stop = stop.clone();
                move || run_stream(Shared { root, sender }, &stop, &ready_sender)
            })?;
        match ready_receiver.recv() {
            Ok(Ok(run_loop)) => Ok(Self {
                receiver,
                run_loop,
                stop,
                thread: Some(thread),
            }),
            Ok(Err(error)) => {
                let _ = thread.join();
                Err(error)
            }
            Err(_) => {
                let _ = thread.join();
                Err(io::Error::other("fsevents thread exited during setup"))
            }
        }
    }

    fn wait(&mut self, timeout: Duration) -> io::Result<Activity> {
        let first = match self.receiver.recv_timeout(timeout) {
            Ok(batch) => batch,
            Err(RecvTimeoutError::Timeout) => return Ok(Activity::Quiet),
            Err(RecvTimeoutError::Disconnected) => {
                return Err(io::Error::other("fsevents stream ended"))
            }
        };
        let mut paths = Vec::new();
        let mut overflow = false;
        for batch in std::iter::once(first).chain(self.receiver.try_iter()) {
            match batch {
                Batch::Overflow => overflow = true,
                Batch::Paths(batch) => paths.extend(batch),
            }
        }
        Ok(if overflow {
            Activity::Overflow
        } else {
            Activity::Paths(paths)
        })
    }
}

impl Drop for PlatformBackend {
    fn drop(&mut self) {
        // Stop before raising the flag: the thread only exits (and frees its
        // run loop) once the flag is set, so the reference is still valid here.
        // SAFETY: the run loop belongs to a thread that is still alive.
        unsafe { CFRunLoopStop(self.run_loop.0) };
        self.stop.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn run_stream(shared: Shared, stop: &AtomicBool, ready: &Sender<io::Result<RunLoop>>) {
    let stream = match create_stream(&shared) {
        Ok(stream) => stream,
        Err(error) => {
            let _ = ready.send(Err(error));
            return;
        }
    };
    // SAFETY: `stream` is a valid stream scheduled only on this thread's run
    // loop; it is stopped, invalidated and released below before `shared`
    // (its callback context) is dropped.
    unsafe {
        let run_loop = CFRunLoopGetCurrent();
        FSEventStreamScheduleWithRunLoop(stream, run_loop, kCFRunLoopDefaultMode);
        if FSEventStreamStart(stream) == 0 {
            FSEventStreamInvalidate(stream);
            FSEventStreamRelease(stream);
            let _ = ready.send(Err(io::Error::other("could not start fsevents stream")));
            return;
        }
        if ready.send(Ok(RunLoop(run_loop))).is_ok() {
            while !stop.load(Ordering::SeqCst) {
                CFRunLoopRunInMode(kCFRunLoopDefaultMode, RUN_SLICE, 0);
            }
        }
        FSEventStreamStop(stream);
        FSEventStreamInvalidate(stream);
        FSEventStreamRelease(stream);
    }
}

fn create_stream(shared: &Shared) -> io::Result<FSEventStreamRef> {
    let path = CString::new(shared.root.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path contains a NUL byte"))?;
    let context = FSEventStreamContext {
        version: 0,
        info: std::ptr::from_ref(shared).cast_mut().cast(),
        retain: None,
        release: None,
        copy_description: None,
    };
    // SAFETY: every CoreFoundation object created here is checked for null and
    // released once the stream holds its own reference; `context.info` points
    // to `shared`, which outlives the stream (see `run_stream`).
    let stream = unsafe {
        let cf_path =
            CFStringCreateWithCString(kCFAllocatorDefault, path.as_ptr(), kCFStringEncodingUTF8);
        if cf_path.is_null() {
            return Err(io::Error::other("could not convert the watched path"));
        }
        let paths = CFArrayCreateMutable(kCFAllocatorDefault, 1, &kCFTypeArrayCallBacks);
        if paths.is_null() {
            CFRelease(cf_path);
            return Err(io::Error::other("could not allocate the watched paths"));
        }
        CFArrayAppendValue(paths, cf_path);
        CFRelease(cf_path);
        let stream = FSEventStreamCreate(
            kCFAllocatorDefault,
            on_events,
            &context,
            paths as CFArrayRef,
            kFSEventStreamEventIdSinceNow,
            LATENCY,
            kFSEventStreamCreateFlagFileEvents | kFSEventStreamCreateFlagNoDefer,
        );
        CFRelease(paths);
        stream
    };
    if stream.is_null() {
        return Err(io::Error::other("could not create fsevents stream"));
    }
    Ok(stream)
}

extern "C" fn on_events(
    _stream: FSEventStreamRef,
    info: *mut c_void,
    count: usize,
    paths: *mut c_void,
    flags: *const FSEventStreamEventFlags,
    _ids: *const FSEventStreamEventId,
) {
    if info.is_null() || paths.is_null() || flags.is_null() || count == 0 {
        return;
    }
    // SAFETY: `info` is the `Shared` passed in `create_stream`, alive while the
    // stream runs. Without `UseCFTypes`, FSEvents passes `count` C strings and
    // `count` flags that stay valid for the duration of this callback.
    let (shared, paths, flags) = unsafe {
        (
            &*(info as *const Shared),
            std::slice::from_raw_parts(paths as *const *const c_char, count),
            std::slice::from_raw_parts(flags, count),
        )
    };
    let dropped = kFSEventStreamEventFlagMustScanSubDirs
        | kFSEventStreamEventFlagUserDropped
        | kFSEventStreamEventFlagKernelDropped;
    if flags.iter().any(|flag| flag & dropped != 0) {
        let _ = shared.sender.send(Batch::Overflow);
        return;
    }
    let relative = paths
        .iter()
        .filter(|path| !path.is_null())
        .filter_map(|&path| {
            // SAFETY: non-null entries are NUL-terminated paths owned by FSEvents.
            let bytes = unsafe { CStr::from_ptr(path) }.to_bytes().to_vec();
            let absolute = PathBuf::from(OsString::from_vec(bytes));
            absolute
                .strip_prefix(&shared.root)
                .ok()
                .map(Path::to_path_buf)
        })
        .collect::<Vec<_>>();
    if !relative.is_empty() {
        let _ = shared.sender.send(Batch::Paths(relative));
    }
}
