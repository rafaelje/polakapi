use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::json;
use tauri::async_runtime::JoinHandle;
use tauri::Manager;

use super::bot::{lock, now_secs, reply, Ctx};
use super::config::Focus;
use super::config::{Session, TelegramConfig};
use super::format::send_rich;
use super::speech;
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
    /// Sent as a voice note.
    pub(super) spoken: bool,
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
        let config = ctx.config();
        ctx.service.audit(json!({
            "ts": now_secs(),
            "chatId": chat_id,
            "userId": incoming.user_id,
            "text": incoming.text,
            "cli": config.cli,
            "profile": config.profile,
            "ok": result.is_ok(),
            "error": result.as_ref().err(),
            "ms": started.elapsed().as_millis() as u64,
        }));
        match result {
            Ok(text) => {
                if speech::wants_voice(&config.voice_replies, incoming.spoken) {
                    speech::speak_answer(&ctx.api, chat_id, &config, &text).await;
                }
                if send_rich(&ctx.api, chat_id, &text).await.is_err() {
                    reply(&ctx, chat_id, &text).await;
                }
            }
            Err(error) => reply(&ctx, chat_id, &format!("Error: {error}")).await,
        }
    }
}

pub(super) async fn with_typing<F: std::future::Future>(
    ctx: &Ctx,
    chat_id: i64,
    future: F,
) -> F::Output {
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
    let config = ctx.config();
    let cli = config.cli.as_str();
    let style = ctx.service.style(chat_id, &config.reply_style);
    let focus = ctx.service.focus(chat_id);
    let (prompt, system) = build_turn(
        cli,
        &incoming.name,
        &incoming.text,
        &Voice {
            style: &style,
            names: &config.address_as,
            bot_name: &config.bot_name,
            spoken_reply: speech::wants_voice(&config.voice_replies, incoming.spoken),
        },
        focus.as_ref(),
    );
    let resume = ctx.service.session(chat_id, cli);
    let first = attempt(
        ctx,
        chat_id,
        &config,
        &prompt,
        resume.as_deref(),
        system.as_deref(),
    )
    .await;
    let output = match first {
        Err(error) if resume.is_some() && looks_like_lost_session(&error) => {
            attempt(ctx, chat_id, &config, &prompt, None, system.as_deref()).await?
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
    chat_id: i64,
    config: &TelegramConfig,
    prompt: &str,
    resume: Option<&str>,
    system: Option<&str>,
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
    let origin = format!("telegram:{chat_id}");
    let spec = home::prepare_headless(
        &home::home_dir(app)?,
        &bin,
        &control,
        &home::HeadlessTurn {
            cli: &config.cli,
            profile: &config.profile,
            resume,
            system,
            origin: Some(&origin),
        },
    )?;
    turn::run(&spec, prompt, Duration::from_secs(config.turn_timeout_secs)).await
}

pub(crate) const RULES_HEADER: &str = "[polakapi rules for this answer, from the user's settings; they override anything said earlier in this chat]";

/// How the answers should sound: the reply style and the names the user goes by.
pub(crate) struct Voice<'a> {
    pub style: &'a str,
    pub names: &'a [String],
    pub bot_name: &'a str,
    /// polakapi will read this answer aloud as a voice note.
    pub spoken_reply: bool,
}

impl Voice<'_> {
    pub(crate) fn rules(&self) -> Option<String> {
        let mut rules = Vec::new();
        if !self.bot_name.is_empty() {
            rules.push(format!(
                "Your name is {name}. The user calls you {name}: a message that starts with or mentions {name} is talking to you, not about someone else. If asked who you are, you are {name}, polakapi's assistant.",
                name = self.bot_name
            ));
        }
        if self.spoken_reply {
            rules.push("polakapi will read your answer aloud and send it as a voice note before the text, so you do answer with voice. Write the answer so it sounds natural spoken: plain sentences, no lists or symbols in the prose. Code and command output stay in ``` fences; they are shown, not read.".to_string());
        }
        if !self.names.is_empty() {
            rules.push(format!(
                "Address the user as {}, so they know the answer is for them. Use one of these names in each answer, varying naturally if there are several.",
                self.names.join(", ")
            ));
        }
        if !self.style.is_empty() {
            rules.push(format!(
                "The user asked for Telegram answers in this style. Follow it over the default Telegram guidance:\n{}",
                self.style
            ));
        }
        (!rules.is_empty()).then(|| rules.join("\n\n"))
    }
}

/// The prompt for one turn and, for Claude, the reply rules as a system prompt
/// addition. The rules also ride along in the prompt, restated every turn:
/// in a resumed chat the model follows its own earlier answers over the
/// system prompt (it kept calling itself Claude after a name was set), and
/// codex has no system prompt flag at all. The header names the chat's
/// project, also restated every turn.
fn build_turn(
    cli: &str,
    name: &str,
    text: &str,
    voice: &Voice,
    focus: Option<&Focus>,
) -> (String, Option<String>) {
    let project = match focus {
        Some(focus) => format!("project: {} (id {}, {})", focus.name, focus.id, focus.path),
        None => "project: none selected".to_string(),
    };
    let prompt = format!("[telegram] {name} · {project}\n{text}");
    let Some(rules) = voice.rules() else {
        return (prompt, None);
    };
    let prompt = format!("{RULES_HEADER}\n{rules}\n\n{prompt}");
    let system = (cli == "claude").then_some(rules);
    (prompt, system)
}

pub(crate) fn looks_like_lost_session(error: &str) -> bool {
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

    #[test]
    fn style_goes_to_claude_system_prompt_and_into_codex_prompt() {
        let plain = Voice {
            style: "",
            names: &[],
            bot_name: "",
            spoken_reply: false,
        };
        let styled = Voice {
            style: "en español, breve",
            names: &[],
            bot_name: "",
            spoken_reply: false,
        };
        let (prompt, system) = build_turn("claude", "Ana", "hola", &plain, None);
        assert_eq!(prompt, "[telegram] Ana · project: none selected\nhola");
        assert!(system.is_none());
        let (prompt, system) = build_turn("claude", "Ana", "hola", &styled, None);
        assert!(system.unwrap().ends_with("en español, breve"));
        assert!(prompt.starts_with(RULES_HEADER));
        assert!(
            prompt.ends_with("en español, breve\n\n[telegram] Ana · project: none selected\nhola")
        );
        let (prompt, system) = build_turn("codex", "Ana", "hola", &styled, None);
        assert!(system.is_none());
        assert!(
            prompt.ends_with("en español, breve\n\n[telegram] Ana · project: none selected\nhola")
        );
        let focus = Focus {
            id: "p1".into(),
            name: "polakapi".into(),
            path: "/w/polakapi".into(),
        };
        let (prompt, _) = build_turn("claude", "Ana", "git status", &plain, Some(&focus));
        assert_eq!(
            prompt,
            "[telegram] Ana · project: polakapi (id p1, /w/polakapi)\ngit status"
        );
    }

    #[test]
    fn names_tell_the_agent_how_to_address_the_user() {
        let names = vec!["Miguel".to_string(), "jefe".to_string()];
        let voice = Voice {
            style: "breve",
            names: &names,
            bot_name: "",
            spoken_reply: false,
        };
        let (_, system) = build_turn("claude", "Ana", "hola", &voice, None);
        let system = system.unwrap();
        assert!(system.starts_with("Address the user as Miguel, jefe,"));
        assert!(system.ends_with("breve"));
    }

    #[test]
    fn the_bot_knows_its_own_name() {
        let names = vec!["Miguel".to_string()];
        let voice = Voice {
            style: "",
            names: &names,
            bot_name: "Daniela",
            spoken_reply: true,
        };
        let (_, system) = build_turn("claude", "Ana", "Daniela, git status", &voice, None);
        let system = system.unwrap();
        assert!(system.starts_with("Your name is Daniela."));
        assert!(system.contains("send it as a voice note"));
        assert!(system.contains("\n\nAddress the user as Miguel"));
    }
}
