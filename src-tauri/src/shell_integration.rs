//! Shell-integration script injection for bare shell (bash/zsh) PTY spawns.
//! Reports each submitted command via OSC so "Resume all" can replay it.

use std::path::Path;

use portable_pty::CommandBuilder;

const INTEGRATION_BASH: &str = include_str!("../resources/shell-integration/integration.bash");
const INTEGRATION_ZSH: &str = include_str!("../resources/shell-integration/integration.zsh");
const ZSHENV_WRAPPER: &str = include_str!("../resources/shell-integration/zshenv");
const ZSHRC_WRAPPER: &str = include_str!("../resources/shell-integration/zshrc");

fn ensure_files(base_dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(base_dir)
        .map_err(|e| format!("could not create {}: {e}", base_dir.display()))?;
    std::fs::write(base_dir.join("integration.bash"), INTEGRATION_BASH)
        .map_err(|e| format!("could not write integration.bash: {e}"))?;
    std::fs::write(base_dir.join("integration.zsh"), INTEGRATION_ZSH)
        .map_err(|e| format!("could not write integration.zsh: {e}"))?;
    std::fs::write(base_dir.join(".zshenv"), ZSHENV_WRAPPER)
        .map_err(|e| format!("could not write .zshenv: {e}"))?;
    std::fs::write(base_dir.join(".zshrc"), ZSHRC_WRAPPER)
        .map_err(|e| format!("could not write .zshrc: {e}"))?;
    Ok(())
}

/// Injects shell-integration hooks into `cmd` for bash/zsh. Only call for a
/// bare-shell spawn request (no explicit command/args).
pub fn apply(
    integration_base_dir: &Path,
    cmd: &mut CommandBuilder,
    shell: &str,
    session_token: &str,
) {
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
    cmd.env("POLAKAPI_SHELL_TOKEN", session_token);

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
