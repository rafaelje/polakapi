use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread::JoinHandle;

use crate::ctx::offload::{floor_char_boundary, OffloadResult};

// Runs the commands context mode reroutes, for both `polakapi ctx exec` and the
// MCP server's ctx_exec.

const MAX_EXEC_OUTPUT: usize = 8 * 1024 * 1024;
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
    let status = child
        .wait()
        .map_err(|e| format!("could not run command: {e}"))?;
    let (stdout, stdout_cut) = join_capture(stdout);
    let (stderr, stderr_cut) = join_capture(stderr);

    let mut text = String::from_utf8_lossy(&stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&stderr));
    if stdout_cut || stderr_cut || text.len() > MAX_EXEC_OUTPUT {
        text.truncate(floor_char_boundary(&text, MAX_EXEC_OUTPUT));
        text.push_str("\n… output truncated by polakapi");
    }
    Ok(ShellOutput {
        text,
        code: status.code(),
    })
}

/// Keeps at most `MAX_EXEC_OUTPUT` bytes of a stream and discards the rest, so
/// the child never blocks on a full pipe and memory stays bounded. Reports
/// whether anything was discarded.
fn capture<R: Read + Send + 'static>(stream: R) -> JoinHandle<(Vec<u8>, bool)> {
    std::thread::spawn(move || {
        let mut kept = Vec::new();
        let mut limited = stream.take(MAX_EXEC_OUTPUT as u64);
        let _ = limited.read_to_end(&mut kept);
        let dropped = std::io::copy(&mut limited.into_inner(), &mut std::io::sink()).unwrap_or(0);
        (kept, dropped > 0)
    })
}

fn join_capture(handle: Option<JoinHandle<(Vec<u8>, bool)>>) -> (Vec<u8>, bool) {
    handle
        .and_then(|handle| handle.join().ok())
        .unwrap_or_default()
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
