use std::io::Read;

use serde_json::{json, Value};

use crate::ctx::config::{self, CtxConfig};
use crate::ctx::intercept;

// `polakapi ctx-hook --for <cli>` — the hook that puts context mode in the
// agent's path, for Claude Code and for the Cursor CLI.
//
//   pre-tool-use   rewrites a shell command known to produce large output so it
//                  runs through `polakapi ctx exec`, which stores the output and
//                  hands the model a summary or a pointer instead.
//   session-start  tells the model the offloaded output exists and how to query
//                  it, because a pointer it cannot resolve is worse than none.
//
// Both CLIs were verified against real sessions: each honours the rewrite without
// a permission decision, and each surfaces session-start context to the model.
// They differ in spelling — Claude sends `PreToolUse`/`Bash` and expects
// `hookSpecificOutput`; Cursor sends `preToolUse`/`Shell` and expects
// `updated_input` / `additional_context` at the top level.
//
// `--for` exists because the Cursor CLI also runs the hooks in Claude's settings
// file. Each installed hook acts only under the CLI it was installed for, so
// running both CLIs never applies a rewrite twice.
//
// Post-tool-use is deliberately absent: it runs after the output reached the
// model and cannot replace it for built-in tools.
//
// The hooks live in global settings, so they also fire in sessions started
// outside polakapi. Every path therefore fails open: no polakapi terminal,
// context mode off, the wrong CLI, unparsable input or any error all leave the
// agent's call untouched.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Target {
    Claude,
    Cursor,
}

impl Target {
    pub fn from_arg(value: &str) -> Option<Self> {
        match value {
            "claude" => Some(Target::Claude),
            "cursor" => Some(Target::Cursor),
            _ => None,
        }
    }

    /// The id under which Settings stores this CLI's toggle.
    pub fn config_id(self) -> &'static str {
        match self {
            Target::Claude => "claude",
            Target::Cursor => "cursor",
        }
    }

    /// The `POLAKAPI_CLI` value the PTY layer sets for this CLI's binary.
    fn binary(self) -> &'static str {
        match self {
            Target::Claude => "claude",
            Target::Cursor => "cursor-agent",
        }
    }

    fn shell_tool(self) -> &'static str {
        match self {
            Target::Claude => "Bash",
            Target::Cursor => "Shell",
        }
    }
}

pub fn run(args: &[String]) -> i32 {
    let target = match args {
        [flag, value, ..] if flag == "--for" => Target::from_arg(value),
        _ => Some(Target::Claude),
    };
    let Some(target) = target else {
        return 0;
    };
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
    record_session_start(&event);
    let env = HookEnv {
        target,
        in_polakapi_terminal: std::env::var_os("POLAKAPI_PTY_ID").is_some(),
        cli: caller_cli(&event),
        config: config::load_from_env(),
        bin: bin.to_string_lossy().into_owned(),
    };
    let decision = decide(&event, &env);
    log_decision(&event, &env, &decision);
    match decision {
        Ok(reply) => println!("{reply}"),
        // Cursor documents that a malformed answer to a permission hook blocks
        // the action. Empty output did not block in testing, but an empty JSON
        // object is valid under any reading of that rule.
        Err(_) if target == Target::Cursor => println!("{{}}"),
        Err(_) => {}
    }
    0
}

/// One line per invocation in polakapi.db.log, next to the capture hook's,
/// saying what was done with the command and why. Whether context mode acted
/// has to be checkable from the outside, not inferred from what the agent
/// happened to print.
fn log_decision(event: &Value, env: &HookEnv, decision: &Result<Value, String>) {
    let name = event
        .get("hook_event_name")
        .and_then(Value::as_str)
        .unwrap_or("?");
    let command = event
        .get("tool_input")
        .and_then(|input| input.get("command"))
        .and_then(Value::as_str)
        .map(|command| format!(" | {}", intercept::program_name(command)))
        .unwrap_or_default();
    let outcome = match decision {
        Ok(_) if name.eq_ignore_ascii_case("sessionstart") => "instructions sent".to_string(),
        Ok(_) => "rewritten through polakapi ctx exec".to_string(),
        Err(reason) => format!("left alone: {reason}"),
    };
    let pty = std::env::var("POLAKAPI_PTY_ID").unwrap_or_else(|_| "?".into());
    crate::capture::append_log_line(&format!(
        "{} [CTX] cli={} pty={} event={name} {outcome}{command}",
        crate::capture::now_ts(),
        env.cli,
        pty
    ));
}

/// Notes which CLI session just started in this terminal, so the store and the
/// /context window follow `/clear` and new sessions instead of showing the last
/// one. Done here as well as in the capture hook because Cursor has no capture
/// hook, and context mode must work for users who never enabled notifications.
fn record_session_start(event: &Value) {
    let starting = event
        .get("hook_event_name")
        .and_then(Value::as_str)
        .is_some_and(|name| name.eq_ignore_ascii_case("sessionstart"));
    if !starting {
        return;
    }
    let (Ok(pty_id), Some(db_path), Some(session)) = (
        std::env::var("POLAKAPI_PTY_ID"),
        std::env::var_os("POLAKAPI_DB_PATH"),
        event.get("session_id").and_then(Value::as_str),
    ) else {
        return;
    };
    let cli = caller_cli(event);
    let cwd = event
        .get("cwd")
        .and_then(Value::as_str)
        .filter(|cwd| !cwd.is_empty());
    // A failed record only costs the scoping; it must never break the session.
    let _ = crate::db::agent_session::record_start(
        std::path::Path::new(&db_path),
        &pty_id,
        &cli,
        session,
        cwd,
    );
}

/// The CLI behind this call. A CLI started by hand in a shell pane has no
/// `POLAKAPI_CLI`, so the event tells: Cursor tags its payloads with
/// `cursor_version` and spells event names in camelCase, Claude Code does not.
fn caller_cli(event: &Value) -> String {
    match std::env::var("POLAKAPI_CLI") {
        Ok(cli) if !cli.is_empty() => cli,
        _ => infer_cli(event).to_string(),
    }
}

pub fn infer_cli(event: &Value) -> &'static str {
    let camel_case = event
        .get("hook_event_name")
        .and_then(Value::as_str)
        .and_then(|name| name.chars().next())
        .is_some_and(char::is_lowercase);
    if camel_case || event.get("cursor_version").is_some() {
        Target::Cursor.binary()
    } else {
        Target::Claude.binary()
    }
}

pub struct HookEnv {
    pub target: Target,
    pub in_polakapi_terminal: bool,
    pub cli: String,
    pub config: CtxConfig,
    pub bin: String,
}

/// The whole decision, free of I/O so it can be tested directly.
pub fn respond(event: &Value, env: &HookEnv) -> Option<Value> {
    decide(event, env).ok()
}

/// The reply to print, or the reason there is none.
pub fn decide(event: &Value, env: &HookEnv) -> Result<Value, String> {
    let target = env.target;
    if !env.in_polakapi_terminal {
        return Err("outside a polakapi terminal (POLAKAPI_PTY_ID unset)".into());
    }
    if env.cli != target.binary() {
        return Err(format!(
            "installed for {}, but this session runs {}",
            target.config_id(),
            if env.cli.is_empty() {
                "an unknown CLI"
            } else {
                &env.cli
            }
        ));
    }
    if !env.config.enabled_for(target.config_id()) {
        return Err(format!(
            "context mode is off for {} in settings",
            target.config_id()
        ));
    }
    let name = event
        .get("hook_event_name")
        .and_then(Value::as_str)
        .ok_or_else(|| "event has no hook_event_name".to_string())?
        .to_ascii_lowercase();
    match name.as_str() {
        "pretooluse" => pre_tool_use(event, env),
        "sessionstart" => {
            let text = instructions(&env.bin);
            Ok(match target {
                Target::Claude => json!({
                    "hookSpecificOutput": {
                        "hookEventName": "SessionStart",
                        "additionalContext": text,
                    }
                }),
                Target::Cursor => json!({ "additional_context": text }),
            })
        }
        other => Err(format!("event {other} is not handled")),
    }
}

fn pre_tool_use(event: &Value, env: &HookEnv) -> Result<Value, String> {
    let target = env.target;
    let bin = env.bin.as_str();
    let tool = event
        .get("tool_name")
        .and_then(Value::as_str)
        .unwrap_or("?");
    if tool != target.shell_tool() {
        return Err(format!("tool {tool} is not the shell tool"));
    }
    let input = event
        .get("tool_input")
        .ok_or_else(|| "no tool_input".to_string())?;
    // A background command reports through a different channel; leave it be.
    if input.get("run_in_background").and_then(Value::as_bool) == Some(true) {
        return Err("runs in the background".into());
    }
    let command = input
        .get("command")
        .and_then(Value::as_str)
        .ok_or_else(|| "no command in tool_input".to_string())?;
    let kind = intercept::classify(command)?;

    // Send back the whole input with only the command replaced, so the result
    // is the same whether the CLI merges or replaces it. No permission decision:
    // the rewritten command goes through the user's normal approval flow.
    let mut updated = input.clone();
    updated["command"] = Value::String(intercept::rewrite(bin, command, kind));
    Ok(match target {
        Target::Claude => json!({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "updatedInput": updated,
            }
        }),
        Target::Cursor => json!({ "updated_input": updated }),
    })
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
    fn every_way_of_doing_nothing_names_its_reason() {
        let mut outside = env(true, "claude");
        outside.in_polakapi_terminal = false;
        assert!(decide(&bash("git log"), &outside)
            .unwrap_err()
            .contains("outside a polakapi terminal"));
        assert!(decide(&bash("git log"), &env(false, "claude"))
            .unwrap_err()
            .contains("off for claude"));
        assert!(decide(&bash("npm test"), &env(true, "claude"))
            .unwrap_err()
            .contains("npm is not a command"));
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
}
