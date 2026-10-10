use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use super::api::CallbackQuery;
use super::bot::{lock, Ctx, TelegramService};
use super::danger;
use super::format::{send_rich, terminal_block};
use super::projects;
use crate::app_control::server::ControlServer;

// Tool calls from a Telegram turn pass through here before they reach the
// main window. Three things happen:
// - the chat's project is filled in when the model leaves `project` out;
// - `polakapi_chat_focus`, a tool only Telegram turns see, changes that project;
// - typing into a terminal or running a command is held until the user taps
//   Run or Cancel in the chat, when "Ask before acting" is on, and always
//   when the command is destructive.

pub const FOCUS_TOOL: &str = "polakapi_chat_focus";
const SEND_TOOL: &str = "polakapi_send_to_terminal";
pub(super) const RUN_TOOL: &str = "polakapi_run_command";
pub(super) const TERMINAL_TOOL: &str = "polakapi_run_in_terminal";
const HELD_TOOLS: &[&str] = &[SEND_TOOL, RUN_TOOL, TERMINAL_TOOL];
const FOCUSED_TOOLS: &[&str] = &[
    RUN_TOOL,
    "polakapi_project_status",
    "polakapi_open_terminal",
];
const ACTION_TTL: Duration = Duration::from_secs(15 * 60);
const MAX_PENDING: usize = 50;
const HELD_REPLY: &str = "Held: polakapi asked the user to confirm this in Telegram with buttons, and will report the result there itself. Tell the user it is waiting for their tap. Do not retry it and do not ask for confirmation in your own words.";

struct Pending {
    chat_id: i64,
    name: String,
    arguments: Value,
    at: Instant,
}

#[derive(Default)]
pub struct Actions {
    next: AtomicU64,
    pending: Mutex<HashMap<u64, Pending>>,
}

impl Actions {
    fn register(&self, pending: Pending) -> u64 {
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let mut map = lock(&self.pending);
        map.retain(|_, held| held.at.elapsed() < ACTION_TTL);
        if map.len() >= MAX_PENDING {
            if let Some(oldest) = map.iter().min_by_key(|(_, held)| held.at).map(|(k, _)| *k) {
                map.remove(&oldest);
            }
        }
        map.insert(id, pending);
        id
    }

    /// One answer per action, only from the chat it was asked in.
    fn take(&self, id: u64, chat_id: i64) -> Option<Pending> {
        let mut map = lock(&self.pending);
        if map.get(&id)?.chat_id != chat_id {
            return None;
        }
        map.remove(&id)
            .filter(|held| held.at.elapsed() < ACTION_TTL)
    }
}

pub fn chat_of(params: &Value) -> Option<i64> {
    params
        .get("origin")
        .and_then(Value::as_str)?
        .strip_prefix("telegram:")?
        .parse()
        .ok()
}

pub fn focus_tool() -> Value {
    json!({
        "name": FOCUS_TOOL,
        "description": "Set the project this Telegram chat works on. Call it as soon as the user starts talking about a different project; later tool calls default to it.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "project": { "type": "string", "description": "Project id, name or path." }
            },
            "required": ["project"],
            "additionalProperties": false
        }
    })
}

fn tool_text(text: impl Into<String>, is_error: bool) -> Value {
    json!({ "text": text.into(), "isError": is_error })
}

/// `None` lets the request through untouched.
pub fn intercept(
    server: &ControlServer,
    app: &AppHandle,
    method: &str,
    params: &Value,
) -> Option<Result<Value, String>> {
    let chat_id = chat_of(params)?;
    let service = app.try_state::<Arc<TelegramService>>()?;
    if method == "tools.list" {
        return Some(server.relay(app, method, params.clone()).map(|mut result| {
            if let Some(tools) = result.get_mut("tools").and_then(Value::as_array_mut) {
                tools.push(focus_tool());
            }
            result
        }));
    }
    if method != "tools.call" {
        return None;
    }
    let name = params.get("name").and_then(Value::as_str)?.to_string();
    let mut arguments = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    if name == FOCUS_TOOL {
        let query = arguments
            .get("project")
            .and_then(Value::as_str)
            .unwrap_or("");
        return Some(Ok(match service.set_focus(server, app, chat_id, query) {
            Ok(focus) => tool_text(
                format!("This chat now works on {} ({}).", focus.name, focus.path),
                false,
            ),
            Err(error) => tool_text(error, true),
        }));
    }
    let mut changed = false;
    if FOCUSED_TOOLS.contains(&name.as_str()) && arguments.get("project").is_none() {
        if let (Some(focus), Some(object)) = (service.focus(chat_id), arguments.as_object_mut()) {
            object.insert("project".into(), Value::String(focus.id));
            changed = true;
        }
    }
    let config = service.config();
    let command = command_of(server, app, &name, &arguments);
    if let Some(reason) = command
        .as_deref()
        .and_then(|command| config.sudo_block(command))
    {
        return Some(Ok(tool_text(
            format!("{reason} Tell the user; do not try another way."),
            true,
        )));
    }
    let danger = command.as_deref().and_then(danger::assess);
    let full = params.get("profile").and_then(Value::as_str) == Some("full");
    if HELD_TOOLS.contains(&name.as_str()) && full && (config.confirm_actions || danger.is_some()) {
        let label = warn(danger.as_deref(), describe(server, app, &name, &arguments));
        let sent = service.api().map(|api| {
            tauri::async_runtime::block_on(ask(
                &service.actions,
                &api,
                chat_id,
                &label,
                name,
                arguments,
            ))
        });
        return Some(Ok(match sent {
            Some(Ok(())) => tool_text(HELD_REPLY, false),
            Some(Err(error)) => tool_text(format!("could not ask the user: {error}"), true),
            None => tool_text("the Telegram bot is not running", true),
        }));
    }
    if !changed {
        return None;
    }
    let mut params = params.clone();
    params["arguments"] = arguments;
    Some(server.relay(app, method, params))
}

pub(super) fn warn(danger: Option<&str>, label: String) -> String {
    match danger {
        Some(reason) => format!("⚠️ Destructive: this {reason}.\n\n{label}"),
        None => label,
    }
}

/// Holds a tool call and asks the chat with Run / Cancel buttons.
async fn ask(
    actions: &Actions,
    api: &super::api::Api,
    chat_id: i64,
    label: &str,
    name: String,
    arguments: Value,
) -> Result<(), super::api::ApiError> {
    let id = actions.register(Pending {
        chat_id,
        name,
        arguments,
        at: Instant::now(),
    });
    api.send_with_buttons(
        chat_id,
        label,
        &[
            ("▶ Run", format!("act:{id}:yes")),
            ("✖ Cancel", format!("act:{id}:no")),
        ],
    )
    .await
}

/// Holds a command the user typed in the chat when it is destructive, and
/// returns whether it did; the buttons then run it.
pub(super) async fn hold_if_destructive(
    ctx: &Ctx,
    chat_id: i64,
    command: &str,
    label: String,
    name: &str,
    arguments: Value,
) -> bool {
    let Some(reason) = danger::assess(command) else {
        return false;
    };
    let label = warn(Some(&reason), label);
    let asked = ask(
        &ctx.service.actions,
        &ctx.api,
        chat_id,
        &label,
        name.to_string(),
        arguments,
    )
    .await;
    if let Err(error) = asked {
        super::bot::reply(
            ctx,
            chat_id,
            &format!("Not run: could not ask you to confirm ({error})."),
        )
        .await;
    }
    true
}

/// The shell command a tool call would run. Text sent to an AI CLI pane is a
/// prompt, not a command, so it is not checked here.
fn command_of(
    server: &ControlServer,
    app: &AppHandle,
    name: &str,
    arguments: &Value,
) -> Option<String> {
    let arg = |key: &str| {
        arguments
            .get(key)
            .and_then(Value::as_str)
            .map(str::to_string)
    };
    match name {
        RUN_TOOL | TERMINAL_TOOL => arg("command"),
        SEND_TOOL => {
            let pty_id = arg("ptyId").unwrap_or_default();
            let ai_pane = terminal_rows(server, app)
                .iter()
                .find(|row| row.get("ptyId").and_then(Value::as_str) == Some(pty_id.as_str()))
                .and_then(|row| row.get("cli").and_then(Value::as_str))
                .is_some_and(|cli| cli != "shell");
            if ai_pane {
                None
            } else {
                arg("text")
            }
        }
        _ => None,
    }
}

fn terminal_rows(server: &ControlServer, app: &AppHandle) -> Vec<Value> {
    call_tool(server, app, "polakapi_terminals", json!({}))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default()
}

fn describe(server: &ControlServer, app: &AppHandle, name: &str, arguments: &Value) -> String {
    let arg = |key: &str| arguments.get(key).and_then(Value::as_str).unwrap_or("");
    if name == TERMINAL_TOOL {
        let target = terminal_rows(server, app)
            .into_iter()
            .find(|row| row.get("ptyId").and_then(Value::as_str) == Some(arg("ptyId")))
            .map(|row| {
                format!(
                    "{} · {}",
                    row.pointer("/project/name")
                        .and_then(Value::as_str)
                        .unwrap_or("?"),
                    row.get("cwd").and_then(Value::as_str).unwrap_or("?")
                )
            })
            .unwrap_or_else(|| format!("terminal {}", arg("ptyId")));
        return format!("⌨ Run in {target}?\n\n$ {}", arg("command"));
    }
    if name == RUN_TOOL {
        let project = project_name(server, app, arg("project"));
        return format!("▶ Run in {project}?\n\n$ {}", arg("command"));
    }
    let target = pane_label(server, app, arg("ptyId"));
    let enter = if arguments.get("submit").and_then(Value::as_bool) == Some(true) {
        "and press Enter"
    } else {
        "without pressing Enter"
    };
    format!("📨 Send to {target} ({enter})?\n\n{}", arg("text"))
}

/// A tool call from the bot itself (not from a model turn), off the async
/// runtime because the relay blocks.
pub(super) async fn tool(ctx: &Ctx, name: &str, arguments: Value) -> Result<String, String> {
    let app = ctx.service.app.clone();
    let name = name.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let server = app
            .try_state::<Arc<ControlServer>>()
            .ok_or_else(|| "the agent control server is not running".to_string())?;
        call_tool(&server, &app, &name, arguments)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn call_tool(
    server: &ControlServer,
    app: &AppHandle,
    name: &str,
    arguments: Value,
) -> Result<String, String> {
    let result = server.relay(
        app,
        "tools.call",
        json!({ "name": name, "arguments": arguments, "profile": "full" }),
    )?;
    let text = result
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if result.get("isError").and_then(Value::as_bool) == Some(true) {
        Err(text)
    } else {
        Ok(text)
    }
}

fn project_name(server: &ControlServer, app: &AppHandle, query: &str) -> String {
    call_tool(server, app, "polakapi_overview", json!({}))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|overview| {
            let rows = projects::rows(&overview);
            projects::find(&rows, query)
                .ok()
                .map(|row| row.name.clone())
        })
        .unwrap_or_else(|| {
            if query.is_empty() {
                "the selected project".to_string()
            } else {
                query.to_string()
            }
        })
}

fn pane_label(server: &ControlServer, app: &AppHandle, pty_id: &str) -> String {
    let panes = call_tool(server, app, "polakapi_agents_status", json!({}))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .unwrap_or(Value::Null);
    panes
        .as_array()
        .into_iter()
        .flatten()
        .find(|pane| pane.get("ptyId").and_then(Value::as_str) == Some(pty_id))
        .and_then(|pane| {
            Some(format!(
                "{} · {}",
                pane.pointer("/project/name")?.as_str()?,
                pane.get("cli")?.as_str()?
            ))
        })
        .unwrap_or_else(|| format!("terminal {pty_id}"))
}

impl TelegramService {
    pub(super) fn focus(&self, chat_id: i64) -> Option<super::config::Focus> {
        lock(&self.state).focus.get(&chat_id.to_string()).cloned()
    }

    pub(super) fn set_focus(
        &self,
        server: &ControlServer,
        app: &AppHandle,
        chat_id: i64,
        query: &str,
    ) -> Result<super::config::Focus, String> {
        let overview: Value =
            serde_json::from_str(&call_tool(server, app, "polakapi_overview", json!({}))?)
                .map_err(|e| format!("unexpected overview: {e}"))?;
        let rows = projects::rows(&overview);
        let focus = projects::find(&rows, query)?.focus();
        self.update_state(|state| {
            state.focus.insert(chat_id.to_string(), focus.clone());
        });
        Ok(focus)
    }

    pub(super) fn clear_focus(&self, chat_id: i64) {
        self.update_state(|state| {
            state.focus.remove(&chat_id.to_string());
        });
    }
}

pub fn parse_callback(data: &str) -> Option<(u64, bool)> {
    let rest = data.strip_prefix("act:")?;
    let (id, answer) = rest.split_once(':')?;
    let run = match answer {
        "yes" => true,
        "no" => false,
        _ => return None,
    };
    Some((id.parse().ok()?, run))
}

pub(super) async fn handle_callback(ctx: &Arc<Ctx>, press: CallbackQuery) {
    let Some(message) = press.message.clone() else {
        return;
    };
    let chat_id = message.chat.id;
    let original = message.text.clone().unwrap_or_default();
    let held = press
        .data
        .as_deref()
        .and_then(parse_callback)
        .filter(|_| ctx.config().allowed_user_ids.contains(&press.from.id))
        .and_then(|(id, run)| {
            ctx.service
                .actions
                .take(id, chat_id)
                .map(|held| (held, run))
        });
    let Some((held, run)) = held else {
        let _ = ctx
            .api
            .answer_callback(&press.id, "This was already answered or expired.")
            .await;
        return;
    };
    if !run {
        let _ = ctx.api.answer_callback(&press.id, "Cancelled.").await;
        let _ = ctx
            .api
            .edit_text(
                chat_id,
                message.message_id,
                &format!("{original}\n\n→ Cancelled."),
            )
            .await;
        return;
    }
    let _ = ctx.api.answer_callback(&press.id, "Running…").await;
    let app = ctx.service.app.clone();
    let name = held.name.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let server = app
            .try_state::<Arc<ControlServer>>()
            .ok_or_else(|| "the agent control server is not running".to_string())?;
        call_tool(&server, &app, &held.name, held.arguments)
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|result| result);
    let shows_output = name == RUN_TOOL || name == TERMINAL_TOOL;
    let outcome = match &result {
        Ok(_) if shows_output => "→ Ran.".to_string(),
        Ok(_) => "→ Sent.".to_string(),
        Err(error) => format!("→ Failed: {error}"),
    };
    let _ = ctx
        .api
        .edit_text(
            chat_id,
            message.message_id,
            &format!("{original}\n\n{outcome}"),
        )
        .await;
    if let (Ok(transcript), true) = (&result, shows_output) {
        let _ = send_rich(&ctx.api, chat_id, &terminal_block(transcript)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_chat_from_the_origin() {
        assert_eq!(chat_of(&json!({ "origin": "telegram:42" })), Some(42));
        assert_eq!(chat_of(&json!({ "origin": "tab" })), None);
        assert_eq!(chat_of(&json!({ "origin": null })), None);
        assert_eq!(chat_of(&json!({})), None);
    }

    #[test]
    fn parses_action_buttons() {
        assert_eq!(parse_callback("act:3:yes"), Some((3, true)));
        assert_eq!(parse_callback("act:3:no"), Some((3, false)));
        assert_eq!(parse_callback("act:3:maybe"), None);
        assert_eq!(parse_callback("perm:3:allow"), None);
    }

    #[test]
    fn actions_answer_once_and_only_in_their_chat() {
        let actions = Actions::default();
        let held = || Pending {
            chat_id: 42,
            name: RUN_TOOL.into(),
            arguments: json!({ "command": "git status" }),
            at: Instant::now(),
        };
        let id = actions.register(held());
        assert!(actions.take(id, 7).is_none());
        assert_eq!(actions.take(id, 42).unwrap().name, RUN_TOOL);
        assert!(actions.take(id, 42).is_none());
    }

    #[test]
    fn the_focus_tool_has_a_valid_schema() {
        let tool = focus_tool();
        assert_eq!(tool["name"], FOCUS_TOOL);
        assert_eq!(tool["inputSchema"]["required"][0], "project");
    }
}
