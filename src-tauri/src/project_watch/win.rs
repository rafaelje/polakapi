use std::ffi::OsString;
use std::io;
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::{Path, PathBuf};
use std::ptr;
use std::time::Duration;

use windows_sys::Win32::Foundation::{
    ERROR_IO_INCOMPLETE, ERROR_NOTIFY_ENUM_DIR, FALSE, HANDLE, INVALID_HANDLE_VALUE, TRUE,
    WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, ReadDirectoryChangesW, FILE_ACTION_MODIFIED, FILE_FLAG_BACKUP_SEMANTICS,
    FILE_FLAG_OVERLAPPED, FILE_LIST_DIRECTORY, FILE_NOTIFY_CHANGE_CREATION,
    FILE_NOTIFY_CHANGE_DIR_NAME, FILE_NOTIFY_CHANGE_FILE_NAME, FILE_NOTIFY_CHANGE_LAST_WRITE,
    FILE_NOTIFY_CHANGE_SIZE, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
};
use windows_sys::Win32::System::Threading::{CreateEventW, ResetEvent, WaitForSingleObject};
use windows_sys::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};

use super::{Activity, Backend, Scope};

const BUFFER_WORDS: usize = 16 * 1024;

pub(crate) struct PlatformBackend {
    root: PathBuf,
    dir: OwnedHandle,
    event: OwnedHandle,
    overlapped: Box<OVERLAPPED>,
    buffer: Box<[u32]>,
    pending: bool,
}

// SAFETY: the raw pointers inside `OVERLAPPED` only refer to handles and
// buffers owned by this backend, which is used from one thread at a time.
unsafe impl Send for PlatformBackend {}

fn owned(handle: HANDLE) -> io::Result<OwnedHandle> {
    if handle.is_null() || handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `handle` is a valid handle that nothing else owns.
    Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
}

fn overlapped(event: HANDLE) -> OVERLAPPED {
    // SAFETY: an all-zero `OVERLAPPED` is valid.
    let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
    overlapped.hEvent = event;
    overlapped
}

impl PlatformBackend {
    fn arm(&mut self) -> io::Result<()> {
        let filter = FILE_NOTIFY_CHANGE_FILE_NAME
            | FILE_NOTIFY_CHANGE_DIR_NAME
            | FILE_NOTIFY_CHANGE_LAST_WRITE
            | FILE_NOTIFY_CHANGE_SIZE
            | FILE_NOTIFY_CHANGE_CREATION;
        let event = self.event.as_raw_handle();
        *self.overlapped = overlapped(event);
        let byte_len = u32::try_from(std::mem::size_of_val(&*self.buffer)).unwrap_or(u32::MAX);
        // SAFETY: the buffer and `OVERLAPPED` are heap allocations owned by
        // `self` that stay alive until the read completes or is cancelled in `drop`.
        let issued = unsafe {
            ResetEvent(event);
            ReadDirectoryChangesW(
                self.dir.as_raw_handle(),
                self.buffer.as_mut_ptr().cast(),
                byte_len,
                TRUE,
                filter,
                ptr::null_mut(),
                &mut *self.overlapped,
                None,
            )
        };
        if issued == FALSE {
            return Err(io::Error::last_os_error());
        }
        self.pending = true;
        Ok(())
    }

    fn records(&self, len: usize) -> Vec<PathBuf> {
        let bytes: Vec<u8> = self
            .buffer
            .iter()
            .flat_map(|word| word.to_ne_bytes())
            .take(len)
            .collect();
        // A directory is reported as modified whenever an entry inside it
        // changes, and that entry already has its own record.
        parse(&bytes)
            .into_iter()
            .filter(|(action, path)| {
                *action != FILE_ACTION_MODIFIED as usize || !self.root.join(path).is_dir()
            })
            .map(|(_, path)| path)
            .collect()
    }
}

fn read_u32(bytes: &[u8], at: usize) -> Option<usize> {
    let raw = bytes.get(at..at + 4)?;
    Some(u32::from_ne_bytes(raw.try_into().ok()?) as usize)
}

fn parse(bytes: &[u8]) -> Vec<(usize, PathBuf)> {
    let mut paths = Vec::new();
    let mut offset = 0;
    loop {
        let (Some(next), Some(action), Some(name_len)) = (
            read_u32(bytes, offset),
            read_u32(bytes, offset + 4),
            read_u32(bytes, offset + 8),
        ) else {
            break;
        };
        let start = offset + 12;
        let Some(name) = bytes.get(start..start + name_len) else {
            break;
        };
        let wide: Vec<u16> = name
            .chunks_exact(2)
            .map(|pair| u16::from_ne_bytes([pair[0], pair[1]]))
            .collect();
        paths.push((action, PathBuf::from(OsString::from_wide(&wide))));
        if next == 0 {
            break;
        }
        offset += next;
    }
    paths
}

impl Backend for PlatformBackend {
    fn open(root: &Path, _scope: &Scope) -> io::Result<Self> {
        let wide: Vec<u16> = root.as_os_str().encode_wide().chain([0]).collect();
        // SAFETY: `wide` is a NUL-terminated UTF-16 string.
        let dir = owned(unsafe {
            CreateFileW(
                wide.as_ptr(),
                FILE_LIST_DIRECTORY,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                ptr::null(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OVERLAPPED,
                ptr::null_mut(),
            )
        })?;
        // SAFETY: a manual-reset, unnamed event with default security.
        let event = owned(unsafe { CreateEventW(ptr::null(), TRUE, FALSE, ptr::null()) })?;
        let mut backend = Self {
            root: root.to_path_buf(),
            dir,
            event,
            overlapped: Box::new(overlapped(ptr::null_mut())),
            buffer: vec![0; BUFFER_WORDS].into_boxed_slice(),
            pending: false,
        };
        backend.arm()?;
        Ok(backend)
    }

    fn wait(&mut self, timeout: Duration) -> io::Result<Activity> {
        if !self.pending {
            self.arm()?;
        }
        let millis = u32::try_from(timeout.as_millis())
            .unwrap_or(u32::MAX)
            .min(u32::MAX - 1);
        // SAFETY: `event` is a valid event handle.
        match unsafe { WaitForSingleObject(self.event.as_raw_handle(), millis) } {
            WAIT_TIMEOUT => return Ok(Activity::Quiet),
            WAIT_OBJECT_0 => {}
            _ => return Err(io::Error::last_os_error()),
        }
        let mut len = 0u32;
        // SAFETY: `overlapped` belongs to the read issued on `dir`.
        let done = unsafe {
            GetOverlappedResult(self.dir.as_raw_handle(), &*self.overlapped, &mut len, FALSE)
        };
        if done == FALSE {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(ERROR_IO_INCOMPLETE as i32) {
                return Ok(Activity::Quiet);
            }
            self.pending = false;
            if error.raw_os_error() == Some(ERROR_NOTIFY_ENUM_DIR as i32) {
                self.arm()?;
                return Ok(Activity::Overflow);
            }
            return Err(error);
        }
        self.pending = false;
        let activity = if len == 0 {
            Activity::Overflow
        } else {
            Activity::Paths(self.records(len as usize))
        };
        self.arm()?;
        Ok(activity)
    }
}

impl Drop for PlatformBackend {
    fn drop(&mut self) {
        if !self.pending {
            return;
        }
        let mut len = 0u32;
        // SAFETY: cancels the read issued on `dir` and waits for it to finish
        // so the kernel no longer touches `overlapped` or `buffer`.
        unsafe {
            CancelIoEx(self.dir.as_raw_handle(), &*self.overlapped);
            GetOverlappedResult(self.dir.as_raw_handle(), &*self.overlapped, &mut len, TRUE);
        }
    }
}
