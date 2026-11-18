//! Grants belong to a source session and a single live reviewer. No review
//! content is captured at launch, cached by the broker, or written to disk.
use super::*;
use rusqlite::{Connection, OpenFlags};
use serde::Deserialize;
use std::path::{Path, PathBuf};

#[derive(Clone)]
pub(super) struct Grant {
    reviewer: String,
    session: String,
    epoch: Uuid,
    database: PathBuf,
    home: PathBuf,
}

fn active(database: &Path, pane: &str, expected: &str) -> bool {
    let Ok(c) = Connection::open_with_flags(database, OpenFlags::SQLITE_OPEN_READ_ONLY) else {
        return false;
    };
    if c.busy_timeout(Duration::ZERO).is_err() {
        return false;
    }
    c.query_row("SELECT cli = 'codex' AND status = 'active' AND cli_session_id = ?2 FROM sessions WHERE pty_id = ?1 ORDER BY id DESC LIMIT 1",
        (pane, expected), |row| row.get::<_, bool>(0)).unwrap_or(false)
}

impl State {
    pub(super) fn revoke_pane(&mut self, pane: &str) {
        self.grants
            .retain(|source, grant| source != pane && grant.reviewer != pane);
    }

    fn permitted(&self, token: &str, target: &str) -> Option<&Grant> {
        let grant = self.grants.get(target)?;
        let recipient = self.peers.get(&grant.reviewer)?;
        let source = self.peers.get(target)?;
        (self.enabled && recipient.token == token && self.visible(recipient, source))
            .then_some(grant)
    }
}

impl Broker {
    pub(crate) fn revoke_review(&self, target: &str) {
        self.state.lock().grants.remove(target);
    }

    pub(crate) fn grant_review(
        &self,
        target: &str,
        reviewer: &str,
        session: &str,
        database: PathBuf,
        home: PathBuf,
    ) -> Result<(), String> {
        if Uuid::parse_str(session).is_err() || !active(&database, target, session) {
            return Err("No matching live Codex session. Refresh the context window and check session hooks.".into());
        }
        let mut state = self.state.lock();
        if !state.enabled
            || !state
                .peers
                .get(target)
                .zip(state.peers.get(reviewer))
                .is_some_and(|(a, b)| state.visible(a, b))
        {
            return Err(
                "Enable agent communication and select two enrolled panes in its current scope."
                    .into(),
            );
        }
        state.grants.insert(
            target.to_owned(),
            Grant {
                reviewer: reviewer.into(),
                session: session.into(),
                epoch: Uuid::new_v4(),
                database,
                home,
            },
        );
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadRequest {
    target: String,
    cursor: Option<Cursor>,
    #[serde(default)]
    from_start: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Cursor {
    grant_id: Uuid,
    offset: u64,
}

pub(super) async fn read(shared: &Arc<Mutex<State>>, token: &str, body: &[u8]) -> (u16, Value) {
    let unavailable = || {
        error_response(
            404,
            "review_unavailable",
            "No active review grant for this session",
        )
    };
    let Ok(req) = serde_json::from_slice::<ReadRequest>(body) else {
        return error_response(
            400,
            "invalid_review",
            "Expected target and optional review cursor",
        );
    };
    if req.from_start && req.cursor.is_some() {
        return error_response(400, "invalid_review", "Use a cursor or fromStart, not both");
    }
    let (grant, permit) = {
        let state = shared.lock();
        let Some(g) = state.permitted(token, &req.target) else {
            return unavailable();
        };
        if req.cursor.as_ref().is_some_and(|c| c.grant_id != g.epoch) {
            return error_response(
                409,
                "stale_cursor",
                "Review grant changed; request a new snapshot",
            );
        }
        let Ok(permit) = Arc::clone(&state.read_slot).try_acquire_owned() else {
            return error_response(429, "review_busy", "A context read is already in progress");
        };
        (g.clone(), permit)
    };
    let epoch = grant.epoch;
    let source = req.target.clone();
    let data = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        if !active(&grant.database, &source, &grant.session) {
            return None;
        }
        let result = if req.cursor.is_none() && !req.from_start {
            crate::agent_context::review::latest(&grant.home, &grant.session)
        } else {
            crate::agent_context::review::read(
                &grant.home,
                &grant.session,
                req.cursor.map(|c| c.offset),
            )
        };
        active(&grant.database, &source, &grant.session).then_some(result)
    })
    .await;
    let mut state = shared.lock();
    if state
        .permitted(token, &req.target)
        .is_none_or(|g| g.epoch != epoch)
    {
        return unavailable();
    }
    match data {
        Ok(Some(Ok(mut page))) => {
            let offset = page
                .as_object_mut()
                .and_then(|o| o.remove("nextCursor"))
                .unwrap_or(Value::Null);
            page["cursor"] = json!({"grantId":epoch,"offset":offset});
            (200, page)
        }
        Ok(None) => {
            state.grants.remove(&req.target);
            unavailable()
        }
        Ok(Some(Err(_))) | Err(_) => error_response(
            409,
            "review_not_ready",
            "The exact Codex session is unavailable or unsupported",
        ),
    }
}
