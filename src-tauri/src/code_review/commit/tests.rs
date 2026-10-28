use super::*;
use crate::code_review::test_repo::TestRepo;

fn stdout(repo: &TestRepo, args: &[&str]) -> String {
    let output = repo.git_output(args);
    assert!(output.status.success());
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

#[test]
fn commit_records_only_staged_content_with_the_message() {
    let repo = TestRepo::with_commit(&[("a.txt", "one\n"), ("b.txt", "one\n")]);
    repo.write("a.txt", "two\n");
    repo.write("b.txt", "two\n");
    repo.git(&["add", "a.txt"]);

    let hash = commit_sync(
        &repo.path_str(),
        "fix: update a\n\nwith \"quotes\" and $HOME",
    )
    .unwrap();

    assert_eq!(hash, stdout(&repo, &["rev-parse", "--short", "HEAD"]));
    assert_eq!(
        stdout(&repo, &["log", "-1", "--format=%B"]),
        "fix: update a\n\nwith \"quotes\" and $HOME"
    );
    assert_eq!(stdout(&repo, &["show", "HEAD:a.txt"]), "two");
    assert_eq!(stdout(&repo, &["show", "HEAD:b.txt"]), "one");
    assert_eq!(stdout(&repo, &["diff", "--name-only"]), "b.txt");
}

#[test]
fn commit_refuses_an_empty_index() {
    let repo = TestRepo::with_commit(&[("a.txt", "one\n")]);
    repo.write("a.txt", "two\n");

    let error = commit_sync(&repo.path_str(), "message").unwrap_err();

    assert_eq!(error, "nothing is staged to commit");
    assert_eq!(stdout(&repo, &["rev-list", "--count", "HEAD"]), "1");
}

#[test]
fn commit_refuses_a_blank_message() {
    let repo = TestRepo::with_commit(&[("a.txt", "one\n")]);
    repo.write("a.txt", "two\n");
    repo.git(&["add", "a.txt"]);

    for message in ["", "  \n\t "] {
        let error = commit_sync(&repo.path_str(), message).unwrap_err();
        assert_eq!(error, "the commit message is empty");
    }
    assert_eq!(stdout(&repo, &["rev-list", "--count", "HEAD"]), "1");
}

#[test]
fn commit_creates_the_first_commit_of_a_new_repo() {
    let repo = TestRepo::new();
    repo.write("a.txt", "one\n");
    repo.git(&["add", "a.txt"]);

    let hash = commit_sync(&repo.path_str(), "first").unwrap();

    assert_eq!(hash, stdout(&repo, &["rev-parse", "--short", "HEAD"]));
    assert_eq!(stdout(&repo, &["log", "--format=%s"]), "first");
}

#[cfg(unix)]
#[test]
fn commit_surfaces_a_failing_hook() {
    use std::os::unix::fs::PermissionsExt;

    let repo = TestRepo::with_commit(&[("a.txt", "one\n")]);
    let hook = repo.path().join(".git/hooks/pre-commit");
    std::fs::write(
        &hook,
        "#!/bin/sh\necho 'lint failed on a.txt' >&2\nexit 1\n",
    )
    .unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    repo.write("a.txt", "two\n");
    repo.git(&["add", "a.txt"]);

    let error = commit_sync(&repo.path_str(), "message").unwrap_err();

    assert!(error.starts_with("git commit failed:"), "{error}");
    assert!(error.contains("lint failed on a.txt"), "{error}");
    assert_eq!(stdout(&repo, &["rev-list", "--count", "HEAD"]), "1");
}
