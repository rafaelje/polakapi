//! Control channel for the operator agent (the bottom panel's "agent" tab).
//!
//! - `server`: loopback TCP endpoint inside the app; relays each request to
//!   the main webview and waits for its answer.
//! - `client` + `mcp`: the `polakapi app-mcp` subcommand the CLI spawns,
//!   which turns MCP tool calls into control requests.
//! - `home`: the private working directory with per-CLI MCP registration.
//! - `detect`: which agent CLIs are installed.

pub mod client;
pub mod detect;
pub mod home;
pub mod mcp;
pub mod server;

use std::sync::Arc;

use serde_json::Value;
use tauri::{AppHandle, State};

use self::server::{ControlServer, Reply};

#[tauri::command]
pub fn app_control_set_ready(server: State<'_, Arc<ControlServer>>, ready: bool) {
    server.set_ready(ready);
}

#[tauri::command]
pub fn app_control_respond(
    server: State<'_, Arc<ControlServer>>,
    id: u64,
    ok: bool,
    payload: Value,
) -> Result<(), String> {
    if server.resolve(id, Reply { ok, payload }) {
        Ok(())
    } else {
        Err(format!("no pending control request with id {id}"))
    }
}

#[tauri::command]
pub fn agent_home_prepare(app: AppHandle, cli: String) -> Result<home::LaunchSpec, String> {
    home::prepare(&app, &cli)
}

#[tauri::command(async)]
pub fn agent_cli_detect() -> Vec<detect::DetectedCli> {
    detect::detect()
}
