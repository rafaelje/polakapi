use std::{
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
    sync::Arc,
};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State, Window};

use crate::a2a_broker::Broker;

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Scope {
    #[default]
    Window,
    All,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
pub(crate) struct Preferences {
    enabled: bool,
    scope: Scope,
}

impl Preferences {
    fn load(path: &Path) -> Result<Self, String> {
        match fs::read(path) {
            Ok(bytes) => {
                serde_json::from_slice(&bytes).map_err(|e| format!("Invalid A2A settings: {e}"))
            }
            Err(e) if e.kind() == ErrorKind::NotFound => Ok(Self::default()),
            Err(e) => Err(format!("Cannot read A2A settings: {e}")),
        }
    }

    fn patch(self, enabled: Option<bool>, scope: Option<Scope>) -> Self {
        Self {
            enabled: enabled.unwrap_or(self.enabled),
            scope: scope.unwrap_or(self.scope),
        }
    }

    fn save(&self, path: &Path) -> Result<(), String> {
        let dir = path.parent().ok_or("Missing A2A settings directory")?;
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let mut file = tempfile::NamedTempFile::new_in(dir).map_err(|e| e.to_string())?;
        serde_json::to_writer(file.as_file_mut(), self).map_err(|e| e.to_string())?;
        file.persist(path).map_err(|e| e.to_string())?;
        Ok(())
    }
}

pub(crate) struct Runtime {
    pub broker: Arc<Broker>,
    path: PathBuf,
    preferences: Mutex<Preferences>,
}

impl Runtime {
    pub fn start(app: &AppHandle) -> Result<Self, String> {
        let path = app
            .path()
            .app_config_dir()
            .map_err(|e| e.to_string())?
            .join("a2a.json");
        let preferences = Preferences::load(&path)?;
        let broker = Arc::new(Broker::start()?);
        broker.configure(preferences.enabled, preferences.scope == Scope::All);
        Ok(Self {
            broker,
            path,
            preferences: Mutex::new(preferences),
        })
    }
}

#[tauri::command]
pub(crate) fn a2a_settings(state: State<'_, Runtime>) -> Preferences {
    *state.preferences.lock()
}

#[tauri::command]
pub(crate) fn a2a_update_settings(
    window: Window,
    state: State<'_, Runtime>,
    enabled: Option<bool>,
    scope: Option<Scope>,
) -> Result<Preferences, String> {
    if !matches!(window.label(), "main" | "settings") {
        return Err("A2A settings can only be changed from the main or settings window".into());
    }
    let mut current = state.preferences.lock();
    let next = current.patch(enabled, scope);
    next.save(&state.path)?;
    state
        .broker
        .configure(next.enabled, next.scope == Scope::All);
    *current = next;
    window
        .app_handle()
        .emit("a2a:settings", next)
        .map_err(|e| e.to_string())?;
    Ok(next)
}

#[tauri::command(async)]
pub(crate) fn a2a_review_share(
    window: Window,
    state: State<'_, Runtime>,
    target: String,
    session: String,
    reviewer: Option<String>,
) -> Result<(), String> {
    if window.label() != "context" {
        return Err("Review sharing can only be changed in the context window".into());
    }
    let Some(reviewer) = reviewer else {
        state.broker.revoke_review(&target);
        return Ok(());
    };
    let db = crate::db::Db::resolve_path(window.app_handle())?;
    let home = match std::env::var_os("CODEX_HOME") {
        Some(v) if !v.is_empty() => PathBuf::from(v),
        _ => crate::platform_command::user_home_dir()
            .ok_or("Codex home unavailable")?
            .join(".codex"),
    };
    if !home.is_absolute() {
        return Err("Codex home must be an absolute path".into());
    }
    state
        .broker
        .grant_review(&target, &reviewer, &session, db, home)
}

pub(crate) struct Membership {
    broker: Arc<Broker>,
    id: String,
}

impl Membership {
    pub fn prepare(
        window: &Window,
        id: &str,
        cli: Option<&str>,
        args: &mut Vec<String>,
    ) -> Result<Option<(Self, String)>, String> {
        if !matches!(cli, Some("codex" | "claude")) {
            return Ok(None);
        }
        let Some(state) = window.try_state::<Runtime>() else {
            return Ok(None);
        };
        let bin = std::env::current_exe().map_err(|e| e.to_string())?;
        let bin = bin
            .to_str()
            .ok_or("A2A requires a Unicode executable path")?;
        let token = state.broker.register(id, window.label());
        if token.is_empty() {
            return Err(format!(
                "Cannot enroll this {} pane: A2A peer capacity or window label limit exceeded",
                if cli == Some("claude") {
                    "Claude"
                } else {
                    "Codex"
                }
            ));
        }
        let provider_args = match cli {
            Some("codex") => crate::a2a_mcp::codex_args(bin),
            Some("claude") => claude::claude_args(bin),
            _ => unreachable!("only supported providers enroll"),
        };
        args.splice(0..0, provider_args);
        Ok(Some((
            Self {
                broker: state.broker.clone(),
                id: id.into(),
            },
            token,
        )))
    }

    pub fn set_environment(
        enrollment: Option<(Self, String)>,
        cmd: &mut portable_pty::CommandBuilder,
    ) -> Option<Self> {
        cmd.env_remove("POLAKAPI_A2A_TOKEN");
        cmd.env_remove("POLAKAPI_A2A_PORT");
        let (membership, token) = enrollment?;
        cmd.env("POLAKAPI_A2A_TOKEN", token);
        cmd.env("POLAKAPI_A2A_PORT", membership.broker.port().to_string());
        Some(membership)
    }

    pub fn move_to(&self, window: &str) {
        self.broker.move_to(&self.id, window);
    }
}

impl Drop for Membership {
    fn drop(&mut self) {
        self.broker.unregister(&self.id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scope_and_toggle_are_independent_and_survive_restart() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a2a.json");
        let initial = Preferences::load(&path).unwrap();
        assert!(!initial.enabled);
        assert_eq!(initial.scope, Scope::Window);
        let changed = initial
            .patch(None, Some(Scope::All))
            .patch(Some(true), None);
        changed.save(&path).unwrap();
        assert_eq!(
            Preferences::load(&path).unwrap(),
            Preferences {
                enabled: true,
                scope: Scope::All
            }
        );
    }
}

#[cfg(test)]
mod claude_enrollment_tests {
    #[test]
    fn claude_inline_config_preserves_following_cli_arguments() {
        let mut args = vec![
            "--continue".into(),
            "mcp".into(),
            "list".into(),
            "-p".into(),
            "ordinary positional prompt".into(),
        ];
        args.splice(
            0..0,
            super::claude::claude_args(r#"C:\polakapi\polakapi.exe"#),
        );
        assert_eq!(args.len(), 6);
        assert!(args[0].starts_with("--mcp-config="));
        assert_eq!(
            &args[1..],
            [
                "--continue",
                "mcp",
                "list",
                "-p",
                "ordinary positional prompt"
            ]
        );
        let config: serde_json::Value =
            serde_json::from_str(args[0].strip_prefix("--mcp-config=").unwrap()).unwrap();
        assert_eq!(
            config,
            serde_json::json!({
                "mcpServers": {
                    "polakapi_a2a": {
                        "command": r#"C:\polakapi\polakapi.exe"#,
                        "args": ["a2a-mcp"]
                    }
                }
            })
        );
    }
}

mod claude;
