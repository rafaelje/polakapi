use serde::Serialize;

use crate::platform_command::find_in_path;

// Which agent CLIs this machine can run. The ids match the frontend's CLI
// registry; `command` is the executable the registry launches.

pub const AGENT_CLIS: &[(&str, &str, &str)] = &[
    ("claude", "Claude Code", "claude"),
    ("codex", "Codex", "codex"),
    ("cursor", "Cursor", "cursor-agent"),
    ("gemini", "Gemini", "gemini"),
    ("opencode", "OpenCode", "opencode"),
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedCli {
    pub id: String,
    pub label: String,
    pub command: String,
    pub path: Option<String>,
}

pub fn detect() -> Vec<DetectedCli> {
    AGENT_CLIS
        .iter()
        .map(|(id, label, command)| DetectedCli {
            id: (*id).to_string(),
            label: (*label).to_string(),
            command: (*command).to_string(),
            path: find_in_path(command).map(|path| path.to_string_lossy().into_owned()),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_every_supported_cli() {
        let ids: Vec<String> = detect().into_iter().map(|cli| cli.id).collect();
        assert_eq!(ids, vec!["claude", "codex", "cursor", "gemini", "opencode"]);
    }
}
