use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::json;
use tauri::Manager;

use super::api::{Api, CallbackQuery};
use super::bot::{lock, Ctx, TelegramService};
use super::turn::{chunks, TELEGRAM_MESSAGE_LIMIT};
use crate::app_control::server::ControlServer;

// Agent notifications mirrored to Telegram. The main window decides when a
// notification fires, exactly as for the desktop; this module only delivers
// it. Permission notifications can carry Allow / Always / Deny buttons; a press
// is relayed to the main window, which checks the pane still shows the prompt
// before it types the answer.

const APPROVAL_TTL: Duration = Duration::from_secs(15 * 60);
const MAX_PENDING: usize = 50;
const PROMPT_LIMIT: usize = 3000;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Notice {
    /// `permission`, `finished` or `waiting`.
    pub kind: String,
    pub title: String,
    pub body: String,
    #[serde(default)]
    pub pty_id: Option<String>,
    /// What the pane shows around the permission question, if it was found.
    #[serde(default)]
    pub prompt: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Choice {
    Allow,
    Always,
    Deny,
}

impl Choice {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "allow" => Some(Self::Allow),
            "always" => Some(Self::Always),
            "deny" => Some(Self::Deny),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Allow => "allow",
            Self::Always => "always",
            Self::Deny => "deny",
        }
    }

    fn outcome(self) -> &'static str {
        match self {
            Self::Allow => "Allowed from Telegram.",
            Self::Always => "Allowed from Telegram, without asking again.",
            Self::Deny => "Denied from Telegram.",
        }
    }
}

#[derive(Default)]
pub struct Approvals {
    next: AtomicU64,
    pending: Mutex<HashMap<u64, (String, Instant)>>,
}

impl Approvals {
    fn register(&self, pty_id: &str) -> u64 {
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let mut pending = lock(&self.pending);
        pending.retain(|_, (_, at)| at.elapsed() < APPROVAL_TTL);
        if pending.len() >= MAX_PENDING {
            if let Some(oldest) = pending
                .iter()
                .min_by_key(|(_, (_, at))| *at)
                .map(|(k, _)| *k)
            {
                pending.remove(&oldest);
            }
        }
        pending.insert(id, (pty_id.to_string(), Instant::now()));
        id
    }

    /// One answer per prompt: the entry is gone after the first press.
    fn take(&self, id: u64) -> Option<String> {
        let (pty_id, at) = lock(&self.pending).remove(&id)?;
        (at.elapsed() < APPROVAL_TTL).then_some(pty_id)
    }
}

pub fn parse_callback(data: &str) -> Option<(u64, Choice)> {
    let mut parts = data.split(':');
    if parts.next()? != "perm" {
        return None;
    }
    let id = parts.next()?.parse().ok()?;
    let choice = Choice::parse(parts.next()?)?;
    parts.next().is_none().then_some((id, choice))
}

pub fn format_notice(notice: &Notice) -> String {
    let icon = match notice.kind.as_str() {
        "permission" => "🔐",
        "finished" => "✅",
        "waiting" => "⏳",
        _ => "🔔",
    };
    let mut text = format!("{icon} {}\n{}", notice.title, notice.body);
    if let Some(prompt) = notice
        .prompt
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty())
    {
        let prompt: String = prompt.chars().take(PROMPT_LIMIT).collect();
        text.push_str("\n\n");
        text.push_str(&prompt);
    }
    text
}

impl TelegramService {
    /// Delivers one notification to every allowed user. Returns whether it was
    /// sent, so the caller can tell "forwarding is off" from a failure.
    pub async fn notify(self: &Arc<Self>, notice: Notice) -> Result<bool, String> {
        let config = self.config();
        if !config.forward_notifications {
            return Ok(false);
        }
        let Some(api) = self.api() else {
            return Ok(false);
        };
        let text = format_notice(&notice);
        let approval = match (&notice.pty_id, notice.kind.as_str()) {
            (Some(pty_id), "permission") if config.remote_approvals && notice.prompt.is_some() => {
                Some(self.approvals.register(pty_id))
            }
            _ => None,
        };
        let mut errors = Vec::new();
        for chat_id in &config.allowed_user_ids {
            let sent = match approval {
                Some(id) => send_approval(&api, *chat_id, &text, id).await,
                None => send_plain(&api, *chat_id, &text).await,
            };
            if let Err(error) = sent {
                errors.push(error.to_string());
            }
        }
        match errors.first() {
            Some(error) if errors.len() == config.allowed_user_ids.len() => Err(error.clone()),
            _ => Ok(true),
        }
    }

    fn respond(&self, pty_id: &str, choice: Choice) -> Result<(), String> {
        let server = self
            .app
            .try_state::<Arc<ControlServer>>()
            .ok_or_else(|| "the agent control server is not running".to_string())?;
        server
            .relay(
                &self.app,
                "permission.respond",
                json!({ "ptyId": pty_id, "choice": choice.as_str() }),
            )
            .map(|_| ())
    }
}

async fn send_plain(api: &Api, chat_id: i64, text: &str) -> Result<(), super::api::ApiError> {
    for chunk in chunks(text, TELEGRAM_MESSAGE_LIMIT) {
        api.send_message(chat_id, &chunk).await?;
    }
    Ok(())
}

async fn send_approval(
    api: &Api,
    chat_id: i64,
    text: &str,
    id: u64,
) -> Result<(), super::api::ApiError> {
    let text: String = text.chars().take(TELEGRAM_MESSAGE_LIMIT - 100).collect();
    api.send_with_buttons(
        chat_id,
        &text,
        &[
            ("✅ Allow", format!("perm:{id}:allow")),
            ("♾ Always", format!("perm:{id}:always")),
            ("❌ Deny", format!("perm:{id}:deny")),
        ],
    )
    .await
}

pub(super) async fn handle_callback(ctx: &Arc<Ctx>, press: CallbackQuery) {
    let config = ctx.config();
    let toast = if !config.allowed_user_ids.contains(&press.from.id) {
        "Not allowed.".to_string()
    } else if !config.remote_approvals {
        "Approvals from Telegram are off. Turn them on with /approvals on.".to_string()
    } else {
        match press.data.as_deref().and_then(parse_callback) {
            None => "Unknown button.".to_string(),
            Some((id, choice)) => match ctx.service.approvals.take(id) {
                None => "This prompt was already answered or expired.".to_string(),
                Some(pty_id) => {
                    let service = ctx.service.clone();
                    let result = tauri::async_runtime::spawn_blocking(move || {
                        service.respond(&pty_id, choice)
                    })
                    .await
                    .map_err(|e| e.to_string())
                    .and_then(|result| result);
                    let outcome = match &result {
                        Ok(()) => choice.outcome().to_string(),
                        Err(error) => format!("Not sent: {error}"),
                    };
                    if let Some(message) = &press.message {
                        let original = message.text.clone().unwrap_or_default();
                        let _ = ctx
                            .api
                            .edit_text(
                                message.chat.id,
                                message.message_id,
                                &format!("{original}\n\n→ {outcome}"),
                            )
                            .await;
                    }
                    outcome
                }
            },
        }
    };
    let short: String = toast.chars().take(190).collect();
    let _ = ctx.api.answer_callback(&press.id, &short).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_only_well_formed_callbacks() {
        assert_eq!(parse_callback("perm:7:allow"), Some((7, Choice::Allow)));
        assert_eq!(parse_callback("perm:7:always"), Some((7, Choice::Always)));
        assert_eq!(parse_callback("perm:7:deny"), Some((7, Choice::Deny)));
        assert_eq!(parse_callback("perm:7:root"), None);
        assert_eq!(parse_callback("perm:x:allow"), None);
        assert_eq!(parse_callback("perm:7:allow:extra"), None);
        assert_eq!(parse_callback("other:7:allow"), None);
    }

    #[test]
    fn approvals_answer_once() {
        let approvals = Approvals::default();
        let id = approvals.register("pty-1");
        assert_eq!(approvals.take(id).as_deref(), Some("pty-1"));
        assert_eq!(approvals.take(id), None);
        assert_eq!(approvals.take(999), None);
    }

    #[test]
    fn pending_approvals_are_bounded() {
        let approvals = Approvals::default();
        let first = approvals.register("first");
        for i in 0..MAX_PENDING {
            approvals.register(&format!("pty-{i}"));
        }
        assert_eq!(approvals.take(first), None);
        assert_eq!(lock(&approvals.pending).len(), MAX_PENDING);
    }

    #[test]
    fn notice_text_includes_the_prompt() {
        let notice = Notice {
            kind: "permission".into(),
            title: "polakapi · claude".into(),
            body: "Agent needs permission".into(),
            pty_id: Some("p".into()),
            prompt: Some("Bash command\n  git push\nDo you want to proceed?".into()),
        };
        assert_eq!(
            format_notice(&notice),
            "🔐 polakapi · claude\nAgent needs permission\n\nBash command\n  git push\nDo you want to proceed?"
        );
    }
}
