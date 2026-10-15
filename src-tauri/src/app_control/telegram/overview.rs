use serde_json::Value;

// `/status` answers from the live app without spending model tokens: the
// `polakapi_overview` tool result, flattened into a few readable lines.

pub fn format_overview(value: &Value) -> String {
    let active = value.get("activeProjectId").and_then(Value::as_str);
    let mut lines = Vec::new();
    let project_line = |project: &Value, indent: &str| {
        let name = project.get("name").and_then(Value::as_str).unwrap_or("?");
        let marker = if project.get("id").and_then(Value::as_str) == active && active.is_some() {
            "★"
        } else {
            "•"
        };
        let live = project
            .get("liveTerminals")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let activity = project
            .get("activity")
            .and_then(Value::as_str)
            .unwrap_or("idle");
        format!("{indent}{marker} {name} — {live} terminals, {activity}")
    };
    for workspace in value
        .get("workspaces")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let name = workspace.get("name").and_then(Value::as_str).unwrap_or("?");
        lines.push(format!("▸ {name}"));
        for folder in workspace
            .get("folders")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let folder_name = folder.get("name").and_then(Value::as_str).unwrap_or("?");
            lines.push(format!("  ▹ {folder_name}"));
            for project in folder
                .get("projects")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                lines.push(project_line(project, "    "));
            }
        }
        for project in workspace
            .get("projects")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            lines.push(project_line(project, "  "));
        }
    }
    if lines.is_empty() {
        "No workspaces yet.".to_string()
    } else {
        lines.join("\n")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn overview_is_readable() {
        let value = json!({
            "activeProjectId": "p1",
            "workspaces": [{
                "name": "work",
                "folders": [{ "name": "clients", "projects": [
                    { "id": "p2", "name": "shop", "liveTerminals": 0, "activity": "idle" }
                ]}],
                "projects": [
                    { "id": "p1", "name": "polakapi", "liveTerminals": 3, "activity": "working" }
                ]
            }]
        });
        assert_eq!(
            format_overview(&value),
            "▸ work\n  ▹ clients\n    • shop — 0 terminals, idle\n  ★ polakapi — 3 terminals, working"
        );
        assert_eq!(format_overview(&json!({})), "No workspaces yet.");
    }
}
