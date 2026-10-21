use serde_json::Value;

use super::config::Focus;

// Projects as the chat sees them: `/projects`, `/active`, `/project`, and the
// lookup that turns "polakapi", "3" or an id into one project. Everything is
// read from the `polakapi_overview` tool result, so no model is involved.

#[derive(Debug, Clone, PartialEq)]
pub struct ProjectRow {
    pub id: String,
    pub name: String,
    pub path: String,
    pub workspace: String,
    pub live: u64,
    pub activity: String,
    /// The project selected in polakapi's window.
    pub selected: bool,
}

impl ProjectRow {
    pub fn focus(&self) -> Focus {
        Focus {
            id: self.id.clone(),
            name: self.name.clone(),
            path: self.path.clone(),
        }
    }

    /// Has a live terminal, or printed output recently.
    pub fn is_active(&self) -> bool {
        self.live > 0 || matches!(self.activity.as_str(), "working" | "ready" | "recent")
    }
}

fn text(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn array<'a>(value: &'a Value, key: &str) -> impl Iterator<Item = &'a Value> {
    value
        .get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
}

/// Every project in sidebar order: workspace by workspace, folders first.
pub fn rows(overview: &Value) -> Vec<ProjectRow> {
    let selected = overview.get("activeProjectId").and_then(Value::as_str);
    let mut out = Vec::new();
    for workspace in array(overview, "workspaces") {
        let workspace_name = text(workspace, "name");
        let folders = array(workspace, "folders").flat_map(|folder| array(folder, "projects"));
        for project in folders.chain(array(workspace, "projects")) {
            let id = text(project, "id");
            out.push(ProjectRow {
                selected: selected == Some(id.as_str()),
                id,
                name: text(project, "name"),
                path: text(project, "path"),
                workspace: workspace_name.clone(),
                live: project
                    .get("liveTerminals")
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
                activity: project
                    .get("activity")
                    .and_then(Value::as_str)
                    .unwrap_or("idle")
                    .to_string(),
            });
        }
    }
    out
}

/// Numbered like `/projects`, so "/project 3" picks the third line.
pub fn format_list(rows: &[ProjectRow], focus: Option<&Focus>, only_active: bool) -> String {
    let mut lines = Vec::new();
    let mut workspace = None;
    for (index, row) in rows.iter().enumerate() {
        if only_active && !row.is_active() {
            continue;
        }
        if workspace != Some(row.workspace.as_str()) {
            workspace = Some(row.workspace.as_str());
            lines.push(format!("▸ {}", row.workspace));
        }
        let marker = if focus.is_some_and(|focus| focus.id == row.id) {
            "◉"
        } else {
            "•"
        };
        let terminals = match row.live {
            0 => "no terminals".to_string(),
            1 => "1 terminal".to_string(),
            n => format!("{n} terminals"),
        };
        lines.push(format!(
            "{:>3}. {marker} {} — {terminals}, {}",
            index + 1,
            row.name,
            row.activity
        ));
    }
    if lines.is_empty() {
        return if only_active {
            "No active projects: nothing has a live terminal right now.".to_string()
        } else {
            "No projects yet.".to_string()
        };
    }
    lines.push(String::new());
    lines.push(
        "◉ marks this chat's project. /project <number or name> switches to another.".to_string(),
    );
    lines.join("\n")
}

/// By list number, id, path, exact name, then a unique partial name.
pub fn find<'a>(rows: &'a [ProjectRow], query: &str) -> Result<&'a ProjectRow, String> {
    let query = query.trim();
    if query.is_empty() {
        return Err("which project?".to_string());
    }
    if let Ok(number) = query.parse::<usize>() {
        return rows
            .get(number.wrapping_sub(1))
            .ok_or_else(|| format!("there is no project number {number}; see /projects"));
    }
    let lower = query.to_lowercase();
    if let Some(row) = rows
        .iter()
        .find(|row| row.id == query || row.path == query)
        .or_else(|| rows.iter().find(|row| row.name.to_lowercase() == lower))
    {
        return Ok(row);
    }
    let partial: Vec<&ProjectRow> = rows
        .iter()
        .filter(|row| row.name.to_lowercase().contains(&lower))
        .collect();
    match partial.as_slice() {
        [one] => Ok(one),
        [] => Err(format!("no project matches \"{query}\"; see /projects")),
        many => Err(format!(
            "\"{query}\" matches {}: {}",
            many.len(),
            many.iter()
                .map(|row| row.name.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn overview() -> Value {
        json!({
            "activeProjectId": "p1",
            "workspaces": [{
                "name": "work",
                "folders": [{ "name": "clients", "projects": [
                    { "id": "p2", "name": "shop-front", "path": "/w/shop-front", "liveTerminals": 0, "activity": "idle" },
                    { "id": "p3", "name": "shop-api", "path": "/w/shop-api", "liveTerminals": 0, "activity": "recent" }
                ]}],
                "projects": [
                    { "id": "p1", "name": "polakapi", "path": "/w/polakapi", "liveTerminals": 3, "activity": "working" }
                ]
            }]
        })
    }

    #[test]
    fn flattens_in_sidebar_order() {
        let rows = rows(&overview());
        let names: Vec<&str> = rows.iter().map(|row| row.name.as_str()).collect();
        assert_eq!(names, ["shop-front", "shop-api", "polakapi"]);
        assert!(rows[2].selected);
        assert!(!rows[0].is_active());
        assert!(rows[1].is_active());
    }

    #[test]
    fn lists_all_or_only_active_projects() {
        let rows = rows(&overview());
        let focus = rows[2].focus();
        let all = format_list(&rows, Some(&focus), false);
        assert!(all.starts_with("▸ work\n  1. • shop-front — no terminals, idle\n"));
        assert!(all.contains("  3. ◉ polakapi — 3 terminals, working"));
        let active = format_list(&rows, None, true);
        assert!(!active.contains("shop-front"));
        assert!(active.contains("  2. • shop-api"));
        assert_eq!(
            format_list(&rows[..1], None, true),
            "No active projects: nothing has a live terminal right now."
        );
    }

    #[test]
    fn finds_projects_by_number_name_id_path_or_unique_part() {
        let rows = rows(&overview());
        assert_eq!(find(&rows, "3").unwrap().id, "p1");
        assert_eq!(find(&rows, "Polakapi").unwrap().id, "p1");
        assert_eq!(find(&rows, "p2").unwrap().name, "shop-front");
        assert_eq!(find(&rows, "/w/shop-api").unwrap().id, "p3");
        assert_eq!(find(&rows, "front").unwrap().id, "p2");
        assert!(find(&rows, "api").unwrap_err().contains("matches 2"));
        assert!(find(&rows, "shop").unwrap_err().contains("matches 2"));
        assert!(find(&rows, "9").is_err());
        assert!(find(&rows, "0").is_err());
        assert!(find(&rows, "nope").is_err());
    }
}
