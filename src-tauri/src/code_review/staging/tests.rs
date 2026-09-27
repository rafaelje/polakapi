use super::*;
use crate::code_review::test_repo::TestRepo;

fn staged_names(repo: &TestRepo) -> Vec<String> {
    names(repo, &["diff", "--cached", "--name-only"])
}

fn unstaged_names(repo: &TestRepo) -> Vec<String> {
    names(repo, &["diff", "--name-only"])
}

fn untracked_names(repo: &TestRepo) -> Vec<String> {
    names(repo, &["ls-files", "--others", "--exclude-standard"])
}

fn names(repo: &TestRepo, args: &[&str]) -> Vec<String> {
    let output = repo.git_output(args);
    assert!(output.status.success());
    let mut names: Vec<String> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::to_string)
        .collect();
    names.sort();
    names
}

fn paths(items: &[&str]) -> Vec<String> {
    items.iter().map(|item| item.to_string()).collect()
}

#[test]
fn stage_adds_modified_untracked_and_deleted_files() {
    let repo = TestRepo::with_commit(&[("a.txt", "one\n"), ("gone.txt", "bye\n")]);
    repo.write("a.txt", "two\n");
    repo.write("dir/new file.txt", "new\n");
    std::fs::remove_file(repo.path().join("gone.txt")).unwrap();

    stage_sync(
        &repo.path_str(),
        &paths(&["a.txt", "dir/new file.txt", "gone.txt"]),
    )
    .unwrap();

    assert_eq!(
        staged_names(&repo),
        ["a.txt", "dir/new file.txt", "gone.txt"]
    );
    assert!(unstaged_names(&repo).is_empty());
    assert!(untracked_names(&repo).is_empty());
}

#[test]
fn stage_only_touches_the_given_paths() {
    let repo = TestRepo::with_commit(&[("a.txt", "one\n"), ("b.txt", "one\n")]);
    repo.write("a.txt", "two\n");
    repo.write("b.txt", "two\n");

    stage_sync(&repo.path_str(), &paths(&["a.txt"])).unwrap();

    assert_eq!(staged_names(&repo), ["a.txt"]);
    assert_eq!(unstaged_names(&repo), ["b.txt"]);
}

#[test]
fn stage_treats_paths_literally() {
    let repo = TestRepo::with_commit(&[("a.txt", "one\n"), ("b.txt", "one\n")]);
    repo.write("a.txt", "two\n");
    repo.write("b.txt", "two\n");

    assert!(stage_sync(&repo.path_str(), &paths(&["*.txt"])).is_err());
    assert!(staged_names(&repo).is_empty());
}

#[test]
fn unstage_moves_a_staged_file_back_to_the_working_tree() {
    let repo = TestRepo::with_commit(&[("a.txt", "one\n"), ("b.txt", "one\n")]);
    repo.write("a.txt", "two\n");
    repo.write("b.txt", "two\n");
    repo.git(&["add", "-A"]);

    unstage_sync(&repo.path_str(), &paths(&["a.txt"])).unwrap();

    assert_eq!(staged_names(&repo), ["b.txt"]);
    assert_eq!(unstaged_names(&repo), ["a.txt"]);
    assert_eq!(
        std::fs::read_to_string(repo.path().join("a.txt")).unwrap(),
        "two\n"
    );
}

#[test]
fn unstage_of_an_added_file_leaves_it_untracked() {
    let repo = TestRepo::with_commit(&[("a.txt", "one\n")]);
    repo.write("new.txt", "new\n");
    repo.git(&["add", "new.txt"]);

    unstage_sync(&repo.path_str(), &paths(&["new.txt"])).unwrap();

    assert!(staged_names(&repo).is_empty());
    assert_eq!(untracked_names(&repo), ["new.txt"]);
}

#[test]
fn unstage_works_in_a_repo_without_commits() {
    let repo = TestRepo::new();
    repo.write("a.txt", "one\n");
    repo.write("b.txt", "one\n");
    repo.git(&["add", "-A"]);

    unstage_sync(&repo.path_str(), &paths(&["a.txt"])).unwrap();

    assert_eq!(names(&repo, &["ls-files", "--cached"]), ["b.txt"]);
    assert_eq!(untracked_names(&repo), ["a.txt"]);
}

#[test]
fn unstage_a_rename_restores_both_sides() {
    let repo = TestRepo::with_commit(&[("old.txt", "same\n")]);
    repo.git(&["mv", "old.txt", "new.txt"]);

    unstage_sync(&repo.path_str(), &paths(&["new.txt", "old.txt"])).unwrap();

    assert!(staged_names(&repo).is_empty());
    assert_eq!(unstaged_names(&repo), ["old.txt"]);
    assert_eq!(untracked_names(&repo), ["new.txt"]);
}

#[test]
fn partially_staged_file_moves_whole_between_groups() {
    let repo = TestRepo::with_commit(&[("a.txt", "one\n")]);
    repo.write("a.txt", "one\ntwo\n");
    repo.git(&["add", "a.txt"]);
    repo.write("a.txt", "one\ntwo\nthree\n");
    assert_eq!(staged_names(&repo), ["a.txt"]);
    assert_eq!(unstaged_names(&repo), ["a.txt"]);

    unstage_sync(&repo.path_str(), &paths(&["a.txt"])).unwrap();
    assert!(staged_names(&repo).is_empty());
    assert_eq!(unstaged_names(&repo), ["a.txt"]);

    repo.write("a.txt", "one\ntwo\n");
    repo.git(&["add", "a.txt"]);
    repo.write("a.txt", "one\ntwo\nthree\n");
    stage_sync(&repo.path_str(), &paths(&["a.txt"])).unwrap();
    assert_eq!(staged_names(&repo), ["a.txt"]);
    assert!(unstaged_names(&repo).is_empty());
}

#[test]
fn stage_all_stages_every_change() {
    let repo = TestRepo::with_commit(&[("a.txt", "one\n"), ("gone.txt", "bye\n")]);
    repo.write("a.txt", "two\n");
    repo.write("nested/new.txt", "new\n");
    std::fs::remove_file(repo.path().join("gone.txt")).unwrap();

    stage_all_sync(&repo.path_str()).unwrap();

    assert_eq!(staged_names(&repo), ["a.txt", "gone.txt", "nested/new.txt"]);
    assert!(unstaged_names(&repo).is_empty());
    assert!(untracked_names(&repo).is_empty());
}

#[test]
fn stage_all_works_in_a_repo_without_commits() {
    let repo = TestRepo::new();
    repo.write("a.txt", "one\n");

    stage_all_sync(&repo.path_str()).unwrap();

    assert_eq!(names(&repo, &["ls-files", "--cached"]), ["a.txt"]);
}

#[test]
fn rejects_unsafe_or_missing_paths() {
    let repo = TestRepo::with_commit(&[("a.txt", "one\n")]);
    let project = repo.path_str();
    for bad in ["../outside.txt", "/etc/passwd", "--force", ""] {
        assert!(stage_sync(&project, &paths(&[bad])).is_err(), "{bad}");
        assert!(unstage_sync(&project, &paths(&[bad])).is_err(), "{bad}");
    }
    assert!(stage_sync(&project, &[]).is_err());
    assert!(unstage_sync(&project, &[]).is_err());
}

#[test]
fn reports_an_error_outside_a_repository() {
    let dir = tempfile::tempdir().unwrap();
    let project = dir.path().to_string_lossy().to_string();
    assert!(stage_sync(&project, &paths(&["a.txt"])).is_err());
    assert!(stage_all_sync(&project).is_err());
}
