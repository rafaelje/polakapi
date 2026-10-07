use std::io::{BufRead, BufReader, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{json, Value};

// Client half of the control channel, used by `polakapi app-mcp`. The control
// file is re-read on every call: the app rewrites it with a fresh port and
// token each launch, and the MCP process may outlive one of those launches.

const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
const CALL_TIMEOUT: Duration = Duration::from_secs(200);

pub struct ControlClient {
    file: PathBuf,
}

#[derive(Debug)]
struct Endpoint {
    addr: SocketAddr,
    token: String,
    pid: Option<u64>,
}

impl ControlClient {
    pub fn new(file: impl Into<PathBuf>) -> Self {
        Self { file: file.into() }
    }

    fn endpoint(&self) -> Result<Endpoint, String> {
        read_endpoint(&self.file)
    }

    pub fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        let endpoint = self.endpoint()?;
        let stream = TcpStream::connect_timeout(&endpoint.addr, CONNECT_TIMEOUT).map_err(|_| {
            match endpoint.pid {
                Some(pid) => format!(
                    "the polakapi instance that launched this agent (pid {pid}) is not answering; restart the agent from the running polakapi"
                ),
                None => "polakapi is not running (control port unreachable)".to_string(),
            }
        })?;
        stream
            .set_read_timeout(Some(CALL_TIMEOUT))
            .map_err(|e| format!("control socket: {e}"))?;
        let mut writer = stream
            .try_clone()
            .map_err(|e| format!("control socket: {e}"))?;
        let request = json!({ "token": endpoint.token, "method": method, "params": params });
        writeln!(writer, "{request}").map_err(|e| format!("control write: {e}"))?;
        writer.flush().map_err(|e| format!("control write: {e}"))?;

        let mut line = String::new();
        BufReader::new(stream)
            .read_line(&mut line)
            .map_err(|e| format!("control read: {e}"))?;
        if line.trim().is_empty() {
            return Err("polakapi closed the control connection".to_string());
        }
        let response: Value =
            serde_json::from_str(line.trim()).map_err(|e| format!("control response: {e}"))?;
        if response.get("ok").and_then(Value::as_bool) == Some(true) {
            Ok(response.get("result").cloned().unwrap_or(Value::Null))
        } else {
            Err(response
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("control request failed")
                .to_string())
        }
    }
}

fn read_endpoint(path: &Path) -> Result<Endpoint, String> {
    let raw = std::fs::read_to_string(path).map_err(|_| {
        format!(
            "the polakapi instance that launched this agent is no longer running (no control file at {}); restart the agent from the running polakapi",
            path.display()
        )
    })?;
    let parsed: Value =
        serde_json::from_str(&raw).map_err(|e| format!("control file is malformed: {e}"))?;
    let port = parsed
        .get("port")
        .and_then(Value::as_u64)
        .and_then(|port| u16::try_from(port).ok())
        .ok_or_else(|| "control file has no port".to_string())?;
    let token = parsed
        .get("token")
        .and_then(Value::as_str)
        .filter(|token| !token.is_empty())
        .ok_or_else(|| "control file has no token".to_string())?
        .to_string();
    Ok(Endpoint {
        addr: SocketAddr::from(([127, 0, 0, 1], port)),
        token,
        pid: parsed.get("pid").and_then(Value::as_u64),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_port_and_token() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("agent-control.json");
        std::fs::write(&path, r#"{"port": 5555, "token": "abc"}"#).unwrap();
        let endpoint = read_endpoint(&path).unwrap();
        assert_eq!(endpoint.addr.port(), 5555);
        assert_eq!(endpoint.token, "abc");
    }

    #[test]
    fn missing_file_reports_app_not_running() {
        let err = read_endpoint(Path::new("/nonexistent/agent-control.json")).unwrap_err();
        assert!(err.contains("no longer running"));
    }
}
