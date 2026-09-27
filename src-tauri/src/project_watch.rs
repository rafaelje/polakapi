use std::ffi::OsStr;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
use linux::PlatformBackend;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
use macos::PlatformBackend;

#[cfg(windows)]
mod win;
#[cfg(windows)]
use win::PlatformBackend;

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
mod unsupported;
#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
use unsupported::PlatformBackend;

#[cfg(all(test, any(target_os = "linux", target_os = "macos", windows)))]
mod tests;

const QUIET: Duration = Duration::from_millis(300);
const MAX_DELAY: Duration = Duration::from_secs(2);
const POLL: Duration = Duration::from_millis(100);

/// What a backend observed during one `wait`. Paths are relative to the watched root.
#[cfg_attr(
    not(any(target_os = "linux", target_os = "macos", windows)),
    allow(dead_code)
)]
pub(crate) enum Activity {
    Quiet,
    Paths(Vec<PathBuf>),
    Overflow,
}

/// A platform binding. The core owns ignore rules, debouncing and stopping;
/// a backend only reports raw activity under the root and keeps its OS watches
/// up to date (skipping directories for which `should_watch_dir` is false).
pub(crate) trait Backend: Sized + Send + 'static {
    fn open(root: &Path) -> io::Result<Self>;
    /// Blocks for at most `timeout`.
    fn wait(&mut self, timeout: Duration) -> io::Result<Activity>;
}

/// Watches one project and calls `on_change` once per debounced burst of
/// relevant changes. Dropping it stops and joins the watcher thread.
pub struct ProjectWatcher {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl ProjectWatcher {
    pub fn start(root: &Path, on_change: impl Fn() + Send + 'static) -> io::Result<Self> {
        if !root.is_dir() {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                format!("not a directory: {}", root.display()),
            ));
        }
        let backend = PlatformBackend::open(root)?;
        let stop = Arc::new(AtomicBool::new(false));
        let thread = std::thread::Builder::new()
            .name("polakapi-project-watch".into())
            .spawn({
                let stop = stop.clone();
                move || run(backend, &stop, on_change)
            })?;
        Ok(Self {
            stop,
            thread: Some(thread),
        })
    }
}

impl Drop for ProjectWatcher {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn run<B: Backend>(mut backend: B, stop: &AtomicBool, on_change: impl Fn()) {
    let mut burst: Option<(Instant, Instant)> = None;
    while !stop.load(Ordering::SeqCst) {
        let timeout = match burst {
            Some((_, last)) => QUIET.saturating_sub(last.elapsed()).min(POLL),
            None => POLL,
        };
        let changed = match backend.wait(timeout) {
            Ok(Activity::Quiet) => false,
            Ok(Activity::Overflow) => true,
            Ok(Activity::Paths(paths)) => paths.iter().any(|path| !is_ignored(path)),
            Err(error) => {
                eprintln!("polakapi: project watcher stopped: {error}");
                return;
            }
        };
        let now = Instant::now();
        if changed {
            burst = Some(burst.map_or((now, now), |(first, _)| (first, now)));
        }
        if let Some((first, last)) = burst {
            if now.duration_since(last) >= QUIET || now.duration_since(first) >= MAX_DELAY {
                burst = None;
                on_change();
            }
        }
    }
}

fn normal_parts(relative: &Path) -> Vec<&OsStr> {
    relative
        .components()
        .filter_map(|component| match component {
            Component::Normal(part) => Some(part),
            _ => None,
        })
        .collect()
}

/// `.git/` is ignored except `.git/index` and `.git/HEAD`; `node_modules/` and
/// `target/` are ignored at any depth.
pub(crate) fn is_ignored(relative: &Path) -> bool {
    let parts = normal_parts(relative);
    if parts
        .iter()
        .any(|part| *part == "node_modules" || *part == "target")
    {
        return true;
    }
    match parts.iter().position(|part| *part == ".git") {
        None => false,
        Some(0) => !(parts.len() == 2 && (parts[1] == "index" || parts[1] == "HEAD")),
        Some(_) => true,
    }
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) fn should_watch_dir(relative: &Path) -> bool {
    normal_parts(relative) == [OsStr::new(".git")] || !is_ignored(relative)
}
