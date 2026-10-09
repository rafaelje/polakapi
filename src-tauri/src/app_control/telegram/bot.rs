use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Semaphore;

use super::actions::Actions;
use super::api::CallbackQuery;
use super::api::{Api, ApiError, Message};
use super::commands::{
    command_argument, focus_callback, list_projects, project_command, run_command, style_command,
    toggle_command,
};
use super::config::{
    load_json, save_json, BotState, TelegramConfig, AUDIT_FILE, CONFIG_FILE, STATE_FILE,
};
use super::notify::{handle_callback, Approvals};
use super::overview::format_overview;
use super::queue::{Chats, Enqueued, Incoming};
use super::terminals;
use super::turn::{self, TELEGRAM_MESSAGE_LIMIT};
use super::voice;
use crate::app_control::server::ControlServer;

// The bot lives inside the app and dies with the main window. One task long-
// polls Telegram; each chat gets a worker that runs its queued messages one at
// a time, and at most `MAX_PARALLEL_TURNS` turns run across all chats.

pub const STATUS_EVENT: &str = "telegram-status";
const MAX_PARALLEL_TURNS: usize = 2;
/// Messages older than this were sent while polakapi was closed. They are not
/// run: a command typed hours ago should not fire when the laptop opens.
const STALE_AFTER_SECS: i64 = 300;
const COMMANDS: &[(&str, &str)] = &[
    ("projects", "List every project"),
    ("active", "List projects with live terminals"),
    ("project", "Show or switch this chat's project"),
    ("run", "Run a shell command in this chat's project"),
    ("terminals", "List open terminals by folder"),
    ("terminal", "Pick the terminal /sh and $ commands go to"),
    (
        "sh",
        "Run a command in the chosen terminal (or start a message with $)",
    ),
    ("peek", "Show the last lines of the chosen terminal"),
    ("new", "Start a new conversation"),
    ("stop", "Cancel the running turn"),
    ("status", "Workspaces and projects, without the model"),
    ("style", "Show or set how the bot answers in this chat"),
    ("notify", "Agent notifications here: on or off"),
    (
        "approvals",
        "Permission buttons on notifications: on or off",
    ),
    (
        "confirm",
        "Ask before typing into terminals or running commands",
    ),
    ("help", "What this bot does"),
];

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusView {
    /// `stopped`, `starting`, `running` or `error`.
    pub state: String,
    pub detail: String,
    pub bot_username: Option<String>,
    /// Messages dropped because the sender is not on the allowlist.
    pub ignored: u64,
}

struct Paths {
    config: PathBuf,
    state: PathBuf,
    audit: PathBuf,
}

pub struct TelegramService {
    pub(super) app: AppHandle,
    paths: Paths,
    config: Mutex<TelegramConfig>,
    pub(super) state: Mutex<BotState>,
    status: Mutex<StatusView>,
    ignored: AtomicU64,
    runtime: Mutex<Option<Runtime>>,
    pub(super) approvals: Approvals,
    pub(super) actions: Actions,
}

struct Runtime {
    poller: JoinHandle<()>,
    chats: Arc<Chats>,
    api: Api,
}

pub(super) struct Ctx {
    pub(super) service: Arc<TelegramService>,
    pub(super) api: Api,
    pub(super) chats: Arc<Chats>,
    pub(super) turns: Semaphore,
}

impl TelegramService {
    pub fn new(app: &AppHandle) -> Result<Arc<Self>, String> {
        let dir = app
            .path()
            .app_data_dir()
            .map_err(|e| format!("could not resolve app_data_dir: {e}"))?;
        let paths = Paths {
            config: dir.join(CONFIG_FILE),
            state: dir.join(STATE_FILE),
            audit: dir.join(AUDIT_FILE),
        };
        let config = load_json::<TelegramConfig>(&paths.config).normalized();
        let state = load_json::<BotState>(&paths.state);
        Ok(Arc::new(Self {
            app: app.clone(),
            paths,
            config: Mutex::new(config),
            state: Mutex::new(state),
            status: Mutex::new(StatusView {
                state: "stopped".into(),
                ..StatusView::default()
            }),
            ignored: AtomicU64::new(0),
            runtime: Mutex::new(None),
            approvals: Approvals::default(),
            actions: Actions::default(),
        }))
    }

    pub fn config(&self) -> TelegramConfig {
        lock(&self.config).clone()
    }

    /// Only the token and the on/off switch need a new poller; everything else
    /// is read live, so changing it never cancels a running turn.
    pub fn save_config(self: &Arc<Self>, next: TelegramConfig) -> Result<(), String> {
        save_json(&self.paths.config, &next)?;
        let previous = std::mem::replace(&mut *lock(&self.config), next.clone());
        if previous.token != next.token
            || previous.enabled != next.enabled
            || previous.blocker() != next.blocker()
        {
            self.restart();
        }
        Ok(())
    }

    pub fn status(&self) -> StatusView {
        let mut view = lock(&self.status).clone();
        view.ignored = self.ignored.load(Ordering::Relaxed);
        view
    }

    fn set_status(&self, state: &str, detail: impl Into<String>, username: Option<String>) {
        let view = {
            let mut status = lock(&self.status);
            status.state = state.to_string();
            status.detail = detail.into();
            if username.is_some() || state == "stopped" {
                status.bot_username = username;
            }
            status.clone()
        };
        let _ = self.app.emit(STATUS_EVENT, self.with_ignored(view));
    }

    fn with_ignored(&self, mut view: StatusView) -> StatusView {
        view.ignored = self.ignored.load(Ordering::Relaxed);
        view
    }

    /// Stops whatever runs and starts again from the saved configuration.
    pub fn restart(self: &Arc<Self>) {
        self.stop();
        let config = self.config();
        if let Some(reason) = config.blocker() {
            self.set_status("stopped", reason, None);
            return;
        }
        let api = match Api::new(&config.token) {
            Ok(api) => api,
            Err(error) => {
                self.set_status("error", error.to_string(), None);
                return;
            }
        };
        let chats = Arc::new(Chats::default());
        let ctx = Arc::new(Ctx {
            service: self.clone(),
            api: api.clone(),
            chats: chats.clone(),
            turns: Semaphore::new(MAX_PARALLEL_TURNS),
        });
        self.set_status("starting", "", None);
        let poller = tauri::async_runtime::spawn(poll(ctx));
        *lock(&self.runtime) = Some(Runtime { poller, chats, api });
    }

    /// The running bot's client, if the bot is running.
    pub(super) fn api(&self) -> Option<Api> {
        lock(&self.runtime)
            .as_ref()
            .map(|runtime| runtime.api.clone())
    }

    pub fn stop(&self) {
        let Some(runtime) = lock(&self.runtime).take() else {
            return;
        };
        runtime.poller.abort();
        runtime.chats.abort_all();
        self.set_status("stopped", "", None);
    }

    pub(super) fn style(&self, chat_id: i64, default: &str) -> String {
        lock(&self.state).style_for(chat_id, default).to_string()
    }

    pub(super) fn session(&self, chat_id: i64, cli: &str) -> Option<String> {
        lock(&self.state)
            .session_for(chat_id, cli)
            .map(str::to_string)
    }

    pub(super) fn update_state(&self, change: impl FnOnce(&mut BotState)) {
        let mut state = lock(&self.state);
        change(&mut state);
        if let Err(error) = save_json(&self.paths.state, &*state) {
            eprintln!("polakapi: could not save telegram state: {error}");
        }
    }

    pub(super) fn audit(&self, entry: Value) {
        let mut options = std::fs::OpenOptions::new();
        options.create(true).append(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        if let Ok(mut file) = options.open(&self.paths.audit) {
            let _ = writeln!(file, "{entry}");
        }
    }

    pub(super) fn relay_overview(&self) -> Result<Value, String> {
        let server = self
            .app
            .try_state::<Arc<ControlServer>>()
            .ok_or_else(|| "the agent control server is not running".to_string())?;
        let result = server.relay(
            &self.app,
            "tools.call",
            json!({ "name": "polakapi_overview", "arguments": {}, "profile": "readonly" }),
        )?;
        let text = result.get("text").and_then(Value::as_str).unwrap_or("");
        if result.get("isError").and_then(Value::as_bool) == Some(true) {
            return Err(text.to_string());
        }
        serde_json::from_str(text).map_err(|e| format!("unexpected overview: {e}"))
    }
}

impl Ctx {
    pub(super) fn config(&self) -> TelegramConfig {
        self.service.config()
    }
}

async fn poll(ctx: Arc<Ctx>) {
    let service = &ctx.service;
    let username = loop {
        match ctx.api.get_me().await {
            Ok(me) => break me.username,
            Err(ApiError::Unauthorized) => {
                service.set_status("error", ApiError::Unauthorized.to_string(), None);
                return;
            }
            Err(error) => {
                service.set_status("error", format!("{error}; retrying"), None);
                tokio::time::sleep(Duration::from_secs(15)).await;
            }
        }
    };
    let _ = ctx.api.set_commands(COMMANDS).await;
    service.set_status("running", "", username.clone());

    let mut offset = lock(&service.state).offset;
    let mut backoff = 1;
    let mut healthy = true;
    loop {
        match ctx.api.get_updates(offset).await {
            Ok(updates) => {
                if !healthy {
                    service.set_status("running", "", username.clone());
                    healthy = true;
                }
                backoff = 1;
                let before = offset;
                for update in updates {
                    offset = offset.max(update.update_id + 1);
                    if let Some(message) = update.message {
                        handle(&ctx, message).await;
                    } else if let Some(press) = update.callback_query {
                        route_callback(&ctx, press).await;
                    }
                }
                if offset != before {
                    service.update_state(|state| state.offset = offset);
                }
            }
            Err(ApiError::Unauthorized) => {
                service.set_status("error", ApiError::Unauthorized.to_string(), None);
                return;
            }
            Err(ApiError::RetryAfter(secs)) => {
                tokio::time::sleep(Duration::from_secs(secs.max(1))).await;
            }
            Err(error) => {
                healthy = false;
                service.set_status("error", format!("{error}; retrying"), username.clone());
                let wait = if error == ApiError::Conflict {
                    30
                } else {
                    backoff
                };
                tokio::time::sleep(Duration::from_secs(wait)).await;
                backoff = (backoff * 2).min(60);
            }
        }
    }
}

async fn route_callback(ctx: &Arc<Ctx>, press: CallbackQuery) {
    match press.data.as_deref().unwrap_or("") {
        data if data.starts_with("act:") => super::actions::handle_callback(ctx, press).await,
        data if data.starts_with("focus:") => focus_callback(ctx, press).await,
        data if data.starts_with("term:") => terminals::select_callback(ctx, press).await,
        _ => handle_callback(ctx, press).await,
    }
}

/// Telegram ids, not usernames: a username can be changed or taken over.
fn is_allowed(config: &TelegramConfig, message: &Message) -> Option<i64> {
    if message.chat.kind != "private" {
        return None;
    }
    let user = message.from.as_ref()?;
    config
        .allowed_user_ids
        .contains(&user.id)
        .then_some(user.id)
}

async fn handle(ctx: &Arc<Ctx>, message: Message) {
    let config = ctx.config();
    let Some(user_id) = is_allowed(&config, &message) else {
        ctx.service.ignored.fetch_add(1, Ordering::Relaxed);
        let view = ctx.service.status();
        let _ = ctx.service.app.emit(STATUS_EVENT, view);
        return;
    };
    let chat_id = message.chat.id;
    if now_secs() - message.date > STALE_AFTER_SECS {
        let what = match message.text.as_deref() {
            Some(text) => format!("\"{}\"", preview(text.trim())),
            None => "a message".to_string(),
        };
        reply(
            ctx,
            chat_id,
            &format!("Skipped because polakapi was closed when you sent {what}. Send it again to run it."),
        )
        .await;
        return;
    }
    let Some(text) = voice::message_text(ctx, &config, &message).await else {
        return;
    };
    let text = text.as_str();
    let command = text.strip_prefix('/').map(|rest| {
        rest.split(|c: char| c.is_whitespace() || c == '@')
            .next()
            .unwrap_or("")
    });
    match command {
        Some("start") | Some("help") => {
            let help = format!(
                "polakapi operator bot. Messages go to {} with the {} tool profile.\n\n/projects and /active list projects, /project picks the one this chat works on, /run <command> runs a shell command there.\n/terminals lists open terminals by folder, /terminal picks one, then /sh <command> or a message starting with $ runs it there; /peek shows its screen.\n/new starts a new conversation, /stop cancels the running turn, /status shows workspaces.\n/style sets how answers are written, /notify and /approvals mirror agent alerts with permission buttons, /confirm on|off decides whether the agent asks before typing into terminals or running commands.",
                config.cli, config.profile
            );
            reply(ctx, chat_id, &help).await;
        }
        Some("projects") => list_projects(ctx, chat_id, false).await,
        Some("active") => list_projects(ctx, chat_id, true).await,
        Some("project") => project_command(ctx, chat_id, command_argument(text)).await,
        Some("run") => run_command(ctx, chat_id, command_argument(text)).await,
        Some("terminals") => terminals::list(ctx, chat_id).await,
        Some("terminal") => terminals::select(ctx, chat_id, command_argument(text)).await,
        Some("sh") => terminals::run(ctx, chat_id, command_argument(text)).await,
        Some("peek") => terminals::peek(ctx, chat_id, command_argument(text)).await,
        None if text.starts_with("$ ") || text == "$" => {
            terminals::run(ctx, chat_id, text.trim_start_matches('$').trim()).await
        }
        Some(name @ ("notify" | "approvals" | "confirm")) => {
            let answer = toggle_command(ctx, name, command_argument(text));
            reply(ctx, chat_id, &answer).await;
        }
        Some("style") => {
            let argument = command_argument(text);
            let answer = style_command(ctx, chat_id, argument);
            reply(ctx, chat_id, &answer).await;
        }
        Some("new") => {
            ctx.service.update_state(|state| {
                state.sessions.remove(&chat_id.to_string());
            });
            reply(
                ctx,
                chat_id,
                "New conversation. The next message starts fresh.",
            )
            .await;
        }
        Some("stop") => {
            let stopped = ctx.chats.stop(chat_id);
            reply(
                ctx,
                chat_id,
                if stopped {
                    "Stopped."
                } else {
                    "Nothing is running."
                },
            )
            .await;
        }
        Some("status") => {
            let service = ctx.service.clone();
            let overview = tauri::async_runtime::spawn_blocking(move || service.relay_overview())
                .await
                .map_err(|e| e.to_string())
                .and_then(|result| result);
            let text = match overview {
                Ok(value) => format_overview(&value),
                Err(error) => format!("Could not read polakapi: {error}"),
            };
            send_long(ctx, chat_id, &text).await;
        }
        _ => {
            let incoming = Incoming {
                user_id,
                name: message
                    .from
                    .as_ref()
                    .map(|user| user.first_name.clone())
                    .unwrap_or_default(),
                text: text.to_string(),
            };
            match ctx.chats.enqueue(ctx, chat_id, incoming) {
                Enqueued::Started => {}
                Enqueued::Queued(position) => {
                    reply(ctx, chat_id, &format!("Queued ({position} ahead).")).await;
                }
                Enqueued::Busy => {
                    reply(
                        ctx,
                        chat_id,
                        "Busy with earlier messages. Try again later or /stop.",
                    )
                    .await;
                }
            }
        }
    }
}

pub(super) async fn reply(ctx: &Ctx, chat_id: i64, text: &str) {
    if let Err(error) = ctx.api.send_message(chat_id, text).await {
        eprintln!("polakapi: telegram sendMessage failed: {error}");
    }
}

pub(super) async fn send_long(ctx: &Ctx, chat_id: i64, text: &str) {
    for chunk in turn::chunks(text, TELEGRAM_MESSAGE_LIMIT) {
        reply(ctx, chat_id, &chunk).await;
    }
}

fn preview(text: &str) -> String {
    let mut out: String = text.chars().take(80).collect();
    if text.chars().count() > 80 {
        out.push('…');
    }
    out
}

pub(super) fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub(super) fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_control::telegram::api::{Chat, User};

    fn message(chat_kind: &str, from: i64) -> Message {
        Message {
            chat: Chat {
                id: from,
                kind: chat_kind.into(),
            },
            from: Some(User {
                id: from,
                first_name: "Ana".into(),
                username: None,
            }),
            text: Some("hi".into()),
            date: now_secs(),
            voice: None,
            audio: None,
        }
    }

    #[test]
    fn only_allowed_users_in_private_chats_get_through() {
        let config = TelegramConfig {
            allowed_user_ids: vec![42],
            ..TelegramConfig::default()
        };
        assert_eq!(is_allowed(&config, &message("private", 42)), Some(42));
        assert_eq!(is_allowed(&config, &message("private", 7)), None);
        assert_eq!(is_allowed(&config, &message("group", 42)), None);
        let mut anonymous = message("private", 42);
        anonymous.from = None;
        assert_eq!(is_allowed(&config, &anonymous), None);
    }
}
