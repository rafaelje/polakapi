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
    generation: u64,
}

impl CtxSession {
    pub fn open(
        session_id: &str,
        project: Option<&Path>,
        config: CtxConfig,
    ) -> Result<Self, String> {
        // Not while another process is moving the store.
        let lifecycle = project.map(paths::ProjectLock::acquire).transpose()?;
        let _lock = lock(session_id);
        // A session promoted by an earlier process already lives in the project.
        // Each hooked command runs as its own process, so this is the only way
        // a later call finds what an earlier one stored.
        let already_promoted = project
            .and_then(|project| paths::project_store(project, session_id))
            .is_some_and(|dir| dir.join("ctx.db").is_file());
        let persist_now = already_promoted
            || paths::should_persist(config.storage, 0, config.promote_after_sources);
        let dir = match (persist_now, project) {
            (true, Some(project)) => {
                paths::ensure_self_ignored(project)?;
                paths::project_store(project, session_id)
            }
            _ => paths::temp_store(session_id),
        }
        .ok_or_else(|| format!("unsafe session id: {session_id}"))?;

        // Idle MCP sessions must not pin files that deletion or rename needs.
        drop(CtxStore::open(&dir.join("ctx.db"))?);
        Ok(Self {
            session_id: session_id.to_string(),
            project: project.map(Path::to_path_buf),
            config,
            dir,
            store: None,
            persisted: persist_now,
            generation: lifecycle.as_ref().map_or(0, |lock| lock.generation),
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
        // Every hooked command is its own process, and parallel ones share this
        // session: one of them promoting the store while another writes to it
        // would lose that write.
        self.with_store(|session| {
            let artifacts = session.dir.join("artifacts");
            let policy = session.config.policy;
            let session_id = session.session_id.clone();
            let result = offload(
                session.store()?,
                Some(&artifacts),
                &session_id,
                source,
                text,
                &policy,
            )?;
            session.promote_if_due()?;
            Ok(result)
        })
    }

    pub fn search(
        &mut self,
        query: &str,
        source: Option<&str>,
        limit: usize,
    ) -> Result<Vec<SearchRow>, String> {
        self.with_store(|session| {
            let session_id = session.session_id.clone();
            session.store()?.search(&session_id, query, source, limit)
        })
    }

    pub fn read(&mut self, source: &str, ordinal: i64) -> Result<Option<String>, String> {
        self.with_store(|session| {
            let session_id = session.session_id.clone();
            session.store()?.read_chunk(&session_id, source, ordinal)
        })
    }

    pub fn list(&mut self) -> Result<Vec<SourceRow>, String> {
        self.with_store(|session| {
            let session_id = session.session_id.clone();
            session.store()?.list_sources(&session_id)
        })
    }

    pub fn savings(&mut self) -> Result<(u64, u64), String> {
        self.with_store(|session| {
            let session_id = session.session_id.clone();
            session.store()?.savings(&session_id)
        })
    }

    fn lock(&self) -> Option<std::fs::File> {
        lock(&self.session_id)
    }

    /// The project store, when another process has promoted or renamed this
    /// session's store since it was opened here.
    fn promoted_elsewhere(&self) -> Option<PathBuf> {
        if self.persisted && self.dir.join("ctx.db").is_file() {
            return None;
        }
        let target = paths::project_store(self.project.as_deref()?, &self.session_id)?;
        (target != self.dir && target.join("ctx.db").is_file()).then_some(target)
    }

    fn with_store<T>(
        &mut self,
        operation: impl FnOnce(&mut Self) -> Result<T, String>,
    ) -> Result<T, String> {
        let lifecycle = self.project_lock()?;
        let _lock = self.lock();
        let result = self
            .refresh(lifecycle.as_ref())
            .and_then(|()| operation(self));
        // Close even on errors, and before releasing either lifecycle lock.
        self.store = None;
        result
    }

    fn project_lock(&self) -> Result<Option<paths::ProjectLock>, String> {
        self.project
            .as_deref()
            .map(paths::ProjectLock::acquire)
            .transpose()
    }

    /// Both locks stay held through the actual read/write, not just this check.
    fn refresh(&mut self, lifecycle: Option<&paths::ProjectLock>) -> Result<(), String> {
        let generation = lifecycle.map_or(0, |lock| lock.generation);
        if generation != self.generation {
            self.store = None;
            self.generation = generation;
            if self.persisted {
                let project = self.project.as_deref().ok_or("missing project")?;
                paths::ensure_self_ignored(project)?;
                self.dir =
                    paths::project_store(project, &self.session_id).ok_or("unsafe session id")?;
            }
        }
        self.switch_to_promoted()?;
        if self.store.is_none() {
            self.store = Some(CtxStore::open(&self.dir.join("ctx.db"))?);
        }
        Ok(())
    }

    /// Callers hold the lock.
    fn switch_to_promoted(&mut self) -> Result<(), String> {
        let Some(target) = self.promoted_elsewhere() else {
            return Ok(());
        };
        self.store = None;
        self.store = Some(CtxStore::open(&target.join("ctx.db"))?);
        self.dir = target;
        self.persisted = true;
        Ok(())
    }

    /// Moves the store into the project once the session has grown enough.
    fn promote_if_due(&mut self) -> Result<(), String> {
        if self.persisted || self.config.storage != Storage::Promote {
            return Ok(());
        }
        let Some(project) = self.project.clone() else {
            return Ok(());
        };
        let session_id = self.session_id.clone();
        let sources = self.store()?.list_sources(&session_id)?.len() as u64;
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

        // Close the database before the files move under it, with nothing
        // left behind in the write-ahead log. A failed checkpoint still leaves
        // the log, which is copied along with the database.
        if let Some(store) = &self.store {
            let _ = store.checkpoint();
        }
        self.store = None;
        paths::promote(&self.dir, &target)?;
        self.dir = target;
        self.store = Some(CtxStore::open(&self.dir.join("ctx.db"))?);
        self.persisted = true;
        Ok(())
    }
}

/// Renames a session's project store after its title, holding the lock so no
/// process writes into it while it moves.
pub fn rename_store(
    session_id: &str,
    project: &Path,
    title: Option<&str>,
) -> Result<Option<PathBuf>, String> {
    let _lifecycle = paths::ProjectLock::acquire(project)?;
    let _lock = lock(session_id);
    paths::rename_project_store(project, session_id, title)
}

/// Held while a process opens or writes a session's store; released on drop.
/// Best effort: a filesystem without locks still gets context mode, just
/// without the guarantee.
fn lock(session_id: &str) -> Option<std::fs::File> {
    let path = paths::lock_file(session_id)?;
    std::fs::create_dir_all(path.parent()?).ok()?;
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(path)
        .ok()?;
    file.lock().ok()?;
    Some(file)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ctx::router::Policy;

    fn config(storage: Storage, promote_after: u64) -> CtxConfig {
        CtxConfig {
            enabled: true,
            clis: vec!["claude".to_string()],
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
    fn clearing_revokes_open_readers_even_after_the_store_is_recreated() {
        let project = tempfile::tempdir().unwrap();
        let id = format!("sess-clear-{}", uuid::Uuid::new_v4());
        let mut idle =
            CtxSession::open(&id, Some(project.path()), config(Storage::Project, 1)).unwrap();
        idle.offload("before", &body("forgotten")).unwrap();
        let mut reader =
            CtxSession::open(&id, Some(project.path()), config(Storage::Project, 1)).unwrap();
        crate::ctx::project_data::clear(project.path()).unwrap();
        let mut fresh =
            CtxSession::open(&id, Some(project.path()), config(Storage::Project, 1)).unwrap();
        fresh.offload("after", &body("retained")).unwrap();
        assert!(reader.search("forgotten", None, 10).unwrap().is_empty());
        assert!(reader.read("before", 0).unwrap().is_none());
        assert_eq!(
            idle.list()
                .unwrap()
                .iter()
                .map(|r| r.source.as_str())
                .collect::<Vec<_>>(),
            vec!["after"]
        );
        assert_eq!(idle.savings().unwrap(), fresh.savings().unwrap());
        idle.offload("later", &body("durable")).unwrap();
        drop(idle);
        drop(reader);
        drop(fresh);
        let mut reopened =
            CtxSession::open(&id, Some(project.path()), config(Storage::Project, 1)).unwrap();
        assert_eq!(reopened.list().unwrap().len(), 2);
        assert!(reopened.read("before", 0).unwrap().is_none());
    }

    #[test]
    fn clearing_an_open_store_allows_durable_subsequent_offloads() {
        let project = tempfile::tempdir().unwrap();
        let id = format!("sess-clear-write-{}", uuid::Uuid::new_v4());
        let mut open =
            CtxSession::open(&id, Some(project.path()), config(Storage::Promote, 1)).unwrap();
        open.offload("before", &body("forgotten")).unwrap();
        crate::ctx::project_data::clear(project.path()).unwrap();
        open.offload("after", &body("durable")).unwrap();
        drop(open);
        let mut reopened =
            CtxSession::open(&id, Some(project.path()), config(Storage::Promote, 1)).unwrap();
        let sources = reopened.list().unwrap();
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].source, "after");
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
    fn a_later_process_finds_a_session_that_was_already_promoted() {
        // Each hooked command is its own `polakapi ctx exec` process, so the
        // store has to be found again from disk, not from in-memory state.
        let project = tempfile::tempdir().unwrap();
        let id = format!("sess-reopen-{}", uuid::Uuid::new_v4());
        {
            let mut first =
                CtxSession::open(&id, Some(project.path()), config(Storage::Promote, 1)).unwrap();
            first.offload("exec:one", &body("a")).unwrap();
            assert!(first.dir().starts_with(project.path()), "promoted");
        }
        let mut second =
            CtxSession::open(&id, Some(project.path()), config(Storage::Promote, 1)).unwrap();
        assert!(second.dir().starts_with(project.path()));
        assert_eq!(second.list().unwrap().len(), 1);
    }

    #[test]
    fn a_session_opened_before_another_process_promoted_it_follows_the_move() {
        let project = tempfile::tempdir().unwrap();
        let id = format!("sess-follow-{}", uuid::Uuid::new_v4());
        let mut idle =
            CtxSession::open(&id, Some(project.path()), config(Storage::Promote, 2)).unwrap();
        idle.offload("exec:one", &body("a")).unwrap();
        {
            let mut busy =
                CtxSession::open(&id, Some(project.path()), config(Storage::Promote, 2)).unwrap();
            busy.offload("exec:two", &body("b")).unwrap();
            assert!(busy.dir().starts_with(project.path()), "promoted");
        }
        assert_eq!(idle.list().unwrap().len(), 2);
        idle.offload("exec:three", &body("c")).unwrap();
        assert!(idle.dir().starts_with(project.path()));
        assert_eq!(idle.list().unwrap().len(), 3);
    }

    #[test]
    fn an_open_session_follows_a_rename_made_by_another_process() {
        let project = tempfile::tempdir().unwrap();
        let id = format!("sess-rename-{}", uuid::Uuid::new_v4());
        let mut open =
            CtxSession::open(&id, Some(project.path()), config(Storage::Project, 1)).unwrap();
        open.offload("exec:one", &body("a")).unwrap();
        drop(open.store.take());

        let renamed = rename_store(&id, project.path(), Some("Ekim"))
            .unwrap()
            .unwrap();

        open.offload("exec:two", &body("b")).unwrap();
        assert_eq!(open.dir(), renamed);
        assert_eq!(open.list().unwrap().len(), 2);
        assert!(!project
            .path()
            .join(paths::STORE_DIR)
            .join("ctx")
            .join(&id)
            .exists());
    }

    #[test]
    fn parallel_writers_lose_nothing_across_a_promotion() {
        let project = tempfile::tempdir().unwrap();
        let id = format!("sess-parallel-{}", uuid::Uuid::new_v4());
        let writers: Vec<_> = (0..8)
            .map(|n| {
                let id = id.clone();
                let project = project.path().to_path_buf();
                std::thread::spawn(move || {
                    let mut session =
                        CtxSession::open(&id, Some(&project), config(Storage::Promote, 3)).unwrap();
                    session
                        .offload(&format!("exec:{n}"), &body(&n.to_string()))
                        .unwrap();
                })
            })
            .collect();
        for writer in writers {
            writer.join().unwrap();
        }
        let mut session =
            CtxSession::open(&id, Some(project.path()), config(Storage::Promote, 3)).unwrap();
        assert_eq!(session.list().unwrap().len(), 8);
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
