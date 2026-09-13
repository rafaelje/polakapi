//! Discovery and review of agent skills installed for the local AI CLIs.
//!
//! Scans the well-known skill directories of each supported CLI (`claude`,
//! `codex`, `opencode`, `cursor`) in two scopes: the global ones under the
//! user's home, and the ones a repository ships in its own tree. Exposes
//! read/write access scoped to those roots, and can ask any one-shot capable
//! CLI to explain a skill.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;

use crate::loop_cli::{run_one_shot, AgentResult};
use crate::platform_command;

const EXPLAIN_TIMEOUT_SECS: u64 = 300;
const MAX_INLINE_SKILL_BYTES: usize = 60_000;
const SCOPE_GLOBAL: &str = "global";
const SCOPE_PROJECT: &str = "project";

/// Project roots reported by the last `skills_list` call. Read and write only
/// accept paths under a global skill root or under one of these, so editing a
/// repo-local skill never widens the reachable area beyond what was listed.
static KNOWN_PROJECT_ROOTS: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillEntry {
    pub cli: String,
    pub name: String,
    pub description: String,
    pub path: String,
    pub source: String,
    /// `global` for the home directories every project sees, `project` for the
    /// ones checked into a repository.
    pub scope: String,
    /// Root of the repository that ships the skill, only for `project` scope.
    pub project_path: Option<String>,
}

fn global_skill_roots(home: &Path) -> Vec<(&'static str, PathBuf)> {
    vec![
        ("claude", home.join(".claude").join("skills")),
        ("codex", home.join(".codex").join("skills")),
        ("codex", home.join(".codex").join("prompts")),
        (
            "opencode",
            home.join(".config").join("opencode").join("skill"),
        ),
        (
            "opencode",
            home.join(".config").join("opencode").join("skills"),
        ),
        ("cursor", home.join(".cursor").join("skills")),
        ("cursor", home.join(".cursor").join("skills-cursor")),
    ]
}

fn project_skill_roots(project: &Path) -> Vec<(&'static str, PathBuf)> {
    vec![
        ("claude", project.join(".claude").join("skills")),
        ("codex", project.join(".codex").join("skills")),
        ("codex", project.join(".codex").join("prompts")),
        ("opencode", project.join(".opencode").join("skill")),
        ("opencode", project.join(".opencode").join("skills")),
        ("cursor", project.join(".cursor").join("skills")),
    ]
}

fn home_dir() -> Result<PathBuf, String> {
    platform_command::user_home_dir().ok_or_else(|| "could not resolve home directory".to_string())
}

fn strip_quotes(value: &str) -> String {
    let trimmed = value.trim();
    trimmed
        .strip_prefix('"')
        .and_then(|v| v.strip_suffix('"'))
        .or_else(|| {
            trimmed
                .strip_prefix('\'')
                .and_then(|v| v.strip_suffix('\''))
        })
        .unwrap_or(trimmed)
        .to_string()
}

fn parse_frontmatter(content: &str) -> (Option<String>, Option<String>) {
    let mut lines = content.lines();
    if lines.next().map(str::trim) != Some("---") {
        return (None, None);
    }
    let mut name = None;
    let mut description = None;
    for line in lines {
        let trimmed = line.trim();
        if trimmed == "---" {
            break;
        }
        if let Some(value) = trimmed.strip_prefix("name:") {
            let cleaned = strip_quotes(value);
            if !cleaned.is_empty() {
                name = Some(cleaned);
            }
        } else if let Some(value) = trimmed.strip_prefix("description:") {
            let cleaned = strip_quotes(value);
            if !cleaned.is_empty() {
                description = Some(cleaned);
            }
        }
    }
    (name, description)
}

fn source_label(root: &Path, home: &Path) -> String {
    root.strip_prefix(home)
        .map(|p| format!("~/{}", p.display()))
        .unwrap_or_else(|_| root.display().to_string())
}

/// `<repo-name>/.claude/skills`, so two projects with the same layout stay
/// distinguishable in the list.
fn project_source_label(root: &Path, project: &Path) -> String {
    let name = project
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| project.display().to_string());
    root.strip_prefix(project)
        .map(|p| format!("{name}/{}", p.display()))
        .unwrap_or_else(|_| root.display().to_string())
}

fn skill_file_for(entry_path: &Path) -> Option<PathBuf> {
    if entry_path.is_dir() {
        let candidate = entry_path.join("SKILL.md");
        return candidate.is_file().then_some(candidate);
    }
    let is_md = entry_path
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("md"));
    (is_md && entry_path.is_file()).then(|| entry_path.to_path_buf())
}

fn fallback_name(entry_path: &Path) -> String {
    entry_path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| entry_path.display().to_string())
}

fn scan_root(
    cli: &str,
    root: &Path,
    source: &str,
    scope: &str,
    project_path: Option<&str>,
    out: &mut Vec<SkillEntry>,
) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let entry_path = entry.path();
        let Some(md_path) = skill_file_for(&entry_path) else {
            continue;
        };
        let content = fs::read_to_string(&md_path).unwrap_or_default();
        let (name, description) = parse_frontmatter(&content);
        out.push(SkillEntry {
            cli: cli.to_string(),
            name: name.unwrap_or_else(|| fallback_name(&entry_path)),
            description: description.unwrap_or_default(),
            path: md_path.to_string_lossy().to_string(),
            source: source.to_string(),
            scope: scope.to_string(),
            project_path: project_path.map(str::to_string),
        });
    }
}

fn allowed_roots() -> Result<Vec<PathBuf>, String> {
    let home = home_dir()?;
    let mut roots: Vec<PathBuf> = global_skill_roots(&home)
        .into_iter()
        .map(|(_, root)| root)
        .collect();
    let known = KNOWN_PROJECT_ROOTS.lock().map_err(|e| e.to_string())?;
    for project in known.iter() {
        roots.extend(project_skill_roots(project).into_iter().map(|(_, r)| r));
    }
    Ok(roots)
}

/// Project root from the last listing that contains `file`, if any.
fn owning_project_root(file: &Path) -> Option<PathBuf> {
    let known = KNOWN_PROJECT_ROOTS.lock().ok()?;
    known
        .iter()
        .filter(|root| file.starts_with(root))
        .max_by_key(|root| root.components().count())
        .cloned()
}

fn validate_skill_path(path: &str) -> Result<PathBuf, String> {
    let canonical =
        fs::canonicalize(path).map_err(|e| format!("invalid skill path {path}: {e}"))?;
    if !canonical.is_file() {
        return Err(format!("skill path is not a file: {path}"));
    }
    let allowed = allowed_roots()?.into_iter().any(|root| {
        fs::canonicalize(&root)
            .map(|r| canonical.starts_with(&r))
            .unwrap_or(false)
    });
    if !allowed {
        return Err(format!("path is outside the known skill roots: {path}"));
    }
    Ok(canonical)
}

fn truncate_at_char_boundary(content: &str, max_bytes: usize) -> &str {
    if content.len() <= max_bytes {
        return content;
    }
    let mut end = max_bytes;
    while !content.is_char_boundary(end) {
        end -= 1;
    }
    &content[..end]
}

fn build_explain_prompt(path: &Path, content: &str) -> String {
    let body = truncate_at_char_boundary(content, MAX_INLINE_SKILL_BYTES);
    format!(
        "Read the following agent skill definition and explain it so a human can review it.\n\
         Structure the answer as:\n\
         1. Purpose — what the skill does and when it should trigger.\n\
         2. How it works — the behavior it instructs, step by step.\n\
         3. Dependencies — tools, files, commands or services it relies on.\n\
         4. Review notes — anything unclear, outdated, risky or worth improving.\n\
         Be concise and concrete.\n\n\
         Skill file: {}\n\n\
         ```markdown\n{}\n```",
        path.display(),
        body
    )
}

/// `project_paths` are the repositories the workspace sidebar knows about;
/// each contributes its own checked-in skill directories.
#[tauri::command]
pub async fn skills_list(project_paths: Vec<String>) -> Result<Vec<SkillEntry>, String> {
    let home = home_dir()?;
    let mut out = Vec::new();
    for (cli, root) in global_skill_roots(&home) {
        let source = source_label(&root, &home);
        scan_root(cli, &root, &source, SCOPE_GLOBAL, None, &mut out);
    }

    let mut projects: Vec<String> = project_paths;
    projects.sort();
    projects.dedup();
    for project in &projects {
        let project_dir = PathBuf::from(project);
        for (cli, root) in project_skill_roots(&project_dir) {
            let source = project_source_label(&root, &project_dir);
            scan_root(cli, &root, &source, SCOPE_PROJECT, Some(project), &mut out);
        }
    }
    if let Ok(mut known) = KNOWN_PROJECT_ROOTS.lock() {
        *known = projects.into_iter().map(PathBuf::from).collect();
    }

    out.sort_by(|a, b| {
        a.scope
            .cmp(&b.scope)
            .then_with(|| a.project_path.cmp(&b.project_path))
            .then_with(|| a.cli.cmp(&b.cli))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

#[tauri::command]
pub async fn skill_read(path: String) -> Result<String, String> {
    let file = validate_skill_path(&path)?;
    fs::read_to_string(&file).map_err(|e| format!("could not read skill: {e}"))
}

#[tauri::command]
pub async fn skill_write(path: String, content: String) -> Result<(), String> {
    let file = validate_skill_path(&path)?;
    fs::write(&file, content).map_err(|e| format!("could not write skill: {e}"))
}

#[tauri::command]
pub async fn skill_explain(
    cli: String,
    model: String,
    path: String,
) -> Result<AgentResult, String> {
    let file = validate_skill_path(&path)?;
    let content = fs::read_to_string(&file).map_err(|e| format!("could not read skill: {e}"))?;
    let prompt = build_explain_prompt(&file, &content);
    // Project skills are explained from their own repo so the agent can open
    // whatever the skill references; global ones fall back to the home dir.
    let base = owning_project_root(&file).map_or_else(home_dir, Ok)?;
    let cwd = platform_command::external_path(&base)
        .to_string_lossy()
        .to_string();
    run_one_shot(
        &cli,
        &model,
        &cwd,
        &prompt,
        Duration::from_secs(EXPLAIN_TIMEOUT_SECS),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_frontmatter_name_and_description() {
        let content = "---\nname: my-skill\ndescription: \"Does something useful\"\n---\n\nBody";
        let (name, description) = parse_frontmatter(content);
        assert_eq!(name.as_deref(), Some("my-skill"));
        assert_eq!(description.as_deref(), Some("Does something useful"));
    }

    #[test]
    fn frontmatter_missing_returns_none() {
        let (name, description) = parse_frontmatter("# just a title\nbody");
        assert!(name.is_none());
        assert!(description.is_none());
    }

    #[test]
    fn frontmatter_ignores_fields_after_close() {
        let content = "---\nname: real\n---\nname: fake";
        let (name, _) = parse_frontmatter(content);
        assert_eq!(name.as_deref(), Some("real"));
    }

    #[test]
    fn strip_quotes_handles_both_quote_styles() {
        assert_eq!(strip_quotes(" \"a b\" "), "a b");
        assert_eq!(strip_quotes("'c'"), "c");
        assert_eq!(strip_quotes("plain"), "plain");
    }

    #[test]
    fn truncates_on_char_boundary() {
        let s = "aé".repeat(10);
        let cut = truncate_at_char_boundary(&s, 3);
        assert!(cut.len() <= 3);
        assert!(s.starts_with(cut));
    }

    #[test]
    fn scans_skill_dirs_and_flat_md_files() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("skills");
        let dir_skill = root.join("alpha");
        fs::create_dir_all(&dir_skill).unwrap();
        fs::write(
            dir_skill.join("SKILL.md"),
            "---\nname: alpha\ndescription: first\n---\n",
        )
        .unwrap();
        fs::write(root.join("beta.md"), "no frontmatter").unwrap();
        fs::write(root.join("ignored.txt"), "nope").unwrap();

        let mut out = Vec::new();
        let source = source_label(&root, tmp.path());
        scan_root("claude", &root, &source, SCOPE_GLOBAL, None, &mut out);
        out.sort_by(|a, b| a.name.cmp(&b.name));

        assert_eq!(out.len(), 2);
        assert_eq!(out[0].name, "alpha");
        assert_eq!(out[0].description, "first");
        assert_eq!(out[1].name, "beta");
        assert_eq!(out[1].description, "");
        assert_eq!(out[0].source, "~/skills");
        assert_eq!(out[0].scope, SCOPE_GLOBAL);
        assert!(out[0].project_path.is_none());
    }

    #[test]
    fn project_scan_tags_scope_and_owning_repo() {
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path().join("my-repo");
        let root = project.join(".claude").join("skills");
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("deploy.md"),
            "---\nname: deploy\ndescription: ship it\n---\n",
        )
        .unwrap();

        let mut out = Vec::new();
        let source = project_source_label(&root, &project);
        let project_str = project.to_string_lossy().to_string();
        scan_root(
            "claude",
            &root,
            &source,
            SCOPE_PROJECT,
            Some(&project_str),
            &mut out,
        );

        assert_eq!(out.len(), 1);
        assert_eq!(out[0].scope, SCOPE_PROJECT);
        assert_eq!(out[0].project_path.as_deref(), Some(project_str.as_str()));
        assert_eq!(out[0].source, "my-repo/.claude/skills");
    }

    #[test]
    fn owning_project_root_picks_the_deepest_match() {
        let tmp = tempfile::tempdir().unwrap();
        let outer = tmp.path().join("outer");
        let inner = outer.join("nested");
        *KNOWN_PROJECT_ROOTS.lock().unwrap() = vec![outer.clone(), inner.clone()];
        let file = inner.join(".claude").join("skills").join("a.md");
        assert_eq!(owning_project_root(&file), Some(inner));
        assert_eq!(owning_project_root(Path::new("/elsewhere/a.md")), None);
        KNOWN_PROJECT_ROOTS.lock().unwrap().clear();
    }

    #[test]
    fn validate_rejects_paths_outside_roots() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("loose.md");
        fs::write(&file, "x").unwrap();
        let result = validate_skill_path(file.to_str().unwrap());
        assert!(result.is_err());
    }
}
