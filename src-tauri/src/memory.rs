use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use serde::Serialize;
use sysinfo::{ProcessesToUpdate, System};
use tauri::State;

use crate::pty::PtyStore;

const MB: u64 = 1024 * 1024;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMemory {
    pub id: String,
    pub rss_mb: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryStats {
    pub total_mb: u64,
    pub available_mb: u64,
    pub sessions: Vec<SessionMemory>,
}

/// Reports system memory plus the RSS of each PTY session's process TREE —
/// AI CLIs spawn children (MCP servers, workers) that hold most of the
/// memory, so counting only the direct child would badly under-report.
#[tauri::command]
pub fn pty_memory_stats(store: State<'_, Arc<PtyStore>>) -> Result<MemoryStats, String> {
    let session_pids = store.session_pids();
    let mut sys = System::new();
    sys.refresh_memory();
    sys.refresh_processes(ProcessesToUpdate::All, true);

    let mut mem_by_pid: HashMap<u32, u64> = HashMap::new();
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for (pid, process) in sys.processes() {
        // Linux lists tasks (threads) as processes, each reporting the WHOLE
        // process RSS with parent() set to the process — counting them would
        // multiply every process by its thread count (observed 13x on a
        // claude tree with ~10 threads per node child).
        if process.thread_kind().is_some() {
            continue;
        }
        mem_by_pid.insert(pid.as_u32(), process.memory());
        if let Some(parent) = process.parent() {
            children.entry(parent.as_u32()).or_default().push(pid.as_u32());
        }
    }

    let sessions = session_pids
        .into_iter()
        .map(|(id, pid)| SessionMemory {
            id,
            rss_mb: tree_rss(pid, &mem_by_pid, &children) / MB,
        })
        .collect();

    Ok(MemoryStats {
        total_mb: sys.total_memory() / MB,
        available_mb: sys.available_memory() / MB,
        sessions,
    })
}

/// Sums memory over `root` and all its descendants. The visited set guards
/// against cycles from pid reuse between the snapshot's reads.
fn tree_rss(root: u32, mem_by_pid: &HashMap<u32, u64>, children: &HashMap<u32, Vec<u32>>) -> u64 {
    let mut total = 0u64;
    let mut visited: HashSet<u32> = HashSet::new();
    let mut stack = vec![root];
    while let Some(pid) = stack.pop() {
        if !visited.insert(pid) {
            continue;
        }
        total += mem_by_pid.get(&pid).copied().unwrap_or(0);
        if let Some(kids) = children.get(&pid) {
            stack.extend(kids.iter().copied());
        }
    }
    total
}

#[cfg(test)]
mod tests {
    use super::*;

    fn maps(
        mem: &[(u32, u64)],
        tree: &[(u32, &[u32])],
    ) -> (HashMap<u32, u64>, HashMap<u32, Vec<u32>>) {
        let mem_by_pid = mem.iter().copied().collect();
        let children = tree
            .iter()
            .map(|(parent, kids)| (*parent, kids.to_vec()))
            .collect();
        (mem_by_pid, children)
    }

    #[test]
    fn sums_root_and_descendants() {
        let (mem, kids) = maps(
            &[(1, 100), (2, 40), (3, 60), (4, 5)],
            &[(1, &[2, 3]), (3, &[4])],
        );
        assert_eq!(tree_rss(1, &mem, &kids), 205);
    }

    #[test]
    fn unknown_pids_count_as_zero() {
        let (mem, kids) = maps(&[(2, 40)], &[(1, &[2])]);
        assert_eq!(tree_rss(1, &mem, &kids), 40);
        assert_eq!(tree_rss(99, &mem, &kids), 0);
    }

    #[test]
    fn survives_cycles_from_pid_reuse() {
        let (mem, kids) = maps(&[(1, 10), (2, 20)], &[(1, &[2]), (2, &[1])]);
        assert_eq!(tree_rss(1, &mem, &kids), 30);
    }
}
