use super::AgentResult;

pub(super) fn parse_claude_json(raw: &str) -> Result<AgentResult, String> {
    let value: serde_json::Value = match serde_json::from_str(raw.trim()) {
        Ok(v) => v,
        Err(e) => {
            return Ok(AgentResult::empty_with_error(format!(
                "malformed claude JSON: {e}"
            )));
        }
    };

    let text = value
        .get("result")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();

    let session_id = value
        .get("session_id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let cost_usd = value
        .get("total_cost_usd")
        .and_then(|v| v.as_f64())
        .or_else(|| value.get("cost_usd").and_then(|v| v.as_f64()));

    let usage = value.get("usage");
    let tokens_in = usage
        .and_then(|u| u.get("input_tokens"))
        .and_then(|v| v.as_u64());
    let tokens_out = usage
        .and_then(|u| u.get("output_tokens"))
        .and_then(|v| v.as_u64());

    let is_error = value
        .get("is_error")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    // claude uses `result` for the human-readable error message (e.g. "There's
    // an issue with the selected model (xxx)..."). If empty, fall back to
    // `api_error_status`. If that is also missing, a generic message.
    let error = if is_error {
        let detail = if !text.is_empty() {
            text.clone()
        } else if let Some(status) = value.get("api_error_status").and_then(|v| v.as_u64()) {
            format!("claude api error {status}")
        } else {
            "claude marked is_error=true".to_string()
        };
        Some(detail)
    } else {
        None
    };

    Ok(AgentResult {
        text,
        tokens_in,
        tokens_out,
        cost_usd,
        session_id,
        error,
    })
}

pub(super) fn extract_codex_error(stdout: &str) -> Option<String> {
    for line in stdout.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) else {
            continue;
        };
        let type_field = value.get("type").and_then(|v| v.as_str());
        if type_field == Some("error") {
            if let Some(msg) = value.get("message").and_then(|v| v.as_str()) {
                return Some(unwrap_nested_json_message(msg));
            }
        }
        if type_field == Some("item.completed") {
            let item = value.pointer("/item")?;
            if item.get("type").and_then(|v| v.as_str()) == Some("error") {
                if let Some(msg) = item.get("message").and_then(|v| v.as_str()) {
                    return Some(unwrap_nested_json_message(msg));
                }
            }
        }
    }
    None
}

/// Codex sometimes stuffs the raw provider JSON into the `message` field
/// (`"{\"type\":\"error\",\"status\":400,\"error\":{\"message\":\"...\"}}"`).
/// Peel that layer off so the user sees the sentence, not the payload.
pub(super) fn unwrap_nested_json_message(msg: &str) -> String {
    if let Ok(inner) = serde_json::from_str::<serde_json::Value>(msg) {
        if let Some(deep) = inner.pointer("/error/message").and_then(|v| v.as_str()) {
            return deep.to_string();
        }
        if let Some(deep) = inner.get("message").and_then(|v| v.as_str()) {
            return deep.to_string();
        }
    }
    msg.to_string()
}

pub(super) fn parse_codex_jsonl(stdout: &str, last_message: &str) -> Result<AgentResult, String> {
    // codex --json emits a sequence of JSON objects (JSONL). We walk through
    // them trying to capture the last one that has usage. Tolerant to empty
    // or non-JSON lines (misc logs).
    let mut tokens_in: Option<u64> = None;
    let mut tokens_out: Option<u64> = None;
    let mut cost_usd: Option<f64> = None;
    let mut session_id: Option<String> = None;

    for line in stdout.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) else {
            continue;
        };

        if let Some(sid) = value
            .get("session_id")
            .or_else(|| value.pointer("/msg/session_id"))
            .and_then(|v| v.as_str())
        {
            session_id = Some(sid.to_string());
        }

        // codex reports usage in `token_count` objects or similar; we cover
        // several reasonable paths without coupling to an exact version.
        let usage = value
            .get("usage")
            .or_else(|| value.pointer("/msg/usage"))
            .or_else(|| value.pointer("/info/usage"));
        if let Some(u) = usage {
            if let Some(v) = u.get("input_tokens").and_then(|v| v.as_u64()) {
                tokens_in = Some(v);
            }
            if let Some(v) = u.get("output_tokens").and_then(|v| v.as_u64()) {
                tokens_out = Some(v);
            }
        }

        if let Some(c) = value
            .get("total_cost_usd")
            .or_else(|| value.pointer("/msg/total_cost_usd"))
            .or_else(|| value.get("cost_usd"))
            .and_then(|v| v.as_f64())
        {
            cost_usd = Some(c);
        }
    }

    Ok(AgentResult {
        text: last_message.trim_end().to_string(),
        tokens_in,
        tokens_out,
        cost_usd,
        session_id,
        error: None,
    })
}

pub(super) fn parse_opencode_stream(raw: &str) -> Result<AgentResult, String> {
    // Opencode's real JSONL shape (verified against `opencode run --format json`
    // at the current CLI version):
    //   {"type":"step_start", "sessionID": "...", "part": {...}}
    //   {"type":"text", "sessionID": "...", "part": {"type":"text", "text": "…the agent's answer…"}}
    //   {"type":"step_finish", "sessionID": "...", "part": {"tokens": {"input": 12860, "output": 17, ...}, "cost": 0.0182}}
    //
    // We concatenate every `type=text` part in order (the agent may emit its
    // reply across multiple text events) and pull tokens/cost from the last
    // `step_finish`. Older shapes (`role=assistant`, `usage.input_tokens`) are
    // still accepted as a fallback so downgrades don't silently break.
    let mut text_parts: Vec<String> = Vec::new();
    let mut tokens_in: Option<u64> = None;
    let mut tokens_out: Option<u64> = None;
    let mut cost_usd: Option<f64> = None;
    let mut session_id: Option<String> = None;
    let mut saw_any = false;
    let mut fallback_last_assistant: Option<String> = None;

    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) else {
            continue;
        };
        saw_any = true;

        let event_type = value.get("type").and_then(|v| v.as_str());

        if event_type == Some("text") {
            if let Some(text) = value
                .pointer("/part/text")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
            {
                text_parts.push(text.to_string());
            }
        }

        if event_type == Some("step_finish") {
            if let Some(tokens) = value.pointer("/part/tokens") {
                if let Some(v) = tokens.get("input").and_then(|v| v.as_u64()) {
                    tokens_in = Some(v);
                }
                if let Some(v) = tokens.get("output").and_then(|v| v.as_u64()) {
                    tokens_out = Some(v);
                }
            }
            if let Some(c) = value.pointer("/part/cost").and_then(|v| v.as_f64()) {
                cost_usd = Some(c);
            }
        }

        // Session id: opencode emits `sessionID` at the root of every event.
        if let Some(sid) = value
            .get("sessionID")
            .or_else(|| value.get("session_id"))
            .or_else(|| value.pointer("/session/id"))
            .and_then(|v| v.as_str())
        {
            session_id = Some(sid.to_string());
        }

        // Legacy fallback shape (kept so older CLI versions don't regress).
        let role = value
            .get("role")
            .or_else(|| value.pointer("/message/role"))
            .and_then(|v| v.as_str());
        if matches!(role, Some("assistant")) {
            if let Some(text) = extract_opencode_text(&value) {
                fallback_last_assistant = Some(text);
            }
        }
        if let Some(u) = value
            .get("usage")
            .or_else(|| value.pointer("/message/usage"))
        {
            if let Some(v) = u.get("input_tokens").and_then(|v| v.as_u64()) {
                tokens_in.get_or_insert(v);
            }
            if let Some(v) = u.get("output_tokens").and_then(|v| v.as_u64()) {
                tokens_out.get_or_insert(v);
            }
        }
        if let Some(c) = value
            .get("cost_usd")
            .or_else(|| value.get("total_cost_usd"))
            .and_then(|v| v.as_f64())
        {
            cost_usd.get_or_insert(c);
        }
    }

    if !saw_any {
        // Not JSONL — opencode may have emitted plain text. Treat stdout as the
        // agent message so the caller has *something* to parse.
        return Ok(AgentResult {
            text: raw.trim().to_string(),
            tokens_in: None,
            tokens_out: None,
            cost_usd: None,
            session_id: None,
            error: None,
        });
    }

    let text = if !text_parts.is_empty() {
        text_parts.join("")
    } else {
        fallback_last_assistant.unwrap_or_default()
    };

    Ok(AgentResult {
        text,
        tokens_in,
        tokens_out,
        cost_usd,
        session_id,
        error: None,
    })
}

pub(super) fn extract_opencode_text(value: &serde_json::Value) -> Option<String> {
    let content = value
        .get("content")
        .or_else(|| value.pointer("/message/content"))?;

    if let Some(s) = content.as_str() {
        return Some(s.to_string());
    }

    if let Some(arr) = content.as_array() {
        let mut buf = String::new();
        for part in arr {
            if let Some(t) = part.get("text").and_then(|v| v.as_str()) {
                buf.push_str(t);
            } else if let Some(t) = part.as_str() {
                buf.push_str(t);
            }
        }
        if !buf.is_empty() {
            return Some(buf);
        }
    }

    None
}
