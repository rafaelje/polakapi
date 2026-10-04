use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::ctx::paths::Storage;
use crate::ctx::router::Policy;

// Reads the Context Mode settings the UI writes through tauri-plugin-store.
//
// The store lives in the app *data* directory (tauri-plugin-store resolves it
// with BaseDirectory::AppData) while polakapi.db lives in the app *config*
// directory. On Linux those differ — ~/.local/share/<id> versus ~/.config/<id> —
// so the path cannot be derived from POLAKAPI_DB_PATH. The PTY layer resolves it
// with the same API the plugin uses and exports it as POLAKAPI_CTX_CONFIG for
// the helpers (`polakapi ctx`, `ctx-mcp`, `ctx-hook`), which run without an
// AppHandle.

pub const CONFIG_FILE: &str = "context-mode.json";
pub const CONFIG_ENV: &str = "POLAKAPI_CTX_CONFIG";

#[derive(Debug, Clone, PartialEq)]
pub struct CtxConfig {
    pub enabled: bool,
    /// CLI ids switched on in settings ("claude", "codex", ...).
    pub clis: Vec<String>,
    pub storage: Storage,
    pub promote_after_sources: u64,
    pub policy: Policy,
}

impl Default for CtxConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            clis: Vec::new(),
            storage: Storage::Promote,
            promote_after_sources: 20,
            policy: Policy::default(),
        }
    }
}

impl CtxConfig {
    /// Whether this CLI should route through context mode at all: the master
    /// switch and its own toggle both have to be on.
    pub fn enabled_for(&self, cli: &str) -> bool {
        self.enabled && self.clis.iter().any(|enabled| enabled == cli)
    }
}

pub fn config_path_from_db(db_path: &Path) -> Option<PathBuf> {
    Some(db_path.parent()?.join(CONFIG_FILE))
}

/// Where the UI's store file is, as the running app resolves it.
pub fn config_path_for_app<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<PathBuf> {
    use tauri::Manager;
    Some(app.path().app_data_dir().ok()?.join(CONFIG_FILE))
}

/// Config path from the environment the PTY layer injects. Falls back to the
/// database directory only for platforms where data and config coincide.
pub fn config_path_from_env() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os(CONFIG_ENV).filter(|value| !value.is_empty()) {
        return Some(PathBuf::from(path));
    }
    let db = std::env::var("POLAKAPI_DB_PATH").ok()?;
    config_path_from_db(Path::new(&db))
}

pub fn read_raw(path: &Path) -> Value {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .unwrap_or(Value::Null)
}

/// Parses the stored preferences, falling back to the defaults field by field
/// so a partially written file never disables the feature by surprise.
pub fn parse(raw: &Value) -> CtxConfig {
    let defaults = CtxConfig::default();
    let Some(prefs) = raw.get("preferences") else {
        return defaults;
    };
    let kb = |key: &str, fallback: u64| -> u64 {
        prefs
            .get(key)
            .and_then(Value::as_u64)
            .map(|value| value.saturating_mul(1024))
            .unwrap_or(fallback)
    };
    CtxConfig {
        enabled: prefs
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(defaults.enabled),
        clis: prefs
            .get("clis")
            .and_then(Value::as_object)
            .map(|clis| {
                clis.iter()
                    .filter(|(_, on)| on.as_bool() == Some(true))
                    .map(|(cli, _)| cli.clone())
                    .collect()
            })
            .unwrap_or_default(),
        storage: prefs
            .get("storage")
            .and_then(Value::as_str)
            .map(Storage::from_label)
            .unwrap_or(defaults.storage),
        promote_after_sources: prefs
            .get("promoteAfterSources")
            .and_then(Value::as_u64)
            .unwrap_or(defaults.promote_after_sources),
        policy: Policy {
            bypass_bytes: kb("bypassKb", defaults.policy.bypass_bytes),
            externalize_bytes: kb("externalizeKb", defaults.policy.externalize_bytes),
        },
    }
}

pub fn load_from_env() -> CtxConfig {
    match config_path_from_env() {
        Some(path) => parse(&read_raw(&path)),
        None => CtxConfig::default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(json: Value) -> Value {
        json
    }

    #[test]
    fn missing_or_empty_config_yields_the_defaults() {
        assert_eq!(parse(&Value::Null), CtxConfig::default());
        assert_eq!(parse(&raw(serde_json::json!({}))), CtxConfig::default());
    }

    #[test]
    fn reads_the_stored_preferences() {
        let config = parse(&raw(serde_json::json!({
            "preferences": {
                "enabled": true,
                "storage": "project",
                "promoteAfterSources": 3,
                "bypassKb": 2,
                "externalizeKb": 50
            }
        })));
        assert!(config.enabled);
        assert_eq!(config.storage, Storage::Project);
        assert_eq!(config.promote_after_sources, 3);
        assert_eq!(config.policy.bypass_bytes, 2 * 1024);
        assert_eq!(config.policy.externalize_bytes, 50 * 1024);
    }

    #[test]
    fn a_half_written_file_keeps_the_remaining_defaults() {
        let config = parse(&raw(
            serde_json::json!({ "preferences": { "enabled": true } }),
        ));
        assert!(config.enabled);
        assert_eq!(config.storage, CtxConfig::default().storage);
        assert_eq!(
            config.policy.externalize_bytes,
            CtxConfig::default().policy.externalize_bytes
        );
    }

    #[test]
    fn per_cli_flags_gate_on_top_of_the_master_switch() {
        let raw = raw(serde_json::json!({
            "preferences": { "enabled": true, "clis": { "claude": true, "codex": false } }
        }));
        let config = parse(&raw);
        assert!(config.enabled_for("claude"));
        assert!(!config.enabled_for("codex"));
        // A CLI absent from the file is off, not on.
        assert!(!config.enabled_for("opencode"));
    }

    #[test]
    fn nothing_is_enabled_while_the_master_switch_is_off() {
        let raw = raw(serde_json::json!({
            "preferences": { "enabled": false, "clis": { "claude": true } }
        }));
        assert!(!parse(&raw).enabled_for("claude"));
    }

    #[test]
    fn the_config_sits_next_to_the_database() {
        let path = config_path_from_db(Path::new("/home/u/.config/polakapi/polakapi.db")).unwrap();
        assert_eq!(
            path,
            Path::new("/home/u/.config/polakapi/context-mode.json")
        );
    }
}
