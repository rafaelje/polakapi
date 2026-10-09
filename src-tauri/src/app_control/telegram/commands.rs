use std::sync::Arc;

use super::api::CallbackQuery;
use super::bot::{lock, reply, Ctx};
use super::config::{normalize_style, ConfigPatch};
use super::format::{send_rich, terminal_block};
use super::projects::{self, ProjectRow};
use crate::app_control::run;

// Chat commands answered without the model: settings (`/style`, `/notify`,
// `/approvals`, `/confirm`) and projects (`/projects`, `/active`, `/project`,
// `/run`).

/// Text after the command token, e.g. `/style@bot be brief` → `be brief`.
pub(super) fn command_argument(text: &str) -> &str {
    text.split_once(char::is_whitespace)
        .map(|(_, rest)| rest.trim())
        .unwrap_or("")
}

/// `/notify`, `/approvals` and `/confirm` change the same settings as the
/// settings window.
pub(super) fn toggle_command(ctx: &Ctx, name: &str, argument: &str) -> String {
    let config = ctx.config();
    let (current, label) = match name {
        "notify" => (
            config.forward_notifications,
            "Agent notifications in Telegram",
        ),
        "confirm" => (config.confirm_actions, "Ask before acting"),
        _ => (config.remote_approvals, "Permission buttons"),
    };
    let wanted = match argument.to_lowercase().as_str() {
        "" => {
            return format!(
                "{label}: {}. Send /{name} on or /{name} off.",
                on_off(current)
            )
        }
        "on" => true,
        "off" => false,
        _ => return format!("Use /{name} on or /{name} off."),
    };
    let patch = match name {
        "notify" => ConfigPatch {
            forward_notifications: Some(wanted),
            ..ConfigPatch::default()
        },
        "confirm" => ConfigPatch {
            confirm_actions: Some(wanted),
            ..ConfigPatch::default()
        },
        _ => ConfigPatch {
            remote_approvals: Some(wanted),
            ..ConfigPatch::default()
        },
    };
    let saved = config
        .apply(patch)
        .and_then(|next| ctx.service.save_config(next));
    let mut answer = match saved {
        Ok(()) => format!("{label}: {}.", on_off(wanted)),
        Err(error) => return format!("Could not save: {error}"),
    };
    if name == "approvals" && wanted && !config.forward_notifications {
        answer.push_str(
            " Notifications are off, so no buttons will arrive until you send /notify on.",
        );
    }
    answer
}

fn on_off(value: bool) -> &'static str {
    if value {
        "on"
    } else {
        "off"
    }
}

pub(super) fn style_command(ctx: &Ctx, chat_id: i64, argument: &str) -> String {
    let key = chat_id.to_string();
    let config = ctx.config();
    let default = &config.reply_style;
    match argument {
        "" => {
            let state = lock(&ctx.service.state);
            match state.styles.get(&key) {
                Some(style) => format!(
                    "Style for this chat:\n{style}\n\n/style reset goes back to the default."
                ),
                None if !default.is_empty() => {
                    format!("Default style from polakapi settings:\n{default}")
                }
                None => "No style set. Send /style followed by how you want answers written."
                    .to_string(),
            }
        }
        "reset" => {
            ctx.service.update_state(|state| {
                state.styles.remove(&key);
            });
            if default.is_empty() {
                "Style cleared.".to_string()
            } else {
                format!("Back to the default style:\n{default}")
            }
        }
        style => {
            let style = normalize_style(style);
            ctx.service.update_state(|state| {
                state.styles.insert(key, style.clone());
            });
            format!("Style saved for this chat. It applies from the next message:\n{style}")
        }
    }
}

async fn project_rows(ctx: &Ctx) -> Result<Vec<ProjectRow>, String> {
    let service = ctx.service.clone();
    let overview = tauri::async_runtime::spawn_blocking(move || service.relay_overview())
        .await
        .map_err(|e| e.to_string())??;
    Ok(projects::rows(&overview))
}

pub(super) async fn list_projects(ctx: &Ctx, chat_id: i64, only_active: bool) {
    let text = match project_rows(ctx).await {
        Ok(rows) => projects::format_list(&rows, ctx.service.focus(chat_id).as_ref(), only_active),
        Err(error) => format!("Could not read polakapi: {error}"),
    };
    send_rich(&ctx.api, chat_id, &format!("```\n{text}\n```"))
        .await
        .ok();
}

/// `/project` shows the chat's project and buttons to switch; `/project x`
/// switches; `/project none` forgets it.
pub(super) async fn project_command(ctx: &Ctx, chat_id: i64, argument: &str) {
    if matches!(argument, "none" | "clear" | "-") {
        ctx.service.clear_focus(chat_id);
        reply(ctx, chat_id, "This chat is no longer tied to a project.").await;
        return;
    }
    let rows = match project_rows(ctx).await {
        Ok(rows) => rows,
        Err(error) => {
            reply(ctx, chat_id, &format!("Could not read polakapi: {error}")).await;
            return;
        }
    };
    if argument.is_empty() {
        let current = match ctx.service.focus(chat_id) {
            Some(focus) => format!("Working on {} ({}).", focus.name, focus.path),
            None => "No project selected for this chat.".to_string(),
        };
        let buttons: Vec<(String, String)> = rows
            .iter()
            .take(40)
            .map(|row| (row.name.clone(), format!("focus:{}", row.id)))
            .filter(|(_, data)| data.len() <= 64)
            .collect();
        let keyboard: Vec<Vec<(String, String)>> = buttons.chunks(2).map(<[_]>::to_vec).collect();
        let text = format!("{current}\nPick one, or send /project <name or number>.");
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
    let answer = match projects::find(&rows, argument) {
        Ok(row) => focus_on(ctx, chat_id, row),
        Err(error) => format!("Could not switch: {error}."),
    };
    reply(ctx, chat_id, &answer).await;
}

fn focus_on(ctx: &Ctx, chat_id: i64, row: &ProjectRow) -> String {
    let focus = row.focus();
    ctx.service.update_state(|state| {
        state.focus.insert(chat_id.to_string(), focus.clone());
    });
    format!(
        "Now working on {} ({}). Everything you ask refers to it until you name another project.",
        focus.name, focus.path
    )
}

pub(super) async fn focus_callback(ctx: &Arc<Ctx>, press: CallbackQuery) {
    let allowed = ctx.config().allowed_user_ids.contains(&press.from.id);
    let (Some(message), Some(id)) = (
        press.message.as_ref(),
        press
            .data
            .as_deref()
            .and_then(|data| data.strip_prefix("focus:")),
    ) else {
        return;
    };
    let toast = if !allowed {
        "Not allowed.".to_string()
    } else {
        match project_rows(ctx).await {
            Ok(rows) => match rows.iter().find(|row| row.id == id) {
                Some(row) => {
                    let answer = focus_on(ctx, message.chat.id, row);
                    let _ = ctx
                        .api
                        .edit_text(message.chat.id, message.message_id, &answer)
                        .await;
                    row.name.clone()
                }
                None => "That project is gone.".to_string(),
            },
            Err(error) => error,
        }
    };
    let _ = ctx.api.answer_callback(&press.id, &toast).await;
}

/// `/run <command>` in the chat's project, without the model.
pub(super) async fn run_command(ctx: &Ctx, chat_id: i64, command: &str) {
    if ctx.config().profile != "full" {
        reply(
            ctx,
            chat_id,
            "/run needs the Full tool profile in polakapi's Telegram settings.",
        )
        .await;
        return;
    }
    let Some(focus) = ctx.service.focus(chat_id) else {
        reply(ctx, chat_id, "Pick a project first: /project").await;
        return;
    };
    if let Some(reason) = ctx.config().sudo_block(command) {
        reply(ctx, chat_id, &reason).await;
        return;
    }
    if command.is_empty() {
        reply(
            ctx,
            chat_id,
            &format!("Usage: /run git status (runs in {})", focus.name),
        )
        .await;
        return;
    }
    let _ = ctx.api.send_typing(chat_id).await;
    let text = match run::run_shell(&focus.path, command, run::DEFAULT_TIMEOUT).await {
        Ok(output) => terminal_block(&output.transcript()),
        Err(error) => format!("Could not run it: {error}"),
    };
    if send_rich(&ctx.api, chat_id, &text).await.is_err() {
        reply(ctx, chat_id, &text).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_argument_skips_the_command_token() {
        assert_eq!(command_argument("/style be brief"), "be brief");
        assert_eq!(
            command_argument("/style@polabot  en español\n"),
            "en español"
        );
        assert_eq!(command_argument("/style"), "");
    }
}
