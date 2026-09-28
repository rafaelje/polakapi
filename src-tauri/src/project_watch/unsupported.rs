use std::io;
use std::path::Path;
use std::time::Duration;

use super::{Activity, Backend, Scope};

pub(crate) struct PlatformBackend;

impl Backend for PlatformBackend {
    fn open(_root: &Path, _scope: &Scope) -> io::Result<Self> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "file watching not supported on this platform yet",
        ))
    }

    fn wait(&mut self, timeout: Duration) -> io::Result<Activity> {
        std::thread::sleep(timeout);
        Ok(Activity::Quiet)
    }
}
