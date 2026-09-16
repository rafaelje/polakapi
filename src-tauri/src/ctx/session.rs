use std::path::{Path, PathBuf};

use crate::ctx::config::CtxConfig;
use crate::ctx::offload::{offload, OffloadResult};
use crate::ctx::paths::{self, Storage};
use crate::ctx::store::{CtxStore, SearchRow, SourceRow};

// One agent session's store, plus the rule that decides where it lives.
//
// Ephemeral sessions stay in the temp directory. A promoted session starts
// there and moves into the project once it has offloaded enough to be worth
// keeping; moving means closing the database first, so the connection is
// dropped and reopened around the move.

pub struct CtxSession {
    session_id: String,
    project: Option<PathBuf>,
    config: CtxConfig,
    dir: PathBuf,
    store: Option<CtxStore>,
    persisted: bool,
}

impl CtxSession {
    pub fn open(
        session_id: &str,
        project: Option<&Path>,
        config: CtxConfig,
    ) -> Result<Self, String> {
        let persist_now = paths::should_persist(config.storage, 0, config.promote_after_sources);
        let dir = match (persist_now, project) {
            (true, Some(project)) => {
                paths::ensure_self_ignored(project)?;
                paths::project_store(project, session_id)
            }
            _ => paths::temp_store(session_id),
        }
        .ok_or_else(|| format!("unsafe session id: {session_id}"))?;

        let store = CtxStore::open(&dir.join("ctx.db"))?;
        Ok(Self {
            session_id: session_id.to_string(),
            project: project.map(Path::to_path_buf),
            config,
            dir,
            store: Some(store),
            persisted: persist_now,
        })
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn store(&mut self) -> Result<&mut CtxStore, String> {
        self.store
            .as_mut()
            .ok_or_else(|| "context store is closed".to_string())
    }

    pub fn offload(&mut self, source: &str, text: &str) -> Result<OffloadResult, String> {
        let artifacts = self.dir.join("artifacts");
        let policy = self.config.policy;
        let session_id = self.session_id.clone();
        let result = offload(
            self.store()?,
            Some(&artifacts),
            &session_id,
            source,
            text,
            &policy,
        )?;
        self.promote_if_due()?;
        Ok(result)
    }

    pub fn search(
        &mut self,
        query: &str,
        source: Option<&str>,
        limit: usize,
    ) -> Result<Vec<SearchRow>, String> {
        let session_id = self.session_id.clone();
        self.store()?.search(&session_id, query, source, limit)
    }

    pub fn read(&mut self, source: &str, ordinal: i64) -> Result<Option<String>, String> {
        let session_id = self.session_id.clone();
        self.store()?.read_chunk(&session_id, source, ordinal)
    }

    pub fn list(&mut self) -> Result<Vec<SourceRow>, String> {
        let session_id = self.session_id.clone();
        self.store()?.list_sources(&session_id)
    }

    pub fn savings(&mut self) -> Result<(u64, u64), String> {
        let session_id = self.session_id.clone();
        self.store()?.savings(&session_id)
    }

    /// Moves the store into the project once the session has grown enough.
    fn promote_if_due(&mut self) -> Result<(), String> {
        if self.persisted || self.config.storage != Storage::Promote {
            return Ok(());
        }
        let Some(project) = self.project.clone() else {
            return Ok(());
        };
        let sources = self.list()?.len() as u64;
        if !paths::should_persist(
            self.config.storage,
            sources,
            self.config.promote_after_sources,
        ) {
            return Ok(());
        }
        let target = paths::project_store(&project, &self.session_id)
            .ok_or_else(|| format!("unsafe session id: {}", self.session_id))?;
        paths::ensure_self_ignored(&project)?;

        // Close the database before the files move under it.
        self.store = None;
        paths::promote(&self.dir, &target)?;
        self.dir = target;
        self.store = Some(CtxStore::open(&self.dir.join("ctx.db"))?);
        self.persisted = true;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ctx::router::Policy;

    fn config(storage: Storage, promote_after: u64) -> CtxConfig {
        CtxConfig {
            enabled: true,
            storage,
            promote_after_sources: promote_after,
            policy: Policy {
                bypass_bytes: 10,
                externalize_bytes: 10_000,
            },
        }
    }

    fn body(tag: &str) -> String {
        (0..100).map(|i| format!("{tag} line {i}\n")).collect()
    }

    #[test]
    fn an_ephemeral_session_stays_out_of_the_project() {
        let project = tempfile::tempdir().unwrap();
        let mut session = CtxSession::open(
            "sess-ephemeral",
            Some(project.path()),
            config(Storage::Ephemeral, 1),
        )
        .unwrap();
        session.offload("exec:one", &body("a")).unwrap();
        assert!(!project.path().join(paths::STORE_DIR).join("ctx").exists());
    }

    #[test]
    fn project_mode_writes_into_the_project_from_the_start() {
        let project = tempfile::tempdir().unwrap();
        let session = CtxSession::open(
            "sess-project",
            Some(project.path()),
            config(Storage::Project, 20),
        )
        .unwrap();
        assert!(session.dir().starts_with(project.path()));
        // And the store ignores itself immediately.
        let ignore = project.path().join(paths::STORE_DIR).join(".gitignore");
        assert_eq!(std::fs::read_to_string(ignore).unwrap(), "*\n");
    }

    #[test]
    fn a_growing_session_is_promoted_into_the_project() {
        let project = tempfile::tempdir().unwrap();
        let mut session = CtxSession::open(
            "sess-promote",
            Some(project.path()),
            config(Storage::Promote, 2),
        )
        .unwrap();

        session.offload("exec:one", &body("a")).unwrap();
        assert!(!session.dir().starts_with(project.path()), "still in temp");

        session.offload("exec:two", &body("b")).unwrap();
        assert!(session.dir().starts_with(project.path()), "promoted");

        // The data survived the move, and remains searchable.
        assert_eq!(session.list().unwrap().len(), 2);
    }

    #[test]
    fn promotion_without_a_known_project_is_a_no_op() {
        let mut session =
            CtxSession::open("sess-noproject", None, config(Storage::Promote, 1)).unwrap();
        session.offload("exec:one", &body("a")).unwrap();
        assert_eq!(session.list().unwrap().len(), 1);
    }

    #[test]
    fn rejects_a_session_id_that_would_escape_the_store() {
        assert!(CtxSession::open("../escape", None, config(Storage::Ephemeral, 1)).is_err());
    }
}
