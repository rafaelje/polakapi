use std::fs;

use super::*;
use crate::code_review::test_repo::TestRepo;

fn prepare(repo: &TestRepo, clear: bool) -> Result<ReviewFolder, String> {
    prepare_sync(&repo.path_str(), clear)
}

fn read(repo: &TestRepo, name: &str) -> String {
    fs::read_to_string(repo.path().join(name)).unwrap()
}

#[test]
fn maps_slashes_in_the_branch_name_to_tildes() {
    assert_eq!(branch_folder_name("feat/login/form"), "feat~login~form");
    assert_eq!(branch_folder_name("feat/login-form"), "feat~login-form");
    assert_eq!(branch_folder_name("main"), "main");
}

#[test]
fn distinct_branches_get_distinct_folders() {
    let branches = ["feat/x", "feat-x", "a-/b", "a/-b", "a--b", "a/b/c", "a/b-c"];
    let folders: std::collections::HashSet<String> = branches
        .iter()
        .map(|branch| branch_folder_name(branch))
        .collect();
    assert_eq!(folders.len(), branches.len());
}

#[test]
fn clearing_one_branch_keeps_the_folder_of_a_similar_one() {
    let repo = TestRepo::with_commit(&[("a.txt", "one\n")]);
    repo.git(&["switch", "-q", "-c", "feat-x"]);
    let dashed = prepare(&repo, true).unwrap();
    repo.write(&format!("{}/1.1-a.md", dashed.folder), "keep");
    repo.git(&["switch", "-q", "-c", "feat/x"]);

    let slashed = prepare(&repo, true).unwrap();

    assert_ne!(slashed.folder, dashed.folder);
    assert_eq!(read(&repo, &format!("{}/1.1-a.md", dashed.folder)), "keep");
}

#[test]
fn creates_the_branch_folder_and_an_ignore_all_gitignore() {
    let repo = TestRepo::with_commit(&[("a.txt", "one\n")]);
    repo.git(&["switch", "-q", "-c", "feat/login"]);

    let folder = prepare(&repo, true).unwrap();

    assert_eq!(folder.branch, "feat/login");
    assert_eq!(folder.folder, "docs/code-review/feat~login");
    assert!(repo.path().join("docs/code-review/feat~login").is_dir());
    assert_eq!(read(&repo, "docs/code-review/.gitignore"), "*\n");
    repo.write("docs/code-review/feat~login/1.1-a.md", "x");
    let status = repo.git_output(&["status", "--porcelain", "--untracked-files=all"]);
    assert_eq!(String::from_utf8_lossy(&status.stdout), "");
}

#[test]
fn appends_the_ignore_rule_to_an_existing_gitignore() {
    let repo = TestRepo::with_commit(&[("a.txt", "one\n")]);
    repo.write("docs/code-review/.gitignore", "notes.txt");

    prepare(&repo, true).unwrap();

    assert_eq!(read(&repo, "docs/code-review/.gitignore"), "notes.txt\n*\n");
}

#[test]
fn keeps_a_gitignore_that_already_ignores_everything() {
    let repo = TestRepo::with_commit(&[("a.txt", "one\n")]);
    repo.write("docs/code-review/.gitignore", "# reviews\n*\n");

    prepare(&repo, true).unwrap();

    assert_eq!(read(&repo, "docs/code-review/.gitignore"), "# reviews\n*\n");
}

#[test]
fn clearing_removes_the_previous_run_of_the_branch_only() {
    let repo = TestRepo::with_commit(&[("a.txt", "one\n")]);
    repo.write("docs/code-review/main/1.1-old.md", "old");
    repo.write("docs/code-review/other/1.1-keep.md", "keep");

    prepare(&repo, true).unwrap();

    assert!(repo.path().join("docs/code-review/main").is_dir());
    assert!(!repo
        .path()
        .join("docs/code-review/main/1.1-old.md")
        .exists());
    assert!(repo
        .path()
        .join("docs/code-review/other/1.1-keep.md")
        .exists());
}

#[test]
fn keeping_leaves_the_previous_run_in_place() {
    let repo = TestRepo::with_commit(&[("a.txt", "one\n")]);
    repo.write("docs/code-review/main/1.1-old.md", "old");

    prepare(&repo, false).unwrap();

    assert!(repo
        .path()
        .join("docs/code-review/main/1.1-old.md")
        .exists());
}

#[test]
fn refuses_a_detached_head() {
    let repo = TestRepo::with_commit(&[("a.txt", "one\n")]);
    repo.git(&["switch", "-q", "--detach", "HEAD"]);

    let error = prepare(&repo, true).unwrap_err();

    assert!(error.contains("detached"), "{error}");
    assert!(!repo.path().join("docs/code-review").exists());
}
