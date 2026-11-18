use polakapi_lib::a2a_broker::Broker;
use polakapi_lib::a2a_mcp::codex_args;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::Duration;
use tempfile::TempDir;

const RPC_TIMEOUT: Duration = Duration::from_secs(20);

struct CodexAppServer {
    child: Child,
    stdin: ChildStdin,
    lines: Receiver<String>,
    next_id: u64,
    thread_id: Option<String>,
}

impl CodexAppServer {
    fn start(
        codex: &Path,
        polakapi: &Path,
        home: &Path,
        token: &str,
        port: u16,
    ) -> Result<Self, String> {
        let codex_home = home.join(".codex");
        std::fs::create_dir_all(&codex_home).map_err(|error| error.to_string())?;
        let mut command = Command::new(codex);
        command
            .args(codex_args(&polakapi.to_string_lossy()))
            .args([
                "-c",
                "analytics.enabled=false",
                "-c",
                "model_provider=\"offline\"",
                "-c",
                "model_providers.offline.name=\"Local closed-port test provider\"",
                "-c",
                "model_providers.offline.base_url=\"http://127.0.0.1:9/v1\"",
                "-c",
                "model_providers.offline.wire_api=\"responses\"",
                "app-server",
                "--listen",
                "stdio://",
            ])
            .env_clear()
            .env("HOME", home)
            .env("CODEX_HOME", codex_home)
            .env("XDG_CONFIG_HOME", home.join(".config"))
            .env("XDG_CACHE_HOME", home.join(".cache"))
            .env("CODEX_DISABLE_TELEMETRY", "1")
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .env("POLAKAPI_A2A_TOKEN", token)
            .env("POLAKAPI_A2A_PORT", port.to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut child = command
            .spawn()
            .map_err(|error| format!("could not launch isolated Codex app-server: {error}"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Codex app-server stdin was unavailable".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Codex app-server stdout was unavailable".to_string())?;
        let (sender, lines) = mpsc::channel();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                match line {
                    Ok(line) => {
                        if sender.send(line).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });
        let mut server = Self {
            child,
            stdin,
            lines,
            next_id: 1,
            thread_id: None,
        };
        server.request(
            "initialize",
            json!({"clientInfo":{"name":"polakapi-a2a-e2e","version":"1"}}),
        )?;
        server.notify("initialized", json!({}))?;
        Ok(server)
    }

    fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        self.write(&json!({"id":id,"method":method,"params":params}))?;
        loop {
            let line = self
                .lines
                .recv_timeout(RPC_TIMEOUT)
                .map_err(|error| format!("timed out waiting for Codex {method}: {error}"))?;
            let response: Value = serde_json::from_str(&line)
                .map_err(|error| format!("Codex app-server returned invalid JSON: {error}"))?;
            if response.get("id").and_then(Value::as_u64) != Some(id) {
                continue;
            }
            if let Some(error) = response.get("error") {
                return Err(format!("Codex {method} failed: {error}"));
            }
            return Ok(response.get("result").cloned().unwrap_or(Value::Null));
        }
    }

    fn notify(&mut self, method: &str, params: Value) -> Result<(), String> {
        self.write(&json!({"method":method,"params":params}))
    }

    fn write(&mut self, message: &Value) -> Result<(), String> {
        serde_json::to_writer(&mut self.stdin, message).map_err(|error| error.to_string())?;
        self.stdin
            .write_all(b"\n")
            .map_err(|error| error.to_string())?;
        self.stdin.flush().map_err(|error| error.to_string())
    }

    fn call_tool(&mut self, tool: &str, arguments: Value) -> Result<Value, String> {
        let thread_id = self
            .thread_id
            .as_deref()
            .ok_or_else(|| "Codex thread must be started before calling A2A tools".to_string())?;
        let result = self.request(
            "mcpServer/tool/call",
            json!({
                "threadId":thread_id,
                "server":"polakapi_a2a",
                "tool":tool,
                "arguments":arguments
            }),
        )?;
        if result.get("isError").and_then(Value::as_bool) == Some(true) {
            return Err(result["content"][0]["text"]
                .as_str()
                .unwrap_or("Codex reported an MCP tool error")
                .to_string());
        }
        Ok(result)
    }
}

impl Drop for CodexAppServer {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn tool_json(value: &Value) -> Value {
    let text = value["content"][0]["text"]
        .as_str()
        .expect("A2A MCP tool should return its JSON result as text");
    serde_json::from_str(text).expect("A2A MCP result should contain JSON")
}

fn executable(env_name: &str, fallback: PathBuf) -> PathBuf {
    std::env::var_os(env_name)
        .map(PathBuf::from)
        .unwrap_or(fallback)
}

#[test]
#[ignore = "requires an installed Codex CLI; runs isolated app-server processes without inference"]
fn two_real_codex_app_servers_exchange_scoped_a2a_messages() {
    let polakapi = executable(
        "POLAKAPI_A2A_BIN",
        PathBuf::from(env!("CARGO_BIN_EXE_polakapi")),
    );
    let codex = executable("CODEX_BIN", PathBuf::from("codex"));
    let temp = TempDir::new().expect("create isolated Codex homes");
    let broker = Broker::start().expect("start the production loopback broker");
    broker.configure(true, false);
    let token_a = broker.register("fixture-codex-a", "fixture-window-shared");
    let token_b = broker.register("fixture-codex-b", "fixture-window-shared");
    assert!(!token_a.is_empty() && !token_b.is_empty());

    let mut codex_a = CodexAppServer::start(
        &codex,
        &polakapi,
        &temp.path().join("codex-a"),
        &token_a,
        broker.port(),
    )
    .expect("start first real Codex app-server");
    let mut codex_b = CodexAppServer::start(
        &codex,
        &polakapi,
        &temp.path().join("codex-b"),
        &token_b,
        broker.port(),
    )
    .expect("start second real Codex app-server");

    let thread_a = codex_a
        .request("thread/start", json!({"cwd":temp.path().to_string_lossy()}))
        .expect("start local Codex thread without starting an inference turn");
    let thread_b = codex_b
        .request("thread/start", json!({"cwd":temp.path().to_string_lossy()}))
        .expect("start local Codex thread without starting an inference turn");
    codex_a.thread_id = thread_a["thread"]["id"].as_str().map(str::to_owned);
    codex_b.thread_id = thread_b["thread"]["id"].as_str().map(str::to_owned);
    assert!(
        codex_a.thread_id.is_some(),
        "Codex A should return a real thread id"
    );
    assert!(
        codex_b.thread_id.is_some(),
        "Codex B should return a real thread id"
    );

    let peers = tool_json(
        &codex_a
            .call_tool("list_peers", json!({}))
            .expect("Codex A lists peers through the configured production MCP child"),
    );
    assert!(peers["peers"]
        .as_array()
        .unwrap()
        .iter()
        .any(|peer| peer["id"] == "fixture-codex-b"));

    let context = "same-window-context";
    codex_a
        .call_tool(
            "send_message",
            json!({"target":"fixture-codex-b","text":"challenge: return ACK same-window-42","contextId":context}),
        )
        .expect("Codex A sends same-window challenge");
    let challenge = tool_json(
        &codex_b
            .call_tool("receive_messages", json!({"waitMs":2_000}))
            .expect("Codex B receives same-window challenge"),
    );
    assert_eq!(challenge["messages"][0]["from"], "fixture-codex-a");
    assert_eq!(challenge["messages"][0]["message"]["contextId"], context);
    assert_eq!(
        challenge["messages"][0]["message"]["parts"][0]["text"],
        "challenge: return ACK same-window-42"
    );
    codex_b
        .call_tool(
            "send_message",
            json!({"target":"fixture-codex-a","text":"ACK same-window-42","contextId":context}),
        )
        .expect("Codex B sends same-window ACK");
    let ack = tool_json(
        &codex_a
            .call_tool("receive_messages", json!({"waitMs":2_000}))
            .expect("Codex A receives peer ACK"),
    );
    assert_eq!(ack["messages"][0]["from"], "fixture-codex-b");
    assert_eq!(
        ack["messages"][0]["message"]["parts"][0]["text"],
        "ACK same-window-42"
    );
    println!("fixture same-window Codex B response: ACK same-window-42");

    broker.move_to("fixture-codex-b", "fixture-window-other");
    let denied = codex_a
        .call_tool(
            "send_message",
            json!({"target":"fixture-codex-b","text":"cross-window-denied","contextId":"denied-context"}),
        )
        .expect_err("window scope denies cross-window delivery");
    assert!(
        denied.contains("404") || denied.contains("not found"),
        "{denied}"
    );
    println!("fixture window-scope denial: {denied}");

    broker.configure(true, true);
    let context = "all-agents-context";
    codex_a
        .call_tool(
            "send_message",
            json!({"target":"fixture-codex-b","text":"challenge: return ACK all-agents-91","contextId":context}),
        )
        .expect("all-agent scope permits cross-window challenge");
    let challenge = tool_json(
        &codex_b
            .call_tool("receive_messages", json!({"waitMs":2_000}))
            .expect("Codex B receives cross-window challenge"),
    );
    assert_eq!(challenge["messages"][0]["from"], "fixture-codex-a");
    assert_eq!(challenge["messages"][0]["message"]["contextId"], context);
    assert_eq!(
        challenge["messages"][0]["message"]["parts"][0]["text"],
        "challenge: return ACK all-agents-91"
    );
    codex_b
        .call_tool(
            "send_message",
            json!({"target":"fixture-codex-a","text":"ACK all-agents-91","contextId":context}),
        )
        .expect("Codex B sends cross-window ACK");
    let ack = tool_json(
        &codex_a
            .call_tool("receive_messages", json!({"waitMs":2_000}))
            .expect("Codex A receives cross-window peer ACK"),
    );
    assert_eq!(ack["messages"][0]["from"], "fixture-codex-b");
    assert_eq!(ack["messages"][0]["message"]["contextId"], context);
    assert_eq!(
        ack["messages"][0]["message"]["parts"][0]["text"],
        "ACK all-agents-91"
    );
    println!("fixture all-agent cross-window Codex B response: ACK all-agents-91");
}
