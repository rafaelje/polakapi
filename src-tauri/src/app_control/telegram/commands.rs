use super::bot::{lock, Ctx};
use super::config::{normalize_style, ConfigPatch};

// Chat commands that change settings: `/style`, `/notify` and `/approvals`.

/// Text after the command token, e.g. `/style@bot be brief` → `be brief`.
pub(super) fn command_argument(text: &str) -> &str {
    text.split_once(char::is_whitespace)
        .map(|(_, rest)| rest.trim())
        .unwrap_or("")
}

/// `/notify` and `/approvals` change the same settings as the settings window.
pub(super) fn toggle_command(ctx: &Ctx, name: &str, argument: &str) -> String {
    let config = ctx.config();
    let (current, label) = match name {
        "notify" => (
            config.forward_notifications,
            "Agent notifications in Telegram",
        ),
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
