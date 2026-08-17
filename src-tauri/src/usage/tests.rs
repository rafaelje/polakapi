use super::*;
use serde_json::json;
use std::fs::File;
use std::io::Write;

fn write_lines(path: &Path, lines: &[Value]) {
    let mut file = File::create(path).unwrap();
    for line in lines {
        writeln!(file, "{line}").unwrap();
    }
}

#[test]
fn claude_dedupes_usage_per_message_id_and_buckets_by_day() {
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("project-a");
    std::fs::create_dir_all(&project).unwrap();
    let file = project.join("session-1.jsonl");
    let usage = json!({
        "input_tokens": 10,
        "output_tokens": 5,
        "cache_creation_input_tokens": 100,
        "cache_read_input_tokens": 50,
        "output_tokens_details": { "thinking_tokens": 2 }
    });
    write_lines(
        &file,
        &[
            json!({
                "type": "assistant",
                "timestamp": "2026-08-15T20:22:14.488Z",
                "message": { "id": "msg_1", "model": "claude-opus-4-7", "usage": usage }
            }),
            // Duplicate id -> must be ignored.
            json!({
                "type": "assistant",
                "timestamp": "2026-08-15T20:22:15.000Z",
                "message": { "id": "msg_1", "model": "claude-opus-4-7", "usage": usage }
            }),
            // Different id, next day.
            json!({
                "type": "assistant",
                "timestamp": "2026-08-16T00:01:00.000Z",
                "message": { "id": "msg_2", "model": "claude-opus-4-7",
                    "usage": { "input_tokens": 1, "output_tokens": 1 } }
            }),
            // User line: no usage, ignored.
            json!({ "type": "user", "timestamp": "2026-08-16T00:02:00.000Z" }),
        ],
    );

    let days = collect_claude_from_dir(temp.path()).unwrap();
    assert_eq!(days.len(), 2);
    let d15 = days.get("2026-08-15").unwrap();
    assert_eq!(d15.input, 10);
    assert_eq!(d15.output, 5);
    assert_eq!(d15.cache_read, 50);
    assert_eq!(d15.cache_write, 100);
    assert_eq!(d15.reasoning, 2);
    assert_eq!(d15.total, 10 + 5 + 50 + 100);
    let d16 = days.get("2026-08-16").unwrap();
    assert_eq!(d16.total, 2);
}

#[test]
fn codex_sums_last_token_usage_only() {
    let temp = tempfile::tempdir().unwrap();
    let day = temp.path().join("2026").join("08").join("15");
    std::fs::create_dir_all(&day).unwrap();
    let file = day.join("rollout.jsonl");
    write_lines(
        &file,
        &[
            // Meta line: no counters.
            json!({
                "timestamp": "2026-08-15T10:00:00.000Z",
                "type": "session_meta",
                "payload": { "session_id": "s1" }
            }),
            json!({
                "timestamp": "2026-08-15T10:00:05.000Z",
                "type": "event_msg",
                "payload": {
                    "type": "token_count",
                    "info": {
                        "total_token_usage": { "input_tokens": 999, "output_tokens": 999 },
                        "last_token_usage": {
                            "input_tokens": 100,
                            "cached_input_tokens": 30,
                            "cache_write_input_tokens": 5,
                            "output_tokens": 40,
                            "reasoning_output_tokens": 3,
                            "total_tokens": 140
                        }
                    }
                }
            }),
            // Non-token_count event -> ignored.
            json!({
                "timestamp": "2026-08-15T10:00:07.000Z",
                "type": "event_msg",
                "payload": { "type": "agent_message" }
            }),
            // Next day, another turn.
            json!({
                "timestamp": "2026-08-16T09:00:00.000Z",
                "type": "event_msg",
                "payload": {
                    "type": "token_count",
                    "info": {
                        "last_token_usage": {
                            "input_tokens": 10,
                            "cached_input_tokens": 0,
                            "output_tokens": 5
                        }
                    }
                }
            }),
        ],
    );

    let days = collect_codex_from_dir(temp.path()).unwrap();
    assert_eq!(days.len(), 2);
    let d15 = days.get("2026-08-15").unwrap();
    assert_eq!(d15.input, 70); // 100 - 30 cached
    assert_eq!(d15.cache_read, 30);
    assert_eq!(d15.cache_write, 5);
    assert_eq!(d15.output, 40);
    assert_eq!(d15.reasoning, 3);
    assert_eq!(d15.total, 70 + 40 + 30 + 5);
    let d16 = days.get("2026-08-16").unwrap();
    assert_eq!(d16.total, 15);
}

#[test]
fn missing_stores_are_not_an_error() {
    let temp = tempfile::tempdir().unwrap();
    let absent = temp.path().join("does-not-exist");
    assert!(collect_claude_from_dir(&absent).unwrap().is_empty());
    assert!(collect_codex_from_dir(&absent).unwrap().is_empty());
}

#[test]
fn iso_to_epoch_seconds_handles_z_and_offset() {
    assert_eq!(iso_to_epoch_seconds("1970-01-01T00:00:00Z"), Some(0));
    assert_eq!(
        iso_to_epoch_seconds("2026-08-16T12:34:56.789Z"),
        Some(1_786_883_696)
    );
    assert_eq!(
        iso_to_epoch_seconds("2026-08-16T12:34:56+00:00"),
        Some(1_786_883_696)
    );
    assert_eq!(iso_to_epoch_seconds("not-a-date"), None);
    assert_eq!(iso_to_epoch_seconds("2026-13-01T00:00:00Z"), None);
}

#[test]
fn claude_block_captures_recent_messages_only() {
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("proj");
    std::fs::create_dir_all(&project).unwrap();
    let now = 1_787_000_000_i64; // arbitrary "now"
    let inside_start = now - 2 * 3600; // 2h ago -> block start
    let inside_second = now - 1800; // 30m ago
    let older = now - 7 * 3600; // > 5h ago, ignored
    let path = project.join("s.jsonl");
    write_lines(
        &path,
        &[
            json!({
                "type": "assistant",
                "timestamp": epoch_to_iso(older),
                "message": { "id": "old", "usage": {"input_tokens": 999, "output_tokens": 999} }
            }),
            json!({
                "type": "assistant",
                "timestamp": epoch_to_iso(inside_start),
                "message": { "id": "a", "usage": {"input_tokens": 10, "output_tokens": 5} }
            }),
            json!({
                "type": "assistant",
                "timestamp": epoch_to_iso(inside_second),
                "message": { "id": "b", "usage": {"input_tokens": 3, "output_tokens": 2} }
            }),
        ],
    );

    let block = claude_block_from_dir(temp.path(), now).unwrap().unwrap();
    assert_eq!(block.started_at, inside_start);
    assert_eq!(block.ends_at, inside_start + 5 * 3600);
    assert_eq!(block.tokens.total, 10 + 5 + 3 + 2);
}

#[test]
fn claude_block_absent_when_nothing_recent() {
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("p");
    std::fs::create_dir_all(&project).unwrap();
    let now = 1_787_000_000_i64;
    let path = project.join("s.jsonl");
    write_lines(
        &path,
        &[json!({
            "type": "assistant",
            "timestamp": epoch_to_iso(now - 10 * 3600),
            "message": { "id": "x", "usage": {"input_tokens": 1, "output_tokens": 1} }
        })],
    );
    assert!(claude_block_from_dir(temp.path(), now).unwrap().is_none());
}

#[test]
fn codex_limits_pick_latest_snapshot() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("rollout.jsonl");
    write_lines(
        &path,
        &[
            json!({
                "timestamp": "2026-08-15T10:00:00.000Z",
                "type": "event_msg",
                "payload": {
                    "type": "token_count",
                    "info": { "last_token_usage": {"input_tokens": 1, "output_tokens": 1} },
                    "rate_limits": {
                        "plan_type": "prolite",
                        "primary": {"used_percent": 12.5, "window_minutes": 300, "resets_at": 1_800_000_000_i64},
                        "secondary": null
                    }
                }
            }),
            json!({
                "timestamp": "2026-08-15T11:00:00.000Z",
                "type": "event_msg",
                "payload": {
                    "type": "token_count",
                    "info": { "last_token_usage": {"input_tokens": 1, "output_tokens": 1} },
                    "rate_limits": {
                        "plan_type": "prolite",
                        "primary": {"used_percent": 40.0, "window_minutes": 10080, "resets_at": 1_800_100_000_i64},
                        "secondary": {"used_percent": 5.0, "window_minutes": 300, "resets_at": 1_800_100_500_i64}
                    }
                }
            }),
        ],
    );

    let limits = codex_limits_from_dir(temp.path()).unwrap().unwrap();
    assert_eq!(limits.plan_type.as_deref(), Some("prolite"));
    let primary = limits.primary.unwrap();
    assert!((primary.used_percent - 40.0).abs() < f64::EPSILON);
    assert_eq!(primary.window_minutes, Some(10080));
    let secondary = limits.secondary.unwrap();
    assert!((secondary.used_percent - 5.0).abs() < f64::EPSILON);
}

fn epoch_to_iso(epoch: i64) -> String {
    // Only used for test fixtures; delegates to a tiny UTC formatter that
    // mirrors iso_to_epoch_seconds so round-tripping is exact.
    let (y, mo, d, h, mi, s) = civil_from_days_and_seconds(epoch);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}.000Z")
}

fn civil_from_days_and_seconds(epoch: i64) -> (i64, u32, u32, u32, u32, u32) {
    let days = epoch.div_euclid(86_400);
    let secs_of_day = epoch.rem_euclid(86_400) as u32;
    let hour = secs_of_day / 3600;
    let minute = (secs_of_day % 3600) / 60;
    let second = secs_of_day % 60;
    // Inverse of days_from_civil.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 {
        (mp + 3) as u32
    } else {
        (mp - 9) as u32
    };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d, hour, minute, second)
}

#[test]
fn date_from_iso_rejects_malformed_input() {
    assert_eq!(
        date_from_iso("2026-08-15T00:00:00Z").as_deref(),
        Some("2026-08-15")
    );
    assert_eq!(date_from_iso("2026-08-15"), None);
    assert_eq!(date_from_iso("not-a-date"), None);
    assert_eq!(date_from_iso("abcd-ef-ghTxx:yy:zz"), None);
}
