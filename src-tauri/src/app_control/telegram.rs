//! Telegram bot in front of the operator agent.
//!
//! - `actions`: tool calls from Telegram turns: project focus, held actions.
//! - `api`: the few Bot API methods the bot uses.
//! - `config`: settings, the bot's offset and sessions, private file writes.
//! - `bot`: long polling, allowlist and commands.
//! - `commands`: `/style`, `/notify` and `/approvals`.
//! - `terminals`: `/terminals`, `/terminal`, `/sh`, `$ …` and `/peek`.
//! - `queue`: per-chat workers that run turns in order.
//! - `overview`: the `/status` text.
//! - `files`: files from this computer sent to the chat.
//! - `format`: Markdown answers as Telegram HTML, terminal blocks.
//! - `privilege`: spots sudo and friends in a command line.
//! - `danger`: spots destructive commands.
//! - `delegate`: coding jobs handed to Claude in a project folder.
//! - `jobs`: `/jobs` and `/cancel`.
//! - `projects`: `/projects`, `/active` and project lookup.
//! - `notify`: agent notifications and permission buttons.
//! - `turn`: one headless CLI turn and its parsed answer.
//! - `voice`: voice notes transcribed locally with whisper.cpp.
//! - `speech`: answers read aloud locally with Piper.

pub mod actions;
pub mod api;
pub mod bot;
mod commands;
pub mod config;
mod danger;
mod delegate;
mod files;
mod format;
mod jobs;
mod notify;
mod overview;
pub mod privilege;
mod projects;
pub(crate) mod queue;
pub(crate) mod speech;
mod terminals;
pub mod turn;
pub(crate) mod voice;

use std::sync::Arc;

use tauri::{AppHandle, Emitter, State};

use self::api::Api;
use self::bot::{StatusView, TelegramService};
use self::config::{ConfigPatch, ConfigView};

const CONFIG_EVENT: &str = "telegram-config";

#[tauri::command]
pub fn telegram_config_get(service: State<'_, Arc<TelegramService>>) -> ConfigView {
    service.config().view()
}

/// Every window hears about the change, so the agent tab's microphone
/// follows the voice control switch.
#[tauri::command]
pub fn telegram_config_set(
    app: AppHandle,
    service: State<'_, Arc<TelegramService>>,
    patch: ConfigPatch,
) -> Result<ConfigView, String> {
    let next = service.config().apply(patch)?;
    service.save_config(next.clone())?;
    let view = next.view();
    let _ = app.emit(CONFIG_EVENT, &view);
    Ok(view)
}

/// Mirrors an agent notification the main window just delivered.
#[tauri::command]
pub async fn telegram_notify(
    service: State<'_, Arc<TelegramService>>,
    notice: notify::Notice,
) -> Result<bool, String> {
    service.inner().clone().notify(notice).await
}

#[tauri::command]
pub fn telegram_status(service: State<'_, Arc<TelegramService>>) -> StatusView {
    service.status()
}

/// Finds whisper-cli, ffmpeg and a model for voice notes, and Piper with a
/// voice when answers are spoken.
#[tauri::command]
pub fn telegram_voice_check(service: State<'_, Arc<TelegramService>>) -> Result<String, String> {
    let config = service.config();
    let whisper = voice::locate(&config)?.summary();
    if config.voice_replies == "off" {
        return Ok(whisper);
    }
    let speaker = speech::locate(&config)?.summary();
    Ok(format!("{whisper}; answers with {speaker}"))
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
