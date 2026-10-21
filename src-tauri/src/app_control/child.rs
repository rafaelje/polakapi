use std::collections::{HashSet, VecDeque};
use std::io;
use std::process::ExitStatus;
use std::sync::Mutex;
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::{Child, ChildStdin, Command};

// Headless child processes of the operator agent and the Telegram bot. Each
// one runs in its own process group, so a cancel or a timeout also stops what
// it started (dev servers, MCP servers, browsers), and its output is capped so
// a chatty command cannot exhaust memory.

/// How long a stopped group gets to exit on SIGTERM before SIGKILL.
#[cfg(unix)]
const TERM_GRACE: Duration = Duration::from_secs(2);
/// How long to keep reading once the process exited. A background job
/// (`npm run dev &`) inherits the pipes and would otherwise hold them open
/// until the timeout.
const DRAIN_GRACE: Duration = Duration::from_secs(2);
const READ_CHUNK: usize = 16 * 1024;

static LIVE: Mutex<Option<HashSet<u32>>> = Mutex::new(None);

/// How much of a stream is kept: the first `head` bytes and the last `tail`.
#[derive(Debug, Clone, Copy)]
pub struct Limit {
    pub head: usize,
    pub tail: usize,
}

impl Limit {
    pub const fn tail(bytes: usize) -> Self {
        Self {
            head: 0,
            tail: bytes,
        }
    }
}

#[derive(Debug, Default)]
pub struct Captured {
    pub bytes: Vec<u8>,
    /// Bytes between the head and the tail were dropped.
    pub truncated: bool,
}

#[derive(Debug)]
pub struct Output {
    /// `None` when the timeout stopped the process.
    pub status: Option<ExitStatus>,
    pub stdout: Captured,
    pub stderr: Captured,
}

pub struct Running {
    child: Child,
    group: Group,
}

pub fn spawn(command: &mut Command) -> io::Result<Running> {
    #[cfg(unix)]
    command.process_group(0);
    #[cfg(not(unix))]
    command.kill_on_drop(true);
    let child = command.spawn()?;
    let group = Group::new(child.id());
    Ok(Running { child, group })
}

/// Stops every running group. Used on exit, where cancelled tasks may never
/// get dropped.
pub fn stop_all() {
    let pids = lock_live().take().unwrap_or_default();
    for pid in pids {
        stop_group(pid);
    }
}

impl Running {
    pub fn stdin(&mut self) -> Option<ChildStdin> {
        self.child.stdin.take()
    }

    /// Waits for the process while reading its output. Dropping the future,
    /// or the timeout, stops the whole process group.
    pub async fn wait(self, timeout: Duration, stdout: Limit, stderr: Limit) -> io::Result<Output> {
        let Running { mut child, group } = self;
        let mut out = Ring::new(stdout);
        let mut err = Ring::new(stderr);
        let (out_pipe, err_pipe) = (child.stdout.take(), child.stderr.take());
        let status = {
            let reading = async {
                tokio::join!(drain(out_pipe, &mut out), drain(err_pipe, &mut err));
            };
            tokio::pin!(reading);
            let waiting = async {
                let status = tokio::select! {
                    status = child.wait() => {
                        let _ = tokio::time::timeout(DRAIN_GRACE, &mut reading).await;
                        status
                    }
                    _ = &mut reading => child.wait().await,
                };
                status
            };
            tokio::time::timeout(timeout, waiting).await
        };
        let status = match status {
            Ok(status) => {
                let status = status?;
                group.release();
                Some(status)
            }
            Err(_) => None,
        };
        Ok(Output {
            status,
            stdout: out.finish(),
            stderr: err.finish(),
        })
    }
}

async fn drain<R: AsyncRead + Unpin>(pipe: Option<R>, ring: &mut Ring) {
    let Some(mut pipe) = pipe else {
        return;
    };
    let mut buf = vec![0u8; READ_CHUNK];
    loop {
        match pipe.read(&mut buf).await {
            Ok(0) | Err(_) => return,
            Ok(n) => ring.push(&buf[..n]),
        }
    }
}

struct Ring {
    limit: Limit,
    head: Vec<u8>,
    tail: VecDeque<u8>,
    dropped: bool,
}

impl Ring {
    fn new(limit: Limit) -> Self {
        Self {
            limit,
            head: Vec::new(),
            tail: VecDeque::new(),
            dropped: false,
        }
    }

    fn push(&mut self, chunk: &[u8]) {
        let room = self.limit.head.saturating_sub(self.head.len());
        let (head, rest) = chunk.split_at(room.min(chunk.len()));
        self.head.extend_from_slice(head);
        let excess = (self.tail.len() + rest.len()).saturating_sub(self.limit.tail);
        if excess == 0 {
            self.tail.extend(rest);
            return;
        }
        self.dropped = true;
        let from_tail = excess.min(self.tail.len());
        self.tail.drain(..from_tail);
        self.tail.extend(&rest[excess - from_tail..]);
    }

    fn finish(self) -> Captured {
        let mut bytes = self.head;
        bytes.extend(self.tail);
        Captured {
            bytes,
            truncated: self.dropped,
        }
    }
}

struct Group {
    pid: Option<u32>,
}

impl Group {
    fn new(pid: Option<u32>) -> Self {
        if let Some(pid) = pid {
            lock_live().get_or_insert_with(HashSet::new).insert(pid);
        }
        Self { pid }
    }

    fn release(mut self) {
        if let Some(pid) = self.pid.take() {
            forget(pid);
        }
    }
}

impl Drop for Group {
    fn drop(&mut self) {
        if let Some(pid) = self.pid.take() {
            if forget(pid) {
                stop_group(pid);
            }
        }
    }
}

fn forget(pid: u32) -> bool {
    lock_live().as_mut().is_some_and(|live| live.remove(&pid))
}

fn lock_live() -> std::sync::MutexGuard<'static, Option<HashSet<u32>>> {
    LIVE.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(unix)]
fn stop_group(pid: u32) {
    let Ok(pgid) = libc::pid_t::try_from(pid) else {
        return;
    };
    // SIGTERM first so a CLI can shut its own MCP servers down cleanly.
    unsafe { libc::killpg(pgid, libc::SIGTERM) };
    let _ = std::thread::Builder::new()
        .name("polakapi-child-stop".into())
        .spawn(move || {
            std::thread::sleep(TERM_GRACE);
            unsafe { libc::killpg(pgid, libc::SIGKILL) };
        });
}

#[cfg(not(unix))]
fn stop_group(_pid: u32) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ring_keeps_head_and_tail() {
        let mut ring = Ring::new(Limit { head: 3, tail: 4 });
        ring.push(b"abc");
        ring.push(b"de");
        assert!(!ring.dropped);
        ring.push(b"fghij");
        let out = ring.finish();
        assert_eq!(out.bytes, b"abcghij");
        assert!(out.truncated);
    }

    #[test]
    fn ring_with_no_tail_keeps_only_the_head() {
        let mut ring = Ring::new(Limit { head: 2, tail: 0 });
        ring.push(b"hello");
        let out = ring.finish();
        assert_eq!(out.bytes, b"he");
        assert!(out.truncated);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn caps_a_runaway_stream() {
        let mut command = Command::new("sh");
        command
            .arg("-c")
            .arg("yes | head -c 5000000")
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        let out = spawn(&mut command)
            .unwrap()
            .wait(
                Duration::from_secs(20),
                Limit::tail(1024),
                Limit::tail(1024),
            )
            .await
            .unwrap();
        assert!(out.status.unwrap().success());
        assert_eq!(out.stdout.bytes.len(), 1024);
        assert!(out.stdout.truncated);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn timeout_stops_the_whole_group() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("grandchild.pid");
        let mut command = Command::new("sh");
        command
            .arg("-c")
            .arg(format!("sleep 30 & echo $! > {}; wait", marker.display()))
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        let out = spawn(&mut command)
            .unwrap()
            .wait(
                Duration::from_millis(500),
                Limit::tail(1024),
                Limit::tail(1024),
            )
            .await
            .unwrap();
        assert!(out.status.is_none());
        let pid: libc::pid_t = std::fs::read_to_string(&marker)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        let mut alive = true;
        for _ in 0..50 {
            std::thread::sleep(Duration::from_millis(100));
            alive = unsafe { libc::kill(pid, 0) } == 0;
            if !alive {
                break;
            }
        }
        assert!(!alive, "the grandchild outlived the timeout");
    }
}
