use std::fs;
use std::path::Path;
use std::sync::mpsc::{channel, Receiver};
use std::time::{Duration, Instant};

use tempfile::TempDir;

use super::ProjectWatcher;

const SETTLE: Duration = Duration::from_millis(1500);

fn watch(root: &Path) -> (ProjectWatcher, Receiver<()>) {
    let (sender, receiver) = channel();
    let watcher = ProjectWatcher::start(root, move || {
        let _ = sender.send(());
    })
    .expect("start watcher");
    (watcher, receiver)
}

fn signals_within(receiver: &Receiver<()>, window: Duration) -> usize {
    let deadline = Instant::now() + window;
    let mut count = 0;
    while let Some(left) = deadline.checked_duration_since(Instant::now()) {
        match receiver.recv_timeout(left) {
            Ok(()) => count += 1,
            Err(_) => break,
        }
    }
    count
}

fn project() -> TempDir {
    let dir = tempfile::tempdir().expect("tempdir");
    fs::create_dir_all(dir.path().join("src")).unwrap();
    fs::write(dir.path().join("src/main.rs"), "fn main() {}\n").unwrap();
    for ignored in [".git/objects/ab", "node_modules/pkg", "target/debug"] {
        fs::create_dir_all(dir.path().join(ignored)).unwrap();
    }
    fs::write(dir.path().join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
    dir
}

#[test]
fn a_burst_of_writes_emits_one_signal() {
    let dir = project();
    let (_watcher, receiver) = watch(dir.path());
    for round in 0..20 {
        fs::write(dir.path().join("src/main.rs"), format!("// {round}\n")).unwrap();
    }
    assert_eq!(signals_within(&receiver, SETTLE), 1);
}

#[test]
fn creating_renaming_and_deleting_each_emit_one_signal() {
    let dir = project();
    let (_watcher, receiver) = watch(dir.path());

    fs::write(dir.path().join("src/new.rs"), "new\n").unwrap();
    assert_eq!(signals_within(&receiver, SETTLE), 1);

    fs::rename(
        dir.path().join("src/new.rs"),
        dir.path().join("src/renamed.rs"),
    )
    .unwrap();
    assert_eq!(signals_within(&receiver, SETTLE), 1);

    fs::remove_file(dir.path().join("src/renamed.rs")).unwrap();
    assert_eq!(signals_within(&receiver, SETTLE), 1);
}

#[test]
fn writes_under_ignored_directories_emit_nothing() {
    let dir = project();
    let (_watcher, receiver) = watch(dir.path());
    fs::write(dir.path().join(".git/objects/ab/cdef"), "blob").unwrap();
    fs::write(dir.path().join(".git/FETCH_HEAD"), "x").unwrap();
    fs::write(dir.path().join("node_modules/pkg/index.js"), "x").unwrap();
    fs::write(dir.path().join("target/debug/app"), "x").unwrap();
    fs::create_dir_all(dir.path().join("target/release")).unwrap();
    assert_eq!(signals_within(&receiver, SETTLE), 0);
}

#[test]
fn a_new_nested_node_modules_is_ignored() {
    let dir = project();
    let (_watcher, receiver) = watch(dir.path());
    fs::create_dir_all(dir.path().join("src/node_modules/nested")).unwrap();
    fs::write(dir.path().join("src/node_modules/nested/a.js"), "x").unwrap();
    assert_eq!(signals_within(&receiver, SETTLE), 0);
}

#[test]
fn git_index_and_head_changes_emit() {
    let dir = project();
    let (_watcher, receiver) = watch(dir.path());

    fs::write(dir.path().join(".git/index.lock"), "index").unwrap();
    fs::rename(
        dir.path().join(".git/index.lock"),
        dir.path().join(".git/index"),
    )
    .unwrap();
    assert_eq!(signals_within(&receiver, SETTLE), 1);

    fs::write(dir.path().join(".git/HEAD"), "ref: refs/heads/other\n").unwrap();
    assert_eq!(signals_within(&receiver, SETTLE), 1);
}

#[test]
fn a_new_subdirectory_is_watched() {
    let dir = project();
    let (_watcher, receiver) = watch(dir.path());
    fs::create_dir_all(dir.path().join("src/feature/deep")).unwrap();
    assert_eq!(signals_within(&receiver, SETTLE), 1);

    fs::write(dir.path().join("src/feature/deep/mod.rs"), "x").unwrap();
    assert_eq!(signals_within(&receiver, SETTLE), 1);
}

#[test]
fn stopping_ends_the_thread_and_signals_no_more() {
    let dir = project();
    let (watcher, receiver) = watch(dir.path());
    let started = Instant::now();
    drop(watcher);
    assert!(started.elapsed() < Duration::from_secs(2));
    fs::write(dir.path().join("src/main.rs"), "changed\n").unwrap();
    assert_eq!(signals_within(&receiver, SETTLE), 0);
}

#[test]
fn starting_on_a_missing_directory_fails() {
    let dir = project();
    let missing = dir.path().join("missing");
    assert!(ProjectWatcher::start(&missing, || {}).is_err());
}
