use std::io;
use std::path::{Path, PathBuf};
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

mod scope;
use scope::{watch_roots, Scope};

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
/// up to date (skipping directories for which `Scope::should_watch_dir` is false).
pub(crate) trait Backend: Sized + Send + 'static {
    fn open(root: &Path, scope: &Scope) -> io::Result<Self>;
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
        let mut watches = Vec::new();
        for (index, (path, scope)) in watch_roots(root).into_iter().enumerate() {
            match PlatformBackend::open(&path, &scope) {
                Ok(backend) => watches.push((backend, scope)),
                Err(error) if index == 0 => return Err(error),
                Err(error) => {
                    eprintln!("polakapi: could not watch {}: {error}", path.display());
                }
            }
        }
        let stop = Arc::new(AtomicBool::new(false));
        let thread = std::thread::Builder::new()
            .name("polakapi-project-watch".into())
            .spawn({
                let stop = stop.clone();
                move || run(watches, &stop, on_change)
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

fn run<B: Backend>(mut watches: Vec<(B, Scope)>, stop: &AtomicBool, on_change: impl Fn()) {
    let mut burst: Option<(Instant, Instant)> = None;
    while !stop.load(Ordering::SeqCst) {
        let timeout = match burst {
            Some((_, last)) => QUIET.saturating_sub(last.elapsed()).min(POLL),
            None => POLL,
        };
        let mut changed = false;
        let mut failed = None;
        for (index, (backend, scope)) in watches.iter_mut().enumerate() {
            let wait = if index == 0 { timeout } else { Duration::ZERO };
            match backend.wait(wait) {
                Ok(Activity::Quiet) => {}
                Ok(Activity::Overflow) => changed = true,
                Ok(Activity::Paths(paths)) => {
                    changed |= paths.iter().any(|path| scope.is_relevant(path));
                }
                Err(error) => {
                    eprintln!("polakapi: project watcher stopped: {error}");
                    failed = Some(index);
                    break;
                }
            }
        }
        match failed {
            Some(0) => return,
            Some(index) => drop(watches.remove(index)),
            None => {}
        }
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
