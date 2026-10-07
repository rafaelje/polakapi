use std::io::{BufRead, Write};

use serde_json::Value;

// Newline-delimited JSON-RPC 2.0 over stdin/stdout, shared by every stdio MCP
// server the binary exposes. Nothing but responses may reach stdout — any
// diagnostic goes to stderr or the client desyncs.

/// Reads requests until stdin closes. `handle` returns `None` for
/// notifications, which expect no reply. Returns the process exit code.
pub fn serve(label: &str, mut handle: impl FnMut(&Value) -> Option<Value>) -> i32 {
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines().map_while(Result::ok) {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(request) = serde_json::from_str::<Value>(&line) else {
            eprintln!("{label}: ignoring malformed request");
            continue;
        };
        let Some(response) = handle(&request) else {
            continue;
        };
        if writeln!(stdout, "{response}").is_err() || stdout.flush().is_err() {
            return 1;
        }
    }
    0
}
