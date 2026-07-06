-- 0001_init.sql · initial schema for the prompts history DB.
-- One row in `sessions` per terminal-panel tab whose spawned command is an
-- AI CLI (claude / codex / opencode). One row in `prompts` per user turn
-- (prompt + the assistant response that followed).

CREATE TABLE IF NOT EXISTS sessions (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    pty_id           TEXT    NOT NULL,
    cli              TEXT    NOT NULL,
    cli_session_id   TEXT,
    cwd              TEXT,
    title            TEXT,
    status           TEXT    NOT NULL DEFAULT 'active',
    created_at       INTEGER NOT NULL,
    closed_at        INTEGER
);

CREATE INDEX IF NOT EXISTS idx_sessions_pty_id     ON sessions (pty_id);
CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON sessions (created_at);

CREATE TABLE IF NOT EXISTS prompts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      INTEGER NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    seq             INTEGER NOT NULL,
    user_input      TEXT,
    response_text   TEXT,
    tokens_in       INTEGER,
    tokens_out      INTEGER,
    cost_usd        REAL,
    elapsed_ms      INTEGER,
    error           TEXT,
    created_at      INTEGER NOT NULL,
    UNIQUE (session_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_prompts_session_id  ON prompts (session_id);
CREATE INDEX IF NOT EXISTS idx_prompts_created_at  ON prompts (created_at);

CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL
);