use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Manager};

use super::actions::{self, tool_text};
use super::api::{Api, CallbackQuery};
use super::bot::{lock, now_secs, Ctx, TelegramService};
use super::config::{Focus, Session};
use super::danger;
use super::format::send_rich;
use super::privilege::{program, walk};
use super::queue::looks_like_lost_session;
use super::speech;
use super::turn::{self, TurnOutput};
use crate::app_control::home::{self, APPROVE_TOOL};
use crate::app_control::server::ControlServer;

// Jobs: coding tasks the operator agent hands to Claude (`claude -p`) in a
// project folder instead of running commands itself. A job runs in the
// background and posts its result to the chat when it ends. File edits are
// accepted; anything else that needs permission comes to the chat as
// Allow / Deny buttons through `polakapi_approve`, with the sudo block and the
// destructive-command warning applied. One job per project at a time.

pub const DELEGATE_TOOL: &str = "polakapi_delegate";
pub const DELEGATE_PROFILE: &str = "delegate";
const JOB_TIMEOUT: Duration = Duration::from_secs(60 * 60);
const APPROVAL_TIMEOUT: Duration = Duration::from_secs(30 * 60);
/// Claude Code's own limit on an MCP tool call, in milliseconds: longer than
/// the wait for the user's tap.
const MCP_TOOL_TIMEOUT_MS: &str = "1900000";

pub(super) struct Job {
    pub(super) chat_id: i64,
    pub(super) project: Focus,
    pub(super) task: String,
    pub(super) started: Instant,
    pub(super) handle: JoinHandle<()>,
    /// Programs the user allowed for the rest of the job.
    allowed: HashSet<String>,
}

enum Decision {
    Allow,
    AllowPrograms,
    Deny,
}

struct Asking {
    chat_id: i64,
    job_id: u64,
    programs: Vec<String>,
    answer: mpsc::Sender<Decision>,
}

#[derive(Default)]
pub struct Jobs {
    next: AtomicU64,
    pub(super) running: std::sync::Mutex<HashMap<u64, Job>>,
    next_ask: AtomicU64,
    asking: std::sync::Mutex<HashMap<u64, Asking>>,
}

impl Jobs {
    pub fn abort_all(&self) {
        for (_, job) in lock(&self.running).drain() {
            job.handle.abort();
        }
        lock(&self.asking).clear();
    }

    /// Unanswered permissions of a job that ended are denied.
    pub(super) fn forget(&self, job_id: u64) {
        lock(&self.asking).retain(|_, asking| asking.job_id != job_id);
    }
}

pub fn delegate_tool() -> Value {
    json!({
        "name": DELEGATE_TOOL,
        "description": "Hand a coding task in a project to Claude Code, which works in the project's folder with its own file and shell tools. Use it for any work inside a repository (fix, implement, review, investigate, refactor, run the tests and fix them...). It runs in the background: polakapi posts the result to the chat when it ends and asks the user in Telegram before Claude runs commands. Follow-ups in the same project continue the same Claude conversation unless `fresh` is true.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "project": { "type": "string", "description": "Project id, name or path. Defaults to the chat's project." },
                "task": { "type": "string", "description": "What Claude should do, complete and self-contained, in the user's language." },
                "fresh": { "type": "boolean", "description": "Start a new Claude conversation instead of continuing the last one in this project." }
            },
            "required": ["task"],
            "additionalProperties": false
        }
    })
}

fn approve_tool() -> Value {
    json!({
        "name": APPROVE_TOOL,
        "description": "Asks the user in Telegram whether a tool may run.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "tool_name": { "type": "string" },
                "input": { "type": "object" },
                "tool_use_id": { "type": "string" }
            },
            "required": ["tool_name", "input"]
        }
    })
}

pub fn job_of(params: &Value) -> Option<u64> {
    params
        .get("origin")
        .and_then(Value::as_str)?
        .split_once(":job:")?
        .1
        .parse()
        .ok()
}

/// Requests from a delegated Claude's MCP server.
pub fn serve(service: &TelegramService, method: &str, params: &Value) -> Result<Value, String> {
    match method {
        "tools.list" => Ok(json!({ "tools": [approve_tool()] })),
        "tools.call" if params.get("name").and_then(Value::as_str) == Some(APPROVE_TOOL) => {
            let chat_id = actions::chat_of(params).ok_or("no chat")?;
            let job_id = job_of(params).ok_or("no job")?;
            let arguments = params.get("arguments").cloned().unwrap_or(Value::Null);
            Ok(tool_text(
                approve(service, chat_id, job_id, &arguments).to_string(),
                false,
            ))
        }
        _ => Err(format!("{method} is not available to delegated jobs")),
    }
}

fn allow(input: &Value) -> Value {
    json!({ "behavior": "allow", "updatedInput": input })
}

fn deny(message: &str) -> Value {
    json!({ "behavior": "deny", "message": message })
}

/// Every program a shell command line would run.
fn programs_of(command: &str) -> Vec<String> {
    let mut found = Vec::new();
    walk(command, &mut |words| {
        if let Some((name, _)) = program(words) {
            if !found.contains(&name) {
                found.push(name);
            }
        }
        None
    });
    found
}

fn short(value: &Value) -> String {
    let text = serde_json::to_string_pretty(value).unwrap_or_default();
    let mut out: String = text.chars().take(800).collect();
    if text.chars().count() > 800 {
        out.push('…');
    }
    out
}

/// Runs on the control server's connection thread, so it can wait for the
/// user's tap.
fn approve(service: &TelegramService, chat_id: i64, job_id: u64, arguments: &Value) -> Value {
    let tool = arguments
        .get("tool_name")
        .and_then(Value::as_str)
        .unwrap_or("a tool");
    let input = arguments.get("input").cloned().unwrap_or_else(|| json!({}));
    let Some((project, allowed)) = lock(&service.jobs.running)
        .get(&job_id)
        .filter(|job| job.chat_id == chat_id)
        .map(|job| (job.project.name.clone(), job.allowed.clone()))
    else {
        return deny("This job was cancelled.");
    };
    let config = service.config();
    let command = (tool == "Bash")
        .then(|| input.get("command").and_then(Value::as_str))
        .flatten();
    let mut programs = Vec::new();
    let label = match command {
        Some(command) => {
            if let Some(reason) = config.sudo_block(command) {
                return deny(&format!("{reason} Do not try another way."));
            }
            let warning = danger::assess(command);
            if warning.is_none() {
                programs = programs_of(command);
                if !programs.is_empty() && programs.iter().all(|name| allowed.contains(name)) {
                    return allow(&input);
                }
            }
            actions::warn(
                warning.as_deref(),
                format!("🤖 Job #{job_id} · {project}\nClaude wants to run:\n\n$ {command}"),
            )
        }
        None => format!(
            "🤖 Job #{job_id} · {project}\nClaude wants to use {tool}:\n\n{}",
            short(&input)
        ),
    };
    let Some(api) = service.api() else {
        return deny("The Telegram bot is not running, so nobody can approve this.");
    };
    let (answer, decision) = mpsc::channel();
    let id = service.jobs.next_ask.fetch_add(1, Ordering::Relaxed) + 1;
    lock(&service.jobs.asking).insert(
        id,
        Asking {
            chat_id,
            job_id,
            programs: programs.clone(),
            answer,
        },
    );
    let similar =
        (!programs.is_empty()).then(|| format!("✅ Allow {} in this job", programs.join(", ")));
    let mut buttons = vec![("✅ Allow", format!("dlg:{id}:yes"))];
    if let Some(text) = similar.as_deref() {
        buttons.push((text, format!("dlg:{id}:all")));
    }
    buttons.push(("❌ Deny", format!("dlg:{id}:no")));
    let sent = tauri::async_runtime::block_on(api.send_with_buttons(chat_id, &label, &buttons));
    if let Err(error) = sent {
        lock(&service.jobs.asking).remove(&id);
        return deny(&format!("Could not ask the user in Telegram: {error}"));
    }
    let decision = decision.recv_timeout(APPROVAL_TIMEOUT);
    lock(&service.jobs.asking).remove(&id);
    match decision {
        Ok(Decision::Allow) => allow(&input),
        Ok(Decision::AllowPrograms) => allow(&input),
        Ok(Decision::Deny) => deny("The user denied this in Telegram. Do not retry it; continue without it or stop and explain."),
        Err(_) => deny("Nobody answered in Telegram in time."),
    }
}

pub fn parse_callback(data: &str) -> Option<(u64, &str)> {
    let (id, answer) = data.strip_prefix("dlg:")?.split_once(':')?;
    matches!(answer, "yes" | "all" | "no").then_some(())?;
    Some((id.parse().ok()?, answer))
}

pub(super) async fn handle_callback(ctx: &Arc<Ctx>, press: CallbackQuery) {
    let Some(message) = press.message.clone() else {
        return;
    };
    let chat_id = message.chat.id;
    let allowed_user = ctx.config().allowed_user_ids.contains(&press.from.id);
    let pending = press
        .data
        .as_deref()
        .and_then(parse_callback)
        .filter(|_| allowed_user)
        .and_then(|(id, answer)| {
            let mut asking = lock(&ctx.service.jobs.asking);
            asking
                .get(&id)
                .is_some_and(|asking| asking.chat_id == chat_id)
                .then(|| asking.remove(&id))
                .flatten()
                .map(|asking| (asking, answer.to_string()))
        });
    let Some((asking, answer)) = pending else {
        let _ = ctx
            .api
            .answer_callback(&press.id, "This was already answered or expired.")
            .await;
        return;
    };
    let (decision, outcome) = match answer.as_str() {
        "yes" => (Decision::Allow, "→ Allowed.".to_string()),
        "all" => {
            if let Some(job) = lock(&ctx.service.jobs.running).get_mut(&asking.job_id) {
                job.allowed.extend(asking.programs.iter().cloned());
            }
            (
                Decision::AllowPrograms,
                format!(
                    "→ Allowed {} for the rest of this job.",
                    asking.programs.join(", ")
                ),
            )
        }
        _ => (Decision::Deny, "→ Denied.".to_string()),
    };
    let _ = asking.answer.send(decision);
    let _ = ctx.api.answer_callback(&press.id, &outcome).await;
    let original = message.text.unwrap_or_default();
    let _ = ctx
        .api
        .edit_text(
            chat_id,
            message.message_id,
            &format!("{original}\n\n{outcome}"),
        )
        .await;
}

/// `polakapi_delegate` from the operator agent. Held for Run / Cancel when
/// "Ask before acting" is on.
pub fn request(
    server: &ControlServer,
    app: &AppHandle,
    service: &Arc<TelegramService>,
    chat_id: i64,
    full: bool,
    arguments: &Value,
) -> Value {
    if !full {
        return tool_text("Delegating needs the Full tool profile in polakapi's Telegram settings. Tell the user.", true);
    }
    let task = arguments
        .get("task")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    if task.is_empty() {
        return tool_text("`task` is required.", true);
    }
    let fresh = arguments.get("fresh").and_then(Value::as_bool) == Some(true);
    let project =
        match arguments.get("project").and_then(Value::as_str) {
            Some(query) if !query.trim().is_empty() => {
                match service.set_focus(server, app, chat_id, query) {
                    Ok(focus) => focus,
                    Err(error) => return tool_text(error, true),
                }
            }
            _ => match service.focus(chat_id) {
                Some(focus) => focus,
                None => return tool_text(
                    "No project selected for this chat. Pass `project`, or ask the user which one.",
                    true,
                ),
            },
        };
    let held = json!({
        "project": { "id": project.id, "name": project.name, "path": project.path },
        "task": task,
        "fresh": fresh,
    });
    if service.config().confirm_actions {
        let label = format!("🤖 Hand this to Claude in {}?\n\n{task}", project.name);
        let Some(api) = service.api() else {
            return tool_text("the Telegram bot is not running", true);
        };
        let sent = tauri::async_runtime::block_on(actions::ask(
            &service.actions,
            &api,
            chat_id,
            &label,
            DELEGATE_TOOL.to_string(),
            held,
        ));
        return match sent {
            Ok(()) => tool_text(actions::HELD_REPLY, false),
            Err(error) => tool_text(format!("could not ask the user: {error}"), true),
        };
    }
    match start_held(service, chat_id, &held) {
        Ok(id) => tool_text(
            format!("Started job #{id}: Claude is working on it in {}. polakapi posts the result to the chat when it ends. Tell the user in one short line; do not wait for it.", project.name),
            false,
        ),
        Err(error) => tool_text(error, true),
    }
}

/// Starts a job from the arguments `request` held.
pub fn start_held(
    service: &Arc<TelegramService>,
    chat_id: i64,
    held: &Value,
) -> Result<u64, String> {
    let project: Focus = serde_json::from_value(held.get("project").cloned().unwrap_or_default())
        .map_err(|e| format!("bad project: {e}"))?;
    let task = held
        .get("task")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let fresh = held.get("fresh").and_then(Value::as_bool) == Some(true);
    start(service, chat_id, project, task, fresh)
}

fn start(
    service: &Arc<TelegramService>,
    chat_id: i64,
    project: Focus,
    task: String,
    fresh: bool,
) -> Result<u64, String> {
    let api = service.api().ok_or("the Telegram bot is not running")?;
    let mut running = lock(&service.jobs.running);
    if let Some((id, _)) = running.iter().find(|(_, job)| job.project.id == project.id) {
        return Err(format!(
            "Job #{id} is already working on {}. Wait for it, or /cancel {id}.",
            project.name
        ));
    }
    let limit = service.config().max_jobs as usize;
    if running.len() >= limit {
        return Err(format!(
            "{limit} jobs are already running, the most polakapi's Telegram settings allow. /jobs lists them."
        ));
    }
    let id = service.jobs.next.fetch_add(1, Ordering::Relaxed) + 1;
    let resume = (!fresh)
        .then(|| service.delegate_session(chat_id, &project.id))
        .flatten();
    let handle = tauri::async_runtime::spawn(run(
        service.clone(),
        api,
        id,
        chat_id,
        project.clone(),
        task.clone(),
        resume,
    ));
    running.insert(
        id,
        Job {
            chat_id,
            project,
            task,
            started: Instant::now(),
            handle,
            allowed: HashSet::new(),
        },
    );
    Ok(id)
}

fn job_prompt(task: &str) -> String {
    format!(
        "Task from the user through polakapi's Telegram bot. Work in this repository.\n\n{task}\n\nWhen you finish, answer with a short summary for a phone: what you did, what changed, and anything the user must check or decide. Do not paste whole files or long logs."
    )
}

async fn execute(
    app: &AppHandle,
    chat_id: i64,
    id: u64,
    project: &Focus,
    task: &str,
    resume: Option<&str>,
) -> Result<TurnOutput, String> {
    let server = app
        .try_state::<Arc<ControlServer>>()
        .ok_or_else(|| "the agent control server is not running".to_string())?;
    let bin = std::env::current_exe()
        .map_err(|e| format!("resolve current exe: {e}"))?
        .to_string_lossy()
        .into_owned();
    let control = server.control_file().to_string_lossy().into_owned();
    let origin = format!("telegram:{chat_id}:job:{id}");
    let spec = home::prepare_delegate(
        &home::home_dir(app)?,
        &bin,
        &control,
        &project.path,
        &origin,
        resume,
    )?;
    turn::run_with_env(
        &spec,
        &job_prompt(task),
        JOB_TIMEOUT,
        &[("MCP_TOOL_TIMEOUT", MCP_TOOL_TIMEOUT_MS)],
    )
    .await
}

pub fn elapsed(duration: Duration) -> String {
    let secs = duration.as_secs();
    match secs {
        0..=59 => format!("{secs}s"),
        _ => format!("{}m {:02}s", secs / 60, secs % 60),
    }
}

async fn run(
    service: Arc<TelegramService>,
    api: Api,
    id: u64,
    chat_id: i64,
    project: Focus,
    task: String,
    resume: Option<String>,
) {
    let started = Instant::now();
    service.audit(json!({
        "ts": now_secs(), "chatId": chat_id, "job": id, "event": "start",
        "project": project.name, "task": task, "resume": resume.is_some(),
    }));
    let app = service.app.clone();
    let mut result = execute(&app, chat_id, id, &project, &task, resume.as_deref()).await;
    if let Err(error) = &result {
        if resume.is_some() && looks_like_lost_session(error) {
            result = execute(&app, chat_id, id, &project, &task, None).await;
        }
    }
    lock(&service.jobs.running).remove(&id);
    service.jobs.forget(id);
    let took = elapsed(started.elapsed());
    service.audit(json!({
        "ts": now_secs(), "chatId": chat_id, "job": id, "event": "end",
        "ok": result.is_ok(), "error": result.as_ref().err(), "ms": started.elapsed().as_millis() as u64,
    }));
    match result {
        Ok(output) => {
            if let Some(session) = output.session.clone() {
                service.update_state(|state| {
                    state.delegates.insert(
                        delegate_key(chat_id, &project.id),
                        Session {
                            cli: "claude".to_string(),
                            id: session,
                        },
                    );
                });
            }
            let config = service.config();
            if config.voice_replies == "always" {
                speech::speak_answer(&api, chat_id, &config, &output.text).await;
            }
            let text = format!(
                "✅ Job #{id} · {} · {took}\n\n{}",
                project.name, output.text
            );
            if send_rich(&api, chat_id, &text).await.is_err() {
                let _ = api.send_message(chat_id, &text).await;
            }
        }
        Err(error) => {
            let text = format!(
                "❌ Job #{id} · {} failed after {took}: {error}",
                project.name
            );
            let _ = api.send_message(chat_id, &text).await;
        }
    }
}

fn delegate_key(chat_id: i64, project_id: &str) -> String {
    format!("{chat_id}:{project_id}")
}

impl TelegramService {
    fn delegate_session(&self, chat_id: i64, project_id: &str) -> Option<String> {
        lock(&self.state)
            .delegates
            .get(&delegate_key(chat_id, project_id))
            .map(|session| session.id.clone())
    }
}

#[cfg(test)]
#[path = "delegate_tests.rs"]
mod tests;
