use std::collections::HashMap;
use std::io::Write;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::app_control::mcp::PROFILES;

// Bot configuration and the bot's own state. Both files hold secrets or chat
// ids, so they are written readable only by the user. The token never goes
// back to the webview once saved: `ConfigView` carries a hint instead.

pub const CONFIG_FILE: &str = "telegram.json";
pub const STATE_FILE: &str = "telegram-state.json";
pub const AUDIT_FILE: &str = "telegram-audit.jsonl";
pub const HEADLESS_CLIS: &[&str] = &["claude", "codex"];
const MIN_TIMEOUT_SECS: u64 = 30;
const MAX_TIMEOUT_SECS: u64 = 3600;
pub const MAX_STYLE_CHARS: usize = 1000;
const MAX_NAMES: usize = 10;
const MAX_NAME_CHARS: usize = 40;
const VOICE_LANGUAGES: &[&str] = &["auto", "es", "en", "pt", "fr", "de", "it"];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TelegramConfig {
    pub enabled: bool,
    pub token: String,
    pub allowed_user_ids: Vec<i64>,
    pub cli: String,
    pub profile: String,
    pub turn_timeout_secs: u64,
    /// How the agent should answer, in the user's words. Chats can override
    /// it with `/style`.
    pub reply_style: String,
    /// What the agent calls the user, so the answers read as meant for them.
    pub address_as: Vec<String>,
    /// Send the desktop agent notifications to the allowed users too.
    pub forward_notifications: bool,
    /// Offer Allow / Always / Deny buttons on permission notifications.
    pub remote_approvals: bool,
    /// Ask in the chat before the agent types into a terminal or runs a
    /// command. Off means it acts directly.
    pub confirm_actions: bool,
    /// Let commands sent from Telegram use sudo, doas, su and the like.
    /// Only the settings window can change it, never the chat.
    pub allow_sudo: bool,
    /// Transcribe voice notes with whisper.cpp on this computer.
    pub voice_notes: bool,
    /// A whisper.cpp ggml model; empty finds one in ~/.local/share/whisper.
    pub whisper_model: String,
    /// Spoken language passed to whisper, or `auto`.
    pub voice_language: String,
    /// When answers also come as a voice note: `off`, `reply` (to voice
    /// notes) or `always`.
    pub voice_replies: String,
    /// A Piper `.onnx` voice; empty finds one in ~/.local/share/piper.
    pub piper_voice: String,
}

impl Default for TelegramConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            token: String::new(),
            allowed_user_ids: Vec::new(),
            cli: "claude".to_string(),
            profile: "readonly".to_string(),
            turn_timeout_secs: 600,
            reply_style: String::new(),
            address_as: Vec::new(),
            forward_notifications: false,
            remote_approvals: false,
            confirm_actions: true,
            allow_sudo: false,
            voice_notes: false,
            whisper_model: String::new(),
            voice_language: "auto".to_string(),
            voice_replies: "off".to_string(),
            piper_voice: String::new(),
        }
    }
}

impl TelegramConfig {
    /// Why a command from Telegram must not run, if it elevates privileges
    /// and settings do not allow that.
    pub fn sudo_block(&self, command: &str) -> Option<String> {
        if self.allow_sudo {
            return None;
        }
        super::privilege::elevation(command).map(|program| {
            format!(
                "Blocked: this command uses {program}. Commands with elevated privileges are off for Telegram; allow them in polakapi Settings → Telegram."
            )
        })
    }

    pub fn normalized(mut self) -> Self {
        let defaults = Self::default();
        self.token = self.token.trim().to_string();
        let mut seen = std::collections::HashSet::new();
        self.allowed_user_ids
            .retain(|id| *id > 0 && seen.insert(*id));
        if !HEADLESS_CLIS.contains(&self.cli.as_str()) {
            self.cli = defaults.cli;
        }
        if !PROFILES.contains(&self.profile.as_str()) {
            self.profile = defaults.profile;
        }
        self.turn_timeout_secs = self
            .turn_timeout_secs
            .clamp(MIN_TIMEOUT_SECS, MAX_TIMEOUT_SECS);
        self.reply_style = normalize_style(&self.reply_style);
        self.address_as = normalize_names(&self.address_as);
        self.whisper_model = self.whisper_model.trim().to_string();
        if !VOICE_LANGUAGES.contains(&self.voice_language.as_str()) {
            self.voice_language = defaults.voice_language;
        }
        if !super::speech::VOICE_REPLY_MODES.contains(&self.voice_replies.as_str()) {
            self.voice_replies = defaults.voice_replies;
        }
        self.piper_voice = self.piper_voice.trim().to_string();
        self
    }

    /// Why the bot must stay stopped, if anything.
    pub fn blocker(&self) -> Option<&'static str> {
        if !self.enabled {
            Some("disabled")
        } else if self.token.is_empty() {
            Some("no bot token")
        } else if self.allowed_user_ids.is_empty() {
            Some("no allowed user ids")
        } else {
            None
        }
    }

    pub fn view(&self) -> ConfigView {
        ConfigView {
            enabled: self.enabled,
            has_token: !self.token.is_empty(),
            token_hint: token_hint(&self.token),
            allowed_user_ids: self.allowed_user_ids.clone(),
            cli: self.cli.clone(),
            profile: self.profile.clone(),
            turn_timeout_secs: self.turn_timeout_secs,
            reply_style: self.reply_style.clone(),
            address_as: self.address_as.clone(),
            forward_notifications: self.forward_notifications,
            remote_approvals: self.remote_approvals,
            confirm_actions: self.confirm_actions,
            allow_sudo: self.allow_sudo,
            voice_notes: self.voice_notes,
            whisper_model: self.whisper_model.clone(),
            voice_language: self.voice_language.clone(),
            voice_replies: self.voice_replies.clone(),
            piper_voice: self.piper_voice.clone(),
        }
    }

    pub fn apply(&self, patch: ConfigPatch) -> Result<Self, String> {
        let mut next = self.clone();
        if let Some(token) = patch.token {
            let token = token.trim().to_string();
            if !token.is_empty() && !is_token_shaped(&token) {
                return Err(
                    "that does not look like a bot token (expected <digits>:<secret> from @BotFather)"
                        .to_string(),
                );
            }
            next.token = token;
        }
        if let Some(enabled) = patch.enabled {
            next.enabled = enabled;
        }
        if let Some(ids) = patch.allowed_user_ids {
            next.allowed_user_ids = ids;
        }
        if let Some(cli) = patch.cli {
            next.cli = cli;
        }
        if let Some(profile) = patch.profile {
            next.profile = profile;
        }
        if let Some(secs) = patch.turn_timeout_secs {
            next.turn_timeout_secs = secs;
        }
        if let Some(style) = patch.reply_style {
            next.reply_style = style;
        }
        if let Some(names) = patch.address_as {
            next.address_as = names;
        }
        if let Some(forward) = patch.forward_notifications {
            next.forward_notifications = forward;
        }
        if let Some(approvals) = patch.remote_approvals {
            next.remote_approvals = approvals;
        }
        if let Some(confirm) = patch.confirm_actions {
            next.confirm_actions = confirm;
        }
        if let Some(allow) = patch.allow_sudo {
            next.allow_sudo = allow;
        }
        if let Some(voice) = patch.voice_notes {
            next.voice_notes = voice;
        }
        if let Some(model) = patch.whisper_model {
            next.whisper_model = model;
        }
        if let Some(language) = patch.voice_language {
            next.voice_language = language;
        }
        if let Some(mode) = patch.voice_replies {
            next.voice_replies = mode;
        }
        if let Some(voice) = patch.piper_voice {
            next.piper_voice = voice;
        }
        Ok(next.normalized())
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigView {
    pub enabled: bool,
    pub has_token: bool,
    pub token_hint: String,
    pub allowed_user_ids: Vec<i64>,
    pub cli: String,
    pub profile: String,
    pub turn_timeout_secs: u64,
    pub reply_style: String,
    pub address_as: Vec<String>,
    pub forward_notifications: bool,
    pub remote_approvals: bool,
    pub confirm_actions: bool,
    pub allow_sudo: bool,
    pub voice_notes: bool,
    pub whisper_model: String,
    pub voice_language: String,
    pub voice_replies: String,
    pub piper_voice: String,
}

/// A partial update from the settings window. `token: Some("")` clears it.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigPatch {
    pub enabled: Option<bool>,
    pub token: Option<String>,
    pub allowed_user_ids: Option<Vec<i64>>,
    pub cli: Option<String>,
    pub profile: Option<String>,
    pub turn_timeout_secs: Option<u64>,
    pub reply_style: Option<String>,
    pub address_as: Option<Vec<String>>,
    pub forward_notifications: Option<bool>,
    pub remote_approvals: Option<bool>,
    pub confirm_actions: Option<bool>,
    pub allow_sudo: Option<bool>,
    pub voice_notes: Option<bool>,
    pub whisper_model: Option<String>,
    pub voice_language: Option<String>,
    pub voice_replies: Option<String>,
    pub piper_voice: Option<String>,
}

pub fn normalize_style(style: &str) -> String {
    style.trim().chars().take(MAX_STYLE_CHARS).collect()
}

fn normalize_names(names: &[String]) -> Vec<String> {
    let mut kept: Vec<String> = Vec::new();
    for name in names {
        let name: String = name.trim().chars().take(MAX_NAME_CHARS).collect();
        if !name.is_empty() && !kept.iter().any(|seen| seen.eq_ignore_ascii_case(&name)) {
            kept.push(name);
        }
    }
    kept.truncate(MAX_NAMES);
    kept
}

fn token_hint(token: &str) -> String {
    if token.is_empty() {
        return String::new();
    }
    let tail: String = token
        .chars()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    format!("••••{tail}")
}

pub fn is_token_shaped(token: &str) -> bool {
    let Some((id, secret)) = token.split_once(':') else {
        return false;
    };
    !id.is_empty()
        && id.chars().all(|c| c.is_ascii_digit())
        && secret.len() >= 20
        && secret
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BotState {
    /// Next `update_id` to ask for, so a restart does not replay messages.
    pub offset: i64,
    /// Keyed by chat id. A session only resumes with the CLI that made it.
    pub sessions: HashMap<String, Session>,
    /// `/style` overrides of the configured reply style, keyed by chat id.
    pub styles: HashMap<String, String>,
    /// The project each chat is working on, keyed by chat id.
    pub focus: HashMap<String, Focus>,
    /// The terminal (ptyId) each chat's `/sh` and `$ …` messages go to.
    pub terminal: HashMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Focus {
    pub id: String,
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub cli: String,
    pub id: String,
}

impl BotState {
    pub fn style_for<'a>(&'a self, chat_id: i64, default: &'a str) -> &'a str {
        self.styles
            .get(&chat_id.to_string())
            .map(String::as_str)
            .unwrap_or(default)
    }

    pub fn session_for(&self, chat_id: i64, cli: &str) -> Option<&str> {
        self.sessions
            .get(&chat_id.to_string())
            .filter(|session| session.cli == cli)
            .map(|session| session.id.as_str())
    }
}

pub fn load_json<T: for<'de> Deserialize<'de> + Default>(path: &Path) -> T {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

pub fn save_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let body = serde_json::to_string_pretty(value).map_err(|e| format!("serialize: {e}"))?;
    write_private(path, body.as_bytes())
}

/// Writes through a private temporary file in the same directory and renames
/// it into place, so a crash never leaves a half-written token behind.
pub fn write_private(path: &Path, body: &[u8]) -> Result<(), String> {
    let dir = path
        .parent()
        .ok_or_else(|| format!("{} has no parent directory", path.display()))?;
    std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let mut file = tempfile::Builder::new()
        .prefix(".telegram-")
        .tempfile_in(dir)
        .map_err(|e| format!("write {}: {e}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.as_file()
            .set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("write {}: {e}", path.display()))?;
    }
    file.write_all(body)
        .and_then(|_| file.flush())
        .map_err(|e| format!("write {}: {e}", path.display()))?;
    file.persist(path)
        .map(|_| ())
        .map_err(|e| format!("write {}: {}", path.display(), e.error))
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "123456:AAH-abcdefghijklmnopqrstu_vwxyz";

    #[test]
    fn empty_allowlist_or_token_keeps_the_bot_stopped() {
        let mut config = TelegramConfig {
            enabled: true,
            ..TelegramConfig::default()
        };
        assert_eq!(config.blocker(), Some("no bot token"));
        config.token = TOKEN.into();
        assert_eq!(config.blocker(), Some("no allowed user ids"));
        config.allowed_user_ids = vec![1];
        assert_eq!(config.blocker(), None);
        config.enabled = false;
        assert_eq!(config.blocker(), Some("disabled"));
    }

    #[test]
    fn normalizes_untrusted_values() {
        let config = TelegramConfig {
            allowed_user_ids: vec![5, -3, 0, 5, 9],
            cli: "gemini".into(),
            profile: "root".into(),
            turn_timeout_secs: 1,
            voice_language: "klingon".into(),
            address_as: vec![" Miguel ".into(), "".into(), "jefe".into(), "miguel".into()],
            ..TelegramConfig::default()
        }
        .normalized();
        assert_eq!(config.address_as, vec!["Miguel", "jefe"]);
        assert_eq!(config.voice_language, "auto");
        assert_eq!(config.allowed_user_ids, vec![5, 9]);
        assert_eq!(config.cli, "claude");
        assert_eq!(config.profile, "readonly");
        assert_eq!(config.turn_timeout_secs, 30);
    }

    #[test]
    fn view_hides_the_token() {
        let config = TelegramConfig {
            token: TOKEN.into(),
            ..TelegramConfig::default()
        };
        let view = serde_json::to_value(config.view()).unwrap();
        assert_eq!(view["tokenHint"], "••••wxyz");
        assert_eq!(view["hasToken"], true);
        assert!(!view.to_string().contains("AAH-"));
    }

    #[test]
    fn patch_validates_the_token_and_keeps_the_rest() {
        let base = TelegramConfig {
            token: TOKEN.into(),
            allowed_user_ids: vec![7],
            ..TelegramConfig::default()
        };
        assert!(base
            .apply(ConfigPatch {
                token: Some("not a token".into()),
                ..ConfigPatch::default()
            })
            .is_err());
        let next = base
            .apply(ConfigPatch {
                enabled: Some(true),
                ..ConfigPatch::default()
            })
            .unwrap();
        assert_eq!(next.token, TOKEN);
        assert_eq!(next.allowed_user_ids, vec![7]);
        let cleared = next
            .apply(ConfigPatch {
                token: Some(String::new()),
                ..ConfigPatch::default()
            })
            .unwrap();
        assert!(cleared.token.is_empty());
    }

    #[test]
    fn sessions_only_resume_with_the_same_cli() {
        let mut state = BotState::default();
        state.sessions.insert(
            "42".into(),
            Session {
                cli: "claude".into(),
                id: "s1".into(),
            },
        );
        assert_eq!(state.session_for(42, "claude"), Some("s1"));
        assert_eq!(state.session_for(42, "codex"), None);
        assert_eq!(state.session_for(43, "claude"), None);
    }

    #[test]
    fn chat_styles_override_the_default() {
        let mut state = BotState::default();
        assert_eq!(state.style_for(42, "brief"), "brief");
        state.styles.insert("42".into(), "formal".into());
        assert_eq!(state.style_for(42, "brief"), "formal");
        assert_eq!(state.style_for(43, "brief"), "brief");
        let long = "x".repeat(MAX_STYLE_CHARS + 50);
        assert_eq!(
            normalize_style(&format!("  {long} ")).len(),
            MAX_STYLE_CHARS
        );
    }

    #[test]
    fn sudo_is_blocked_until_settings_allow_it() {
        let mut config = TelegramConfig::default();
        assert!(config.sudo_block("git status").is_none());
        assert!(config
            .sudo_block("cd x && sudo ls")
            .unwrap()
            .contains("uses sudo"));
        config.allow_sudo = true;
        assert!(config.sudo_block("sudo ls").is_none());
    }

    #[test]
    fn private_files_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(CONFIG_FILE);
        let config = TelegramConfig {
            token: TOKEN.into(),
            ..TelegramConfig::default()
        };
        save_json(&path, &config).unwrap();
        assert_eq!(load_json::<TelegramConfig>(&path), config);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        assert_eq!(
            load_json::<TelegramConfig>(&dir.path().join("missing.json")),
            TelegramConfig::default()
        );
    }
}
