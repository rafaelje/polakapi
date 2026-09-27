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

    discard_sync(&repo.path_str(), &paths(&["a.txt"])).unwrap();

    assert_eq!(read(&repo, "a.txt"), "one\n");
    assert_eq!(status(&repo), " M b.txt\n");
}

#[test]
fn discard_restores_a_staged_file_and_its_working_tree() {
    let repo = TestRepo::with_commit(&[("a.txt", "one\n")]);
    repo.write("a.txt", "two\n");
    repo.git(&["add", "a.txt"]);
    repo.write("a.txt", "three\n");

    discard_sync(&repo.path_str(), &paths(&["a.txt"])).unwrap();

    assert_eq!(read(&repo, "a.txt"), "one\n");
    assert_eq!(status(&repo), "");
}

#[test]
fn discard_brings_back_deleted_files() {
    let repo = TestRepo::with_commit(&[("a.txt", "one\n"), ("b.txt", "bee\n")]);
    std::fs::remove_file(repo.path().join("a.txt")).unwrap();
    repo.git(&["rm", "-q", "b.txt"]);

    discard_sync(&repo.path_str(), &paths(&["a.txt", "b.txt"])).unwrap();

    assert_eq!(read(&repo, "a.txt"), "one\n");
    assert_eq!(read(&repo, "b.txt"), "bee\n");
    assert_eq!(status(&repo), "");
}

#[test]
fn discard_deletes_an_untracked_file() {
    let repo = TestRepo::with_commit(&[("a.txt", "one\n")]);
    repo.write("dir/new file.txt", "new\n");
    repo.write("dir/keep.txt", "keep\n");

    discard_sync(&repo.path_str(), &paths(&["dir/new file.txt"])).unwrap();

    assert!(!repo.path().join("dir/new file.txt").exists());
    assert_eq!(status(&repo), "?? dir/keep.txt\n");
}

#[test]
fn discard_removes_a_staged_new_file_from_index_and_disk() {
    let repo = TestRepo::with_commit(&[("a.txt", "one\n")]);
    repo.write("new.txt", "new\n");
    repo.git(&["add", "new.txt"]);
    repo.write("new.txt", "newer\n");

    discard_sync(&repo.path_str(), &paths(&["new.txt"])).unwrap();

    assert!(!repo.path().join("new.txt").exists());
    assert_eq!(status(&repo), "");
}

#[test]
fn discard_a_rename_restores_both_sides() {
    let repo = TestRepo::with_commit(&[("old.txt", "same\n")]);
    repo.git(&["mv", "old.txt", "new.txt"]);

    discard_sync(&repo.path_str(), &paths(&["new.txt", "old.txt"])).unwrap();

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

    discard_sync(&repo.path_str(), &paths(&["staged.txt", "untracked.txt"])).unwrap();

    assert!(!repo.path().join("staged.txt").exists());
    assert!(!repo.path().join("untracked.txt").exists());
    assert_eq!(status(&repo), "?? keep.txt\n");
}

#[test]
fn discard_refuses_directories() {
    let repo = TestRepo::with_commit(&[("src/a.txt", "one\n")]);
    repo.write("src/a.txt", "two\n");
    repo.write("new/b.txt", "new\n");

    assert!(discard_sync(&repo.path_str(), &paths(&["src"])).is_err());
    assert!(discard_sync(&repo.path_str(), &paths(&["new"])).is_err());

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
        assert!(discard_sync(&project, &paths(&[bad])).is_err(), "{bad}");
    }
    assert!(discard_sync(&project, &[]).is_err());
    assert!(discard_sync(&project, &paths(&["a.txt", "../x"])).is_err());
    assert_eq!(read(&repo, "a.txt"), "two\n");
}

#[cfg(unix)]
#[test]
fn discard_refuses_paths_escaping_through_a_symlink() {
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("secret.txt"), "keep\n").unwrap();
    let repo = TestRepo::with_commit(&[("a.txt", "one\n")]);
    std::os::unix::fs::symlink(outside.path(), repo.path().join("link")).unwrap();

    assert!(discard_sync(&repo.path_str(), &paths(&["link/secret.txt"])).is_err());

    assert!(outside.path().join("secret.txt").exists());
}

#[cfg(unix)]
#[test]
fn discard_deletes_an_untracked_symlink_but_not_its_target() {
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("secret.txt"), "keep\n").unwrap();
    let repo = TestRepo::with_commit(&[("a.txt", "one\n")]);
    std::os::unix::fs::symlink(outside.path(), repo.path().join("link")).unwrap();

    discard_sync(&repo.path_str(), &paths(&["link"])).unwrap();

    assert!(repo.path().join("link").symlink_metadata().is_err());
    assert!(outside.path().join("secret.txt").exists());
}

#[test]
fn discard_reports_an_error_outside_a_repository() {
    let dir = tempfile::tempdir().unwrap();
    let project = dir.path().to_string_lossy().to_string();
    assert!(discard_sync(&project, &paths(&["a.txt"])).is_err());
}
