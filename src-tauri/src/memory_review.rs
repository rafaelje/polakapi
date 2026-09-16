//! Review of the auto-memory Claude Code keeps per project.
//!
//! Claude Code stores one directory per project under `~/.claude/projects/`
//! (the absolute project path with every non-alphanumeric character replaced
//! by `-`), and inside it a `memory/` folder: `MEMORY.md` is the index loaded
//! into context each session, and every other `.md` file holds one saved
//! fact. This module lists those files and exposes read/write/delete access
//! scoped to the memory folders so the UI can prune what Claude decided to
//! remember.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::platform_command;

const INDEX_FILE: &str = "MEMORY.md";

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryFileEntry {
    pub name: String,
    pub description: String,
    pub path: String,
    pub is_index: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryProjectGroup {
    /// Munged directory name under ~/.claude/projects (e.g.
    /// `-home-user-repos-app`). The frontend maps it back to a real project
    /// path by encoding the paths it knows.
    pub dir_name: String,
    pub files: Vec<MemoryFileEntry>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryDeleteResult {
    pub index_pruned: bool,
}

fn home_dir() -> Result<PathBuf, String> {
    platform_command::user_home_dir().ok_or_else(|| "could not resolve home directory".to_string())
}

fn projects_root() -> Result<PathBuf, String> {
    Ok(home_dir()?.join(".claude").join("projects"))
}

fn frontmatter_description(content: &str) -> Option<String> {
    let mut lines = content.lines();
    if lines.next().map(str::trim) != Some("---") {
        return None;
    }
    for line in lines {
        let trimmed = line.trim();
        if trimmed == "---" {
            break;
        }
        if let Some(value) = trimmed.strip_prefix("description:") {
            let cleaned = value.trim().trim_matches('"').trim_matches('\'').trim();
            if !cleaned.is_empty() {
                return Some(cleaned.to_string());
            }
        }
    }
    None
}

fn first_heading(content: &str) -> Option<String> {
    content.lines().find_map(|line| {
        let trimmed = line.trim();
        trimmed
            .strip_prefix('#')
            .map(|rest| rest.trim_start_matches('#').trim().to_string())
            .filter(|text| !text.is_empty())
    })
}

fn describe(path: &Path, content: &str, is_index: bool) -> String {
    if is_index {
        let entries = content
            .lines()
            .filter(|line| line.trim_start().starts_with("- "))
            .count();
        let noun = if entries == 1 { "entry" } else { "entries" };
        return format!("Index loaded every session · {entries} {noun}");
    }
    frontmatter_description(content)
        .or_else(|| first_heading(content))
        .unwrap_or_else(|| {
            path.file_stem()
                .map(|s| s.to_string_lossy().replace('-', " "))
                .unwrap_or_default()
        })
}

fn scan_memory_dir(dir: &Path) -> Vec<MemoryFileEntry> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut files: Vec<MemoryFileEntry> = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let is_md = path
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("md"));
            if !is_md || !path.is_file() {
                return None;
            }
            let name = path.file_name()?.to_string_lossy().to_string();
            let is_index = name == INDEX_FILE;
            let content = fs::read_to_string(&path).unwrap_or_default();
            Some(MemoryFileEntry {
                description: describe(&path, &content, is_index),
                path: path.to_string_lossy().to_string(),
                name,
                is_index,
            })
        })
        .collect();
    files.sort_by(|a, b| {
        b.is_index
            .cmp(&a.is_index)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    files
}

fn validate_memory_path(path: &str) -> Result<PathBuf, String> {
    let root = fs::canonicalize(projects_root()?)
        .map_err(|e| format!("memory root is unavailable: {e}"))?;
    let canonical =
        fs::canonicalize(path).map_err(|e| format!("invalid memory path {path}: {e}"))?;
    if !canonical.is_file() {
        return Err(format!("memory path is not a file: {path}"));
    }
    let relative = canonical
        .strip_prefix(&root)
        .map_err(|_| format!("path is outside the memory root: {path}"))?;
    let components: Vec<String> = relative
        .components()
        .map(|c| c.as_os_str().to_string_lossy().to_string())
        .collect();
    let shape_ok = components.len() == 3
        && components[1] == "memory"
        && components[2].to_lowercase().ends_with(".md");
    if !shape_ok {
        return Err(format!(
            "path is not a project memory markdown file: {path}"
        ));
    }
    Ok(canonical)
}

#[tauri::command]
pub async fn memory_list() -> Result<Vec<MemoryProjectGroup>, String> {
    let root = projects_root()?;
    let Ok(entries) = fs::read_dir(&root) else {
        return Ok(Vec::new());
    };
    let mut groups: Vec<MemoryProjectGroup> = entries
        .flatten()
        .filter_map(|entry| {
            let project_dir = entry.path();
            if !project_dir.is_dir() {
                return None;
            }
            let files = scan_memory_dir(&project_dir.join("memory"));
            if files.is_empty() {
                return None;
            }
            Some(MemoryProjectGroup {
                dir_name: entry.file_name().to_string_lossy().to_string(),
                files,
            })
        })
        .collect();
    groups.sort_by_key(|group| group.dir_name.to_lowercase());
    Ok(groups)
}

#[tauri::command]
pub async fn memory_read(path: String) -> Result<String, String> {
    let file = validate_memory_path(&path)?;
    fs::read_to_string(&file).map_err(|e| format!("could not read memory file: {e}"))
}

#[tauri::command]
pub async fn memory_write(path: String, content: String) -> Result<(), String> {
    let file = validate_memory_path(&path)?;
    fs::write(&file, content).map_err(|e| format!("could not save memory file: {e}"))
}

#[tauri::command]
pub async fn memory_delete(path: String) -> Result<MemoryDeleteResult, String> {
    let file = validate_memory_path(&path)?;
    let name = file
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    if name == INDEX_FILE {
        return Err("MEMORY.md is the index — edit it instead of deleting it".to_string());
    }
    fs::remove_file(&file).map_err(|e| format!("could not delete memory file: {e}"))?;
    let index_pruned = match file.parent() {
        Some(memory_dir) => {
            prune_index_reference(&memory_dir.join(INDEX_FILE), &name).map_err(|error| {
                format!("memory file was deleted, but the index could not be updated: {error}")
            })?
        }
        None => false,
    };
    Ok(MemoryDeleteResult { index_pruned })
}

/// Destination of the first Markdown link in a bullet, normalized: an
/// optional `"title"` dropped and a leading `./` removed. `None` when the
/// bullet holds no link at all.
fn bullet_link_target(line: &str) -> Option<&str> {
    let after = line.split_once("](")?.1;
    let close = after.find(')')?;
    let inside = &after[..close];
    let destination = inside.split_whitespace().next().unwrap_or(inside);
    Some(
        destination
            .strip_prefix("./")
            .unwrap_or(destination)
            .trim_matches('<')
            .trim_matches('>'),
    )
}

/// Drop the index bullet that links to a deleted memory file so MEMORY.md
/// doesn't keep advertising a fact that no longer exists.
///
/// Compares the link destination rather than searching the bullet for
/// `(name.md)`: the substring form both missed legitimate spellings
/// (`](./a.md)`, `](a.md "title")`) and removed unrelated bullets that merely
/// mentioned the name in prose.
fn prune_index_reference(index_path: &Path, file_name: &str) -> Result<bool, String> {
    let content = match fs::read_to_string(index_path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("could not read {}: {error}", index_path.display())),
    };
    let kept: Vec<&str> = content
        .lines()
        .filter(|line| {
            !(line.trim_start().starts_with("- ") && bullet_link_target(line) == Some(file_name))
        })
        .collect();
    if kept.len() == content.lines().count() {
        return Ok(false);
    }
    let mut next = kept.join("\n");
    if content.ends_with('\n') {
        next.push('\n');
    }
    fs::write(index_path, next)
        .map_err(|error| format!("could not write {}: {error}", index_path.display()))?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, content: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    #[test]
    fn scans_memory_dir_with_index_first() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("memory");
        write(&dir.join("MEMORY.md"), "# Index\n\n- [A](a.md) — hook\n");
        write(
            &dir.join("zeta.md"),
            "---\nname: zeta\ndescription: A saved fact\n---\nBody",
        );
        write(&dir.join("alpha.md"), "# Alpha heading\nbody");

        let files = scan_memory_dir(&dir);
        assert_eq!(files.len(), 3);
        assert!(files[0].is_index);
        assert_eq!(files[0].description, "Index loaded every session · 1 entry");
        assert_eq!(files[1].name, "alpha.md");
        assert_eq!(files[1].description, "Alpha heading");
        assert_eq!(files[2].description, "A saved fact");
    }

    #[test]
    fn missing_dir_scans_empty() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(scan_memory_dir(&tmp.path().join("nope")).is_empty());
    }

    #[test]
    fn validate_rejects_files_outside_memory_layout() {
        let tmp = tempfile::tempdir().unwrap();
        let loose = tmp.path().join("loose.md");
        write(&loose, "x");
        assert!(validate_memory_path(loose.to_str().unwrap()).is_err());
    }

    #[test]
    fn prune_index_removes_only_matching_bullet() {
        let tmp = tempfile::tempdir().unwrap();
        let index = tmp.path().join("MEMORY.md");
        write(
            &index,
            "# Memory index\n\n- [A](a.md) — first\n- [B](b.md) — second\n",
        );
        assert!(prune_index_reference(&index, "a.md").unwrap());
        let content = fs::read_to_string(&index).unwrap();
        assert!(!content.contains("(a.md)"));
        assert!(content.contains("(b.md)"));
        assert!(content.ends_with('\n'));
    }

    #[test]
    fn prune_matches_the_link_target_not_the_bullet_text() {
        let tmp = tempfile::tempdir().unwrap();
        let index = tmp.path().join("MEMORY.md");
        write(
            &index,
            "# Memory index\n\n             - [A](a.md) — plain\n             - [B](./a.md) — relative spelling\n             - [C](a.md \"quoted title\") — with a title\n             - [D](b.md) — mentions (a.md) in prose\n             - [E](ab.md) — a different file\n",
        );
        assert!(prune_index_reference(&index, "a.md").unwrap());
        let content = fs::read_to_string(&index).unwrap();

        // Every spelling of a link to a.md is gone.
        assert!(!content.contains("- [A]"));
        assert!(!content.contains("- [B]"));
        assert!(!content.contains("- [C]"));
        // Bullets that only mention it in prose, or link elsewhere, survive —
        // D still contains the literal "(a.md)", which is exactly the
        // false positive the old substring match produced.
        assert!(content.contains("- [D](b.md) — mentions (a.md) in prose"));
        assert!(content.contains("- [E](ab.md)"));
        assert!(content.ends_with('\n'));
    }

    #[test]
    fn bullet_link_target_normalizes_spellings() {
        assert_eq!(bullet_link_target("- [A](a.md) — hook"), Some("a.md"));
        assert_eq!(bullet_link_target("- [A](./a.md)"), Some("a.md"));
        assert_eq!(bullet_link_target("- [A](a.md \"t\")"), Some("a.md"));
        assert_eq!(bullet_link_target("- plain text, no link"), None);
    }

    #[test]
    fn prune_reports_an_unreadable_index() {
        let tmp = tempfile::tempdir().unwrap();
        let index = tmp.path().join("MEMORY.md");
        fs::create_dir(&index).unwrap();

        assert!(prune_index_reference(&index, "a.md").is_err());
    }

    #[test]
    fn frontmatter_description_and_heading_fallbacks() {
        assert_eq!(
            frontmatter_description("---\ndescription: \"quoted\"\n---\n"),
            Some("quoted".to_string())
        );
        assert!(frontmatter_description("no frontmatter").is_none());
        assert_eq!(
            first_heading("\n## Deep title\n"),
            Some("Deep title".to_string())
        );
    }
}
