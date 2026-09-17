use std::io::Read;

use serde_json::{json, Value};

use crate::ctx::config::{self, CtxConfig};
use crate::ctx::intercept;

// `polakapi ctx-hook` — the Claude Code hook that puts context mode in the
// agent's path.
//
//   PreToolUse   rewrites a Bash command known to produce large output so it
//                runs through `polakapi ctx exec`, which stores the output and
//                hands the model a summary or a pointer instead.
//   SessionStart tells the model the offloaded output exists and how to query it,
//                because a pointer it cannot resolve is worse than no pointer.
//
// PostToolUse is deliberately absent: it runs after the output already reached
// the model and cannot replace it for built-in tools.
//
// The hook lives in the user's global settings, so it also fires in Claude
// sessions started outside polakapi. Every path therefore fails open: no
// polakapi terminal, context mode off for this CLI, unparsable input or any
// error all mean "print nothing and exit 0", which leaves Claude untouched.

pub fn run() -> i32 {
    let mut input = String::new();
    if std::io::stdin().read_to_string(&mut input).is_err() {
        return 0;
    }
    let Ok(event) = serde_json::from_str::<Value>(&input) else {
        return 0;
    };
    let Ok(bin) = std::env::current_exe() else {
        return 0;
    };
    let env = HookEnv {
        in_polakapi_terminal: std::env::var_os("POLAKAPI_PTY_ID").is_some(),
        cli: std::env::var("POLAKAPI_CLI").unwrap_or_default(),
        config: config::load_from_env(),
        bin: bin.to_string_lossy().into_owned(),
    };
    if let Some(reply) = respond(&event, &env) {
        println!("{reply}");
    }
    0
}

pub struct HookEnv {
    pub in_polakapi_terminal: bool,
    pub cli: String,
    pub config: CtxConfig,
    pub bin: String,
}

/// The whole decision, free of I/O so it can be tested directly.
pub fn respond(event: &Value, env: &HookEnv) -> Option<Value> {
    if !env.in_polakapi_terminal || !env.config.enabled_for(&env.cli) {
        return None;
    }
    match event.get("hook_event_name").and_then(Value::as_str)? {
        "PreToolUse" => pre_tool_use(event, &env.bin),
        "SessionStart" => Some(json!({
            "hookSpecificOutput": {
                "hookEventName": "SessionStart",
                "additionalContext": instructions(&env.bin),
            }
        })),
        _ => None,
    }
}

fn pre_tool_use(event: &Value, bin: &str) -> Option<Value> {
    if event.get("tool_name").and_then(Value::as_str) != Some("Bash") {
        return None;
    }
    let input = event.get("tool_input")?;
    // A background command reports through a different channel; leave it be.
    if input.get("run_in_background").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    let command = input.get("command").and_then(Value::as_str)?;
    let kind = intercept::classify_command(command)?;

    // Send back the whole input with only the command replaced, so the result
    // is the same whether Claude merges or replaces `updatedInput`. No
    // permissionDecision: the rewritten command goes through the user's normal
    // approval flow instead of skipping it.
    let mut updated = input.clone();
    updated["command"] = Value::String(intercept::rewrite(bin, command, kind));
    Some(json!({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "updatedInput": updated,
        }
    }))
}

fn instructions(bin: &str) -> String {
    let polakapi = intercept::shell_quote(bin);
    format!(
        "polakapi context mode is on in this terminal.\n\
         Some shell commands that produce large output (git log/diff/show, gh, cat, find, \
         grep -r, curl, logs) run through polakapi, which stores the output outside your \
         context. Instead of the raw output you get either a summary or a line starting \
         \"Indexed N sections … from: <source>\". A failing command still ends with \
         \"Exit status N.\"\n\
         To see stored output:\n\
         - {polakapi} ctx search <query> [--source <source>]  ranked matches\n\
         - {polakapi} ctx read <source> <n>                   one section verbatim\n\
         - {polakapi} ctx list                                everything stored this session\n\
         Search before re-running a command just to see its output again."
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(enabled: bool, cli: &str) -> HookEnv {
        HookEnv {
            in_polakapi_terminal: true,
            cli: cli.to_string(),
            config: CtxConfig {
                enabled,
                clis: vec!["claude".to_string()],
                ..CtxConfig::default()
            },
            bin: "/opt/polakapi".to_string(),
        }
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
        assert!(command.ends_with("'git log --oneline'"));
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
    fn leaves_ordinary_commands_alone() {
        assert!(respond(&bash("cargo test"), &env(true, "claude")).is_none());
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
        assert!(respond(&bash("git log"), &env(true, "codex")).is_none());
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
}
