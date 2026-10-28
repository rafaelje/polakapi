use super::*;
use crate::code_review::test_repo::TestRepo;

fn paths(items: &[&str]) -> Vec<String> {
    items.iter().map(|item| item.to_string()).collect()
}

fn status(repo: &TestRepo) -> String {
    let output = repo.git_output(&["status", "--porcelain", "--untracked-files=all"]);
    assert!(output.status.success());
    String::from_utf8_lossy(&output.stdout).to_string()
}

fn read(repo: &TestRepo, name: &str) -> String {
    std::fs::read_to_string(repo.path().join(name)).unwrap()
}

#[test]
fn discard_restores_a_modified_file() {
    let repo = TestRepo::with_commit(&[("a.txt", "one\n"), ("b.txt", "one\n")]);
    repo.write("a.txt", "two\n");
    repo.write("b.txt", "two\n");

    discard_sync(&repo.path_str(), &paths(&["a.txt"]), DiscardGroup::Unstaged).unwrap();

    assert_eq!(read(&repo, "a.txt"), "one\n");
    assert_eq!(status(&repo), " M b.txt\n");
}

#[test]
fn discard_restores_a_staged_file_and_its_working_tree() {
    let repo = TestRepo::with_commit(&[("a.txt", "one\n")]);
    repo.write("a.txt", "two\n");
    repo.git(&["add", "a.txt"]);
    repo.write("a.txt", "three\n");

    discard_sync(&repo.path_str(), &paths(&["a.txt"]), DiscardGroup::Staged).unwrap();

    assert_eq!(read(&repo, "a.txt"), "one\n");
    assert_eq!(status(&repo), "");
}

#[test]
fn discard_unstaged_keeps_the_staged_version_of_a_partly_staged_file() {
    let repo = TestRepo::with_commit(&[("a.txt", "one\n")]);
    repo.write("a.txt", "two\n");
    repo.git(&["add", "a.txt"]);
    repo.write("a.txt", "three\n");

    discard_sync(&repo.path_str(), &paths(&["a.txt"]), DiscardGroup::Unstaged).unwrap();

    assert_eq!(read(&repo, "a.txt"), "two\n");
    assert_eq!(status(&repo), "M  a.txt\n");
}

#[test]
fn discard_unstaged_brings_back_a_file_deleted_from_the_working_tree_only() {
    let repo = TestRepo::with_commit(&[("a.txt", "one\n")]);
    repo.write("a.txt", "two\n");
    repo.git(&["add", "a.txt"]);
    std::fs::remove_file(repo.path().join("a.txt")).unwrap();

    discard_sync(&repo.path_str(), &paths(&["a.txt"]), DiscardGroup::Unstaged).unwrap();

    assert_eq!(read(&repo, "a.txt"), "two\n");
    assert_eq!(status(&repo), "M  a.txt\n");
}

#[test]
fn discard_unstaged_keeps_a_staged_new_file() {
    let repo = TestRepo::with_commit(&[("a.txt", "one\n")]);
    repo.write("new.txt", "new\n");
    repo.git(&["add", "new.txt"]);
    repo.write("new.txt", "newer\n");

    discard_sync(
        &repo.path_str(),
        &paths(&["new.txt"]),
        DiscardGroup::Unstaged,
    )
    .unwrap();

    assert_eq!(read(&repo, "new.txt"), "new\n");
    assert_eq!(status(&repo), "A  new.txt\n");
}

#[test]
fn plan_restores_only_the_working_tree_for_unstaged_rows() {
    let repo = TestRepo::with_commit(&[("a.txt", "one\n")]);
    repo.write("a.txt", "two\n");
    repo.git(&["add", "a.txt"]);
    repo.write("a.txt", "three\n");

    let unstaged = plan_discard(repo.path(), &paths(&["a.txt"]), DiscardGroup::Unstaged).unwrap();
    let staged = plan_discard(repo.path(), &paths(&["a.txt"]), DiscardGroup::Staged).unwrap();

    assert_eq!(
        unstaged,
        DiscardPlan {
            restore_worktree: paths(&["a.txt"]),
            ..DiscardPlan::default()
        }
    );
    assert_eq!(
        staged,
        DiscardPlan {
            restore: paths(&["a.txt"]),
            ..DiscardPlan::default()
        }
    );
}

#[test]
fn plan_deletes_untracked_rows() {
    let repo = TestRepo::with_commit(&[("a.txt", "one\n")]);
    repo.write("new.txt", "new\n");

    let plan = plan_discard(repo.path(), &paths(&["new.txt"]), DiscardGroup::Untracked).unwrap();

    assert!(plan.restore_worktree.is_empty());
    assert!(plan.restore.is_empty());
    assert!(plan.unindex.is_empty());
    assert_eq!(plan.delete.len(), 1);
    assert!(plan.delete[0].ends_with("new.txt"));
}

#[test]
fn discard_brings_back_deleted_files() {
    let repo = TestRepo::with_commit(&[("a.txt", "one\n"), ("b.txt", "bee\n")]);
    std::fs::remove_file(repo.path().join("a.txt")).unwrap();
    repo.git(&["rm", "-q", "b.txt"]);

    discard_sync(&repo.path_str(), &paths(&["a.txt"]), DiscardGroup::Unstaged).unwrap();
    discard_sync(&repo.path_str(), &paths(&["b.txt"]), DiscardGroup::Staged).unwrap();

    assert_eq!(read(&repo, "a.txt"), "one\n");
    assert_eq!(read(&repo, "b.txt"), "bee\n");
    assert_eq!(status(&repo), "");
}

#[test]
fn discard_deletes_an_untracked_file() {
    let repo = TestRepo::with_commit(&[("a.txt", "one\n")]);
    repo.write("dir/new file.txt", "new\n");
    repo.write("dir/keep.txt", "keep\n");

    discard_sync(
        &repo.path_str(),
        &paths(&["dir/new file.txt"]),
        DiscardGroup::Untracked,
    )
    .unwrap();

    assert!(!repo.path().join("dir/new file.txt").exists());
    assert_eq!(status(&repo), "?? dir/keep.txt\n");
}

#[test]
fn discard_removes_a_staged_new_file_from_index_and_disk() {
    let repo = TestRepo::with_commit(&[("a.txt", "one\n")]);
    repo.write("new.txt", "new\n");
    repo.git(&["add", "new.txt"]);
    repo.write("new.txt", "newer\n");

    discard_sync(&repo.path_str(), &paths(&["new.txt"]), DiscardGroup::Staged).unwrap();

    assert!(!repo.path().join("new.txt").exists());
    assert_eq!(status(&repo), "");
}

#[test]
fn discard_a_rename_restores_both_sides() {
    let repo = TestRepo::with_commit(&[("old.txt", "same\n")]);
    repo.git(&["mv", "old.txt", "new.txt"]);

    discard_sync(
        &repo.path_str(),
        &paths(&["new.txt", "old.txt"]),
        DiscardGroup::Staged,
    )
    .unwrap();

    assert_eq!(read(&repo, "old.txt"), "same\n");
    assert!(!repo.path().join("new.txt").exists());
    assert_eq!(status(&repo), "");
}

#[test]
fn discard_works_in_a_repo_without_commits() {
    let repo = TestRepo::new();
    repo.write("staged.txt", "one\n");
    repo.git(&["add", "staged.txt"]);
    repo.write("untracked.txt", "two\n");
    repo.write("keep.txt", "keep\n");

    discard_sync(
        &repo.path_str(),
        &paths(&["staged.txt"]),
        DiscardGroup::Staged,
    )
    .unwrap();
    discard_sync(
        &repo.path_str(),
        &paths(&["untracked.txt"]),
        DiscardGroup::Untracked,
    )
    .unwrap();

    assert!(!repo.path().join("staged.txt").exists());
    assert!(!repo.path().join("untracked.txt").exists());
    assert_eq!(status(&repo), "?? keep.txt\n");
}

#[test]
fn discard_refuses_directories() {
    let repo = TestRepo::with_commit(&[("src/a.txt", "one\n")]);
    repo.write("src/a.txt", "two\n");
    repo.write("new/b.txt", "new\n");

    assert!(discard_sync(&repo.path_str(), &paths(&["src"]), DiscardGroup::Unstaged).is_err());
    assert!(discard_sync(&repo.path_str(), &paths(&["new"]), DiscardGroup::Untracked).is_err());

    assert_eq!(read(&repo, "src/a.txt"), "two\n");
    assert_eq!(read(&repo, "new/b.txt"), "new\n");
}

#[test]
fn discard_rejects_unsafe_or_missing_paths() {
    let repo = TestRepo::with_commit(&[("a.txt", "one\n")]);
    repo.write("a.txt", "two\n");
    let project = repo.path_str();
    for bad in [
        "../outside.txt",
        "/etc/passwd",
        "--force",
        "",
        "a/../../x",
        ".git/HEAD",
    ] {
        for group in [
            DiscardGroup::Staged,
            DiscardGroup::Unstaged,
            DiscardGroup::Untracked,
        ] {
            assert!(
                discard_sync(&project, &paths(&[bad]), group).is_err(),
                "{bad}"
            );
        }
    }
    assert!(discard_sync(&project, &[], DiscardGroup::Unstaged).is_err());
    assert!(discard_sync(&project, &paths(&["a.txt", "../x"]), DiscardGroup::Unstaged).is_err());
    assert_eq!(read(&repo, "a.txt"), "two\n");
}

#[cfg(unix)]
#[test]
fn discard_refuses_paths_escaping_through_a_symlink() {
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("secret.txt"), "keep\n").unwrap();
    let repo = TestRepo::with_commit(&[("a.txt", "one\n")]);
    std::os::unix::fs::symlink(outside.path(), repo.path().join("link")).unwrap();

    assert!(discard_sync(
        &repo.path_str(),
        &paths(&["link/secret.txt"]),
        DiscardGroup::Untracked
    )
    .is_err());

    assert!(outside.path().join("secret.txt").exists());
}

#[cfg(unix)]
#[test]
fn discard_deletes_an_untracked_symlink_but_not_its_target() {
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("secret.txt"), "keep\n").unwrap();
    let repo = TestRepo::with_commit(&[("a.txt", "one\n")]);
    std::os::unix::fs::symlink(outside.path(), repo.path().join("link")).unwrap();

    discard_sync(&repo.path_str(), &paths(&["link"]), DiscardGroup::Untracked).unwrap();

    assert!(repo.path().join("link").symlink_metadata().is_err());
    assert!(outside.path().join("secret.txt").exists());
}

#[test]
fn discard_reports_an_error_outside_a_repository() {
    let dir = tempfile::tempdir().unwrap();
    let project = dir.path().to_string_lossy().to_string();
    assert!(discard_sync(&project, &paths(&["a.txt"]), DiscardGroup::Unstaged).is_err());
}
