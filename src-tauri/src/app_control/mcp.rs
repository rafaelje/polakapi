use serde_json::{json, Value};

use super::client::ControlClient;

// Stdio MCP server for the operator agent: `polakapi app-mcp --control <file>`.
// It owns no tool logic. The catalog and every call are forwarded to the
// running app over the control channel, so the tools are defined once, next
// to the code that implements them in the main webview.

const PROTOCOL_VERSION: &str = "2024-11-05";
const CONTROL_FLAG: &str = "--control";

pub struct Server {
    client: ControlClient,
}

impl Server {
    pub fn new(client: ControlClient) -> Self {
        Self { client }
    }

    pub fn handle(&self, request: &Value) -> Option<Value> {
        let id = request.get("id").cloned()?;
        let method = request.get("method").and_then(Value::as_str).unwrap_or("");
        let result = match method {
            "initialize" => Ok(json!({
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "polakapi", "version": env!("CARGO_PKG_VERSION") },
            })),
            "ping" => Ok(json!({})),
            "tools/list" => self.list(),
            "tools/call" => self.call(request.get("params")),
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

    fn list(&self) -> Result<Value, String> {
        let result = self.client.call("tools.list", json!({}))?;
        let tools = result.get("tools").cloned().unwrap_or_else(|| json!([]));
        Ok(json!({ "tools": tools }))
    }

    /// Tool failures come back as `isError` content rather than JSON-RPC
    /// errors, so the model reads the reason and can retry with other input.
    fn call(&self, params: Option<&Value>) -> Result<Value, String> {
        let params = params.ok_or_else(|| "missing params".to_string())?;
        let name = params
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(|| "missing tool name".to_string())?;
        let arguments = params
            .get("arguments")
            .cloned()
            .unwrap_or_else(|| json!({}));
        match self.client.call(
            "tools.call",
            json!({ "name": name, "arguments": arguments }),
        ) {
            Ok(result) => {
                let text = result
                    .get("text")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| result.to_string());
                let is_error = result.get("isError").and_then(Value::as_bool) == Some(true);
                Ok(json!({
                    "content": [{ "type": "text", "text": text }],
                    "isError": is_error,
                }))
            }
            Err(message) => Ok(json!({
                "content": [{ "type": "text", "text": message }],
                "isError": true,
            })),
        }
    }
}

/// Entry point for the `polakapi app-mcp` subcommand.
pub fn run(args: &[String]) -> i32 {
    let control = args
        .windows(2)
        .find(|pair| pair[0] == CONTROL_FLAG)
        .map(|pair| pair[1].clone());
    let Some(control) = control else {
        eprintln!("polakapi app-mcp: missing {CONTROL_FLAG} <file>");
        return 2;
    };
    let server = Server::new(ControlClient::new(control));
    crate::mcp_stdio::serve("polakapi app-mcp", |request| server.handle(request))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initialize_announces_tools_capability() {
        let server = Server::new(ControlClient::new("/nonexistent/control.json"));
        let response = server
            .handle(&json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize" }))
            .unwrap();
        assert_eq!(response["result"]["serverInfo"]["name"], "polakapi");
        assert!(response["result"]["capabilities"]["tools"].is_object());
    }

    #[test]
    fn notifications_get_no_reply() {
        let server = Server::new(ControlClient::new("/nonexistent/control.json"));
        assert!(server
            .handle(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }))
            .is_none());
    }

    #[test]
    fn unreachable_app_surfaces_as_tool_error() {
        let server = Server::new(ControlClient::new("/nonexistent/control.json"));
        let response = server
            .handle(&json!({
                "jsonrpc": "2.0",
                "id": 7,
                "method": "tools/call",
                "params": { "name": "polakapi_overview", "arguments": {} }
            }))
            .unwrap();
        assert_eq!(response["result"]["isError"], true);
        let text = response["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("no longer running"));
    }
}
