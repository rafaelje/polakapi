use serde_json::json;

use super::bot::{lock, now_secs, reply, Ctx};
use super::delegate::elapsed;

// `/jobs` and `/cancel`: the coding jobs `delegate` runs for this chat.

fn preview(text: &str, limit: usize) -> String {
    let line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut out: String = line.chars().take(limit).collect();
    if line.chars().count() > limit {
        out.push('…');
    }
    out
}

/// `/jobs`
pub(super) async fn list_command(ctx: &Ctx, chat_id: i64) {
    let lines: Vec<String> = {
        let running = lock(&ctx.service.jobs.running);
        let mut jobs: Vec<_> = running
            .iter()
            .filter(|(_, job)| job.chat_id == chat_id)
            .collect();
        jobs.sort_by_key(|(id, _)| **id);
        jobs.into_iter()
            .map(|(id, job)| {
                format!(
                    "#{id} · {} · {}\n   {}",
                    job.project.name,
                    elapsed(job.started.elapsed()),
                    preview(&job.task, 120)
                )
            })
            .collect()
    };
    let text = if lines.is_empty() {
        "No jobs running.".to_string()
    } else {
        format!("{}\n\n/cancel <number> stops one.", lines.join("\n"))
    };
    reply(ctx, chat_id, &text).await;
}

/// `/cancel [id]`: with one job running, the number can be left out.
pub(super) async fn cancel_command(ctx: &Ctx, chat_id: i64, argument: &str) {
    let job = {
        let mut running = lock(&ctx.service.jobs.running);
        let mine: Vec<u64> = running
            .iter()
            .filter(|(_, job)| job.chat_id == chat_id)
            .map(|(id, _)| *id)
            .collect();
        let id = match argument.trim_start_matches('#').parse::<u64>() {
            Ok(id) if mine.contains(&id) => Some(id),
            Err(_) if argument.is_empty() && mine.len() == 1 => Some(mine[0]),
            _ => None,
        };
        id.and_then(|id| running.remove(&id).map(|job| (id, job)))
    };
    let text = match job {
        Some((id, job)) => {
            job.handle.abort();
            ctx.service.jobs.forget(id);
            ctx.service.audit(
                json!({ "ts": now_secs(), "chatId": chat_id, "job": id, "event": "cancel" }),
            );
            format!("⏹ Cancelled job #{id} · {}.", job.project.name)
        }
        None if argument.is_empty() => {
            "Which one? /jobs lists them; then /cancel <number>.".to_string()
        }
        None => format!("No running job #{argument} in this chat. /jobs lists them."),
    };
    reply(ctx, chat_id, &text).await;
}
