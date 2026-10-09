use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::json;
use tauri::async_runtime::JoinHandle;
use tauri::Manager;

use super::bot::{lock, now_secs, reply, send_long, Ctx};
use super::config::Session;
use super::turn;
use crate::app_control::home;
use crate::app_control::server::ControlServer;

// Per-chat queues. Each chat with pending messages has one worker task that
// runs them in order; aborting the worker drops the running turn, which kills
// the CLI process.

const MAX_QUEUED: usize = 3;
const TYPING_EVERY: Duration = Duration::from_secs(4);

#[derive(Default)]
pub(super) struct Chats {
    slots: Mutex<HashMap<i64, Slot>>,
}

#[derive(Default)]
struct Slot {
    queue: VecDeque<Incoming>,
    worker: Option<JoinHandle<()>>,
}

#[derive(Debug, Clone)]
pub(super) struct Incoming {
    pub(super) user_id: i64,
    pub(super) name: String,
    pub(super) text: String,
}

#[derive(Debug, PartialEq)]
pub(super) enum Enqueued {
    Started,
    Queued(usize),
    Busy,
}
impl Chats {
    pub(super) fn enqueue(&self, ctx: &Arc<Ctx>, chat_id: i64, incoming: Incoming) -> Enqueued {
        let mut slots = lock(&self.slots);
        let slot = slots.entry(chat_id).or_default();
        if slot.worker.is_some() {
            if slot.queue.len() >= MAX_QUEUED {
                return Enqueued::Busy;
            }
            slot.queue.push_back(incoming);
            return Enqueued::Queued(slot.queue.len());
        }
        slot.queue.push_back(incoming);
        slot.worker = Some(tauri::async_runtime::spawn(work(ctx.clone(), chat_id)));
        Enqueued::Started
    }

    fn next(&self, chat_id: i64) -> Option<Incoming> {
        let mut slots = lock(&self.slots);
        let slot = slots.get_mut(&chat_id)?;
        let next = slot.queue.pop_front();
        if next.is_none() {
            slots.remove(&chat_id);
        }
        next
    }

    pub(super) fn abort_all(&self) {
        for (_, slot) in lock(&self.slots).drain() {
            if let Some(worker) = slot.worker {
                worker.abort();
            }
        }
    }

    /// Aborting the worker drops the running turn, which kills the CLI.
    pub(super) fn stop(&self, chat_id: i64) -> bool {
        let Some(slot) = lock(&self.slots).remove(&chat_id) else {
            return false;
        };
        match slot.worker {
            Some(worker) => {
                worker.abort();
                true
            }
            None => false,
        }
    }
}

async fn work(ctx: Arc<Ctx>, chat_id: i64) {
    while let Some(incoming) = ctx.chats.next(chat_id) {
        let Ok(_permit) = ctx.turns.acquire().await else {
            return;
        };
        let started = std::time::Instant::now();
        let result = with_typing(&ctx, chat_id, run_turn(&ctx, chat_id, &incoming)).await;
        ctx.service.audit(json!({
            "ts": now_secs(),
            "chatId": chat_id,
            "userId": incoming.user_id,
            "text": incoming.text,
            "cli": ctx.config.cli,
            "profile": ctx.config.profile,
            "ok": result.is_ok(),
            "error": result.as_ref().err(),
            "ms": started.elapsed().as_millis() as u64,
        }));
        match result {
            Ok(text) => send_long(&ctx, chat_id, &text).await,
            Err(error) => reply(&ctx, chat_id, &format!("Error: {error}")).await,
        }
    }
}

async fn with_typing<F: std::future::Future>(ctx: &Ctx, chat_id: i64, future: F) -> F::Output {
    tokio::pin!(future);
    let mut tick = tokio::time::interval(TYPING_EVERY);
    loop {
        tokio::select! {
            output = &mut future => return output,
            _ = tick.tick() => {
                let _ = ctx.api.send_typing(chat_id).await;
            }
        }
    }
}

async fn run_turn(ctx: &Ctx, chat_id: i64, incoming: &Incoming) -> Result<String, String> {
    let cli = ctx.config.cli.as_str();
    let prompt = format!("[telegram] {}:\n{}", incoming.name, incoming.text);
    let resume = ctx.service.session(chat_id, cli);
    let first = attempt(ctx, &prompt, resume.as_deref()).await;
    let output = match first {
        Err(error) if resume.is_some() && looks_like_lost_session(&error) => {
            attempt(ctx, &prompt, None).await?
        }
        other => other?,
    };
    if let Some(id) = output.session.clone() {
        ctx.service.update_state(|state| {
            state.sessions.insert(
                chat_id.to_string(),
                Session {
                    cli: cli.to_string(),
                    id,
                },
            );
        });
    }
    Ok(output.text)
}

async fn attempt(
    ctx: &Ctx,
    prompt: &str,
    resume: Option<&str>,
) -> Result<turn::TurnOutput, String> {
    let app = &ctx.service.app;
    let server = app
        .try_state::<Arc<ControlServer>>()
        .ok_or_else(|| "the agent control server is not running".to_string())?;
    let bin = std::env::current_exe()
        .map_err(|e| format!("resolve current exe: {e}"))?
        .to_string_lossy()
        .into_owned();
    let control = server.control_file().to_string_lossy().into_owned();
    let spec = home::prepare_headless(
        &home::home_dir(app)?,
        &ctx.config.cli,
        &bin,
        &control,
        &ctx.config.profile,
        resume,
    )?;
    turn::run(
        &spec,
        prompt,
        Duration::from_secs(ctx.config.turn_timeout_secs),
    )
    .await
}

fn looks_like_lost_session(error: &str) -> bool {
    let error = error.to_lowercase();
    ["session", "conversation", "thread"]
        .iter()
        .any(|word| error.contains(word))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lost_sessions_are_recognized() {
        assert!(looks_like_lost_session(
            "No conversation found with session ID: abc"
        ));
        assert!(!looks_like_lost_session("timed out after 600s"));
    }
}
