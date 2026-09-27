use super::PtyStore;

impl PtyStore {
    pub fn set_owner(&self, id: &str, window_label: &str) {
        let sessions = self.sessions.lock();
        if sessions.contains_key(id) {
            self.owners
                .lock()
                .insert(id.to_string(), window_label.to_string());
        }
    }

    pub fn kill_owned_by(&self, window_label: &str) {
        let owned: Vec<String> = self
            .owners
            .lock()
            .iter()
            .filter(|(_, owner)| owner.as_str() == window_label)
            .map(|(id, _)| id.clone())
            .collect();
        for id in owned {
            self.kill_session(&id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::*;

    #[cfg(unix)]
    fn sleeping_session() -> Arc<PtySession> {
        let pair = NativePtySystem::default()
            .openpty(PtySize::default())
            .expect("openpty");
        let mut cmd = CommandBuilder::new("sleep");
        cmd.arg("30");
        let child = pair.slave.spawn_command(cmd).expect("spawn sleep");
        Arc::new(PtySession {
            writer: Mutex::new(pair.master.take_writer().expect("writer")),
            master: Mutex::new(pair.master),
            child: Mutex::new(child),
        })
    }

    #[cfg(unix)]
    #[test]
    fn kill_owned_by_only_kills_the_window_sessions() {
        let store = PtyStore::default();
        store.insert_session("review".into(), sleeping_session());
        store.insert_session("main".into(), sleeping_session());
        store.set_owner("review", "code-review-abc");
        store.set_owner("main", "main");
        store.set_owner("gone", "code-review-abc");

        store.kill_owned_by("code-review-abc");

        assert!(store.session("review").is_none());
        assert!(store.session("main").is_some());
        assert!(!store.owners.lock().contains_key("gone"));
        store.kill_all();
    }
}
