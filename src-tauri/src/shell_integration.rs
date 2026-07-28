//! Shell-integration script injection for bare shell (bash/zsh) PTY spawns.
//!
//! When a plain shell terminal is spawned (no explicit command/args — i.e.
//! `cliId: "shell"` from the frontend, not an AI CLI or a resume with
//! explicit `resumeArgs`), this materializes a small init script into
//! `<app_config_dir>/shell-integration/` and points the spawned shell at it,
//! without ever touching the user's own dotfiles:
//!
//! - bash: `--init-file <materialized>/integration.bash`, which sources the
//!   user's real `~/.bashrc` itself before adding the hook.
//! - zsh: `ZDOTDIR` is overridden to the materialized directory (which
//!   contains a `.zshrc` wrapper), with the original `ZDOTDIR`/`HOME` passed
//!   through as `POLAKAPI_REAL_ZDOTDIR` so the wrapper can source the real
//!   config and restore `ZDOTDIR` before doing so — same technique VS Code's
//!   shell integration uses.
//!
//! The injected hook reports each Enter-submitted command back to the app via
//! a custom OSC escape (`\x1b]9931;<base64>\x07`, terminal-side, not IPC),
//! which `TerminalManager` captures into `TerminalSpec.lastShellCommand` so
//! "Resume all" can replay it after a suspend/resume cycle. Only bash and zsh
//! are supported for v1 — other shells (fish, dash, …) are a silent no-op.
//! Materialization failures (e.g. cannot write to app_config_dir) are also
//! swallowed: the shell spawns exactly as it does today, just without replay
//! capability for that terminal.

use std::path::Path;

use portable_pty::CommandBuilder;

const INTEGRATION_BASH: &str = include_str!("../resources/shell-integration/integration.bash");
const INTEGRATION_ZSH: &str = include_str!("../resources/shell-integration/integration.zsh");
const ZSHRC_WRAPPER: &str = include_str!("../resources/shell-integration/zshrc");

fn ensure_files(base_dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(base_dir)
        .map_err(|e| format!("could not create {}: {e}", base_dir.display()))?;
    std::fs::write(base_dir.join("integration.bash"), INTEGRATION_BASH)
        .map_err(|e| format!("could not write integration.bash: {e}"))?;
    std::fs::write(base_dir.join("integration.zsh"), INTEGRATION_ZSH)
        .map_err(|e| format!("could not write integration.zsh: {e}"))?;
    // zsh reads `$ZDOTDIR/.zshrc`, so the wrapper must be literally named
    // `.zshrc` inside the materialized directory.
    std::fs::write(base_dir.join(".zshrc"), ZSHRC_WRAPPER)
        .map_err(|e| format!("could not write .zshrc: {e}"))?;
    Ok(())
}

/// Injects shell-integration hooks into `cmd` when `shell`'s basename is bash
/// or zsh, materializing the scripts under `integration_base_dir` (the
/// caller resolves this from `app_config_dir()` — kept as a plain path here
/// so this stays unit-testable without a Tauri `AppHandle`). Callers must
/// only invoke this for a bare-shell spawn request (no explicit
/// command/args) — see `spawn_session` in `pty.rs`.
pub fn apply(integration_base_dir: &Path, cmd: &mut CommandBuilder, shell: &str) {
    let basename = Path::new(shell)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(shell)
        .to_ascii_lowercase();
    if basename != "bash" && basename != "zsh" {
        return;
    }

    if ensure_files(integration_base_dir).is_err() {
        return;
    }

    match basename.as_str() {
        "bash" => {
            cmd.arg("--init-file");
            cmd.arg(integration_base_dir.join("integration.bash"));
        }
        "zsh" => {
            if let Some(real) = std::env::var_os("ZDOTDIR") {
                cmd.env("POLAKAPI_REAL_ZDOTDIR", real);
            }
            cmd.env("ZDOTDIR", integration_base_dir);
        }
        _ => unreachable!(),
    }
}

#[cfg(test)]
mod tests;
