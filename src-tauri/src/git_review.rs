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
//!
//! `validate_repo_path` and `detect_base_ref_sync` are also `pub(crate)`,
//! reused by `git_worktree` for the "Create worktree" action.

use std::path::Path;
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};

mod repository;

pub(crate) use repository::validate_repo_path;
use repository::{
    current_branch, is_safe_git_ref, merge_base, origin_head, ref_exists, rev_parse_verify,
};

// Per-file cap: keeps one huge file (lockfile, generated dump) from eating the
// whole prompt budget. Files past this size are cut at a line boundary and
// listed in `files_truncated`.
const MAX_FILE_BYTES: usize = 40 * 1024;
// Total cap after per-file trimming. Chosen as ~10× the per-file cap so a
// normal review with dozens of files fits, while pathologically large diffs
// still trim.
const MAX_TOTAL_BYTES: usize = 400 * 1024;

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
    /// Files auto-excluded as generated noise (lockfiles, `dist/`, minified
    /// assets, snapshots, …). Empty when nothing was dropped. The UI lists
    /// these on the report so the user can re-scope explicitly if needed.
    pub files_excluded: Vec<String>,
    /// Files whose per-file body exceeded `MAX_FILE_BYTES` and was cut at a
    /// line boundary. Distinct from `files_excluded` (kept, but partial).
    pub files_truncated: Vec<String>,
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

pub(crate) fn detect_base_ref_sync(project_path: &str) -> Result<String, String> {
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

    let Budgeted {
        diff,
        truncated,
        files_excluded,
        files_truncated,
    } = apply_budgets(&full_diff, &clean_paths, MAX_FILE_BYTES, MAX_TOTAL_BYTES);

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
        files_excluded,
        files_truncated,
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
        let pre = p.trim().trim_start_matches("./");
        if pre.is_empty() {
            continue;
        }
        // Reject Windows drive-letter absolutes (`C:\foo`, `C:/foo`) here —
        // after the backslash-to-slash normalization below the `:\` form
        // disappears, so the check has to see the raw input.
        if is_windows_drive_absolute(pre) {
            return Err(format!("scope path must be relative: {p}"));
        }
        let trimmed = pre.replace('\\', "/");
        if trimmed.starts_with('/') {
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

fn is_windows_drive_absolute(s: &str) -> bool {
    let bytes = s.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'/' || bytes[2] == b'\\')
}

fn truncate_at_line(text: &str, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text.to_string();
    }
    // `str` slicing panics if `max_bytes` lands inside a multi-byte UTF-8
    // sequence — real diffs contain non-ASCII bytes (identifiers, string
    // literals, filenames), so floor to the nearest char boundary first.
    let safe_max = floor_char_boundary(text, max_bytes);
    let cutoff = text[..safe_max]
        .rfind('\n')
        .map(|i| i + 1)
        .unwrap_or(safe_max);
    text[..cutoff].to_string()
}

fn floor_char_boundary(text: &str, index: usize) -> usize {
    let mut i = index.min(text.len());
    while i > 0 && !text.is_char_boundary(i) {
        i -= 1;
    }
    i
}

/// Best-effort split of a unified diff into per-file blocks. Each element is
/// `(path, block)` where `path` is the destination path from the
/// `diff --git a/X b/Y` header (or `X` when `Y` is `/dev/null`), and `block`
/// includes the header itself so the concatenation of all blocks recreates
/// the original diff.
///
/// Falls back to a single unnamed block when the input has no `diff --git`
/// markers — we still return the whole content so nothing is silently lost.
fn split_diff_by_file(diff: &str) -> Vec<(String, String)> {
    let bytes = diff.as_bytes();
    let mut starts: Vec<usize> = Vec::new();
    let mut i = 0usize;
    while i < bytes.len() {
        // A `diff --git` header always sits at the start of a line.
        let at_line_start = i == 0 || bytes[i - 1] == b'\n';
        if at_line_start && diff[i..].starts_with("diff --git ") {
            starts.push(i);
            i += "diff --git ".len();
            continue;
        }
        i += 1;
    }
    if starts.is_empty() {
        return vec![(String::new(), diff.to_string())];
    }
    let mut out: Vec<(String, String)> = Vec::with_capacity(starts.len());
    for (idx, &start) in starts.iter().enumerate() {
        let end = starts.get(idx + 1).copied().unwrap_or(bytes.len());
        let block = &diff[start..end];
        let path = parse_diff_git_path(block).unwrap_or_default();
        out.push((path, block.to_string()));
    }
    out
}

/// Extract the target path from a `diff --git a/X b/Y` header. Falls back to
/// `X` when `Y` is `/dev/null` (deletion). Returns `None` when the header can
/// not be parsed — the caller keeps the block but skips the noise filter for
/// it, which is the safer default (we would rather include noise than drop a
/// real file we could not name).
fn parse_diff_git_path(block: &str) -> Option<String> {
    let header = block.lines().next()?;
    let rest = header.strip_prefix("diff --git ")?;
    // Quoted paths ("core.quotePath" is on by default for non-ASCII) look like
    // `"a/…" "b/…"`. We do not decode the escapes — matching still works on
    // the visible bytes, which cover the common patterns (dist/, *.lock, …).
    let (a_path, b_path) = if let Some(after_quote) = rest.strip_prefix('"') {
        let a_end = find_unescaped_quote(after_quote)?;
        let a = &after_quote[..a_end];
        let after_a = after_quote[a_end + 1..].trim_start();
        let after_a = after_a.strip_prefix('"')?;
        let b_end = find_unescaped_quote(after_a)?;
        let b = &after_a[..b_end];
        (a.to_string(), b.to_string())
    } else {
        // Unquoted: `a/PATH b/PATH`. Splitting on ` b/` at the *rightmost*
        // occurrence handles paths that contain " b/" as a substring.
        let (a_raw, b_raw) = split_ab(rest)?;
        (a_raw.to_string(), b_raw.to_string())
    };
    let a = a_path.strip_prefix("a/").unwrap_or(&a_path);
    let b = b_path.strip_prefix("b/").unwrap_or(&b_path);
    // Deletions show `+++ /dev/null`; use the `a` side for those.
    let is_deletion = block.contains("\n+++ /dev/null");
    Some(if is_deletion {
        a.to_string()
    } else {
        b.to_string()
    })
}

fn split_ab(rest: &str) -> Option<(&str, &str)> {
    // Prefer a split at "a/… b/…" — the canonical git shape. If the file
    // is untracked/newly-added, git can also emit "/dev/null b/…"; handle
    // both by locating " b/" and slicing there.
    let idx = rest.rfind(" b/")?;
    let a = rest[..idx].trim();
    let b = &rest[idx + 1..];
    Some((a, b))
}

fn find_unescaped_quote(s: &str) -> Option<usize> {
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\\' {
            i += 2;
            continue;
        }
        if bytes[i] == b'"' {
            return Some(i);
        }
        i += 1;
    }
    None
}

/// Patterns for auto-excluded "noise" files — outputs of package managers,
/// bundlers, and asset pipelines that rarely benefit from human-style review
/// and often dominate diff size. Kept intentionally small: safer to under-
/// exclude and let the user re-scope than to hide a change silently.
fn is_generated_path(rel: &str) -> bool {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    let name_l = name.to_ascii_lowercase();
    let rel_l = rel.to_ascii_lowercase();

    // Directory anchors — anywhere in the path.
    for anchor in [
        "/node_modules/",
        "/vendor/",
        "/dist/",
        "/build/",
        "/out/",
        "/target/",
        "/coverage/",
        "/__snapshots__/",
        "/.next/",
        "/.nuxt/",
        "/.turbo/",
        "/.parcel-cache/",
    ] {
        // Anchor match: at the start (no leading slash) or anywhere mid-path.
        if rel_l.starts_with(&anchor[1..]) || rel_l.contains(anchor) {
            return true;
        }
    }

    // Lock / manifest outputs.
    matches!(
        name_l.as_str(),
        "yarn.lock"
            | "package-lock.json"
            | "pnpm-lock.yaml"
            | "npm-shrinkwrap.json"
            | "composer.lock"
            | "cargo.lock"
            | "gemfile.lock"
            | "poetry.lock"
            | "uv.lock"
            | "bun.lockb"
            | "go.sum"
            | "flake.lock"
    ) || {
        // Suffix-based patterns.
        let suffix_hits = [
            ".min.js", ".min.css", ".min.mjs", ".min.map", ".map", ".snap",
            // Binary / vector assets.
            ".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp", ".avif", ".bmp", ".tiff", ".pdf",
            ".woff", ".woff2", ".ttf", ".otf", ".eot", ".wasm", ".parquet",
        ];
        suffix_hits.iter().any(|s| name_l.ends_with(s))
    }
}

/// Result of running per-file + total budgeting over a raw diff.
struct Budgeted {
    diff: String,
    truncated: bool,
    files_excluded: Vec<String>,
    files_truncated: Vec<String>,
}

fn apply_budgets(
    full_diff: &str,
    scope_paths: &[String],
    max_file_bytes: usize,
    max_total_bytes: usize,
) -> Budgeted {
    let blocks = split_diff_by_file(full_diff);
    let mut kept: Vec<String> = Vec::with_capacity(blocks.len());
    let mut files_excluded: Vec<String> = Vec::new();
    let mut files_truncated: Vec<String> = Vec::new();

    for (path, block) in blocks {
        let should_exclude = !path.is_empty()
            && is_generated_path(&path)
            && !path_explicitly_scoped(&path, scope_paths);
        if should_exclude {
            files_excluded.push(path);
            continue;
        }
        if block.len() > max_file_bytes {
            let mut cut = truncate_at_line(&block, max_file_bytes);
            let label = if path.is_empty() {
                "diff block"
            } else {
                path.as_str()
            };
            cut.push_str(&format!(
                "\n# ---\n# {label}: truncated at {max_file_bytes} bytes (original size: {} bytes)\n",
                block.len()
            ));
            kept.push(cut);
            if !path.is_empty() {
                files_truncated.push(path);
            }
        } else {
            kept.push(block);
        }
    }

    let joined = kept.join("");
    let per_file_truncated = !files_truncated.is_empty();
    let (diff, total_truncated) = if joined.len() > max_total_bytes {
        let mut cut = truncate_at_line(&joined, max_total_bytes);
        cut.push_str(&format!(
            "\n# ---\n# diff truncated at {max_total_bytes} bytes total (original size after per-file trim: {} bytes)\n",
            joined.len()
        ));
        (cut, true)
    } else {
        (joined, false)
    };

    Budgeted {
        diff,
        truncated: per_file_truncated || total_truncated,
        files_excluded,
        files_truncated,
    }
}

/// A user-supplied scope entry "covers" `path` when it names the path itself
/// or a parent directory. Used to override the noise filter — if you asked
/// for `yarn.lock` on purpose, we keep it.
fn path_explicitly_scoped(path: &str, scope_paths: &[String]) -> bool {
    for s in scope_paths {
        if path == s {
            return true;
        }
        let with_slash = if s.ends_with('/') {
            s.clone()
        } else {
            format!("{s}/")
        };
        if path.starts_with(&with_slash) {
            return true;
        }
    }
    false
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
mod tests;
