use super::*;

#[test]
fn reads_the_job_from_the_origin() {
    assert_eq!(job_of(&json!({ "origin": "telegram:42:job:7" })), Some(7));
    assert_eq!(job_of(&json!({ "origin": "telegram:42" })), None);
    assert_eq!(
        actions::chat_of(&json!({ "origin": "telegram:42:job:7" })),
        Some(42)
    );
}

#[test]
fn parses_permission_buttons() {
    assert_eq!(parse_callback("dlg:3:yes"), Some((3, "yes")));
    assert_eq!(parse_callback("dlg:3:all"), Some((3, "all")));
    assert_eq!(parse_callback("dlg:3:no"), Some((3, "no")));
    assert_eq!(parse_callback("dlg:3:maybe"), None);
    assert_eq!(parse_callback("act:3:yes"), None);
}

#[test]
fn lists_every_program_a_command_runs() {
    assert_eq!(programs_of("cargo test"), vec!["cargo"]);
    assert_eq!(
        programs_of("cd src && cargo fmt && git diff | head"),
        vec!["cd", "cargo", "git", "head"]
    );
    assert_eq!(programs_of("FOO=1 npm run build"), vec!["npm"]);
}

#[test]
fn permission_answers_follow_claude_code_format() {
    let input = json!({ "command": "ls" });
    assert_eq!(
        allow(&input),
        json!({ "behavior": "allow", "updatedInput": { "command": "ls" } })
    );
    assert_eq!(deny("no")["behavior"], "deny");
}

#[test]
fn durations_read_naturally() {
    assert_eq!(elapsed(Duration::from_secs(42)), "42s");
    assert_eq!(elapsed(Duration::from_secs(252)), "4m 12s");
}

#[test]
fn the_delegate_tool_has_a_valid_schema() {
    let tool = delegate_tool();
    assert_eq!(tool["name"], DELEGATE_TOOL);
    assert_eq!(tool["inputSchema"]["required"][0], "task");
}
