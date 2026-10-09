//! Telegram bot in front of the operator agent. See docs/telegram-bot-plan.md.
//!
//! - `api`: the few Bot API methods the bot uses.
//! - `config`: settings, the bot's offset and sessions, private file writes.
//! - `bot`: long polling, allowlist and commands.
//! - `queue`: per-chat workers that run turns in order.
//! - `overview`: the `/status` text.
//! - `turn`: one headless CLI turn and its parsed answer.

pub mod api;
pub mod bot;
pub mod config;
mod overview;
mod queue;
pub mod turn;

use std::sync::Arc;

use tauri::State;

use self::api::Api;
use self::bot::{StatusView, TelegramService};
use self::config::{ConfigPatch, ConfigView};

#[tauri::command]
pub fn telegram_config_get(service: State<'_, Arc<TelegramService>>) -> ConfigView {
    service.config().view()
}

#[tauri::command]
pub fn telegram_config_set(
    service: State<'_, Arc<TelegramService>>,
    patch: ConfigPatch,
) -> Result<ConfigView, String> {
    let next = service.config().apply(patch)?;
    service.save_config(next.clone())?;
    Ok(next.view())
}

#[tauri::command]
pub fn telegram_status(service: State<'_, Arc<TelegramService>>) -> StatusView {
    service.status()
}

/// Checks a token with `getMe`. Without one, checks the saved token.
#[tauri::command]
pub async fn telegram_test(
    service: State<'_, Arc<TelegramService>>,
    token: Option<String>,
) -> Result<String, String> {
    let token = token
        .map(|token| token.trim().to_string())
        .filter(|token| !token.is_empty())
        .unwrap_or_else(|| service.config().token);
    if token.is_empty() {
        return Err("no bot token saved".to_string());
    }
    if !config::is_token_shaped(&token) {
        return Err("that does not look like a bot token".to_string());
    }
    let me = Api::new(&token)
        .map_err(|e| e.to_string())?
        .get_me()
        .await
        .map_err(|e| e.to_string())?;
    Ok(me
        .username
        .map(|name| format!("@{name}"))
        .unwrap_or_else(|| me.first_name))
}
