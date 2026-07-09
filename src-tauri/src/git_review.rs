//! Git commands scoped to `/adversarial review`.
//!
//! Two Tauri commands: `git_detect_base_ref` finds the merge base target
//! (`origin/HEAD` → `main` → `master`); `git_branch_diff` resolves the base
//! ref against `HEAD` and returns the unified diff plus `--stat` summary.
//!
//! Both are read-only wrappers over `git` and validate the project path with
//! the same posture as `loop_git_diff_snapshot`: refuse anything that is not
//! a directory, treat a missing `.git` as a hard error (adversarial review
//! only makes sense inside a repo), and never invoke `git` with unvalidated
//! user input as flags — the only user-controlled value passed to a shell
//! process is the base ref, which is first verified with `git rev-parse
//! --verify`.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};

const MAX_DIFF_BYTES: usize = 150 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchDiff {
    pub base_ref: String,
    pub merge_base: String,
    pub head_sha: String,
    pub diff: String,
    pub stat: String,
    pub files_changed: u32,
    pub insertions: u32,
    pub deletions: u32,
    pub truncated: bool,
    /// Repo-relative paths the diff was scoped to. Empty when the whole
    /// branch-vs-base diff was returned; the UI uses this to show a "scoped
    /// to X" hint on the report.
    pub paths: Vec<String>,
    /// Diff source that produced this snapshot — echoed back so the UI/report
    /// can label the review ("committed" = merge-base…HEAD, "working" =
    /// uncommitted working tree vs HEAD).
    pub mode: String,
}

/// Diff source mode. Kept as an enum inside Rust for exhaustive matching; on
/// the wire it's a plain string.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DiffMode {
    /// `git diff <mergeBase>...HEAD` — commits since the branch diverged.
    Committed,
    /// `git diff HEAD` — everything modified in the working tree that has not
    /// been committed yet (staged + unstaged, tracked files only).
    Working,
}

impl DiffMode {
    fn parse(raw: Option<&str>) -> Result<Self, String> {
        match raw.unwrap_or("committed") {
            "committed" => Ok(Self::Committed),
            "working" => Ok(Self::Working),
            other => Err(format!(
                "invalid mode: {other} (expected committed|working)"
            )),
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Committed => "committed",
            Self::Working => "working",
        }
    }
}

/// Resolves the natural base ref for the current branch:
///
/// 1. `origin/HEAD` (via `git symbolic-ref refs/remotes/origin/HEAD`)
/// 2. `main`
/// 3. `master`
///
/// Errors when nothing resolves or when the current branch already *is* the
/// base (nothing to review — the frontend keeps ▶ run disabled).
#[tauri::command]
pub async fn git_detect_base_ref(project_path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || detect_base_ref_sync(&project_path))
        .await
        .map_err(|e| format!("join error: {e}"))?
}

fn detect_base_ref_sync(project_path: &str) -> Result<String, String> {
    let project = validate_repo_path(project_path)?;

    let head_ref = current_branch(&project)?;

    // origin/HEAD as symbolic ref — the CI-common setup.
    if let Some(name) = origin_head(&project)? {
        if name != head_ref {
            return Ok(name);
        }
    }

    for candidate in ["main", "master"] {
        if ref_exists(&project, candidate)? && candidate != head_ref {
            return Ok(candidate.to_string());
        }
    }

    Err(
        "could not detect a base ref (no origin/HEAD, no main, no master, or you are already on it)"
            .to_string(),
    )
}

/// Returns the branch-vs-base diff (`git diff <mergeBase>...HEAD`) along with
/// its `--stat` summary. Rejects invalid base refs and empty diffs.
///
/// If the diff exceeds `MAX_DIFF_BYTES`, it is truncated at the last complete
/// line and `truncated=true` is returned so the UI can flag it.
#[tauri::command]
pub async fn git_branch_diff(
    project_path: String,
    base_ref: String,
    paths: Option<Vec<String>>,
    mode: Option<String>,
) -> Result<BranchDiff, String> {
    let diff_mode = DiffMode::parse(mode.as_deref())?;
    tokio::task::spawn_blocking(move || {
        branch_diff_sync(
            &project_path,
            &base_ref,
            paths.unwrap_or_default(),
            diff_mode,
        )
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

fn branch_diff_sync(
    project_path: &str,
    base_ref: &str,
    paths: Vec<String>,
    mode: DiffMode,
) -> Result<BranchDiff, String> {
    let project = validate_repo_path(project_path)?;
    let head_verified = rev_parse_verify(&project, "HEAD")?;

    // The base ref is only meaningful for `committed` mode; in `working` mode
    // we still record it for the report header but skip validation because the
    // UI may leave the field empty when the user is only reviewing uncommitted
    // work.
    let (merge_base, base_label) = match mode {
        DiffMode::Committed => {
            if !is_safe_git_ref(base_ref) {
                return Err(format!("invalid base ref: {base_ref}"));
            }
            let base_verified = rev_parse_verify(&project, base_ref)?;
            let mb = merge_base(&project, &base_verified, &head_verified)?;
            if mb == head_verified {
                return Err("HEAD is at or behind the base ref — nothing to review".to_string());
            }
            (mb, base_ref.to_string())
        }
        DiffMode::Working => (head_verified.clone(), String::from("HEAD")),
    };

    // Validate + canonicalize each requested path. Rejected paths abort the
    // whole diff so the user always sees the exact error next to the field.
    let clean_paths = normalize_scope_paths(&project, &paths)?;

    let range = match mode {
        DiffMode::Committed => format!("{merge_base}...HEAD"),
        DiffMode::Working => "HEAD".to_string(),
    };
    let mut diff_args: Vec<String> = vec!["diff".to_string(), range.clone()];
    if !clean_paths.is_empty() {
        diff_args.push("--".to_string());
        diff_args.extend(clean_paths.iter().cloned());
    }
    let diff_out = Command::new("git")
        .args(&diff_args)
        .current_dir(&project)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("could not run git diff: {e}"))?;
    if !diff_out.status.success() {
        return Err(format!(
            "git diff failed: {}",
            String::from_utf8_lossy(&diff_out.stderr).trim()
        ));
    }
    let full_diff = String::from_utf8_lossy(&diff_out.stdout).to_string();
    if full_diff.trim().is_empty() {
        let hint = if clean_paths.is_empty() {
            String::new()
        } else {
            format!(" (scoped to {})", clean_paths.join(", "))
        };
        return Err(format!("diff is empty — nothing to review{hint}"));
    }

    let (diff, truncated) = truncate_diff(&full_diff, MAX_DIFF_BYTES);

    let mut stat_args: Vec<String> = vec!["diff".to_string(), "--shortstat".to_string(), range];
    if !clean_paths.is_empty() {
        stat_args.push("--".to_string());
        stat_args.extend(clean_paths.iter().cloned());
    }
    let stat_out = Command::new("git")
        .args(&stat_args)
        .current_dir(&project)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("could not run git diff --shortstat: {e}"))?;
    let stat = if stat_out.status.success() {
        String::from_utf8_lossy(&stat_out.stdout).trim().to_string()
    } else {
        String::new()
    };
    let (files_changed, insertions, deletions) = parse_shortstat(&stat);

    Ok(BranchDiff {
        base_ref: base_label,
        merge_base,
        head_sha: head_verified,
        diff,
        stat,
        files_changed,
        insertions,
        deletions,
        truncated,
        paths: clean_paths,
        mode: mode.label().to_string(),
    })
}

/// Validates each user-supplied scope path against the project root and
/// returns the trimmed, deduplicated list ready to hand to `git`.
///
/// Rules:
///   - Empty / whitespace-only entries are dropped silently (harmless typos).
///   - Absolute paths (`/etc/...`, `C:\`) are rejected outright.
///   - Any component `..` is rejected — no upward traversal.
///   - The resolved path must exist under `project`; symlinks that escape are
///     rejected via canonicalize + starts_with(project) check.
///   - Backslash paths are normalized to forward slashes so the caller can
///     hand-type Windows-style separators.
fn normalize_scope_paths(project: &Path, raw: &[String]) -> Result<Vec<String>, String> {
    let project_canon = project
        .canonicalize()
        .map_err(|e| format!("could not canonicalize project: {e}"))?;

    let mut out: Vec<String> = Vec::new();
    for p in raw {
        let trimmed = p.trim().trim_start_matches("./").replace('\\', "/");
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.starts_with('/') || trimmed.contains(":\\") {
            return Err(format!("scope path must be relative: {p}"));
        }
        if trimmed.split('/').any(|c| c == "..") {
            return Err(format!("scope path may not contain '..': {p}"));
        }

        let target = project.join(&trimmed);
        let target_canon = target
            .canonicalize()
            .map_err(|e| format!("scope path does not exist ({trimmed}): {e}"))?;
        if !target_canon.starts_with(&project_canon) {
            return Err(format!("scope path escapes project: {p}"));
        }

        if !out.contains(&trimmed) {
            out.push(trimmed);
        }
    }
    Ok(out)
}

fn validate_repo_path(project_path: &str) -> Result<PathBuf, String> {
    let project = PathBuf::from(project_path);
    if !project.is_dir() {
        return Err(format!("project_path is not a directory: {project_path}"));
    }
    if !project.join(".git").exists() {
        return Err(format!("project is not a git repo: {project_path}"));
    }
    Ok(project)
}

fn current_branch(project: &PathBuf) -> Result<String, String> {
    let out = Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(project)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("could not run git rev-parse: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "git rev-parse HEAD failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn origin_head(project: &PathBuf) -> Result<Option<String>, String> {
    let out = Command::new("git")
        .args(["symbolic-ref", "refs/remotes/origin/HEAD"])
        .current_dir(project)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("could not run git symbolic-ref: {e}"))?;
    if !out.status.success() {
        return Ok(None);
    }
    let raw = String::from_utf8_lossy(&out.stdout).trim().to_string();
    // The result is like `refs/remotes/origin/main` — trim the prefix so the
    // caller compares against the branch name.
    let name = raw
        .strip_prefix("refs/remotes/origin/")
        .map(|s| s.to_string())
        .unwrap_or(raw);
    if name.is_empty() {
        Ok(None)
    } else {
        Ok(Some(name))
    }
}

fn ref_exists(project: &PathBuf, name: &str) -> Result<bool, String> {
    let out = Command::new("git")
        .args(["rev-parse", "--verify", "--quiet", name])
        .current_dir(project)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("could not run git rev-parse: {e}"))?;
    Ok(out.status.success())
}

fn rev_parse_verify(project: &PathBuf, name: &str) -> Result<String, String> {
    let out = Command::new("git")
        .args(["rev-parse", "--verify", name])
        .current_dir(project)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("could not run git rev-parse: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "unknown ref: {name} ({})",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn merge_base(project: &PathBuf, a: &str, b: &str) -> Result<String, String> {
    let out = Command::new("git")
        .args(["merge-base", a, b])
        .current_dir(project)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("could not run git merge-base: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "git merge-base failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn is_safe_git_ref(name: &str) -> bool {
    // Git's own rules are complex; we only need enough to keep obviously-bad
    // strings from being passed to `git`. `rev-parse --verify` is the
    // authoritative check afterwards.
    if name.is_empty() || name.len() > 200 {
        return false;
    }
    if name.starts_with('-') || name.contains("..") || name.contains(':') || name.contains(' ') {
        return false;
    }
    name.chars().all(|c| {
        c.is_ascii_alphanumeric()
            || matches!(c, '/' | '_' | '-' | '.' | '~' | '^' | '@' | '{' | '}')
    })
}

fn truncate_diff(diff: &str, max_bytes: usize) -> (String, bool) {
    if diff.len() <= max_bytes {
        return (diff.to_string(), false);
    }
    // Cut at the last newline before max_bytes so we don't split a hunk mid-line.
    let cutoff = diff[..max_bytes]
        .rfind('\n')
        .map(|i| i + 1)
        .unwrap_or(max_bytes);
    let mut truncated = diff[..cutoff].to_string();
    truncated.push_str(&format!(
        "\n# ---\n# diff truncated at {max_bytes} bytes (original size: {} bytes)\n",
        diff.len()
    ));
    (truncated, true)
}

fn parse_shortstat(stat: &str) -> (u32, u32, u32) {
    // Format: " 3 files changed, 42 insertions(+), 7 deletions(-)". Some fields
    // may be missing (deletions=0 omits its clause). Parse defensively.
    let mut files = 0u32;
    let mut ins = 0u32;
    let mut del = 0u32;
    for part in stat.split(',') {
        let p = part.trim();
        if let Some(n) = p
            .split_whitespace()
            .next()
            .and_then(|s| s.parse::<u32>().ok())
        {
            if p.contains("file") {
                files = n;
            } else if p.contains("insertion") {
                ins = n;
            } else if p.contains("deletion") {
                del = n;
            }
        }
    }
    (files, ins, del)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_ref_accepts_common_shapes() {
        assert!(is_safe_git_ref("main"));
        assert!(is_safe_git_ref("origin/main"));
        assert!(is_safe_git_ref("feature/x-y-z"));
        assert!(is_safe_git_ref("HEAD~2"));
        assert!(is_safe_git_ref("v1.2.3"));
    }

    #[test]
    fn safe_ref_rejects_dangerous_shapes() {
        assert!(!is_safe_git_ref(""));
        assert!(!is_safe_git_ref("-x"));
        assert!(!is_safe_git_ref("a..b"));
        assert!(!is_safe_git_ref("with space"));
        assert!(!is_safe_git_ref("a:b"));
        assert!(!is_safe_git_ref(&"x".repeat(300)));
    }

    #[test]
    fn parses_shortstat_shapes() {
        assert_eq!(
            parse_shortstat(" 3 files changed, 42 insertions(+), 7 deletions(-)"),
            (3, 42, 7)
        );
        assert_eq!(
            parse_shortstat(" 1 file changed, 4 insertions(+)"),
            (1, 4, 0)
        );
        assert_eq!(parse_shortstat(""), (0, 0, 0));
    }

    #[test]
    fn truncate_keeps_short_diffs_intact() {
        let (out, truncated) = truncate_diff("small\n", 100);
        assert_eq!(out, "small\n");
        assert!(!truncated);
    }

    #[test]
    fn normalize_scope_accepts_relative_paths() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("app/Services/Payment")).unwrap();
        std::fs::write(tmp.path().join("app/Services/Payment/foo.php"), "").unwrap();
        let paths = vec![
            "app/Services/Payment".to_string(),
            "./app/Services/Payment/foo.php".to_string(),
            "  ".to_string(), // dropped silently
        ];
        let clean = normalize_scope_paths(tmp.path(), &paths).unwrap();
        assert_eq!(
            clean,
            vec![
                "app/Services/Payment".to_string(),
                "app/Services/Payment/foo.php".to_string(),
            ]
        );
    }

    #[test]
    fn normalize_scope_rejects_traversal_and_absolute() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("app")).unwrap();
        assert!(normalize_scope_paths(tmp.path(), &["../etc".to_string()]).is_err());
        assert!(normalize_scope_paths(tmp.path(), &["/etc/passwd".to_string()]).is_err());
        assert!(normalize_scope_paths(tmp.path(), &["app/../../etc".to_string()]).is_err());
    }

    #[test]
    fn normalize_scope_rejects_missing_paths() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(normalize_scope_paths(tmp.path(), &["does-not-exist".to_string()]).is_err());
    }

    #[test]
    fn normalize_scope_deduplicates_and_normalizes_separators() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("app/Http")).unwrap();
        let paths = vec![
            "app/Http".to_string(),
            "app\\Http".to_string(),
            "app/Http".to_string(),
        ];
        let clean = normalize_scope_paths(tmp.path(), &paths).unwrap();
        assert_eq!(clean, vec!["app/Http".to_string()]);
    }

    #[test]
    fn truncate_cuts_at_line_boundary() {
        let raw = "aaaa\nbbbb\ncccc\ndddd\n";
        let (out, truncated) = truncate_diff(raw, 10);
        assert!(truncated);
        assert!(out.starts_with("aaaa\nbbbb\n"));
        assert!(out.contains("diff truncated"));
    }
}
