use std::io::{BufRead, Write};
use std::path::PathBuf;

use serde_json::{json, Value};

use crate::ctx::config::{self, CtxConfig};
use crate::ctx::session::CtxSession;
use crate::ctx::shell::{run_shell, stored_or_raw, with_status};

// Stdio MCP server exposing the ctx_* tools. Every CLI polakapi launches speaks
// MCP, which is why the tools live here rather than behind a hook: hooks differ
// per CLI and two of the four have none at all.
//
// Wire format is newline-delimited JSON-RPC 2.0 on stdin/stdout. Nothing else
// may be written to stdout — diagnostics go to stderr or the client desyncs.

const PROTOCOL_VERSION: &str = "2024-11-05";
const DEFAULT_SEARCH_LIMIT: usize = 8;
/// Readable part of a source label, before the disambiguating hash.
const SLUG_HEAD_CHARS: usize = 24;

pub struct Server {
    session_id: String,
    project: Option<PathBuf>,
    config: CtxConfig,
    session: Option<CtxSession>,
}

impl Server {
    pub fn new(session_id: String, project: Option<PathBuf>, config: CtxConfig) -> Self {
        Self {
            session_id,
            project,
            config,
            session: None,
        }
    }

    /// Opened on first use so an unused server never creates a store.
    fn session(&mut self) -> Result<&mut CtxSession, String> {
        if self.session.is_none() {
            self.session = Some(CtxSession::open(
                &self.session_id,
                self.project.as_deref(),
                self.config.clone(),
            )?);
        }
        self.session
            .as_mut()
            .ok_or_else(|| "context session unavailable".to_string())
    }

    /// Returns `None` for notifications, which carry no id and expect no reply.
    pub fn handle(&mut self, request: &Value) -> Option<Value> {
        // No id means a notification: nothing to answer.
        let id = request.get("id").cloned()?;
        let method = request.get("method").and_then(Value::as_str).unwrap_or("");

        let result = match method {
            "initialize" => Ok(json!({
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "polakapi-ctx", "version": env!("CARGO_PKG_VERSION") },
            })),
            "ping" => Ok(json!({})),
            "tools/list" => Ok(json!({ "tools": tool_definitions() })),
            "tools/call" => self
                .call(request.get("params"))
                .map(|text| json!({ "content": [{ "type": "text", "text": text }] })),
            other => Err(format!("unknown method: {other}")),
        };

        Some(match result {
            Ok(value) => json!({ "jsonrpc": "2.0", "id": id, "result": value }),
            Err(message) => json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": -32603, "message": message },
            }),
        })
    }

    fn call(&mut self, params: Option<&Value>) -> Result<String, String> {
        let params = params.ok_or_else(|| "missing params".to_string())?;
        let name = params
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(|| "missing tool name".to_string())?;
        let empty = json!({});
        let args = params.get("arguments").unwrap_or(&empty);
        match name {
            "ctx_exec" => self.exec(args),
            "ctx_search" => self.search(args),
            "ctx_read" => self.read(args),
            "ctx_list" => self.list(),
            other => Err(format!("unknown tool: {other}")),
        }
    }

    fn exec(&mut self, args: &Value) -> Result<String, String> {
        let command = args
            .get("command")
            .and_then(Value::as_str)
            .ok_or_else(|| "ctx_exec needs a command".to_string())?;
        let source = args
            .get("source")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| format!("exec:{}", source_slug(command)));

        // The command runs where the agent is; only the store follows the
        // terminal's directory.
        let output = run_shell(command, None)?;
        let stored = self
            .session()
            .and_then(|session| session.offload(&source, &output.text));
        Ok(with_status(stored_or_raw(stored, &output), &output))
    }

    fn search(&mut self, args: &Value) -> Result<String, String> {
        let query = args
            .get("query")
            .and_then(Value::as_str)
            .ok_or_else(|| "ctx_search needs a query".to_string())?;
        let source = args.get("source").and_then(Value::as_str);
        let limit = args
            .get("limit")
            .and_then(Value::as_u64)
            .unwrap_or(DEFAULT_SEARCH_LIMIT as u64)
            .clamp(1, 50) as usize;

        let hits = self.session()?.search(query, source, limit)?;
        if hits.is_empty() {
            return Ok(format!("No matches for {query:?}."));
        }
        let mut out = vec![format!(
            "{} for {query:?}:",
            plural(hits.len(), "match", "matches")
        )];
        for hit in hits {
            let heading = hit.heading.unwrap_or_else(|| "(untitled)".into());
            out.push(format!(
                "[{}#{}] {heading}{}\n{}",
                hit.source,
                hit.ordinal,
                if hit.has_code { " (code)" } else { "" },
                hit.snippet
            ));
        }
        out.push("Use ctx_read(source, section) for the exact text of a result.".into());
        Ok(out.join("\n\n"))
    }

    fn read(&mut self, args: &Value) -> Result<String, String> {
        let source = args
            .get("source")
            .and_then(Value::as_str)
            .ok_or_else(|| "ctx_read needs a source".to_string())?
            .to_string();
        let section = args.get("section").and_then(Value::as_i64).unwrap_or(0);
        match self.session()?.read(&source, section)? {
            Some(body) => Ok(body),
            None => Err(format!("no section {section} in {source}")),
        }
    }

    fn list(&mut self) -> Result<String, String> {
        let sources = self.session()?.list()?;
        if sources.is_empty() {
            return Ok("Nothing offloaded in this session yet.".into());
        }
        let (raw, context) = self.session()?.savings()?;
        let mut out = vec![format!(
            "{} sources offloaded: {raw} bytes held out of context, {context} bytes returned.",
            sources.len()
        )];
        for source in sources {
            out.push(format!(
                "  {} ({}) — {} sections, {} bytes raw",
                source.source, source.kind, source.chunks, source.raw_bytes
            ));
        }
        Ok(out.join("\n"))
    }
}

fn tool_definitions() -> Value {
    json!([
        {
            "name": "ctx_exec",
            "description": "Run a shell command and keep its output out of the context. Large output is summarised or indexed; you get a summary or a searchable pointer back. Prefer this over a plain shell tool whenever the output could be big.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "command": { "type": "string", "description": "Shell command to run." },
                    "source": { "type": "string", "description": "Optional label to scope later searches." }
                },
                "required": ["command"]
            }
        },
        {
            "name": "ctx_search",
            "description": "Search everything offloaded in this session. Returns ranked snippets with a source and section to read.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string" },
                    "source": { "type": "string", "description": "Restrict to one source label." },
                    "limit": { "type": "integer" }
                },
                "required": ["query"]
            }
        },
        {
            "name": "ctx_read",
            "description": "Return one section verbatim, as located by ctx_search.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "source": { "type": "string" },
                    "section": { "type": "integer" }
                },
                "required": ["source", "section"]
            }
        },
        {
            "name": "ctx_list",
            "description": "List what this session has offloaded and how much context it saved.",
            "inputSchema": { "type": "object", "properties": {} }
        }
    ])
}

/// Short, readable, filesystem-safe label derived from the command.
///
/// The readable head is truncated, so a short hash of the full command is
/// appended: two different commands that start alike must not collide onto the
/// same source and overwrite each other.
pub fn source_slug(command: &str) -> String {
    let mut head = String::new();
    let mut pending_dash = false;
    for c in command.chars() {
        if c.is_ascii_alphanumeric() {
            if pending_dash && !head.is_empty() {
                head.push('-');
            }
            head.push(c.to_ascii_lowercase());
            pending_dash = false;
        } else {
            pending_dash = true;
        }
        if head.chars().count() >= SLUG_HEAD_CHARS {
            break;
        }
    }
    let digest = {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(command.as_bytes());
        format!("{:x}", hasher.finalize())
    };
    let suffix = &digest[..6];
    if head.is_empty() {
        format!("cmd-{suffix}")
    } else {
        format!("{head}-{suffix}")
    }
}

/// English plurals are irregular enough that guessing with an "s" produced
/// "4 matchs"; the caller passes both forms.
fn plural(count: usize, one: &str, many: &str) -> String {
    if count == 1 {
        format!("1 {one}")
    } else {
        format!("{count} {many}")
    }
}

/// Entry point for the `polakapi ctx-mcp` subcommand.
pub fn run() -> i32 {
    let session_id = crate::ctx::paths::session_key_from_env().unwrap_or_else(|| "unscoped".into());
    let project = crate::ctx::paths::project_dir_from_env();
    let mut server = Server::new(session_id, project, config::load_from_env());

    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines().map_while(Result::ok) {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(request) = serde_json::from_str::<Value>(&line) else {
            eprintln!("polakapi ctx-mcp: ignoring malformed request");
            continue;
        };
        let Some(response) = server.handle(&request) else {
            continue;
        };
        if writeln!(stdout, "{response}").is_err() || stdout.flush().is_err() {
            return 1;
        }
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ctx::paths::Storage;
    use crate::ctx::router::Policy;

    fn server(project: &std::path::Path) -> Server {
        Server::new(
            // Unique per test: ephemeral stores live in the shared temp
            // directory and outlive the run, so a fixed id would let one test
            // read another's leftovers.
            format!("mcp-{}", uuid::Uuid::new_v4()),
            Some(project.to_path_buf()),
            CtxConfig {
                enabled: true,
                clis: vec!["claude".to_string()],
                storage: Storage::Ephemeral,
                promote_after_sources: 99,
                policy: Policy {
                    bypass_bytes: 10,
                    externalize_bytes: 10_000,
                },
            },
        )
    }

    fn call(server: &mut Server, name: &str, args: Value) -> Value {
        server
            .handle(&json!({
                "jsonrpc": "2.0", "id": 1, "method": "tools/call",
                "params": { "name": name, "arguments": args }
            }))
            .unwrap()
    }

    fn text(response: &Value) -> String {
        response
            .pointer("/result/content/0/text")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    }

    #[test]
    fn initialize_reports_tool_capability() {
        let project = tempfile::tempdir().unwrap();
        let mut server = server(project.path());
        let response = server
            .handle(&json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize" }))
            .unwrap();
        assert_eq!(
            response.pointer("/result/protocolVersion").unwrap(),
            PROTOCOL_VERSION
        );
        assert!(response.pointer("/result/capabilities/tools").is_some());
    }

    #[test]
    fn notifications_get_no_reply() {
        let project = tempfile::tempdir().unwrap();
        assert!(server(project.path())
            .handle(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }))
            .is_none());
    }

    #[test]
    fn lists_the_four_tools() {
        let project = tempfile::tempdir().unwrap();
        let response = server(project.path())
            .handle(&json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }))
            .unwrap();
        let tools = response
            .pointer("/result/tools")
            .unwrap()
            .as_array()
            .unwrap();
        let names: Vec<&str> = tools
            .iter()
            .filter_map(|tool| tool.get("name").and_then(Value::as_str))
            .collect();
        assert_eq!(
            names,
            vec!["ctx_exec", "ctx_search", "ctx_read", "ctx_list"]
        );
    }

    #[test]
    fn an_unknown_method_is_an_error_not_a_panic() {
        let project = tempfile::tempdir().unwrap();
        let response = server(project.path())
            .handle(&json!({ "jsonrpc": "2.0", "id": 3, "method": "nope" }))
            .unwrap();
        assert!(response.pointer("/error/message").is_some());
    }

    #[cfg(unix)]
    #[test]
    fn exec_keeps_large_output_out_of_the_reply_and_makes_it_searchable() {
        let project = tempfile::tempdir().unwrap();
        let mut server = server(project.path());

        let response = call(
            &mut server,
            "ctx_exec",
            json!({ "command": "for i in $(seq 1 400); do echo \"needle line $i\"; done" }),
        );
        let reply = text(&response);
        // The 400 lines did not come back.
        assert!(reply.len() < 2_000, "reply was {} bytes", reply.len());

        let found = text(&call(
            &mut server,
            "ctx_search",
            json!({ "query": "needle" }),
        ));
        assert!(found.contains("4 matches for"), "{found}");
    }

    #[cfg(unix)]
    #[test]
    fn small_command_output_comes_straight_back() {
        let project = tempfile::tempdir().unwrap();
        let mut server = server(project.path());
        let reply = text(&call(
            &mut server,
            "ctx_exec",
            json!({ "command": "echo hello" }),
        ));
        assert_eq!(reply.trim(), "hello");
    }

    #[cfg(unix)]
    #[test]
    fn output_survives_a_store_that_cannot_be_opened() {
        let project = tempfile::tempdir().unwrap();
        let mut server = server(project.path());
        server.session_id = "../escape".to_string();
        let reply = text(&call(
            &mut server,
            "ctx_exec",
            json!({ "command": "echo kept; exit 3" }),
        ));
        assert_eq!(reply, "kept\n\nExit status 3.");
    }

    #[test]
    fn missing_arguments_are_reported() {
        let project = tempfile::tempdir().unwrap();
        let mut server = server(project.path());
        let response = call(&mut server, "ctx_exec", json!({}));
        assert!(response
            .pointer("/error/message")
            .and_then(Value::as_str)
            .unwrap()
            .contains("needs a command"));
    }

    #[test]
    fn listing_an_empty_session_says_so() {
        let project = tempfile::tempdir().unwrap();
        let mut server = server(project.path());
        assert!(text(&call(&mut server, "ctx_list", json!({}))).contains("Nothing offloaded"));
    }

    #[test]
    fn counts_read_as_english() {
        assert_eq!(plural(1, "match", "matches"), "1 match");
        assert_eq!(plural(4, "match", "matches"), "4 matches");
        assert_eq!(plural(0, "match", "matches"), "0 matches");
    }

    #[test]
    fn command_slugs_stay_filesystem_safe() {
        assert!(
            source_slug("gh issue list --json").starts_with("gh-issue-list-json-"),
            "{}",
            source_slug("gh issue list --json")
        );
        // Runs of punctuation collapse to a single dash rather than a row.
        assert!(!source_slug("gh issue list --json").contains("--"));
        assert!(source_slug("///").starts_with("cmd-"));
        assert!(source_slug(&"x".repeat(200)).chars().count() <= SLUG_HEAD_CHARS + 8);
    }

    #[test]
    fn commands_sharing_a_prefix_get_distinct_sources() {
        // Otherwise the second offload would silently overwrite the first.
        let long_a = format!("cat {}/a.txt", "very-long-directory-name".repeat(3));
        let long_b = format!("cat {}/b.txt", "very-long-directory-name".repeat(3));
        assert_ne!(source_slug(&long_a), source_slug(&long_b));
    }
}
