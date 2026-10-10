use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;
use serde::Serialize;
use sysinfo::{ProcessesToUpdate, System};

use crate::memory::tree_maps;

// Process cost of each agent pane: the whole PTY process tree, not just the
// shell polakapi spawned, because the CLI forks helpers that hold real memory.

const MB: u64 = 1024 * 1024;

#[derive(Debug, Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessStats {
    pub rss_mb: u64,
    pub cpu_percent: f32,
    pub uptime_secs: u64,
    pub pid: Option<u32>,
}

/// Kept across calls so sysinfo can compute CPU as a delta between two samples.
/// The first call therefore reports 0% for every pane, which is honest: there is
/// no prior sample to diff against.
fn system() -> &'static Mutex<System> {
    static SYS: OnceLock<Mutex<System>> = OnceLock::new();
    SYS.get_or_init(|| Mutex::new(System::new()))
}

/// Samples every given pane in one refresh. Panes whose process has gone away
/// come back as `ProcessStats::default()` rather than being dropped, so the
/// window can still show the row.
pub fn sample(session_pids: &[(String, u32)]) -> HashMap<String, ProcessStats> {
    let mut sys = system().lock();
    sys.refresh_processes(ProcessesToUpdate::All, true);
    let (mem_by_pid, children) = tree_maps(&sys);

    let mut cpu_by_pid: HashMap<u32, f32> = HashMap::new();
    let mut start_by_pid: HashMap<u32, u64> = HashMap::new();
    for (pid, process) in sys.processes() {
        if process.thread_kind().is_some() {
            continue;
        }
        cpu_by_pid.insert(pid.as_u32(), process.cpu_usage());
        start_by_pid.insert(pid.as_u32(), process.start_time());
    }
    drop(sys);

    let now = now_seconds();
    session_pids
        .iter()
        .map(|(id, pid)| {
            let stats = ProcessStats {
                rss_mb: tree_total(*pid, &children, |p| {
                    mem_by_pid.get(&p).copied().unwrap_or(0)
                }) / MB,
                cpu_percent: tree_total_f32(*pid, &children, |p| {
                    cpu_by_pid.get(&p).copied().unwrap_or(0.0)
                }),
                uptime_secs: start_by_pid
                    .get(pid)
                    .map(|start| now.saturating_sub(*start))
                    .unwrap_or(0),
                pid: Some(*pid),
            };
            (id.clone(), stats)
        })
        .collect()
}

fn tree_total(root: u32, children: &HashMap<u32, Vec<u32>>, value: impl Fn(u32) -> u64) -> u64 {
    let mut total = 0u64;
    walk(root, children, &mut |pid| {
        total = total.saturating_add(value(pid));
    });
    total
}

fn tree_total_f32(root: u32, children: &HashMap<u32, Vec<u32>>, value: impl Fn(u32) -> f32) -> f32 {
    let mut total = 0.0f32;
    walk(root, children, &mut |pid| total += value(pid));
    total
}

/// Depth-first over the process tree, tolerant of the parent cycles that pid
/// reuse can produce.
fn walk(root: u32, children: &HashMap<u32, Vec<u32>>, visit: &mut impl FnMut(u32)) {
    let mut seen = std::collections::HashSet::new();
    let mut stack = vec![root];
    while let Some(pid) = stack.pop() {
        if !seen.insert(pid) {
            continue;
        }
        visit(pid);
        if let Some(kids) = children.get(&pid) {
            stack.extend(kids.iter().copied());
        }
    }
}

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sums_the_whole_tree() {
        let children: HashMap<u32, Vec<u32>> = [(1u32, vec![2u32, 3]), (3, vec![4])].into();
        let mem: HashMap<u32, u64> = [(1u32, 100u64), (2, 40), (3, 60), (4, 5)].into();
        assert_eq!(
            tree_total(1, &children, |p| mem.get(&p).copied().unwrap_or(0)),
            205
        );
    }

    #[test]
    fn survives_cycles_from_pid_reuse() {
        let children: HashMap<u32, Vec<u32>> = [(1u32, vec![2u32]), (2, vec![1])].into();
        let mem: HashMap<u32, u64> = [(1u32, 10u64), (2, 20)].into();
        assert_eq!(
            tree_total(1, &children, |p| mem.get(&p).copied().unwrap_or(0)),
            30
        );
    }

    #[test]
    fn unknown_pids_count_as_zero() {
        let children: HashMap<u32, Vec<u32>> = HashMap::new();
        assert_eq!(tree_total(99, &children, |_| 7u64), 7);
        assert_eq!(tree_total_f32(99, &children, |_| 0.0), 0.0);
    }
}
