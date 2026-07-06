//! SQLite-backed history of prompts sent to AI CLIs from the terminal
//! panel.
//!
//! Design (see `docs/prompts-sqlite-proposal.html`):
//! - One DB file at `<app_config_dir>/polakapi.db`, opened in WAL mode.
//! - Two tables: `sessions` (one row per terminal-panel tab running an AI
//!   CLI) and `prompts` (one row per user turn + assistant response).
//! - Writes come from two sources:
//!     1. The `polakapi-capture` helper subcommand (invoked by Claude /
//!        Codex hooks), which opens its own connection in WAL mode.
//!     2. The opencode plugin, which writes via `bun:sqlite` directly.
//! - Reads come from the Tauri frontend through the read-only commands
//!   exposed in this module. The Tauri backend holds a single
//!   `Mutex<Db>` in `State` for those reads; writers from outside the
//!   Tauri process do not share that mutex but WAL handles concurrency.
//!
//! Migrations: a `schema_version` table + SQL files embedded with
//! `include_str!`. No external migration crate, keeping the dependency
//! tree minimal (matches the repo's "minimal capabilities" principle).

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

mod migrations;

const MIGRATIONS: &[(i64, &str)] = &[(1, migrations::M_0001_INIT)];

/// Owned DB handle. Cheap to clone is not needed — we keep one behind a
/// `Mutex` in `State`. The connection is opened with `rusqlite::OpenFlags`
/// allowing read+write+create and serialized access (SQLITE_OPEN_NOMUTEX
/// would be wrong: the `Mutex<Db>` already serializes access from Tauri
/// commands; writers from the helper open their own connection).
pub struct Db {
    conn: Connection,
}

impl Db {
    /// Opens (creating if missing) the DB at `path` and runs migrations.
    pub fn open(path: &Path) -> Result<Self, String> {
        let conn = Connection::open(path)
            .map_err(|e| format!("could not open {}: {e}", path.display()))?;
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(|e| format!("could not set WAL: {e}"))?;
        conn.pragma_update(None, "foreign_keys", "ON")
            .map_err(|e| format!("could not enable FK: {e}"))?;
        let db = Self { conn };
        db.migrate()?;
        Ok(db)
    }

    /// Returns the canonical DB path for the app: `<app_config_dir>/polakapi.db`.
    pub fn resolve_path(app: &AppHandle) -> Result<PathBuf, String> {
        let base = app
            .path()
            .app_config_dir()
            .map_err(|e| format!("could not resolve app_config_dir: {e}"))?;
        std::fs::create_dir_all(&base)
            .map_err(|e| format!("could not create {}: {e}", base.display()))?;
        Ok(base.join("polakapi.db"))
    }

    fn migrate(&self) -> Result<(), String> {
        self.conn
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS schema_version (
                    version    INTEGER PRIMARY KEY,
                    applied_at INTEGER NOT NULL
                );",
            )
            .map_err(|e| format!("schema_version create: {e}"))?;
        let current: i64 = self
            .conn
            .query_row(
                "SELECT COALESCE(MAX(version), 0) FROM schema_version",
                [],
                |r| r.get(0),
            )
            .map_err(|e| format!("read schema_version: {e}"))?;
        for (v, sql) in MIGRATIONS {
            if *v <= current {
                continue;
            }
            self.conn
                .execute_batch(sql)
                .map_err(|e| format!("migration {v} failed: {e}"))?;
            let now = crate::loop_prompts::epoch_ms_now();
            self.conn
                .execute(
                    "INSERT INTO schema_version (version, applied_at) VALUES (?1, ?2)",
                    params![v, now],
                )
                .map_err(|e| format!("record migration {v}: {e}"))?;
        }
        Ok(())
    }

    /// Upserts a session row keyed by (pty_id, cli). Called by the helper
    /// on `SessionStart`. Returns the session id.
    fn upsert_session(
        &self,
        pty_id: &str,
        cli: &str,
        cli_session_id: Option<&str>,
        cwd: Option<&str>,
    ) -> Result<i64, String> {
        let now = crate::loop_prompts::epoch_ms_now();
        let existing: Option<i64> = self
            .conn
            .query_row(
                "SELECT id FROM sessions WHERE pty_id = ?1 ORDER BY id DESC LIMIT 1",
                params![pty_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| format!("lookup session: {e}"))?;
        if let Some(id) = existing {
            if cli_session_id.is_some() || cwd.is_some() {
                self.conn
                    .execute(
                        "UPDATE sessions SET cli_session_id = COALESCE(?1, cli_session_id),
                                               cwd = COALESCE(?2, cwd),
                                               status = 'active'
                         WHERE id = ?3",
                        params![cli_session_id, cwd, id],
                    )
                    .map_err(|e| format!("update session: {e}"))?;
            }
            Ok(id)
        } else {
            self.conn
                .execute(
                    "INSERT INTO sessions (pty_id, cli, cli_session_id, cwd, status, created_at)
                     VALUES (?1, ?2, ?3, ?4, 'active', ?5)",
                    params![pty_id, cli, cli_session_id, cwd, now],
                )
                .map_err(|e| format!("insert session: {e}"))?;
            Ok(self.conn.last_insert_rowid())
        }
    }

    fn set_session_title(&self, session_id: i64, title: &str) -> Result<(), String> {
        self.conn
            .execute(
                "UPDATE sessions SET title = ?1 WHERE id = ?2 AND (title IS NULL OR title = '')",
                params![title, session_id],
            )
            .map_err(|e| format!("set title: {e}"))?;
        Ok(())
    }

    fn close_session(&self, pty_id: &str) -> Result<(), String> {
        let now = crate::loop_prompts::epoch_ms_now();
        self.conn
            .execute(
                "UPDATE sessions SET status = 'closed', closed_at = ?1
                 WHERE pty_id = ?2 AND status = 'active'",
                params![now, pty_id],
            )
            .map_err(|e| format!("close session: {e}"))?;
        Ok(())
    }

    /// Inserts a user prompt as a new `prompts` row, returning its id.
    /// The `response_text` is left NULL; it is filled by `set_response`
    /// when the CLI reports the assistant message.
    fn insert_prompt(&self, session_id: i64, user_input: &str) -> Result<i64, String> {
        let now = crate::loop_prompts::epoch_ms_now();
        let next_seq: i64 = self
            .conn
            .query_row(
                "SELECT COALESCE(MAX(seq), 0) + 1 FROM prompts WHERE session_id = ?1",
                params![session_id],
                |r| r.get(0),
            )
            .map_err(|e| format!("next seq: {e}"))?;
        self.conn
            .execute(
                "INSERT INTO prompts (session_id, seq, user_input, created_at)
                 VALUES (?1, ?2, ?3, ?4)",
                params![session_id, next_seq, user_input, now],
            )
            .map_err(|e| format!("insert prompt: {e}"))?;
        let id = self.conn.last_insert_rowid();
        let title: String = user_input.chars().take(80).collect();
        self.set_session_title(session_id, &title)?;
        Ok(id)
    }

    /// Fills the `response_text` (and optional metadata) of the latest
    /// prompt in a session. Called on `Stop` / `session.idle`.
    #[allow(clippy::too_many_arguments)]
    fn set_response(
        &self,
        session_id: i64,
        response_text: Option<&str>,
        tokens_in: Option<i64>,
        tokens_out: Option<i64>,
        cost_usd: Option<f64>,
        elapsed_ms: Option<i64>,
        error: Option<&str>,
    ) -> Result<(), String> {
        self.conn
            .execute(
                "UPDATE prompts SET response_text = COALESCE(?1, response_text),
                                     tokens_in   = COALESCE(?2, tokens_in),
                                     tokens_out  = COALESCE(?3, tokens_out),
                                     cost_usd    = COALESCE(?4, cost_usd),
                                     elapsed_ms  = COALESCE(?5, elapsed_ms),
                                     error       = COALESCE(?6, error)
                 WHERE id = (
                     SELECT id FROM prompts WHERE session_id = ?7
                     ORDER BY seq DESC LIMIT 1
                 )",
                params![
                    response_text,
                    tokens_in,
                    tokens_out,
                    cost_usd,
                    elapsed_ms,
                    error,
                    session_id
                ],
            )
            .map_err(|e| format!("set response: {e}"))?;
        Ok(())
    }

    fn list_sessions(&self) -> Result<Vec<SessionRow>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id, pty_id, cli, cli_session_id, cwd, title, status,
                        created_at, closed_at,
                        (SELECT COUNT(*) FROM prompts p WHERE p.session_id = s.id) AS prompt_count
                 FROM sessions s
                 ORDER BY created_at DESC",
            )
            .map_err(|e| format!("prepare list_sessions: {e}"))?;
        let rows = stmt
            .query_map([], |r| {
                Ok(SessionRow {
                    id: r.get(0)?,
                    pty_id: r.get(1)?,
                    cli: r.get(2)?,
                    cli_session_id: r.get(3)?,
                    cwd: r.get(4)?,
                    title: r.get(5)?,
                    status: r.get(6)?,
                    created_at: r.get(7)?,
                    closed_at: r.get(8)?,
                    prompt_count: r.get(9)?,
                })
            })
            .map_err(|e| format!("query list_sessions: {e}"))?;
        rows.collect::<Result<_, _>>()
            .map_err(|e| format!("row: {e}"))
    }

    fn list_prompts_by_session(&self, session_id: i64) -> Result<Vec<PromptListRow>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id, session_id, seq,
                        substr(user_input, 1, 140) AS user_preview,
                        (response_text IS NOT NULL) AS has_response,
                        tokens_in, tokens_out, cost_usd, elapsed_ms,
                        error, created_at
                 FROM prompts
                 WHERE session_id = ?1
                 ORDER BY seq ASC",
            )
            .map_err(|e| format!("prepare list_prompts: {e}"))?;
        let rows = stmt
            .query_map(params![session_id], |r| {
                Ok(PromptListRow {
                    id: r.get(0)?,
                    session_id: r.get(1)?,
                    seq: r.get(2)?,
                    user_preview: r.get(3)?,
                    has_response: r.get(4)?,
                    tokens_in: r.get(5)?,
                    tokens_out: r.get(6)?,
                    cost_usd: r.get(7)?,
                    elapsed_ms: r.get(8)?,
                    error: r.get(9)?,
                    created_at: r.get(10)?,
                })
            })
            .map_err(|e| format!("query list_prompts: {e}"))?;
        rows.collect::<Result<_, _>>()
            .map_err(|e| format!("row: {e}"))
    }

    fn get_prompt(&self, prompt_id: i64) -> Result<Option<PromptFullRow>, String> {
        let row = self
            .conn
            .query_row(
                "SELECT id, session_id, seq, user_input, response_text,
                        tokens_in, tokens_out, cost_usd, elapsed_ms, error, created_at
                 FROM prompts WHERE id = ?1",
                params![prompt_id],
                |r| {
                    Ok(PromptFullRow {
                        id: r.get(0)?,
                        session_id: r.get(1)?,
                        seq: r.get(2)?,
                        user_input: r.get(3)?,
                        response_text: r.get(4)?,
                        tokens_in: r.get(5)?,
                        tokens_out: r.get(6)?,
                        cost_usd: r.get(7)?,
                        elapsed_ms: r.get(8)?,
                        error: r.get(9)?,
                        created_at: r.get(10)?,
                    })
                },
            )
            .optional()
            .map_err(|e| format!("get_prompt: {e}"))?;
        Ok(row)
    }

    /// LIKE-based search over `user_input` and `response_text`. Filter is
    /// applied at session level (only sessions with at least one matching
    /// prompt are returned). The frontend lists the matching prompts.
    fn search_prompts(&self, needle: &str) -> Result<Vec<PromptListRow>, String> {
        let like = format!("%{}%", needle.replace('%', "\\%"));
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id, session_id, seq,
                        substr(user_input, 1, 140) AS user_preview,
                        (response_text IS NOT NULL) AS has_response,
                        tokens_in, tokens_out, cost_usd, elapsed_ms,
                        error, created_at
                 FROM prompts
                 WHERE user_input LIKE ?1 ESCAPE '\\' OR response_text LIKE ?1 ESCAPE '\\'
                 ORDER BY created_at DESC",
            )
            .map_err(|e| format!("prepare search: {e}"))?;
        let rows = stmt
            .query_map(params![like], |r| {
                Ok(PromptListRow {
                    id: r.get(0)?,
                    session_id: r.get(1)?,
                    seq: r.get(2)?,
                    user_preview: r.get(3)?,
                    has_response: r.get(4)?,
                    tokens_in: r.get(5)?,
                    tokens_out: r.get(6)?,
                    cost_usd: r.get(7)?,
                    elapsed_ms: r.get(8)?,
                    error: r.get(9)?,
                    created_at: r.get(10)?,
                })
            })
            .map_err(|e| format!("query search: {e}"))?;
        rows.collect::<Result<_, _>>()
            .map_err(|e| format!("row: {e}"))
    }

    fn delete_sessions(&mut self, session_ids: &[i64]) -> Result<usize, String> {
        let ids: std::collections::BTreeSet<i64> =
            session_ids.iter().copied().filter(|id| *id > 0).collect();
        if ids.is_empty() {
            return Ok(0);
        }

        let tx = self
            .conn
            .transaction()
            .map_err(|e| format!("delete sessions transaction: {e}"))?;
        let mut deleted = 0;
        for id in ids {
            deleted += tx
                .execute("DELETE FROM sessions WHERE id = ?1", params![id])
                .map_err(|e| format!("delete session {id}: {e}"))?;
        }
        tx.commit()
            .map_err(|e| format!("delete sessions commit: {e}"))?;
        Ok(deleted)
    }
}

/// Public row types returned by the read commands. Serde camelCase so the
/// TS frontend can consume them directly.

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRow {
    pub id: i64,
    pub pty_id: String,
    pub cli: String,
    pub cli_session_id: Option<String>,
    pub cwd: Option<String>,
    pub title: Option<String>,
    pub status: String,
    pub created_at: i64,
    pub closed_at: Option<i64>,
    pub prompt_count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptListRow {
    pub id: i64,
    pub session_id: i64,
    pub seq: i64,
    pub user_preview: String,
    pub has_response: bool,
    pub tokens_in: Option<i64>,
    pub tokens_out: Option<i64>,
    pub cost_usd: Option<f64>,
    pub elapsed_ms: Option<i64>,
    pub error: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptFullRow {
    pub id: i64,
    pub session_id: i64,
    pub seq: i64,
    pub user_input: Option<String>,
    pub response_text: Option<String>,
    pub tokens_in: Option<i64>,
    pub tokens_out: Option<i64>,
    pub cost_usd: Option<f64>,
    pub elapsed_ms: Option<i64>,
    pub error: Option<String>,
    pub created_at: i64,
}

/// Wire format for the `polakapi-capture` helper. The helper reads JSON
/// from stdin matching this enum and dispatches to the right method.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum CaptureEvent {
    SessionStart {
        pty_id: String,
        cli: String,
        cli_session_id: Option<String>,
        cwd: Option<String>,
    },
    UserPrompt {
        pty_id: String,
        user_input: String,
    },
    AssistantStop {
        pty_id: String,
        response_text: Option<String>,
        tokens_in: Option<i64>,
        tokens_out: Option<i64>,
        cost_usd: Option<f64>,
        elapsed_ms: Option<i64>,
        error: Option<String>,
    },
    SessionEnd {
        pty_id: String,
    },
}

/// Applies one `CaptureEvent` against the DB. Used both by the helper
/// subcommand (which opens its own connection) and, in tests, to replay
/// scripted hook traces against a temp DB.
pub fn apply_event(db: &Db, event: &CaptureEvent) -> Result<(), String> {
    match event {
        CaptureEvent::SessionStart {
            pty_id,
            cli,
            cli_session_id,
            cwd,
        } => {
            db.upsert_session(pty_id, cli, cli_session_id.as_deref(), cwd.as_deref())?;
        }
        CaptureEvent::UserPrompt { pty_id, user_input } => {
            let session_id = match lookup_session_id_by_pty(db, pty_id) {
                Ok(id) => id,
                Err(_) => db.upsert_session(pty_id, "", None, None)?,
            };
            db.insert_prompt(session_id, user_input)?;
        }
        CaptureEvent::AssistantStop {
            pty_id,
            response_text,
            tokens_in,
            tokens_out,
            cost_usd,
            elapsed_ms,
            error,
        } => {
            let session_id = lookup_session_id_by_pty(db, pty_id)?;
            db.set_response(
                session_id,
                response_text.as_deref(),
                *tokens_in,
                *tokens_out,
                *cost_usd,
                *elapsed_ms,
                error.as_deref(),
            )?;
        }
        CaptureEvent::SessionEnd { pty_id } => {
            db.close_session(pty_id)?;
        }
    }
    Ok(())
}

fn lookup_session_id_by_pty(db: &Db, pty_id: &str) -> Result<i64, String> {
    db.conn
        .query_row(
            "SELECT id FROM sessions WHERE pty_id = ?1 ORDER BY id DESC LIMIT 1",
            params![pty_id],
            |r| r.get(0),
        )
        .map_err(|e| format!("no session for pty {pty_id}: {e}"))
}

// ---------------------------------------------------------------------------
// Tauri read commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn prompt_list_sessions(db: State<'_, Mutex<Db>>) -> Result<Vec<SessionRow>, String> {
    let db = db.lock().map_err(|e| format!("db lock: {e}"))?;
    db.list_sessions()
}

#[tauri::command]
pub fn prompt_list_by_session(
    db: State<'_, Mutex<Db>>,
    session_id: i64,
) -> Result<Vec<PromptListRow>, String> {
    let db = db.lock().map_err(|e| format!("db lock: {e}"))?;
    db.list_prompts_by_session(session_id)
}

#[tauri::command]
pub fn prompt_get(db: State<'_, Mutex<Db>>, id: i64) -> Result<Option<PromptFullRow>, String> {
    let db = db.lock().map_err(|e| format!("db lock: {e}"))?;
    db.get_prompt(id)
}

#[tauri::command]
pub fn prompt_search(
    db: State<'_, Mutex<Db>>,
    needle: String,
) -> Result<Vec<PromptListRow>, String> {
    if needle.trim().is_empty() {
        return Ok(Vec::new());
    }
    let db = db.lock().map_err(|e| format!("db lock: {e}"))?;
    db.search_prompts(needle.trim())
}

#[tauri::command]
pub fn prompt_delete_sessions(
    db: State<'_, Mutex<Db>>,
    session_ids: Vec<i64>,
) -> Result<usize, String> {
    let mut db = db.lock().map_err(|e| format!("db lock: {e}"))?;
    db.delete_sessions(&session_ids)
}

/// Result of an idempotent hook-install attempt for one CLI.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallHooksResult {
    pub cli: String,
    pub ok: bool,
    pub message: String,
    pub already_installed: bool,
}

const POLAKAPI_HOOK_MARKER: &str = "polakapi-managed";

/// Idempotently installs the polakapi hooks block into the user's
/// `~/.claude/settings.json` (for Claude) or `~/.codex/hooks.json` (for
/// Codex). The hook command points at the running polakapi binary via the
/// `capture` subcommand. We never touch hooks we did not add — the block
/// is only inserted if missing, and re-insertion is detected via the
/// `polakapi-managed` marker in a trailing comment field.
///
/// Returns `already_installed: true` when the block is already present and
/// unchanged. The frontend uses this to show a "ready" status instead of
/// claiming it installed on every check.
#[tauri::command]
pub fn prompt_install_hooks(cli: String) -> Result<InstallHooksResult, String> {
    install_hooks_for_cli(&cli)
}

/// Plain callable used by the tauri command and by the `polakapi
/// install-hooks` subcommand (so users can register hooks from a shell
/// without launching the app).
pub fn install_hooks_for_cli(cli: &str) -> Result<InstallHooksResult, String> {
    let cli_lower = cli.to_ascii_lowercase();
    let bin = std::env::current_exe()
        .map_err(|e| format!("resolve current exe: {e}"))?
        .to_string_lossy()
        .to_string();
    match cli_lower.as_str() {
        "claude" => install_claude_hooks(&bin),
        "codex" => install_codex_hooks(&bin),
        other => Err(format!("unsupported cli: {other}")),
    }
}

fn install_claude_hooks(bin: &str) -> Result<InstallHooksResult, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    let claude_dir = format!("{home}/.claude");
    std::fs::create_dir_all(&claude_dir).map_err(|e| format!("mkdir {claude_dir}: {e}"))?;
    let settings_path = format!("{claude_dir}/settings.json");
    let mut root: serde_json::Value = if let Ok(s) = std::fs::read_to_string(&settings_path) {
        if s.trim().is_empty() {
            serde_json::json!({})
        } else {
            serde_json::from_str(&s).map_err(|e| format!("parse {settings_path}: {e}"))?
        }
    } else {
        serde_json::json!({})
    };
    let hook_cmd = format!("\"{bin}\" capture");
    let desired_hooks = serde_json::json!({
        "SessionStart": [{
            "matcher": "startup|resume",
            "hooks": [{ "type": "command", "command": hook_cmd, "_polakapi": POLAKAPI_HOOK_MARKER }]
        }],
        "UserPromptSubmit": [{
            "hooks": [{ "type": "command", "command": hook_cmd, "_polakapi": POLAKAPI_HOOK_MARKER }]
        }],
        "Stop": [{
            "hooks": [{ "type": "command", "command": hook_cmd, "_polakapi": POLAKAPI_HOOK_MARKER }]
        }],
        "SessionEnd": [{
            "hooks": [{ "type": "command", "command": hook_cmd, "_polakapi": POLAKAPI_HOOK_MARKER }]
        }]
    });
    let already = claude_has_marker(&root, &settings_path);
    if !already {
        // Merge: for each event, replace or append marker-tagged entries.
        let hooks_obj = root.as_object_mut().and_then(|o| {
            o.entry("hooks")
                .or_insert(serde_json::json!({}))
                .as_object_mut()
        });
        if let Some(hooks_obj) = hooks_obj {
            merge_marker_groups(hooks_obj, &desired_hooks);
        } else {
            root["hooks"] = desired_hooks;
        }
        let serialized =
            serde_json::to_string_pretty(&root).map_err(|e| format!("serialize settings: {e}"))?;
        std::fs::write(&settings_path, serialized)
            .map_err(|e| format!("write {settings_path}: {e}"))?;
    }
    Ok(InstallHooksResult {
        cli: "claude".into(),
        ok: true,
        message: format!(
            "{} hooks in {}",
            if already { "kept" } else { "installed" },
            settings_path
        ),
        already_installed: already,
    })
}

/// Detects whether any hook handler in the given settings has our
/// `polakapi` marker in a `_polakapi` extra key. Claude's hook schema
/// permits unknown keys on hook handler objects (they're ignored), so we
/// use a leading-underscore field as a stable marker we control.
fn claude_has_marker(root: &serde_json::Value, _path: &str) -> bool {
    let Some(hooks) = root.get("hooks") else {
        return false;
    };
    let Some(hooks_obj) = hooks.as_object() else {
        return false;
    };
    for (_event, groups) in hooks_obj {
        if let Some(groups) = groups.as_array() {
            for group in groups {
                if let Some(hooks) = group.get("hooks").and_then(|h| h.as_array()) {
                    for hook in hooks {
                        if hook
                            .get("_polakapi")
                            .and_then(|m| m.as_str())
                            .map(|m| m == POLAKAPI_HOOK_MARKER)
                            .unwrap_or(false)
                        {
                            return true;
                        }
                    }
                }
            }
        }
    }
    false
}

/// Merges our marker-tagged groups into the existing hooks object without
/// removing user hooks: for each event we want, drop any groups whose
/// only handler entries are ours, then push our desired group.
fn merge_marker_groups(
    hooks_obj: &mut serde_json::Map<String, serde_json::Value>,
    desired: &serde_json::Value,
) {
    let Some(desired_obj) = desired.as_object() else {
        return;
    };
    for (event, desired_group_arr) in desired_obj {
        let desired_groups = desired_group_arr.as_array().cloned().unwrap_or_default();
        // Remove existing polakapi-marked groups for this event.
        if let Some(existing) = hooks_obj.get_mut(event).and_then(|e| e.as_array_mut()) {
            existing.retain(|group| {
                let hooks = group.get("hooks").and_then(|h| h.as_array());
                match hooks {
                    Some(hooks) => !hooks.iter().all(is_marker),
                    None => true,
                }
            });
            existing.extend(desired_groups);
        } else {
            hooks_obj.insert(event.clone(), serde_json::Value::Array(desired_groups));
        }
    }
}

fn is_marker(hook: &serde_json::Value) -> bool {
    hook.get("_polakapi")
        .and_then(|m| m.as_str())
        .map(|m| m == POLAKAPI_HOOK_MARKER)
        .unwrap_or(false)
}

fn install_codex_hooks(bin: &str) -> Result<InstallHooksResult, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    let codex_dir = format!("{home}/.codex");
    std::fs::create_dir_all(&codex_dir).map_err(|e| format!("mkdir {codex_dir}: {e}"))?;
    let hooks_path = format!("{codex_dir}/hooks.json");
    let mut root: serde_json::Value = if let Ok(s) = std::fs::read_to_string(&hooks_path) {
        if s.trim().is_empty() {
            serde_json::json!({})
        } else {
            serde_json::from_str(&s).map_err(|e| format!("parse {hooks_path}: {e}"))?
        }
    } else {
        serde_json::json!({})
    };
    let hook_cmd = format!("\"{bin}\" capture");
    let desired = serde_json::json!({
        "SessionStart": [{ "matcher": "startup|resume", "hooks": [{ "type": "command", "command": hook_cmd, "_polakapi": POLAKAPI_HOOK_MARKER }] }],
        "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": hook_cmd, "_polakapi": POLAKAPI_HOOK_MARKER }] }],
        "Stop": [{ "hooks": [{ "type": "command", "command": hook_cmd, "_polakapi": POLAKAPI_HOOK_MARKER }] }],
        "SessionEnd": [{ "hooks": [{ "type": "command", "command": hook_cmd, "_polakapi": POLAKAPI_HOOK_MARKER }] }]
    });
    let already = claude_has_marker(&root, &hooks_path);
    if !already {
        let hooks_obj = root.as_object_mut().and_then(|o| {
            o.entry("hooks")
                .or_insert(serde_json::json!({}))
                .as_object_mut()
        });
        if let Some(hooks_obj) = hooks_obj {
            merge_marker_groups(hooks_obj, &desired);
        } else {
            root["hooks"] = desired;
        }
        std::fs::write(&hooks_path, serde_json::to_string_pretty(&root).unwrap())
            .map_err(|e| format!("write {hooks_path}: {e}"))?;
    }
    Ok(InstallHooksResult {
        cli: "codex".into(),
        ok: true,
        message: format!(
            "{} hooks in {}",
            if already { "kept" } else { "installed" },
            hooks_path
        ),
        already_installed: already,
    })
}

// Re-exported for `lib.rs` to register in `tauri::generate_handler!`.

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn tmp_db() -> (TempDir, Db) {
        let dir = TempDir::new().expect("tmpdir");
        let db = Db::open(&dir.path().join("test.db")).expect("open");
        (dir, db)
    }

    #[test]
    fn opens_and_migrates_fresh_db() {
        let (_dir, db) = tmp_db();
        let v: i64 = db
            .conn
            .query_row("SELECT MAX(version) FROM schema_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, 1);
    }

    #[test]
    fn idempotent_migrations_do_not_reapply() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("a.db");
        let _ = Db::open(&path).unwrap();
        let db = Db::open(&path).unwrap();
        let v: i64 = db
            .conn
            .query_row("SELECT MAX(version) FROM schema_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, 1);
    }

    #[test]
    fn apply_event_full_flow_inserts_prompt_and_response() {
        let (_dir, db) = tmp_db();
        let events = [
            CaptureEvent::SessionStart {
                pty_id: "pty-1".into(),
                cli: "claude".into(),
                cli_session_id: Some("cc-sess".into()),
                cwd: Some("/tmp".into()),
            },
            CaptureEvent::UserPrompt {
                pty_id: "pty-1".into(),
                user_input: "hello world".into(),
            },
            CaptureEvent::AssistantStop {
                pty_id: "pty-1".into(),
                response_text: Some("hi there".into()),
                tokens_in: Some(10),
                tokens_out: Some(5),
                cost_usd: Some(0.001),
                elapsed_ms: Some(120),
                error: None,
            },
            CaptureEvent::SessionEnd {
                pty_id: "pty-1".into(),
            },
        ];
        for ev in &events {
            apply_event(&db, ev).expect("apply");
        }

        let sessions = db.list_sessions().expect("list");
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].prompt_count, 1);
        assert_eq!(sessions[0].status, "closed");
        assert_eq!(sessions[0].title.as_deref(), Some("hello world"));

        let prompts = db.list_prompts_by_session(sessions[0].id).expect("list p");
        assert_eq!(prompts.len(), 1);
        assert!(prompts[0].has_response);

        let full = db.get_prompt(prompts[0].id).expect("get").unwrap();
        assert_eq!(full.user_input.as_deref(), Some("hello world"));
        assert_eq!(full.response_text.as_deref(), Some("hi there"));
        assert_eq!(full.tokens_in, Some(10));
    }

    #[test]
    fn search_matches_user_input_or_response() {
        let (_dir, db) = tmp_db();
        apply_event(
            &db,
            &CaptureEvent::SessionStart {
                pty_id: "p".into(),
                cli: "claude".into(),
                cli_session_id: None,
                cwd: None,
            },
        )
        .unwrap();
        apply_event(
            &db,
            &CaptureEvent::UserPrompt {
                pty_id: "p".into(),
                user_input: "how do I parse JSON in rust".into(),
            },
        )
        .unwrap();
        apply_event(
            &db,
            &CaptureEvent::AssistantStop {
                pty_id: "p".into(),
                response_text: Some("use serde_json::from_str".into()),
                tokens_in: None,
                tokens_out: None,
                cost_usd: None,
                elapsed_ms: None,
                error: None,
            },
        )
        .unwrap();

        let hits_input = db.search_prompts("parse").expect("search");
        assert_eq!(hits_input.len(), 1);
        let hits_resp = db.search_prompts("serde_json").expect("search");
        assert_eq!(hits_resp.len(), 1);
        let hits_none = db.search_prompts("nonexistent").expect("search");
        assert!(hits_none.is_empty());
    }

    #[test]
    fn multiple_prompts_in_session_share_seq() {
        let (_dir, db) = tmp_db();
        apply_event(
            &db,
            &CaptureEvent::SessionStart {
                pty_id: "p".into(),
                cli: "claude".into(),
                cli_session_id: None,
                cwd: None,
            },
        )
        .unwrap();
        for i in 0..3 {
            apply_event(
                &db,
                &CaptureEvent::UserPrompt {
                    pty_id: "p".into(),
                    user_input: format!("turn {i}"),
                },
            )
            .unwrap();
            apply_event(
                &db,
                &CaptureEvent::AssistantStop {
                    pty_id: "p".into(),
                    response_text: Some(format!("ans {i}")),
                    tokens_in: None,
                    tokens_out: None,
                    cost_usd: None,
                    elapsed_ms: None,
                    error: None,
                },
            )
            .unwrap();
        }
        let sessions = db.list_sessions().expect("list");
        assert_eq!(sessions[0].prompt_count, 3);
        let prompts = db.list_prompts_by_session(sessions[0].id).expect("list");
        assert_eq!(prompts.iter().map(|p| p.seq).collect::<Vec<_>>(), [1, 2, 3]);
    }

    #[test]
    fn delete_sessions_removes_prompts_and_deduplicates_ids() {
        let (_dir, mut db) = tmp_db();
        for pty_id in ["p1", "p2"] {
            apply_event(
                &db,
                &CaptureEvent::SessionStart {
                    pty_id: pty_id.into(),
                    cli: "claude".into(),
                    cli_session_id: None,
                    cwd: None,
                },
            )
            .unwrap();
            apply_event(
                &db,
                &CaptureEvent::UserPrompt {
                    pty_id: pty_id.into(),
                    user_input: format!("prompt {pty_id}"),
                },
            )
            .unwrap();
        }

        let deleted_id = lookup_session_id_by_pty(&db, "p1").unwrap();
        let kept_id = lookup_session_id_by_pty(&db, "p2").unwrap();
        let deleted = db
            .delete_sessions(&[deleted_id, deleted_id, 999_999])
            .expect("delete");
        let deleted_prompt_count: i64 = db
            .conn
            .query_row(
                "SELECT COUNT(*) FROM prompts WHERE session_id = ?1",
                params![deleted_id],
                |r| r.get(0),
            )
            .unwrap();

        assert_eq!(deleted, 1);
        assert_eq!(deleted_prompt_count, 0);
        assert_eq!(db.list_sessions().unwrap().len(), 1);
        assert_eq!(db.list_prompts_by_session(deleted_id).unwrap().len(), 0);
        assert_eq!(db.list_prompts_by_session(kept_id).unwrap().len(), 1);
    }
}
