use std::path::{Path, PathBuf};
use std::process::Command;

use super::test_repo::TestRepo;

pub(super) struct RemoteFixture {
    _root: tempfile::TempDir,
    peer: PathBuf,
    pub(super) repo: TestRepo,
}

impl RemoteFixture {
    pub(super) fn new() -> Self {
        let repo = TestRepo::with_commit(&[("a.txt", "one\n")]);
        let root = tempfile::tempdir().unwrap();
        let bare = root.path().join("origin.git");
        let peer = root.path().join("peer");
        run(
            root.path(),
            &["init", "-q", "--bare", "-b", "main", as_str(&bare)],
        );
        repo.git(&["remote", "add", "origin", as_str(&bare)]);
        repo.git(&["push", "-q", "-u", "origin", "main"]);
        run(root.path(), &["clone", "-q", as_str(&bare), as_str(&peer)]);
        run(&peer, &["config", "user.email", "peer@example.com"]);
        run(&peer, &["config", "user.name", "Peer"]);
        run(&peer, &["config", "commit.gpgsign", "false"]);
        Self {
            _root: root,
            peer,
            repo,
        }
    }

    pub(super) fn peer_commit(&self, name: &str, content: &str) {
        std::fs::write(self.peer.join(name), content).unwrap();
        run(&self.peer, &["add", "-A"]);
        run(&self.peer, &["commit", "-q", "-m", name]);
    }

    pub(super) fn peer_git(&self, args: &[&str]) {
        run(&self.peer, args);
    }
}

fn as_str(value: &Path) -> &str {
    value.to_str().unwrap()
}

fn run(dir: &Path, args: &[&str]) {
    let output = Command::new("git")
        .args(args)
        .current_dir(dir)
        .output()
        .expect("git should be installed");
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}
