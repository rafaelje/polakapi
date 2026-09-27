use std::path::{Component, Path, PathBuf};

use super::blocking;
use super::git::{git_stdout, git_with_pathspec, has_head, lossy, nul_records};
use super::paths::{literal_pathspec, pathspec};
use crate::git_review::validate_repo_path;

#[tauri::command]
pub async fn code_review_discard(project_path: String, paths: Vec<String>) -> Result<(), String> {
    blocking(move || discard_sync(&project_path, &paths)).await
}

#[derive(Default)]
struct DiscardPlan {
    restore: Vec<String>,
    unindex: Vec<String>,
    delete: Vec<PathBuf>,
}

fn discard_sync(project_path: &str, paths: &[String]) -> Result<(), String> {
    let project = validate_repo_path(project_path)?;
    let plan = plan_discard(&project, paths)?;
    if !plan.restore.is_empty() {
        let spec = literal_pathspec(&plan.restore)?;
        git_with_pathspec(
            &project,
            &["restore", "--staged", "--worktree", "--source=HEAD"],
            &spec,
        )?;
    }
    if !plan.unindex.is_empty() {
        let spec = literal_pathspec(&plan.unindex)?;
        git_with_pathspec(&project, &["rm", "--cached", "-q", "-f"], &spec)?;
    }
    for target in &plan.delete {
        std::fs::remove_file(target)
            .map_err(|error| format!("could not delete {}: {error}", target.display()))?;
    }
    Ok(())
}

fn plan_discard(project: &Path, paths: &[String]) -> Result<DiscardPlan, String> {
    let paths: Vec<String> = pathspec(paths)?.split_off(1);
    let root = project
        .canonicalize()
        .map_err(|error| format!("could not resolve the project: {error}"))?;
    let head = has_head(project);
    let indexed = indexed_paths(project, &paths)?;
    let mut plan = DiscardPlan::default();
    for path in paths {
        if head && in_head(project, &path)? {
            plan.restore.push(path);
            continue;
        }
        if let Some(target) = deletable_target(&root, &path)? {
            plan.delete.push(target);
        }
        if indexed.contains(&path) {
            plan.unindex.push(path);
        }
    }
    Ok(plan)
}

fn indexed_paths(project: &Path, paths: &[String]) -> Result<Vec<String>, String> {
    let spec = literal_pathspec(paths)?;
    let output = git_with_pathspec(project, &["ls-files", "-z", "--cached"], &spec)?;
    Ok(nul_records(&output).map(lossy).collect())
}

fn in_head(project: &Path, path: &str) -> Result<bool, String> {
    let object = format!("HEAD:{path}");
    let Ok(kind) = git_stdout(project, &["cat-file", "-t", &object]) else {
        return Ok(false);
    };
    match String::from_utf8_lossy(&kind).trim() {
        "blob" => Ok(true),
        _ => Err(format!("only files can be discarded: {path}")),
    }
}

fn deletable_target(root: &Path, path: &str) -> Result<Option<PathBuf>, String> {
    let relative = Path::new(path);
    let refused = || format!("refusing to delete {path}");
    if relative
        .components()
        .any(|component| !matches!(component, Component::Normal(_) | Component::CurDir))
    {
        return Err(refused());
    }
    let name = relative.file_name().ok_or_else(refused)?;
    let parent = root
        .join(relative)
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(refused)?;
    let Ok(parent) = parent.canonicalize() else {
        return Ok(None);
    };
    if !parent.starts_with(root) || parent.starts_with(root.join(".git")) || name == ".git" {
        return Err(refused());
    }
    let target = parent.join(name);
    match std::fs::symlink_metadata(&target) {
        Ok(meta) if meta.is_dir() => Err(format!("only files can be discarded: {path}")),
        Ok(_) => Ok(Some(target)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("could not inspect {path}: {error}")),
    }
}

#[cfg(test)]
mod tests;
