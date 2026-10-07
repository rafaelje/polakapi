use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crate::ctx::offload::{floor_char_boundary, OffloadResult};

// Runs the commands context mode reroutes, for both `polakapi ctx exec` and the
// MCP server's ctx_exec.

const MAX_EXEC_OUTPUT: usize = 8 * 1024 * 1024;
const COMMAND_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// How long to keep reading once the shell exited. A background job (`npm run
/// dev &`) inherits the pipes and would otherwise hold them open for good.
const DRAIN_GRACE: Duration = Duration::from_secs(2);
const POLL_INTERVAL: Duration = Duration::from_millis(10);
/// Shells that read the POSIX syntax agents write their commands in. Anything
/// else in $SHELL (fish, nushell, …) would misread them.
const POSIX_SHELLS: &[&str] = &["bash", "zsh", "sh", "dash", "ksh"];

/// Runs the command with the user's own privileges — the same reach the agent's
/// shell tool already has. The output is capped so one runaway process cannot
/// exhaust memory.
pub struct ShellOutput {
    /// stdout followed by stderr.
    pub text: String,
    /// `None` when the process was killed by a signal.
    pub code: Option<i32>,
}

impl ShellOutput {
    pub fn succeeded(&self) -> bool {
        self.code == Some(0)
    }

    /// Appended to whatever reaches the model: a summary or a pointer hides the
    /// output, so without this a failing build would read as a success.
    pub fn status_note(&self) -> Option<String> {
        match self.code {
            Some(0) => None,
            Some(code) => Some(format!("Exit status {code}.")),
            None => Some("The command was terminated by a signal.".to_string()),
        }
    }
}

pub fn run_shell(command: &str, cwd: Option<&Path>) -> Result<ShellOutput, String> {
    let mut cmd = if cfg!(windows) {
        let mut cmd = Command::new("cmd");
        cmd.arg("/C").arg(command);
        cmd
    } else {
        let mut cmd = Command::new(user_shell());
        cmd.arg("-c").arg(command);
        cmd
    };
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not run command: {e}"))?;
    let stdout = child.stdout.take().map(capture);
    let stderr = child.stderr.take().map(capture);
    let (status, timed_out) = wait_until(&mut child, Instant::now() + COMMAND_TIMEOUT)?;
    let drain_deadline = Instant::now() + DRAIN_GRACE;
    let (stdout, stdout_cut, stdout_open) = join_capture(stdout, drain_deadline);
    let (stderr, stderr_cut, stderr_open) = join_capture(stderr, drain_deadline);

    let mut text = String::from_utf8_lossy(&stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&stderr));
    if stdout_cut || stderr_cut || text.len() > MAX_EXEC_OUTPUT {
        text.truncate(floor_char_boundary(&text, MAX_EXEC_OUTPUT));
        text.push_str("\n… output truncated by polakapi");
    }
    if timed_out {
        text.push_str(&format!(
            "\n… command killed by polakapi after {} minutes",
            COMMAND_TIMEOUT.as_secs() / 60
        ));
    } else if stdout_open || stderr_open {
        text.push_str(
            "\n… a background process kept the output open; later output was not captured",
        );
    }
    Ok(ShellOutput {
        text,
        code: status.code(),
    })
}

/// Waits for the child, killing it once the deadline passes. Reports whether it
/// had to be killed.
fn wait_until(
    child: &mut std::process::Child,
    deadline: Instant,
) -> Result<(std::process::ExitStatus, bool), String> {
    loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|e| format!("could not run command: {e}"))?
        {
            return Ok((status, false));
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let status = child
                .wait()
                .map_err(|e| format!("could not run command: {e}"))?;
            return Ok((status, true));
        }
        std::thread::sleep(POLL_INTERVAL);
    }
}

#[derive(Default)]
struct Captured {
    kept: Vec<u8>,
    cut: bool,
}

struct Capture {
    buffer: Arc<Mutex<Captured>>,
    handle: JoinHandle<()>,
}

/// Keeps at most `MAX_EXEC_OUTPUT` bytes of a stream and discards the rest, so
/// the child never blocks on a full pipe and memory stays bounded. The buffer
/// is shared so a reader that never sees EOF can still be harvested.
fn capture<R: Read + Send + 'static>(mut stream: R) -> Capture {
    let buffer = Arc::new(Mutex::new(Captured::default()));
    let shared = Arc::clone(&buffer);
    let handle = std::thread::spawn(move || {
        let mut chunk = [0u8; 64 * 1024];
        loop {
            let read = match stream.read(&mut chunk) {
                Ok(0) => break,
                Ok(read) => read,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            };
            let Ok(mut captured) = shared.lock() else {
                break;
            };
            let room = MAX_EXEC_OUTPUT.saturating_sub(captured.kept.len());
            let kept = read.min(room);
            captured.kept.extend_from_slice(&chunk[..kept]);
            if kept < read {
                captured.cut = true;
            }
        }
    });
    Capture { buffer, handle }
}

/// Collects what the reader gathered, waiting for EOF no later than the
/// deadline. Reports whether output was cut and whether the pipe stayed open.
fn join_capture(capture: Option<Capture>, deadline: Instant) -> (Vec<u8>, bool, bool) {
    let Some(capture) = capture else {
        return (Vec::new(), false, false);
    };
    while !capture.handle.is_finished() && Instant::now() < deadline {
        std::thread::sleep(POLL_INTERVAL);
    }
    let still_open = !capture.handle.is_finished();
    let mut captured = match capture.buffer.lock() {
        Ok(captured) => captured,
        Err(poisoned) => poisoned.into_inner(),
    };
    (std::mem::take(&mut captured.kept), captured.cut, still_open)
}

/// What reaches the model once the command has run. A store that cannot be
/// opened or written must not cost the agent output it already paid for, so
/// the raw text comes back instead and the failure goes to stderr.
pub fn stored_or_raw(stored: Result<OffloadResult, String>, output: &ShellOutput) -> String {
    match stored {
        Ok(result) => result.context_text,
        Err(message) => {
            eprintln!("polakapi ctx: output not stored: {message}");
            output.text.clone()
        }
    }
}

/// The offloaded text plus the exit status when the command failed.
pub fn with_status(context_text: String, output: &ShellOutput) -> String {
    match output.status_note() {
        Some(note) => format!("{context_text}\n{note}"),
        None => context_text,
    }
}

/// The shell the agent's own commands run in: the user's $SHELL, so aliases of
/// the login environment and bash syntax behave the same once rerouted, then
/// bash, then sh.
fn user_shell() -> PathBuf {
    pick_shell(std::env::var_os("SHELL"), find_on_path("bash"))
}

fn pick_shell(shell: Option<std::ffi::OsString>, bash: Option<PathBuf>) -> PathBuf {
    shell
        .map(PathBuf::from)
        .filter(|shell| {
            shell
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| POSIX_SHELLS.contains(&name))
        })
        .or(bash)
        .unwrap_or_else(|| PathBuf::from("sh"))
}

fn find_on_path(program: &str) -> Option<PathBuf> {
    std::env::split_paths(&std::env::var_os("PATH")?)
        .map(|dir| dir.join(program))
        .find(|path| path.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn oversized_output_is_capped_on_a_character_boundary() {
        // Five bytes per line puts the cap inside the two-byte "é".
        let output = run_shell("yes aaé | head -c 9000000", None).unwrap();
        assert!(output.text.ends_with("output truncated by polakapi"));
        assert!(output.text.len() < MAX_EXEC_OUTPUT + 64);
    }

    #[cfg(unix)]
    #[test]
    fn a_background_job_holding_the_pipe_does_not_block() {
        let started = Instant::now();
        let output = run_shell("echo started; sleep 30 &", None).unwrap();
        assert!(started.elapsed() < Duration::from_secs(10));
        assert!(output.text.starts_with("started\n"), "{}", output.text);
        assert!(output
            .text
            .contains("background process kept the output open"));
        assert!(output.succeeded());
    }

    #[cfg(unix)]
    #[test]
    fn a_finished_command_keeps_its_output_untouched() {
        let output = run_shell("echo out; echo err >&2", None).unwrap();
        assert_eq!(output.text, "out\nerr\n");
    }

    #[test]
    fn prefers_the_users_shell_then_bash_then_sh() {
        let bash = Some(PathBuf::from("/usr/bin/bash"));
        assert_eq!(
            pick_shell(Some("/bin/zsh".into()), bash.clone()),
            PathBuf::from("/bin/zsh")
        );
        assert_eq!(
            pick_shell(None, bash.clone()),
            PathBuf::from("/usr/bin/bash")
        );
        assert_eq!(
            pick_shell(Some("".into()), bash.clone()),
            PathBuf::from("/usr/bin/bash")
        );
        assert_eq!(
            pick_shell(Some("/usr/bin/fish".into()), bash),
            PathBuf::from("/usr/bin/bash")
        );
        assert_eq!(pick_shell(None, None), PathBuf::from("sh"));
    }
}
