use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use serde::Serialize;
use sysinfo::{ProcessesToUpdate, System};
use tauri::State;

use crate::pty::PtyStore;

// Answers "is anything actually running inside this pane?" so closing a batch
// of terminals can warn about the ones doing work.
//
// A pane's root process is whatever polakapi spawned — a shell, or the AI CLI
// itself. An idle shell sits at its prompt with no children, so the presence of
// any descendant is the signal that something is running in there.

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningPane {
    pub pty_id: String,
    /// Name of the process found running inside the pane.
    pub command: String,
}

#[tauri::command]
pub fn pty_running_commands(store: State<'_, Arc<PtyStore>>) -> Result<Vec<RunningPane>, String> {
    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::All, true);

    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    let mut names: HashMap<u32, String> = HashMap::new();
    for (pid, process) in sys.processes() {
        // Linux lists threads as processes; they are not separate work.
        if process.thread_kind().is_some() {
            continue;
        }
        names.insert(pid.as_u32(), process.name().to_string_lossy().into_owned());
        if let Some(parent) = process.parent() {
            children
                .entry(parent.as_u32())
                .or_default()
                .push(pid.as_u32());
        }
    }

    let mut out = Vec::new();
    for (pty_id, root) in store.session_pids() {
        if let Some(command) = first_descendant(root, &children, &names) {
            out.push(RunningPane { pty_id, command });
        }
    }
    Ok(out)
}

/// Breadth-first so the name reported is the closest thing to what the user
/// started, not a deeply nested helper. Tolerates the parent cycles that pid
/// reuse can produce.
fn first_descendant(
    root: u32,
    children: &HashMap<u32, Vec<u32>>,
    names: &HashMap<u32, String>,
) -> Option<String> {
    let mut seen: HashSet<u32> = HashSet::from([root]);
    let mut queue: Vec<u32> = children.get(&root).cloned().unwrap_or_default();
    let mut index = 0;
    while index < queue.len() {
        let pid = queue[index];
        index += 1;
        if !seen.insert(pid) {
            continue;
        }
        if let Some(name) = names.get(&pid) {
            return Some(name.clone());
        }
        if let Some(kids) = children.get(&pid) {
            queue.extend(kids.iter().copied());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn maps(
        tree: &[(u32, &[u32])],
        named: &[(u32, &str)],
    ) -> (HashMap<u32, Vec<u32>>, HashMap<u32, String>) {
        let children = tree
            .iter()
            .map(|(parent, kids)| (*parent, kids.to_vec()))
            .collect();
        let names = named
            .iter()
            .map(|(pid, name)| (*pid, (*name).to_string()))
            .collect();
        (children, names)
    }

    #[test]
    fn an_idle_shell_reports_nothing() {
        let (children, names) = maps(&[], &[(1, "bash")]);
        assert_eq!(first_descendant(1, &children, &names), None);
    }

    #[test]
    fn reports_the_command_running_inside() {
        let (children, names) = maps(&[(1, &[2])], &[(1, "bash"), (2, "npm")]);
        assert_eq!(
            first_descendant(1, &children, &names).as_deref(),
            Some("npm")
        );
    }

    #[test]
    fn prefers_the_shallowest_descendant() {
        let (children, names) = maps(
            &[(1, &[2]), (2, &[3])],
            &[(1, "bash"), (2, "npm"), (3, "node")],
        );
        assert_eq!(
            first_descendant(1, &children, &names).as_deref(),
            Some("npm")
        );
    }

    #[test]
    fn survives_cycles_from_pid_reuse() {
        let (children, names) = maps(&[(1, &[2]), (2, &[1])], &[(1, "bash"), (2, "npm")]);
        assert_eq!(
            first_descendant(1, &children, &names).as_deref(),
            Some("npm")
        );
    }
}
