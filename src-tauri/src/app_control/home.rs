use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Value};
use std::sync::Arc;

use tauri::{AppHandle, Manager};

use super::server::ControlServer;

// The operator agent runs in a private directory owned by polakapi rather than
// in a user's project. Every CLI reads its MCP registration and its
// instructions from the working directory, so writing those files here is
// what makes "run claude with polakapi's tools" the same for every CLI. The
// files are rewritten on every launch to track the current binary path.

const INSTRUCTIONS: &str = include_str!("../../resources/agent-home/AGENTS.md");
pub const HOME_DIR: &str = "agent-home";
const SERVER_NAME: &str = "polakapi";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchSpec {
    pub cli: String,
    pub cwd: String,
    pub command: String,
    pub args: Vec<String>,
}

pub fn home_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not resolve app_data_dir: {e}"))?
        .join(HOME_DIR);
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    Ok(dir)
}

pub fn prepare(app: &AppHandle, cli: &str) -> Result<LaunchSpec, String> {
    let home = home_dir(app)?;
    let bin = std::env::current_exe()
        .map_err(|e| format!("resolve current exe: {e}"))?
        .to_string_lossy()
        .into_owned();
    let server = app
        .try_state::<Arc<ControlServer>>()
        .ok_or_else(|| "the agent control server is not running".to_string())?;
    let control = server.control_file().to_string_lossy().into_owned();
    prepare_in(&home, cli, &bin, &control)
}

pub fn prepare_in(home: &Path, cli: &str, bin: &str, control: &str) -> Result<LaunchSpec, String> {
    let server_args = vec![
        "app-mcp".to_string(),
        "--control".to_string(),
        control.to_string(),
    ];
    write_instructions(home)?;

    let (command, args) = match cli {
        "claude" => {
            let config = home.join("mcp").join("claude.json");
            write_json(
                &config,
                &json!({ "mcpServers": { SERVER_NAME: { "command": bin, "args": server_args } } }),
            )?;
            (
                "claude",
                vec![
                    "--mcp-config".to_string(),
                    config.to_string_lossy().into_owned(),
                    "--strict-mcp-config".to_string(),
                    "--allowedTools".to_string(),
                    format!("mcp__{SERVER_NAME}"),
                ],
            )
        }
        "codex" => (
            "codex",
            vec![
                "-c".to_string(),
                format!("mcp_servers.{SERVER_NAME}.command={}", toml_string(bin)),
                "-c".to_string(),
                format!(
                    "mcp_servers.{SERVER_NAME}.args={}",
                    toml_array(&server_args)
                ),
            ],
        ),
        "cursor" => {
            write_json(
                &home.join(".cursor").join("mcp.json"),
                &json!({ "mcpServers": { SERVER_NAME: { "command": bin, "args": server_args } } }),
            )?;
            // The directory is polakapi's own, so the trust prompt has nothing
            // to protect; answering it up front keeps the tab usable.
            (
                "cursor-agent",
                vec!["--approve-mcps".to_string(), "--trust".to_string()],
            )
        }
        "gemini" => {
            write_json(
                &home.join(".gemini").join("settings.json"),
                &json!({
                    "mcpServers": {
                        SERVER_NAME: { "command": bin, "args": server_args, "trust": true }
                    }
                }),
            )?;
            (
                "gemini",
                vec![
                    "--allowed-mcp-server-names".to_string(),
                    SERVER_NAME.to_string(),
                ],
            )
        }
        "opencode" => {
            let mut command = vec![bin.to_string()];
            command.extend(server_args.iter().cloned());
            write_json(
                &home.join("opencode.json"),
                &json!({
                    "$schema": "https://opencode.ai/config.json",
                    "mcp": { SERVER_NAME: { "type": "local", "command": command, "enabled": true } }
                }),
            )?;
            ("opencode", Vec::new())
        }
        other => return Err(format!("unsupported agent cli: {other}")),
    };

    Ok(LaunchSpec {
        cli: cli.to_string(),
        cwd: home.to_string_lossy().into_owned(),
        command: command.to_string(),
        args,
    })
}

#[derive(Debug, Clone, Copy)]
pub struct HeadlessTurn<'a> {
    pub cli: &'a str,
    pub profile: &'a str,
    pub resume: Option<&'a str>,
    pub system: Option<&'a str>,
    /// Passed to `app-mcp --origin`, e.g. `telegram:<chat id>`.
    pub origin: Option<&'a str>,
}

/// Launch spec for one non-interactive turn (the Telegram bot). The prompt is
/// written to stdin, so text that looks like a flag is never parsed as one.
/// Only CLIs whose MCP registration can be passed per process are supported:
/// the others read a shared file in the home that the agent tab also uses.
/// `system` is appended to Claude's system prompt; codex has no such flag, so
/// callers fold it into the prompt instead.
pub fn prepare_headless(
    home: &Path,
    bin: &str,
    control: &str,
    turn: &HeadlessTurn<'_>,
) -> Result<LaunchSpec, String> {
    let HeadlessTurn {
        cli,
        profile,
        resume,
        system,
        origin,
    } = *turn;
    let mut server_args = vec![
        "app-mcp".to_string(),
        "--control".to_string(),
        control.to_string(),
        "--profile".to_string(),
        profile.to_string(),
    ];
    if let Some(origin) = origin {
        server_args.extend(["--origin".to_string(), origin.to_string()]);
    }
    write_instructions(home)?;

    let (command, args) = match cli {
        "claude" => {
            // One file per origin: two chats running at once must not
            // overwrite each other's registration.
            let suffix = origin
                .map(|origin| format!("-{}", file_safe(origin)))
                .unwrap_or_default();
            let config = home
                .join("mcp")
                .join(format!("claude-{profile}{suffix}.json"));
            write_json(
                &config,
                &json!({ "mcpServers": { SERVER_NAME: { "command": bin, "args": server_args } } }),
            )?;
            let mut args = vec![
                "-p".to_string(),
                "--output-format".to_string(),
                "json".to_string(),
                "--mcp-config".to_string(),
                config.to_string_lossy().into_owned(),
                "--strict-mcp-config".to_string(),
                // Nobody can answer a permission prompt, so the built-in shell
                // and file tools are removed rather than left to the user's
                // global allow rules.
                "--tools".to_string(),
                String::new(),
                "--allowedTools".to_string(),
                format!("mcp__{SERVER_NAME}"),
            ];
            if let Some(id) = resume {
                args.extend(["--resume".to_string(), id.to_string()]);
            }
            if let Some(text) = system {
                args.extend(["--append-system-prompt".to_string(), text.to_string()]);
            }
            ("claude", args)
        }
        "codex" => {
            let mut args = vec![
                "exec".to_string(),
                "--json".to_string(),
                "--skip-git-repo-check".to_string(),
                "--sandbox".to_string(),
                "read-only".to_string(),
                "-c".to_string(),
                "approval_policy=\"never\"".to_string(),
                "-c".to_string(),
                format!("mcp_servers.{SERVER_NAME}.command={}", toml_string(bin)),
                "-c".to_string(),
                format!(
                    "mcp_servers.{SERVER_NAME}.args={}",
                    toml_array(&server_args)
                ),
            ];
            if let Some(id) = resume {
                args.extend(["resume".to_string(), id.to_string()]);
            }
            args.push("-".to_string());
            ("codex", args)
        }
        other => return Err(format!("{other} cannot run headless turns")),
    };

    Ok(LaunchSpec {
        cli: cli.to_string(),
        cwd: home.to_string_lossy().into_owned(),
        command: command.to_string(),
        args,
    })
}

/// One body under the three names the CLIs look for, so each reads the same
/// brief without import syntax that differs per CLI.
fn write_instructions(home: &Path) -> Result<(), String> {
    for name in ["AGENTS.md", "CLAUDE.md", "GEMINI.md"] {
        write_if_changed(&home.join(name), INSTRUCTIONS)?;
    }
    Ok(())
}

fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    let body = serde_json::to_string_pretty(value).map_err(|e| format!("serialize: {e}"))?;
    write_if_changed(path, &format!("{body}\n"))
}

fn write_if_changed(path: &Path, body: &str) -> Result<(), String> {
    if std::fs::read_to_string(path).ok().as_deref() == Some(body) {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("could not create {}: {e}", parent.display()))?;
    }
    std::fs::write(path, body).map_err(|e| format!("could not write {}: {e}", path.display()))
}

fn file_safe(value: &str) -> String {
    value
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

fn toml_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04X}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn toml_array(values: &[String]) -> String {
    let items: Vec<String> = values.iter().map(|v| toml_string(v)).collect();
    format!("[{}]", items.join(","))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_gets_strict_mcp_config_and_allowed_tools() {
        let dir = tempfile::tempdir().unwrap();
        let spec = prepare_in(dir.path(), "claude", "/opt/polakapi", "/data/control.json").unwrap();
        assert_eq!(spec.command, "claude");
        assert_eq!(spec.cwd, dir.path().to_string_lossy());
        assert!(spec.args.contains(&"--strict-mcp-config".to_string()));
        assert!(spec.args.contains(&"mcp__polakapi".to_string()));
        let config: Value = serde_json::from_str(
            &std::fs::read_to_string(dir.path().join("mcp/claude.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(config["mcpServers"]["polakapi"]["command"], "/opt/polakapi");
        assert_eq!(
            config["mcpServers"]["polakapi"]["args"][2],
            "/data/control.json"
        );
        assert!(dir.path().join("CLAUDE.md").is_file());
        assert!(dir.path().join("AGENTS.md").is_file());
    }

    #[test]
    fn headless_claude_uses_its_own_config_and_no_builtin_tools() {
        let dir = tempfile::tempdir().unwrap();
        let spec = prepare_headless(
            dir.path(),
            "/opt/polakapi",
            "/c.json",
            &HeadlessTurn {
                cli: "claude",
                profile: "readonly",
                resume: Some("abc"),
                system: Some("be brief"),
                origin: Some("telegram:42"),
            },
        )
        .unwrap();
        assert_eq!(&spec.args[..3], ["-p", "--output-format", "json"]);
        let tools = spec.args.iter().position(|a| a == "--tools").unwrap();
        assert_eq!(spec.args[tools + 1], "");
        assert_eq!(
            spec.args[spec.args.len() - 4..],
            ["--resume", "abc", "--append-system-prompt", "be brief"]
        );
        let config: Value = serde_json::from_str(
            &std::fs::read_to_string(dir.path().join("mcp/claude-readonly-telegram_42.json"))
                .unwrap(),
        )
        .unwrap();
        assert_eq!(config["mcpServers"]["polakapi"]["args"][4], "readonly");
        assert_eq!(config["mcpServers"]["polakapi"]["args"][6], "telegram:42");
        assert!(!dir.path().join("mcp/claude.json").exists());
    }

    #[test]
    fn headless_codex_reads_the_prompt_from_stdin() {
        let dir = tempfile::tempdir().unwrap();
        let fresh = prepare_headless(
            dir.path(),
            "/bin/p",
            "/c.json",
            &HeadlessTurn {
                cli: "codex",
                profile: "full",
                resume: None,
                system: None,
                origin: None,
            },
        )
        .unwrap();
        assert_eq!(fresh.args[0], "exec");
        assert_eq!(fresh.args.last().unwrap(), "-");
        assert!(fresh.args.contains(
            &r#"mcp_servers.polakapi.args=["app-mcp","--control","/c.json","--profile","full"]"#
                .to_string()
        ));
        let resumed = prepare_headless(
            dir.path(),
            "/bin/p",
            "/c.json",
            &HeadlessTurn {
                cli: "codex",
                profile: "full",
                resume: Some("t1"),
                system: None,
                origin: None,
            },
        )
        .unwrap();
        assert_eq!(
            resumed.args[resumed.args.len() - 3..],
            ["resume", "t1", "-"]
        );
        assert!(prepare_headless(
            dir.path(),
            "/bin/p",
            "/c.json",
            &HeadlessTurn {
                cli: "gemini",
                profile: "full",
                resume: None,
                system: None,
                origin: None,
            },
        )
        .is_err());
    }

    #[test]
    fn codex_gets_inline_toml_overrides() {
        let dir = tempfile::tempdir().unwrap();
        let spec = prepare_in(dir.path(), "codex", r#"C:\p "x"\polakapi.exe"#, "/c.json").unwrap();
        assert_eq!(
            spec.args[1],
            r#"mcp_servers.polakapi.command="C:\\p \"x\"\\polakapi.exe""#
        );
        assert_eq!(
            spec.args[3],
            r#"mcp_servers.polakapi.args=["app-mcp","--control","/c.json"]"#
        );
    }

    #[test]
    fn cursor_gemini_and_opencode_write_config_files() {
        let dir = tempfile::tempdir().unwrap();
        let cursor = prepare_in(dir.path(), "cursor", "/bin/polakapi", "/c.json").unwrap();
        assert_eq!(cursor.command, "cursor-agent");
        assert_eq!(cursor.args, vec!["--approve-mcps", "--trust"]);
        assert!(dir.path().join(".cursor/mcp.json").is_file());
        let gemini = prepare_in(dir.path(), "gemini", "/bin/polakapi", "/c.json").unwrap();
        assert_eq!(gemini.args, vec!["--allowed-mcp-server-names", "polakapi"]);
        assert!(dir.path().join(".gemini/settings.json").is_file());
        let opencode = prepare_in(dir.path(), "opencode", "/bin/polakapi", "/c.json").unwrap();
        assert!(opencode.args.is_empty());
        let config: Value = serde_json::from_str(
            &std::fs::read_to_string(dir.path().join("opencode.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(config["mcp"]["polakapi"]["command"][1], "app-mcp");
    }

    #[test]
    fn unknown_cli_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        assert!(prepare_in(dir.path(), "vim", "/bin/polakapi", "/c.json").is_err());
    }
}
