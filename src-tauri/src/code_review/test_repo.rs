use std::path::{Path, PathBuf};
use std::process::Command;

pub(super) struct TestRepo {
    _root: tempfile::TempDir,
    path: PathBuf,
}

impl TestRepo {
    pub(super) fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("repo");
        std::fs::create_dir_all(&path).unwrap();
        let repo = Self { _root: root, path };
        repo.git(&["init", "-q", "-b", "main"]);
        repo.git(&["config", "user.email", "test@example.com"]);
        repo.git(&["config", "user.name", "Test"]);
        repo.git(&["config", "commit.gpgsign", "false"]);
        repo
    }

    pub(super) fn with_commit(files: &[(&str, &str)]) -> Self {
        let repo = Self::new();
        for (name, content) in files {
            repo.write(name, content);
        }
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-q", "-m", "init"]);
        repo
    }

    pub(super) fn path(&self) -> &Path {
        &self.path
    }

    pub(super) fn path_str(&self) -> String {
        self.path.to_string_lossy().to_string()
    }

    pub(super) fn write(&self, name: &str, content: &str) {
        self.write_bytes(name, content.as_bytes());
    }

    pub(super) fn write_bytes(&self, name: &str, content: &[u8]) {
        let target = self.path.join(name);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(target, content).unwrap();
    }

    pub(super) fn git(&self, args: &[&str]) {
        let output = self.git_output(args);
        assert!(
            output.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    pub(super) fn git_output(&self, args: &[&str]) -> std::process::Output {
        Command::new("git")
            .args(args)
            .current_dir(&self.path)
            .output()
            .expect("git should be installed")
    }
}
