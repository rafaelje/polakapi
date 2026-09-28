use std::ffi::OsStr;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};

/// Which changes under a watched root are relevant. `Project` is the project
/// itself; `Git` is a git directory that lives outside it (linked worktrees,
/// submodules, separate git dirs), where `state` is the directory holding
/// this checkout's `index` and `HEAD`, relative to the watched root.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Scope {
    Project,
    Git { state: Option<PathBuf> },
}

impl Scope {
    pub(crate) fn is_relevant(&self, relative: &Path) -> bool {
        let parts = normal_parts(relative);
        match self {
            Self::Project => !is_ignored_parts(&parts),
            Self::Git { state } => {
                is_branch_ref(&parts)
                    || state.as_deref().is_some_and(|state| {
                        let state = normal_parts(state);
                        parts.len() == state.len() + 1
                            && parts.starts_with(&state)
                            && is_state_file(parts[state.len()])
                    })
            }
        }
    }

    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    pub(crate) fn should_watch_dir(&self, relative: &Path) -> bool {
        let parts = normal_parts(relative);
        match self {
            Self::Project => match parts.split_first() {
                Some((first, rest)) if *first == ".git" => is_git_dir_to_watch(rest),
                _ => !is_ignored_parts(&parts),
            },
            Self::Git { state } => {
                is_git_dir_to_watch(&parts)
                    || state
                        .as_deref()
                        .is_some_and(|state| normal_parts(state).starts_with(&parts))
            }
        }
    }
}

fn is_ignored_parts(parts: &[&OsStr]) -> bool {
    match parts.split_first() {
        Some((first, rest)) if *first == ".git" => {
            !(matches!(rest, [name] if is_state_file(name)) || is_branch_ref(rest))
        }
        _ => parts
            .iter()
            .any(|part| *part == "node_modules" || *part == "target" || *part == ".git"),
    }
}

fn is_state_file(name: &OsStr) -> bool {
    name == "index" || name == "HEAD"
}

fn is_branch_ref(parts: &[&OsStr]) -> bool {
    parts.len() > 2 && parts[0] == "refs" && parts[1] == "heads"
}

fn is_git_dir_to_watch(parts: &[&OsStr]) -> bool {
    match parts {
        [] => true,
        [refs] => *refs == "refs",
        [refs, heads, ..] => *refs == "refs" && *heads == "heads",
    }
}

fn normal_parts(relative: &Path) -> Vec<&OsStr> {
    relative
        .components()
        .filter_map(|component| match component {
            Component::Normal(part) => Some(part),
            _ => None,
        })
        .collect()
}

/// The roots to watch for `root`: the project itself, plus its git
/// directories when they do not live at `<root>/.git`.
pub(crate) fn watch_roots(root: &Path) -> Vec<(PathBuf, Scope)> {
    let mut roots = vec![(root.to_path_buf(), Scope::Project)];
    if let (Ok(canonical), Some((git_dir, common_dir))) = (root.canonicalize(), git_dirs(root)) {
        roots.extend(git_roots(&canonical, git_dir, common_dir));
    }
    roots
}

pub(crate) fn git_roots(
    root: &Path,
    git_dir: PathBuf,
    common_dir: PathBuf,
) -> Vec<(PathBuf, Scope)> {
    if git_dir == root.join(".git") {
        return Vec::new();
    }
    let state = git_dir
        .strip_prefix(&common_dir)
        .ok()
        .map(Path::to_path_buf);
    let separate = state.is_none();
    let mut roots = vec![(common_dir, Scope::Git { state })];
    if separate {
        roots.push((
            git_dir,
            Scope::Git {
                state: Some(PathBuf::new()),
            },
        ));
    }
    roots
}

fn git_dirs(root: &Path) -> Option<(PathBuf, PathBuf)> {
    let output = Command::new("git")
        .args(["rev-parse", "--absolute-git-dir", "--git-common-dir"])
        .current_dir(root)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8(output.stdout).ok()?;
    let mut lines = text.lines();
    let git_dir = PathBuf::from(lines.next()?).canonicalize().ok()?;
    let common_dir = root.join(lines.next()?).canonicalize().ok()?;
    Some((git_dir, common_dir))
}

#[cfg(test)]
mod tests;
