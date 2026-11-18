/// Claude Code accepts MCP configuration as an inline JSON string. Keep
/// credentials out of argv and the configuration; the MCP child inherits the
/// per-pane broker capabilities from Claude's environment.
pub fn claude_args(binary: &str) -> Vec<String> {
    let config = serde_json::json!({
        "mcpServers": {
            "polakapi_a2a": {
                "command": binary,
                "args": ["a2a-mcp"]
            }
        }
    });
    // This option accepts multiple values, so the separate-token form would
    // consume every following user argument (including prompts/subcommands).
    vec![format!("--mcp-config={config}")]
}
