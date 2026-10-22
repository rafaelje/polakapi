use super::*;

fn env(enabled: bool, cli: &str) -> HookEnv {
    HookEnv {
        target: Target::Claude,
        in_polakapi_terminal: true,
        cli: cli.to_string(),
        config: CtxConfig {
            enabled,
            clis: vec!["claude".to_string(), "cursor".to_string()],
            ..CtxConfig::default()
        },
        bin: "/opt/polakapi".to_string(),
    }
}

fn cursor_env() -> HookEnv {
    HookEnv {
        target: Target::Cursor,
        ..env(true, "cursor-agent")
    }
}

fn cursor_shell(command: &str) -> Value {
    // Shape captured from cursor-agent 2026.09.15.
    json!({
        "hook_event_name": "preToolUse",
        "tool_name": "Shell",
        "tool_input": { "command": command, "cwd": "", "timeout": 30000 },
        "cursor_version": "2026.09.15-d2fe57e"
    })
}

#[test]
fn codex_denies_with_a_wrapper_and_never_grants_permission() {
    assert_eq!(Target::from_arg("codex"), Some(Target::Codex));
    let mut codex = env(true, "codex");
    codex.target = Target::Codex;
    codex.config.clis.push("codex".into());
    let event = bash("git log --oneline");
    let reply = respond(&event, &codex).unwrap();
    let output = &reply["hookSpecificOutput"];
    assert_eq!(output["permissionDecision"], "deny");
    let reason = output["permissionDecisionReason"].as_str().unwrap();
    assert!(reason.contains("'/opt/polakapi' ctx exec"));
    assert!(reason.contains("git log --oneline"));
    assert!(output.get("updatedInput").is_none());
    let start = respond(&json!({"hook_event_name":"SessionStart"}), &codex).unwrap();
    assert!(start["hookSpecificOutput"]["additionalContext"]
        .as_str()
        .unwrap()
        .contains("ctx search"));
    codex.cli = "claude".into();
    assert!(respond(&event, &codex).is_none());
    assert!(respond(&event, &env(true, "codex")).is_none());
    codex.cli = "codex".into();
    codex.in_polakapi_terminal = false;
    assert!(respond(&event, &codex).is_none());
    codex.in_polakapi_terminal = true;
    codex.config.clis.clear();
    assert!(respond(&event, &codex).is_none());
}

#[test]
fn a_cli_started_from_a_shell_pane_is_told_apart_by_its_events() {
    assert_eq!(infer_cli(&bash("git log")), "claude");
    assert_eq!(infer_cli(&cursor_shell("git log")), "cursor-agent");
    let inferred = env(true, infer_cli(&bash("git log")));
    assert!(decide(&bash("git log --oneline"), &inferred).is_ok());
    let cursor = HookEnv {
        cli: infer_cli(&cursor_shell("git log")).to_string(),
        ..env(true, "")
    };
    assert!(decide(&cursor_shell("git log --oneline"), &cursor).is_err());
}

#[test]
fn codex_started_from_a_shell_pane_is_told_apart_by_its_transcript() {
    let mut event = bash("git log --oneline");
    event["transcript_path"] =
        json!("/home/u/.codex/sessions/2026/10/21/rollout-2026-10-21T11-28-45-01a15f14.jsonl");
    event["turn_id"] = json!("01a15f14-45ab");
    assert_eq!(infer_cli(&event), "codex");
    let mut codex = env(true, infer_cli(&event));
    codex.target = Target::Codex;
    codex.config.clis.push("codex".into());
    assert!(decide(&event, &codex).is_ok());

    let mut claude = bash("git log --oneline");
    claude["transcript_path"] =
        json!("/home/u/.claude/projects/-home-u-repo/0b1c2d3e-4f5a-6b7c-8d9e-0f1a2b3c4d5e.jsonl");
    assert_eq!(infer_cli(&claude), "claude");
    codex.cli = infer_cli(&claude).to_string();
    assert!(decide(&claude, &codex).is_err());
}

#[test]
fn every_way_of_doing_nothing_names_its_reason() {
    let mut outside = env(true, "claude");
    outside.in_polakapi_terminal = false;
    assert!(decide(&bash("git log"), &outside)
        .unwrap_err()
        .contains("outside a polakapi terminal"));
    assert!(decide(&bash("git log"), &env(false, "claude"))
        .unwrap_err()
        .contains("off for claude"));
    assert!(decide(&bash("git status"), &env(true, "claude"))
        .unwrap_err()
        .contains("prints little"));
    assert!(decide(&bash("git log"), &env(true, "cursor-agent"))
        .unwrap_err()
        .contains("runs cursor-agent"));
}

#[test]
fn rewrites_a_cursor_shell_command_in_cursors_own_format() {
    let reply = respond(&cursor_shell("git log --oneline"), &cursor_env()).unwrap();
    let command = reply["updated_input"]["command"].as_str().unwrap();
    assert!(command.starts_with("'/opt/polakapi' ctx exec --source 'read:"));
    assert_eq!(reply["updated_input"]["timeout"], 30000);
    assert!(reply.get("hookSpecificOutput").is_none());
    assert!(reply.get("permission").is_none());
}

#[test]
fn cursor_session_start_uses_top_level_additional_context() {
    let reply = respond(&json!({ "hook_event_name": "sessionStart" }), &cursor_env()).unwrap();
    assert!(reply["additional_context"]
        .as_str()
        .unwrap()
        .contains("ctx search"));
}

#[test]
fn a_hook_acts_only_under_the_cli_it_was_installed_for() {
    // Cursor also runs the hooks in Claude's settings: the Claude hook must
    // stay quiet there, or the command would be rewritten twice.
    let mut claude_hook_in_cursor = env(true, "cursor-agent");
    claude_hook_in_cursor.target = Target::Claude;
    assert!(respond(&cursor_shell("git log"), &claude_hook_in_cursor).is_none());
    assert!(respond(&bash("git log"), &claude_hook_in_cursor).is_none());

    let mut cursor_hook_in_claude = env(true, "claude");
    cursor_hook_in_claude.target = Target::Cursor;
    assert!(respond(&bash("git log"), &cursor_hook_in_claude).is_none());
}

#[test]
fn a_cli_switched_off_in_settings_is_left_alone() {
    let mut only_claude = cursor_env();
    only_claude.config.clis = vec!["claude".to_string()];
    assert!(respond(&cursor_shell("git log"), &only_claude).is_none());
}

fn bash(command: &str) -> Value {
    json!({
        "hook_event_name": "PreToolUse",
        "tool_name": "Bash",
        "tool_input": { "command": command, "description": "Show history" }
    })
}

#[test]
fn rewrites_a_large_output_command_and_keeps_the_rest_of_the_input() {
    let reply = respond(&bash("git log --oneline"), &env(true, "claude")).unwrap();
    let output = &reply["hookSpecificOutput"];
    assert_eq!(output["hookEventName"], "PreToolUse");
    let command = output["updatedInput"]["command"].as_str().unwrap();
    assert!(command.starts_with("'/opt/polakapi' ctx exec --source 'read:"));
    assert!(command.contains("bash -c"));
    assert!(command.contains("git log --oneline"));
    // The description the agent wrote survives the rewrite.
    assert_eq!(output["updatedInput"]["description"], "Show history");
}

#[test]
fn never_grants_permission_on_the_users_behalf() {
    let reply = respond(&bash("git log"), &env(true, "claude")).unwrap();
    assert!(reply["hookSpecificOutput"]
        .get("permissionDecision")
        .is_none());
}

#[test]
fn leaves_commands_that_change_the_shell_or_print_little() {
    assert!(respond(&bash("mkdir -p out"), &env(true, "claude")).is_none());
    assert!(respond(&bash("cd src && cat main.rs"), &env(true, "claude")).is_none());
}

#[test]
fn does_nothing_outside_a_polakapi_terminal() {
    let mut outside = env(true, "claude");
    outside.in_polakapi_terminal = false;
    assert!(respond(&bash("git log"), &outside).is_none());
}

#[test]
fn does_nothing_when_context_mode_is_off_or_this_cli_is_not_enabled() {
    assert!(respond(&bash("git log"), &env(false, "claude")).is_none());
    let mut claude_off = env(true, "claude");
    claude_off.config.clis = vec!["cursor".to_string()];
    assert!(respond(&bash("git log"), &claude_off).is_none());
}

#[test]
fn ignores_other_tools_and_background_commands() {
    let read = json!({
        "hook_event_name": "PreToolUse",
        "tool_name": "Read",
        "tool_input": { "file_path": "/a" }
    });
    assert!(respond(&read, &env(true, "claude")).is_none());

    let background = json!({
        "hook_event_name": "PreToolUse",
        "tool_name": "Bash",
        "tool_input": { "command": "git log", "run_in_background": true }
    });
    assert!(respond(&background, &env(true, "claude")).is_none());
}

#[test]
fn session_start_teaches_the_model_how_to_query_what_was_stored() {
    let reply = respond(
        &json!({ "hook_event_name": "SessionStart", "source": "startup" }),
        &env(true, "claude"),
    )
    .unwrap();
    let text = reply["hookSpecificOutput"]["additionalContext"]
        .as_str()
        .unwrap();
    assert_eq!(reply["hookSpecificOutput"]["hookEventName"], "SessionStart");
    // Absolute path: `polakapi` is not guaranteed to be on PATH.
    assert!(text.contains("'/opt/polakapi' ctx search"));
    assert!(text.contains("ctx read"));
}

#[test]
fn unknown_events_and_malformed_input_produce_nothing() {
    assert!(respond(&json!({ "hook_event_name": "Stop" }), &env(true, "claude")).is_none());
    assert!(respond(&json!({}), &env(true, "claude")).is_none());
    assert!(respond(
        &json!({ "hook_event_name": "PreToolUse", "tool_name": "Bash" }),
        &env(true, "claude")
    )
    .is_none());
}

#[test]
fn the_latest_rename_of_this_session_wins() {
    let dir = tempfile::tempdir().unwrap();
    let transcript = dir.path().join("t.jsonl");
    std::fs::write(
        &transcript,
        [
            r#"{"type":"user","message":"custom-title in a prompt"}"#,
            r#"{"type":"custom-title","customTitle":"first","sessionId":"s-1"}"#,
            r#"{"type":"custom-title","customTitle":"other","sessionId":"s-2"}"#,
            r#"{"type":"custom-title","customTitle":"Ekim NPCs","sessionId":"s-1"}"#,
        ]
        .join("\n"),
    )
    .unwrap();
    assert_eq!(
        custom_title(&transcript, "s-1").as_deref(),
        Some("Ekim NPCs")
    );
    assert_eq!(custom_title(&transcript, "s-3"), None);
    assert_eq!(custom_title(&dir.path().join("missing.jsonl"), "s-1"), None);
}
