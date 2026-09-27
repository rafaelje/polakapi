use std::collections::HashMap;
use std::ffi::OsString;
use std::io;
use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};
use std::time::Duration;

use inotify::{EventMask, Inotify, WatchDescriptor, WatchMask};

use super::{should_watch_dir, Activity, Backend};

pub(crate) struct PlatformBackend {
    inotify: Inotify,
    root: PathBuf,
    dirs: HashMap<WatchDescriptor, PathBuf>,
    buffer: Vec<u8>,
}

struct RawEvent {
    wd: WatchDescriptor,
    mask: EventMask,
    name: Option<OsString>,
}

fn watch_mask() -> WatchMask {
    WatchMask::CREATE
        | WatchMask::DELETE
        | WatchMask::MODIFY
        | WatchMask::ATTRIB
        | WatchMask::MOVED_FROM
        | WatchMask::MOVED_TO
        | WatchMask::DELETE_SELF
        | WatchMask::DONT_FOLLOW
        | WatchMask::EXCL_UNLINK
        | WatchMask::ONLYDIR
}

impl PlatformBackend {
    fn watch(&mut self, relative: &Path) -> io::Result<()> {
        let wd = self
            .inotify
            .watches()
            .add(self.root.join(relative), watch_mask())?;
        self.dirs.insert(wd, relative.to_path_buf());
        Ok(())
    }

    fn watch_tree(&mut self, start: PathBuf) {
        let mut pending = vec![start];
        while let Some(relative) = pending.pop() {
            if !should_watch_dir(&relative) || self.watch(&relative).is_err() {
                continue;
            }
            let Ok(entries) = std::fs::read_dir(self.root.join(&relative)) else {
                continue;
            };
            for entry in entries.flatten() {
                if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                    pending.push(relative.join(entry.file_name()));
                }
            }
        }
    }

    fn read(&mut self) -> io::Result<Vec<RawEvent>> {
        match self.inotify.read_events(&mut self.buffer) {
            Ok(events) => Ok(events
                .map(|event| RawEvent {
                    wd: event.wd,
                    mask: event.mask,
                    name: event.name.map(OsString::from),
                })
                .collect()),
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => Ok(Vec::new()),
            Err(error) => Err(error),
        }
    }
}

fn poll_readable(fd: i32, timeout: Duration) -> io::Result<bool> {
    let mut target = libc::pollfd {
        fd,
        events: libc::POLLIN,
        revents: 0,
    };
    let millis = i32::try_from(timeout.as_millis()).unwrap_or(i32::MAX);
    // SAFETY: `target` is a valid pollfd for the duration of the call.
    let ready = unsafe { libc::poll(&mut target, 1, millis) };
    if ready >= 0 {
        return Ok(ready > 0);
    }
    let error = io::Error::last_os_error();
    if error.kind() == io::ErrorKind::Interrupted {
        Ok(false)
    } else {
        Err(error)
    }
}

impl Backend for PlatformBackend {
    fn open(root: &Path) -> io::Result<Self> {
        let mut backend = Self {
            inotify: Inotify::init()?,
            root: root.to_path_buf(),
            dirs: HashMap::new(),
            buffer: vec![0; 64 * 1024],
        };
        backend.watch(Path::new(""))?;
        backend.watch_tree(PathBuf::new());
        Ok(backend)
    }

    fn wait(&mut self, timeout: Duration) -> io::Result<Activity> {
        if !poll_readable(self.inotify.as_raw_fd(), timeout)? {
            return Ok(Activity::Quiet);
        }
        let mut paths = Vec::new();
        let mut new_dirs = Vec::new();
        let mut overflow = false;
        for event in self.read()? {
            if event.mask.contains(EventMask::Q_OVERFLOW) {
                overflow = true;
                continue;
            }
            if event.mask.contains(EventMask::IGNORED) {
                self.dirs.remove(&event.wd);
                continue;
            }
            let Some(dir) = self.dirs.get(&event.wd) else {
                continue;
            };
            let path = match event.name {
                Some(name) => dir.join(name),
                None => dir.clone(),
            };
            if event.mask.contains(EventMask::ISDIR)
                && event
                    .mask
                    .intersects(EventMask::CREATE | EventMask::MOVED_TO)
            {
                new_dirs.push(path.clone());
            }
            paths.push(path);
        }
        for dir in new_dirs {
            self.watch_tree(dir);
        }
        if overflow {
            self.watch_tree(PathBuf::new());
            return Ok(Activity::Overflow);
        }
        Ok(if paths.is_empty() {
            Activity::Quiet
        } else {
            Activity::Paths(paths)
        })
    }
}
