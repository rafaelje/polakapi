use super::*;

#[test]
fn parses_claude_full_payload() {
    let raw = r#"{
            "result": "hello world",
            "session_id": "abc-123",
            "total_cost_usd": 0.0042,
            "usage": { "input_tokens": 12, "output_tokens": 5 },
            "is_error": false
        }"#;
    let parsed = parse_claude_json(raw).unwrap();
    assert_eq!(parsed.text, "hello world");
    assert_eq!(parsed.session_id.as_deref(), Some("abc-123"));
    assert_eq!(parsed.tokens_in, Some(12));
    assert_eq!(parsed.tokens_out, Some(5));
    assert!(parsed.cost_usd.unwrap() > 0.0);
    assert!(parsed.error.is_none());
}

#[test]
fn parses_claude_with_is_error_true() {
    let raw = r#"{ "result": "failure", "is_error": true }"#;
    let parsed = parse_claude_json(raw).unwrap();
    assert_eq!(parsed.text, "failure");
    assert!(parsed.error.is_some());
}

#[test]
fn claude_malformed_json_becomes_error() {
    let parsed = parse_claude_json("not json").unwrap();
    assert!(parsed.error.is_some());
    assert!(parsed.text.is_empty());
}

#[test]
fn extracts_codex_error_from_top_level_event() {
    let stdout = concat!(
        r#"{"type":"thread.started","thread_id":"x"}"#,
        "\n",
        r#"{"type":"error","message":"{\"type\":\"error\",\"status\":400,\"error\":{\"type\":\"invalid_request_error\",\"message\":\"The 'gpt-5' model is not supported when using Codex with a ChatGPT account.\"}}"}"#,
        "\n"
    );
    let err = extract_codex_error(stdout).unwrap();
    assert!(err.contains("not supported when using Codex with a ChatGPT account"));
}

#[test]
fn extracts_codex_error_from_item_completed_error() {
    let stdout = r#"{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Model metadata for `gpt-5` not found."}}"#;
    let err = extract_codex_error(stdout).unwrap();
    assert_eq!(err, "Model metadata for `gpt-5` not found.");
}

#[test]
fn returns_none_when_no_error_present() {
    let stdout = r#"{"type":"turn.completed","usage":{"input_tokens":10}}"#;
    assert!(extract_codex_error(stdout).is_none());
}

#[test]
fn parses_codex_jsonl_extracts_usage_and_last_message() {
    let jsonl =
        "{\"msg\":{\"session_id\":\"sx\"}}\n{\"usage\":{\"input_tokens\":7,\"output_tokens\":3}}\n";
    let parsed = parse_codex_jsonl(jsonl, "final answer").unwrap();
    assert_eq!(parsed.text, "final answer");
    assert_eq!(parsed.tokens_in, Some(7));
    assert_eq!(parsed.tokens_out, Some(3));
    assert_eq!(parsed.session_id.as_deref(), Some("sx"));
}

#[test]
fn parses_opencode_current_shape_text_and_step_finish() {
    // Real shape captured from `opencode run --format json` (2026-07).
    let stream = concat!(
        r#"{"type":"step_start","sessionID":"ses_x","part":{"type":"step-start"}}"#,
        "\n",
        r#"{"type":"text","sessionID":"ses_x","part":{"type":"text","text":"```json\n{\"pass\":\"critic\"}\n```"}}"#,
        "\n",
        r#"{"type":"step_finish","sessionID":"ses_x","part":{"type":"step-finish","tokens":{"input":12860,"output":17,"reasoning":28},"cost":0.0182}}"#,
        "\n"
    );
    let parsed = parse_opencode_stream(stream).unwrap();
    assert!(parsed.text.contains("```json"));
    assert!(parsed.text.contains("\"pass\":\"critic\""));
    assert_eq!(parsed.tokens_in, Some(12860));
    assert_eq!(parsed.tokens_out, Some(17));
    assert!((parsed.cost_usd.unwrap() - 0.0182).abs() < 1e-9);
    assert_eq!(parsed.session_id.as_deref(), Some("ses_x"));
}

#[test]
fn concatenates_multiple_text_parts_in_order() {
    let stream = concat!(
        r#"{"type":"text","part":{"type":"text","text":"first "}}"#,
        "\n",
        r#"{"type":"text","part":{"type":"text","text":"second"}}"#,
        "\n"
    );
    let parsed = parse_opencode_stream(stream).unwrap();
    assert_eq!(parsed.text, "first second");
}

#[test]
fn parses_opencode_stream_with_assistant_message() {
    let stream = r#"{"role":"user","content":"hi"}
{"role":"assistant","content":"hello from opencode","usage":{"input_tokens":4,"output_tokens":6}}
"#;
    let parsed = parse_opencode_stream(stream).unwrap();
    assert_eq!(parsed.text, "hello from opencode");
    assert_eq!(parsed.tokens_in, Some(4));
    assert_eq!(parsed.tokens_out, Some(6));
}

#[test]
fn opencode_assistant_with_content_parts() {
    let stream = r#"{"role":"assistant","content":[{"text":"part one "},{"text":"part two"}]}
"#;
    let parsed = parse_opencode_stream(stream).unwrap();
    assert_eq!(parsed.text, "part one part two");
}

#[test]
fn opencode_non_jsonl_fallbacks_to_plain_text() {
    let parsed = parse_opencode_stream("just plain text\n").unwrap();
    assert_eq!(parsed.text, "just plain text");
}

#[test]
fn invocation_scope_accepts_run_prompt() {
    let tmp = tempfile::tempdir().unwrap();
    let run_prompts = tmp.path().join(".loop/runs/run-1/prompts");
    std::fs::create_dir_all(&run_prompts).unwrap();
    let prompt = run_prompts.join("analysis.md");
    std::fs::write(&prompt, "prompt").unwrap();

    let scope = validate_loop_invocation_scope(
        tmp.path().to_str().unwrap(),
        "run-1",
        ".loop",
        Some(prompt.to_str().unwrap()),
    )
    .unwrap();

    assert_eq!(scope.cwd, tmp.path().canonicalize().unwrap());
    assert_eq!(
        scope.system_prompt_path.as_deref(),
        Some(prompt.canonicalize().unwrap().to_str().unwrap())
    );
}

#[test]
fn invocation_scope_rejects_prompt_outside_run() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(tmp.path().join(".loop/runs/run-1/prompts")).unwrap();
    let prompt = tmp.path().join("analysis.md");
    std::fs::write(&prompt, "prompt").unwrap();

    let err = validate_loop_invocation_scope(
        tmp.path().to_str().unwrap(),
        "run-1",
        ".loop",
        Some(prompt.to_str().unwrap()),
    )
    .unwrap_err();

    assert!(err.contains("run prompts directory"));
}

#[test]
fn invocation_scope_rejects_unsafe_run_id() {
    let tmp = tempfile::tempdir().unwrap();
    let err = validate_loop_invocation_scope(tmp.path().to_str().unwrap(), "../x", ".loop", None)
        .unwrap_err();
    assert!(err.contains("invalid run_id"));
}

#[test]
fn invocation_scope_accepts_adversarial_root() {
    let tmp = tempfile::tempdir().unwrap();
    let run_prompts = tmp.path().join(".adversarial/runs/run-x/prompts");
    std::fs::create_dir_all(&run_prompts).unwrap();
    let prompt = run_prompts.join("adversarial-critic.md");
    std::fs::write(&prompt, "prompt").unwrap();

    let scope = validate_loop_invocation_scope(
        tmp.path().to_str().unwrap(),
        "run-x",
        ".adversarial",
        Some(prompt.to_str().unwrap()),
    )
    .unwrap();

    assert_eq!(scope.cwd, tmp.path().canonicalize().unwrap());
    assert!(scope.system_prompt_path.is_some());
}

#[test]
fn allowed_run_dir_roots() {
    assert!(is_allowed_run_dir_root(".loop"));
    assert!(is_allowed_run_dir_root(".adversarial"));
    assert!(!is_allowed_run_dir_root(".."));
    assert!(!is_allowed_run_dir_root("/etc"));
    assert!(!is_allowed_run_dir_root("loop"));
}

#[test]
fn normalizes_effort_values() {
    assert_eq!(normalize_effort(Some("high")).as_deref(), Some("high"));
    assert_eq!(normalize_effort(Some("HIGH")).as_deref(), Some("high"));
    assert_eq!(normalize_effort(Some("xhigh")).as_deref(), Some("xhigh"));
    assert_eq!(normalize_effort(Some("default")), None);
    assert_eq!(normalize_effort(Some("")), None);
    assert_eq!(normalize_effort(Some("nonsense")), None);
    assert_eq!(normalize_effort(None), None);
}
