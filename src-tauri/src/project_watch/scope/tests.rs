use std::path::{Path, PathBuf};

use super::{git_roots, Scope};

fn worktree_scope() -> Scope {
    Scope::Git {
        state: Some(PathBuf::from("worktrees/feature")),
    }
}

#[test]
fn project_scope_keeps_sources_and_git_state() {
    let scope = Scope::Project;
    for relevant in [
        "src/main.rs",
        ".git/index",
        ".git/HEAD",
        ".git/refs/heads/main",
        ".git/refs/heads/feat/target",
        ".git/refs/heads/deps/node_modules",
    ] {
        assert!(scope.is_relevant(Path::new(relevant)), "{relevant}");
    }
    for ignored in [
        ".git/objects/ab/cdef",
        ".git/FETCH_HEAD",
        ".git/refs/remotes/origin/main",
        ".git/refs/heads",
        ".git/logs/HEAD",
        "node_modules/pkg/index.js",
        "target/debug/app",
        "vendor/lib/.git/HEAD",
    ] {
        assert!(!scope.is_relevant(Path::new(ignored)), "{ignored}");
    }
}

#[test]
fn project_scope_watches_only_the_git_directories_it_needs() {
    let scope = Scope::Project;
    for watched in [
        "",
        "src",
        ".git",
        ".git/refs",
        ".git/refs/heads",
        ".git/refs/heads/feat",
    ] {
        assert!(scope.should_watch_dir(Path::new(watched)), "{watched}");
    }
    for skipped in [
        ".git/objects",
        ".git/refs/remotes",
        "node_modules",
        "src/target",
    ] {
        assert!(!scope.should_watch_dir(Path::new(skipped)), "{skipped}");
    }
}

#[test]
fn git_scope_keeps_branch_refs_and_its_own_state() {
    let scope = worktree_scope();
    for relevant in [
        "refs/heads/main",
        "refs/heads/feat/x",
        "worktrees/feature/index",
        "worktrees/feature/HEAD",
    ] {
        assert!(scope.is_relevant(Path::new(relevant)), "{relevant}");
    }
    for ignored in [
        "index",
        "HEAD",
        "worktrees/other/index",
        "worktrees/feature/logs/HEAD",
        "refs/remotes/origin/main",
        "objects/ab/cdef",
    ] {
        assert!(!scope.is_relevant(Path::new(ignored)), "{ignored}");
    }
}

#[test]
fn git_scope_watches_refs_and_the_path_to_its_state() {
    let scope = worktree_scope();
    for watched in [
        "",
        "refs",
        "refs/heads",
        "refs/heads/feat",
        "worktrees",
        "worktrees/feature",
    ] {
        assert!(scope.should_watch_dir(Path::new(watched)), "{watched}");
    }
    for skipped in [
        "objects",
        "refs/tags",
        "worktrees/other",
        "worktrees/feature/logs",
    ] {
        assert!(!scope.should_watch_dir(Path::new(skipped)), "{skipped}");
    }
}

#[test]
fn a_regular_repository_needs_no_extra_roots() {
    let root = Path::new("/work/app");
    assert!(git_roots(root, root.join(".git"), root.join(".git")).is_empty());
}

#[test]
fn a_linked_worktree_watches_the_common_directory() {
    let roots = git_roots(
        Path::new("/work/app-feature"),
        PathBuf::from("/work/app/.git/worktrees/feature"),
        PathBuf::from("/work/app/.git"),
    );
    assert_eq!(
        roots,
        vec![(PathBuf::from("/work/app/.git"), worktree_scope())]
    );
}

#[test]
fn a_separate_git_dir_is_watched_with_its_state_at_the_top() {
    let roots = git_roots(
        Path::new("/work/app"),
        PathBuf::from("/git/app.git"),
        PathBuf::from("/git/app.git"),
    );
    assert_eq!(
        roots,
        vec![(
            PathBuf::from("/git/app.git"),
            Scope::Git {
                state: Some(PathBuf::new())
            }
        )]
    );
}
