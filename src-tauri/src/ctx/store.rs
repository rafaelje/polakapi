use std::path::Path;

use rusqlite::{params, Connection};
use serde::Serialize;

// SQLite store for offloaded tool output: one row per source, its chunks, and
// an FTS5 index over the chunk bodies.
//
// The body text lives only in the FTS5 table, keyed by the chunk's rowid, so
// nothing is stored twice. `ctx_chunk` carries the metadata the UI needs and
// `ctx_fts` carries the searchable text.

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS ctx_source (
  id            INTEGER PRIMARY KEY,
  session_id    TEXT NOT NULL,
  source        TEXT NOT NULL,
  kind          TEXT NOT NULL,
  raw_bytes     INTEGER NOT NULL,
  context_bytes INTEGER NOT NULL,
  artifact      TEXT,
  created_at    INTEGER NOT NULL,
  UNIQUE(session_id, source)
);
CREATE TABLE IF NOT EXISTS ctx_chunk (
  id        INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES ctx_source(id) ON DELETE CASCADE,
  ordinal   INTEGER NOT NULL,
  heading   TEXT,
  has_code  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ctx_chunk_source ON ctx_chunk(source_id);
CREATE VIRTUAL TABLE IF NOT EXISTS ctx_fts USING fts5(body, tokenize='porter');
";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceRow {
    pub source: String,
    pub kind: String,
    pub raw_bytes: u64,
    pub context_bytes: u64,
    pub chunks: u64,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchRow {
    pub source: String,
    pub ordinal: i64,
    pub heading: Option<String>,
    pub has_code: bool,
    pub snippet: String,
}

/// Everything about one offload except its chunks.
#[derive(Debug, Clone, Copy)]
pub struct NewSource<'a> {
    pub session_id: &'a str,
    pub source: &'a str,
    pub kind: &'a str,
    pub raw_bytes: u64,
    pub context_bytes: u64,
    pub artifact: Option<&'a str>,
}

/// A chunk on its way into the store.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewChunk {
    pub heading: Option<String>,
    pub has_code: bool,
    pub body: String,
}

pub struct CtxStore {
    conn: Connection,
}

impl CtxStore {
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("could not create {}: {e}", parent.display()))?;
        }
        let conn = Connection::open(path)
            .map_err(|e| format!("could not open {}: {e}", path.display()))?;
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(|e| format!("could not set WAL: {e}"))?;
        conn.pragma_update(None, "foreign_keys", "ON")
            .map_err(|e| format!("could not enable FK: {e}"))?;
        conn.execute_batch(SCHEMA)
            .map_err(|e| format!("ctx schema: {e}"))?;
        Ok(Self { conn })
    }

    #[cfg(test)]
    pub fn open_in_memory() -> Result<Self, String> {
        let conn = Connection::open_in_memory().map_err(|e| e.to_string())?;
        conn.execute_batch(SCHEMA)
            .map_err(|e| format!("ctx schema: {e}"))?;
        Ok(Self { conn })
    }

    /// Records one offload. Re-offloading the same `source` in the same session
    /// replaces it, so a repeated command does not accumulate stale chunks.
    pub fn put_source(&mut self, meta: NewSource<'_>, chunks: &[NewChunk]) -> Result<i64, String> {
        let NewSource {
            session_id,
            source,
            kind,
            raw_bytes,
            context_bytes,
            artifact,
        } = meta;
        let now = crate::loop_prompts::epoch_ms_now();
        let tx = self
            .conn
            .transaction()
            .map_err(|e| format!("ctx transaction: {e}"))?;
        tx.execute(
            "DELETE FROM ctx_fts WHERE rowid IN
               (SELECT c.id FROM ctx_chunk c
                  JOIN ctx_source s ON s.id = c.source_id
                 WHERE s.session_id = ?1 AND s.source = ?2)",
            params![session_id, source],
        )
        .map_err(|e| format!("ctx clear fts: {e}"))?;
        tx.execute(
            "DELETE FROM ctx_source WHERE session_id = ?1 AND source = ?2",
            params![session_id, source],
        )
        .map_err(|e| format!("ctx clear source: {e}"))?;
        tx.execute(
            "INSERT INTO ctx_source
               (session_id, source, kind, raw_bytes, context_bytes, artifact, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                session_id,
                source,
                kind,
                raw_bytes as i64,
                context_bytes as i64,
                artifact,
                now
            ],
        )
        .map_err(|e| format!("ctx insert source: {e}"))?;
        let source_id = tx.last_insert_rowid();

        for (ordinal, chunk) in chunks.iter().enumerate() {
            tx.execute(
                "INSERT INTO ctx_chunk (source_id, ordinal, heading, has_code)
                 VALUES (?1, ?2, ?3, ?4)",
                params![
                    source_id,
                    ordinal as i64,
                    chunk.heading.as_deref(),
                    i64::from(chunk.has_code)
                ],
            )
            .map_err(|e| format!("ctx insert chunk: {e}"))?;
            let chunk_id = tx.last_insert_rowid();
            tx.execute(
                "INSERT INTO ctx_fts (rowid, body) VALUES (?1, ?2)",
                params![chunk_id, chunk.body],
            )
            .map_err(|e| format!("ctx index chunk: {e}"))?;
        }
        tx.commit().map_err(|e| format!("ctx commit: {e}"))?;
        Ok(source_id)
    }

    /// BM25-ranked search, optionally scoped to one source.
    pub fn search(
        &self,
        session_id: &str,
        query: &str,
        source: Option<&str>,
        limit: usize,
    ) -> Result<Vec<SearchRow>, String> {
        let Some(query) = fts_query(query) else {
            return Ok(Vec::new());
        };
        let sql = "
            SELECT s.source, c.ordinal, c.heading, c.has_code,
                   snippet(ctx_fts, 0, '', '', '…', 24)
              FROM ctx_fts
              JOIN ctx_chunk c ON c.id = ctx_fts.rowid
              JOIN ctx_source s ON s.id = c.source_id
             WHERE ctx_fts MATCH ?1
               AND s.session_id = ?2
               AND (?3 IS NULL OR s.source = ?3)
             ORDER BY bm25(ctx_fts)
             LIMIT ?4";
        let mut stmt = self
            .conn
            .prepare(sql)
            .map_err(|e| format!("ctx prepare search: {e}"))?;
        let rows = stmt
            .query_map(params![query, session_id, source, limit as i64], |row| {
                Ok(SearchRow {
                    source: row.get(0)?,
                    ordinal: row.get(1)?,
                    heading: row.get(2)?,
                    has_code: row.get::<_, i64>(3)? != 0,
                    snippet: row.get(4)?,
                })
            })
            .map_err(|e| format!("ctx query search: {e}"))?;
        rows.collect::<Result<_, _>>()
            .map_err(|e| format!("ctx search row: {e}"))
    }

    /// One chunk verbatim — what `ctx_read` returns once search has located it.
    pub fn read_chunk(
        &self,
        session_id: &str,
        source: &str,
        ordinal: i64,
    ) -> Result<Option<String>, String> {
        let row = self.conn.query_row(
            "SELECT f.body
               FROM ctx_chunk c
               JOIN ctx_source s ON s.id = c.source_id
               JOIN ctx_fts f ON f.rowid = c.id
              WHERE s.session_id = ?1 AND s.source = ?2 AND c.ordinal = ?3",
            params![session_id, source, ordinal],
            |row| row.get::<_, String>(0),
        );
        match row {
            Ok(body) => Ok(Some(body)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(format!("ctx read chunk: {e}")),
        }
    }

    pub fn list_sources(&self, session_id: &str) -> Result<Vec<SourceRow>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT s.source, s.kind, s.raw_bytes, s.context_bytes, s.created_at,
                        (SELECT COUNT(*) FROM ctx_chunk c WHERE c.source_id = s.id)
                   FROM ctx_source s
                  WHERE s.session_id = ?1
                  ORDER BY s.created_at DESC",
            )
            .map_err(|e| format!("ctx prepare list: {e}"))?;
        let rows = stmt
            .query_map(params![session_id], |row| {
                Ok(SourceRow {
                    source: row.get(0)?,
                    kind: row.get(1)?,
                    raw_bytes: row.get::<_, i64>(2)?.max(0) as u64,
                    context_bytes: row.get::<_, i64>(3)?.max(0) as u64,
                    created_at: row.get(4)?,
                    chunks: row.get::<_, i64>(5)?.max(0) as u64,
                })
            })
            .map_err(|e| format!("ctx query list: {e}"))?;
        rows.collect::<Result<_, _>>()
            .map_err(|e| format!("ctx list row: {e}"))
    }

    /// `(raw bytes offloaded, bytes that still reached the context)`.
    pub fn savings(&self, session_id: &str) -> Result<(u64, u64), String> {
        self.conn
            .query_row(
                "SELECT COALESCE(SUM(raw_bytes), 0), COALESCE(SUM(context_bytes), 0)
                   FROM ctx_source WHERE session_id = ?1",
                params![session_id],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?.max(0) as u64,
                        row.get::<_, i64>(1)?.max(0) as u64,
                    ))
                },
            )
            .map_err(|e| format!("ctx savings: {e}"))
    }
}

/// Turns what an agent types into a literal FTS5 query.
///
/// FTS5 gives meaning to characters agents use all the time: `name:` is a column
/// filter, a hyphen splits into a column reference, a bare quote opens a string,
/// and AND/OR/NOT are operators. Quoting every word makes each one literal. Words
/// are still ANDed, and a trailing `*` keeps working as a prefix search.
fn fts_query(input: &str) -> Option<String> {
    let terms: Vec<String> = input
        .split_whitespace()
        .filter_map(|word| {
            let (word, prefix) = match word.strip_suffix('*') {
                Some(stem) => (stem, true),
                None => (word, false),
            };
            let word = word.replace('"', "");
            if !word.chars().any(char::is_alphanumeric) {
                return None;
            }
            let quoted = format!("\"{word}\"");
            Some(if prefix { format!("{quoted}*") } else { quoted })
        })
        .collect();
    (!terms.is_empty()).then(|| terms.join(" "))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chunk(heading: &str, body: &str) -> NewChunk {
        NewChunk {
            heading: Some(heading.to_string()),
            has_code: body.contains("```"),
            body: body.to_string(),
        }
    }

    fn meta<'a>(source: &'a str, raw_bytes: u64, context_bytes: u64) -> NewSource<'a> {
        NewSource {
            session_id: "s1",
            source,
            kind: "shell",
            raw_bytes,
            context_bytes,
            artifact: None,
        }
    }

    fn seeded() -> CtxStore {
        let mut store = CtxStore::open_in_memory().unwrap();
        store
            .put_source(
                meta("exec:shell", 59_000, 1_100),
                &[
                    chunk("Cleanup", "useEffect returns a cleanup function"),
                    chunk("Fetching", "```js\nfetch(url)\n```"),
                ],
            )
            .unwrap();
        store
    }

    #[test]
    fn fts5_is_available_and_indexes_chunks() {
        let store = seeded();
        let hits = store.search("s1", "cleanup", None, 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].source, "exec:shell");
        assert_eq!(hits[0].heading.as_deref(), Some("Cleanup"));
        assert!(hits[0].snippet.contains("cleanup"));
    }

    #[test]
    fn plain_text_queries_never_hit_fts5_syntax() {
        // What agents actually type: a colon reads as a column filter, a hyphen
        // as a column too, and bare AND/NOT or a stray quote as broken syntax.
        let store = seeded();
        for query in [
            "cleanup:",
            "returns-a",
            "\"unbalanced",
            "cleanup AND",
            "NOT",
            "function)",
        ] {
            assert!(
                store.search("s1", query, None, 10).is_ok(),
                "{query:?} errored"
            );
        }
        assert_eq!(store.search("s1", "cleanup:", None, 10).unwrap().len(), 1);
    }

    #[test]
    fn a_trailing_star_still_searches_by_prefix() {
        let store = seeded();
        assert_eq!(store.search("s1", "clean*", None, 10).unwrap().len(), 1);
    }

    #[test]
    fn a_query_with_no_words_returns_nothing_instead_of_failing() {
        let store = seeded();
        assert!(store.search("s1", "  \"  ", None, 10).unwrap().is_empty());
    }

    #[test]
    fn search_stems_so_a_word_form_still_matches() {
        // The porter tokenizer is what makes "returning" find "returns".
        let store = seeded();
        assert_eq!(store.search("s1", "returning", None, 10).unwrap().len(), 1);
    }

    #[test]
    fn search_can_be_scoped_to_one_source() {
        let mut store = seeded();
        store
            .put_source(
                meta("exec:other", 10, 10),
                &[chunk("Other", "cleanup lives here too")],
            )
            .unwrap();
        assert_eq!(store.search("s1", "cleanup", None, 10).unwrap().len(), 2);
        let scoped = store
            .search("s1", "cleanup", Some("exec:other"), 10)
            .unwrap();
        assert_eq!(scoped.len(), 1);
        assert_eq!(scoped[0].source, "exec:other");
    }

    #[test]
    fn sessions_do_not_see_each_others_data() {
        let store = seeded();
        assert!(store
            .search("other-session", "cleanup", None, 10)
            .unwrap()
            .is_empty());
        assert!(store.list_sources("other-session").unwrap().is_empty());
    }

    #[test]
    fn code_blocks_come_back_verbatim() {
        let store = seeded();
        let body = store.read_chunk("s1", "exec:shell", 1).unwrap().unwrap();
        assert_eq!(body, "```js\nfetch(url)\n```");
        assert!(store.read_chunk("s1", "exec:shell", 99).unwrap().is_none());
    }

    #[test]
    fn re_offloading_a_source_replaces_it_instead_of_duplicating() {
        let mut store = seeded();
        store
            .put_source(
                meta("exec:shell", 10, 5),
                &[chunk("Fresh", "brand new body")],
            )
            .unwrap();
        let sources = store.list_sources("s1").unwrap();
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].chunks, 1);
        // The old chunks left the index with the old source.
        assert!(store.search("s1", "cleanup", None, 10).unwrap().is_empty());
        assert_eq!(store.search("s1", "brand", None, 10).unwrap().len(), 1);
    }

    #[test]
    fn savings_add_up_per_session() {
        let store = seeded();
        assert_eq!(store.savings("s1").unwrap(), (59_000, 1_100));
        assert_eq!(store.savings("nobody").unwrap(), (0, 0));
    }

    #[test]
    fn list_reports_chunk_counts() {
        let store = seeded();
        let sources = store.list_sources("s1").unwrap();
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].chunks, 2);
        assert_eq!(sources[0].raw_bytes, 59_000);
    }
}
