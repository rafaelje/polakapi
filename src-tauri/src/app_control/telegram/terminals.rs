use std::sync::Arc;

use serde_json::{json, Value};

use super::actions::tool;
use super::api::CallbackQuery;
use super::bot::{lock, reply, Ctx, TelegramService};
use super::format::{send_rich, terminal_block};
use super::queue::with_typing;
use crate::platform_command::user_home_dir;

// The user's own terminals from the chat: `/terminals` lists them by working
// directory, `/terminal` picks the one this chat types into, `/sh <command>`
// and `$ <command>` run a command there and answer with what it printed, and
// `/peek` shows the last lines of the screen.

const PEEK_LINES: u64 = 40;

#[derive(Debug, Clone, PartialEq)]
pub struct TerminalRow {
    pub pty_id: String,
    pub project: String,
    pub project_id: String,
    pub cli: String,
    pub cwd: String,
    pub busy: Option<String>,
}

impl TerminalRow {
    fn label(&self) -> String {
        format!("{} · {}", self.project, tilde(&self.cwd))
    }
}

fn tilde(path: &str) -> String {
    match user_home_dir() {
        Some(home) => {
            let home = home.to_string_lossy();
            match path.strip_prefix(home.as_ref()) {
                Some(rest) if rest.is_empty() || rest.starts_with(['/', '\\']) => {
                    format!("~{rest}")
                }
                _ => path.to_string(),
            }
        }
        None => path.to_string(),
    }
}

pub fn parse_rows(text: &str) -> Vec<TerminalRow> {
    let value: Value = serde_json::from_str(text).unwrap_or(Value::Null);
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|row| {
            Some(TerminalRow {
                pty_id: row.get("ptyId")?.as_str()?.to_string(),
                project: row.pointer("/project/name")?.as_str()?.to_string(),
                project_id: row.pointer("/project/id")?.as_str()?.to_string(),
                cli: row.get("cli")?.as_str()?.to_string(),
                cwd: row
                    .get("cwd")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                busy: row.get("busy").and_then(Value::as_str).map(str::to_string),
            })
        })
        .collect()
}

pub fn format_list(rows: &[TerminalRow], selected: Option<&str>) -> String {
    if rows.is_empty() {
        return "No terminals are open.".to_string();
    }
    let mut lines: Vec<String> = rows
        .iter()
        .enumerate()
        .map(|(index, row)| {
            let marker = if Some(row.pty_id.as_str()) == selected {
                "◉"
            } else {
                "•"
            };
            let state = match (&row.busy, row.cli.as_str()) {
                (Some(program), _) => format!("running {program}"),
                (None, "shell") => "idle".to_string(),
                (None, cli) => cli.to_string(),
            };
            format!("{:>2}. {marker} {} — {}", index + 1, row.label(), state)
        })
        .collect();
    lines.push(String::new());
    lines.push("◉ marks this chat's terminal. /terminal <number or part of the path> picks one; then /sh <command> or $ <command>.".to_string());
    lines.join("\n")
}

/// By list number, ptyId, then a unique match on the working directory.
pub fn find<'a>(rows: &'a [TerminalRow], query: &str) -> Result<&'a TerminalRow, String> {
    let query = query.trim();
    if let Ok(number) = query.parse::<usize>() {
        return rows
            .get(number.wrapping_sub(1))
            .ok_or_else(|| format!("there is no terminal number {number}; see /terminals"));
    }
    if let Some(row) = rows.iter().find(|row| row.pty_id == query) {
        return Ok(row);
    }
    let wanted = query.trim_end_matches(['/', '\\']).to_lowercase();
    let exact: Vec<&TerminalRow> = rows
        .iter()
        .filter(|row| {
            let cwd = row.cwd.to_lowercase();
            cwd == wanted || tilde(&row.cwd).to_lowercase() == wanted
        })
        .collect();
    let candidates = if exact.is_empty() {
        rows.iter()
            .filter(|row| tilde(&row.cwd).to_lowercase().contains(&wanted))
            .collect()
    } else {
        exact
    };
    match candidates.as_slice() {
        [one] => Ok(one),
        [] => Err(format!(
            "no terminal is in a folder matching \"{query}\"; see /terminals"
        )),
        many => Err(format!(
            "\"{query}\" matches {} terminals; use the number from /terminals",
            many.len()
        )),
    }
}

async fn rows(ctx: &Ctx) -> Result<Vec<TerminalRow>, String> {
    Ok(parse_rows(
        &tool(ctx, "polakapi_terminals", json!({})).await?,
    ))
}

pub(super) async fn list(ctx: &Ctx, chat_id: i64) {
    let text = match rows(ctx).await {
        Ok(rows) => format_list(&rows, ctx.service.terminal(chat_id).as_deref()),
        Err(error) => format!("Could not read the terminals: {error}"),
    };
    let _ = send_rich(&ctx.api, chat_id, &format!("```\n{text}\n```")).await;
}

pub(super) async fn select(ctx: &Ctx, chat_id: i64, argument: &str) {
    if matches!(argument, "none" | "clear" | "-") {
        ctx.service.set_terminal(chat_id, None);
        reply(ctx, chat_id, "No terminal selected.").await;
        return;
    }
    let rows = match rows(ctx).await {
        Ok(rows) => rows,
        Err(error) => {
            reply(
                ctx,
                chat_id,
                &format!("Could not read the terminals: {error}"),
            )
            .await;
            return;
        }
    };
    if argument.is_empty() {
        let selected = ctx.service.terminal(chat_id);
        let current = rows
            .iter()
            .find(|row| Some(&row.pty_id) == selected.as_ref())
            .map(|row| format!("Typing into {}.", row.label()))
            .unwrap_or_else(|| "No terminal selected for this chat.".to_string());
        let keyboard: Vec<Vec<(String, String)>> = rows
            .iter()
            .enumerate()
            .filter(|(_, row)| row.cli == "shell")
            .map(|(index, row)| {
                (
                    format!("{}. {}", index + 1, row.label()),
                    format!("term:{}", row.pty_id),
                )
            })
            .filter(|(_, data)| data.len() <= 64)
            .take(30)
            .map(|button| vec![button])
            .collect();
        let text = format!("{current}\nPick one, or send /terminal <number or part of the path>.");
        if ctx
            .api
            .send_with_keyboard(chat_id, &text, &keyboard)
            .await
            .is_err()
        {
            reply(ctx, chat_id, &text).await;
        }
        return;
    }
    let answer = match find(&rows, argument) {
        Ok(row) => choose(ctx, chat_id, row),
        Err(error) => format!("Could not pick it: {error}."),
    };
    reply(ctx, chat_id, &answer).await;
}

fn choose(ctx: &Ctx, chat_id: i64, row: &TerminalRow) -> String {
    ctx.service.set_terminal(chat_id, Some(row.pty_id.clone()));
    let note = if row.cli == "shell" {
        String::new()
    } else {
        format!(
            " It runs {}, so commands cannot go there; ask in plain words instead.",
            row.cli
        )
    };
    format!("Typing into {}.{note}", row.label())
}

pub(super) async fn select_callback(ctx: &Arc<Ctx>, press: CallbackQuery) {
    let allowed = ctx.config().allowed_user_ids.contains(&press.from.id);
    let (Some(message), Some(pty_id)) = (
        press.message.as_ref(),
        press
            .data
            .as_deref()
            .and_then(|data| data.strip_prefix("term:")),
    ) else {
        return;
    };
    let toast = if !allowed {
        "Not allowed.".to_string()
    } else {
        match rows(ctx).await {
            Ok(rows) => match rows.iter().find(|row| row.pty_id == pty_id) {
                Some(row) => {
                    let answer = choose(ctx, message.chat.id, row);
                    let _ = ctx
                        .api
                        .edit_text(message.chat.id, message.message_id, &answer)
                        .await;
                    row.label()
                }
                None => "That terminal is closed.".to_string(),
            },
            Err(error) => error,
        }
    };
    let _ = ctx.api.answer_callback(&press.id, &toast).await;
}

/// The chat's terminal, or the only idle shell of the chat's project.
async fn target(ctx: &Ctx, chat_id: i64) -> Result<TerminalRow, String> {
    let rows = rows(ctx).await?;
    if let Some(selected) = ctx.service.terminal(chat_id) {
        return rows
            .into_iter()
            .find(|row| row.pty_id == selected)
            .ok_or_else(|| {
                "the selected terminal was closed; pick another with /terminal".to_string()
            });
    }
    let focus = ctx.service.focus(chat_id);
    let shells: Vec<TerminalRow> = rows
        .into_iter()
        .filter(|row| row.cli == "shell" && row.busy.is_none())
        .filter(|row| {
            focus
                .as_ref()
                .is_none_or(|focus| focus.id == row.project_id)
        })
        .collect();
    match shells.as_slice() {
        [one] => {
            ctx.service.set_terminal(chat_id, Some(one.pty_id.clone()));
            Ok(one.clone())
        }
        _ => Err("pick a terminal first: /terminal".to_string()),
    }
}

pub(super) async fn run(ctx: &Ctx, chat_id: i64, command: &str) {
    let config = ctx.config();
    if config.profile != "full" {
        reply(
            ctx,
            chat_id,
            "Commands in terminals need the Full tool profile in polakapi's Telegram settings.",
        )
        .await;
        return;
    }
    if command.is_empty() {
        reply(ctx, chat_id, "Usage: /sh git status, or just $ git status").await;
        return;
    }
    if let Some(reason) = config.sudo_block(command) {
        reply(ctx, chat_id, &reason).await;
        return;
    }
    let row = match target(ctx, chat_id).await {
        Ok(row) => row,
        Err(error) => {
            reply(ctx, chat_id, &format!("Cannot run it: {error}.")).await;
            return;
        }
    };
    if row.cli != "shell" {
        reply(
            ctx,
            chat_id,
            &format!(
                "{} runs {}; pick a shell with /terminal.",
                row.label(),
                row.cli
            ),
        )
        .await;
        return;
    }
    if let Some(program) = &row.busy {
        reply(
            ctx,
            chat_id,
            &format!(
                "{} is busy running {program}. /peek shows it; /terminal picks another.",
                row.label()
            ),
        )
        .await;
        return;
    }
    let result = with_typing(
        ctx,
        chat_id,
        tool(
            ctx,
            "polakapi_run_in_terminal",
            json!({ "ptyId": row.pty_id, "command": command }),
        ),
    )
    .await;
    let text = match result {
        Ok(transcript) => format!("{}\n{}", row.label(), terminal_block(&transcript)),
        Err(error) => format!("Could not run it: {error}"),
    };
    if send_rich(&ctx.api, chat_id, &text).await.is_err() {
        reply(ctx, chat_id, &text).await;
    }
}

pub(super) async fn peek(ctx: &Ctx, chat_id: i64, argument: &str) {
    let lines = argument.parse::<u64>().unwrap_or(PEEK_LINES).clamp(1, 200);
    let row = match target(ctx, chat_id).await {
        Ok(row) => row,
        Err(error) => {
            reply(ctx, chat_id, &format!("Cannot peek: {error}.")).await;
            return;
        }
    };
    let text = match tool(
        ctx,
        "polakapi_read_terminal",
        json!({ "ptyId": row.pty_id, "lines": lines }),
    )
    .await
    {
        Ok(screen) => format!("{}\n{}", row.label(), terminal_block(&screen)),
        Err(error) => format!("Could not read it: {error}"),
    };
    let _ = send_rich(&ctx.api, chat_id, &text).await;
}

impl TelegramService {
    pub(super) fn terminal(&self, chat_id: i64) -> Option<String> {
        lock(&self.state)
            .terminal
            .get(&chat_id.to_string())
            .cloned()
    }

    pub(super) fn set_terminal(&self, chat_id: i64, pty_id: Option<String>) {
        self.update_state(|state| match pty_id {
            Some(id) => {
                state.terminal.insert(chat_id.to_string(), id);
            }
            None => {
                state.terminal.remove(&chat_id.to_string());
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rows() -> Vec<TerminalRow> {
        parse_rows(
            &json!([
                { "ptyId": "a", "project": { "id": "p1", "name": "polakapi" }, "cli": "shell", "cwd": "/w/polakapi", "busy": null },
                { "ptyId": "b", "project": { "id": "p1", "name": "polakapi" }, "cli": "shell", "cwd": "/w/polakapi/src", "busy": "npm" },
                { "ptyId": "c", "project": { "id": "p2", "name": "shop" }, "cli": "claude", "cwd": "/w/shop", "busy": "claude" }
            ])
            .to_string(),
        )
    }

    #[test]
    fn lists_terminals_by_folder_and_state() {
        let text = format_list(&rows(), Some("b"));
        assert!(text.starts_with(" 1. • polakapi · /w/polakapi — idle\n 2. ◉ polakapi · /w/polakapi/src — running npm\n 3. • shop · /w/shop — running claude"));
        assert_eq!(format_list(&[], None), "No terminals are open.");
    }

    #[test]
    fn finds_terminals_by_number_id_or_folder() {
        let rows = rows();
        assert_eq!(find(&rows, "2").unwrap().pty_id, "b");
        assert_eq!(find(&rows, "c").unwrap().pty_id, "c");
        assert_eq!(find(&rows, "/w/polakapi").unwrap().pty_id, "a");
        assert_eq!(find(&rows, "/w/polakapi/").unwrap().pty_id, "a");
        assert_eq!(find(&rows, "src").unwrap().pty_id, "b");
        assert_eq!(find(&rows, "shop").unwrap().pty_id, "c");
        assert!(find(&rows, "polakapi").unwrap_err().contains("matches 2"));
        assert!(find(&rows, "9").is_err());
        assert!(find(&rows, "nowhere").is_err());
    }
}
