use super::*;
use std::process::Command;

#[test]
fn valid_branch_names_accepted() {
    assert!(is_valid_new_branch_name("feature/foo"));
    assert!(is_valid_new_branch_name("fix-1"));
    assert!(is_valid_new_branch_name("v2.0"));
    assert!(is_valid_new_branch_name("a"));
}

#[test]
fn invalid_branch_names_rejected() {
    assert!(!is_valid_new_branch_name(""));
    assert!(!is_valid_new_branch_name("-x"));
    assert!(!is_valid_new_branch_name("/x"));
    assert!(!is_valid_new_branch_name("x/"));
    assert!(!is_valid_new_branch_name("a..b"));
    assert!(!is_valid_new_branch_name("a:b"));
    assert!(!is_valid_new_branch_name("with space"));
    assert!(!is_valid_new_branch_name("a//b"));
    assert!(!is_valid_new_branch_name("x.lock"));
    assert!(!is_valid_new_branch_name("x."));
    assert!(!is_valid_new_branch_name(&"x".repeat(300)));
}

#[test]
fn sibling_path_flattens_slashes() {
    let project = std::path::Path::new("/code/app");
    let path = sibling_worktree_path(project, "feature/foo").unwrap();
    assert_eq!(
        path,
        std::path::PathBuf::from("/code/app-worktrees/feature-foo")
    );
}

fn run_git(dir: &std::path::Path, args: &[&str]) {
    let status = Command::new("git")
        .args(args)
        .current_dir(dir)
        .status()
        .expect("git should be installed");
    assert!(status.success(), "git {args:?} failed in {dir:?}");
}

fn init_repo(root: &std::path::Path) -> std::path::PathBuf {
    let repo = root.join("app");
    std::fs::create_dir_all(&repo).unwrap();
    run_git(&repo, &["init", "-b", "main"]);
    run_git(&repo, &["config", "user.email", "test@example.com"]);
    run_git(&repo, &["config", "user.name", "Test"]);
    run_git(&repo, &["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.join("README.md"), "hello").unwrap();
    run_git(&repo, &["add", "README.md"]);
    run_git(&repo, &["commit", "-m", "init"]);
    run_git(&repo, &["checkout", "-b", "current-work"]);
    repo
}

#[test]
fn creates_worktree_as_sibling_directory() {
    let root = tempfile::tempdir().unwrap();
    let repo = init_repo(root.path());

    let worktree_path = create_worktree_sync(&repo.to_string_lossy(), "feature/x").unwrap();

    let expected = root.path().join("app-worktrees").join("feature-x");
    assert_eq!(
        std::path::Path::new(&worktree_path).canonicalize().unwrap(),
        expected.canonicalize().unwrap()
    );
    assert!(expected.join("README.md").exists());
}

#[test]
fn rejects_duplicate_worktree_path() {
    let root = tempfile::tempdir().unwrap();
    let repo = init_repo(root.path());

    create_worktree_sync(&repo.to_string_lossy(), "feature/x").unwrap();
    let err = create_worktree_sync(&repo.to_string_lossy(), "feature/x").unwrap_err();
    assert!(err.contains("already exists"), "unexpected error: {err}");
}
