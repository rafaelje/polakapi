use super::*;
use crate::code_review::test_repo::TestRepo;

fn contents(repo: &TestRepo, path: &str, source: ContentSource) -> FileContents {
    file_contents_sync(&repo.path_str(), path, None, &source).unwrap()
}

fn text(value: &str) -> SideContent {
    SideContent::Text {
        text: value.to_string(),
    }
}

#[test]
fn staged_compares_head_with_the_index() {
    let repo = TestRepo::with_commit(&[("a.txt", "one\n")]);
    repo.write("a.txt", "one\ntwo\n");
    repo.git(&["add", "a.txt"]);
    repo.write("a.txt", "one\ntwo\nthree\n");

    let result = contents(&repo, "a.txt", ContentSource::Staged);

    assert_eq!(result.before, text("one\n"));
    assert_eq!(result.after, text("one\ntwo\n"));
}

#[test]
fn unstaged_compares_the_index_with_the_worktree() {
    let repo = TestRepo::with_commit(&[("a.txt", "one\n")]);
    repo.write("a.txt", "one\ntwo\n");
    repo.git(&["add", "a.txt"]);
    repo.write("a.txt", "one\ntwo\nthree\n");

    let result = contents(&repo, "a.txt", ContentSource::Unstaged);

    assert_eq!(result.before, text("one\ntwo\n"));
    assert_eq!(result.after, text("one\ntwo\nthree\n"));
}

#[test]
fn untracked_file_has_an_absent_before_side() {
    let repo = TestRepo::with_commit(&[("a.txt", "one\n")]);
    repo.write("dir/new file.txt", "hello\n");

    let result = contents(&repo, "dir/new file.txt", ContentSource::Untracked);

    assert_eq!(result.before, SideContent::Absent);
    assert_eq!(result.after, text("hello\n"));
}

#[test]
fn staged_added_file_has_an_absent_before_side() {
    let repo = TestRepo::with_commit(&[("a.txt", "one\n")]);
    repo.write("b.txt", "new\n");
    repo.git(&["add", "b.txt"]);

    let result = contents(&repo, "b.txt", ContentSource::Staged);

    assert_eq!(result.before, SideContent::Absent);
    assert_eq!(result.after, text("new\n"));
}

#[test]
fn staged_file_in_a_repo_without_commits_has_an_absent_before_side() {
    let repo = TestRepo::new();
    repo.write("a.txt", "first\n");
    repo.git(&["add", "a.txt"]);

    let result = contents(&repo, "a.txt", ContentSource::Staged);

    assert_eq!(result.before, SideContent::Absent);
    assert_eq!(result.after, text("first\n"));
}

#[test]
fn deleted_files_have_an_absent_after_side() {
    let repo = TestRepo::with_commit(&[("staged.txt", "s\n"), ("unstaged.txt", "u\n")]);
    repo.git(&["rm", "-q", "staged.txt"]);
    std::fs::remove_file(repo.path().join("unstaged.txt")).unwrap();

    let staged = contents(&repo, "staged.txt", ContentSource::Staged);
    let unstaged = contents(&repo, "unstaged.txt", ContentSource::Unstaged);

    assert_eq!(staged.before, text("s\n"));
    assert_eq!(staged.after, SideContent::Absent);
    assert_eq!(unstaged.before, text("u\n"));
    assert_eq!(unstaged.after, SideContent::Absent);
}

#[test]
fn staged_rename_reads_the_before_side_from_the_original_path() {
    let repo = TestRepo::with_commit(&[("old.txt", "one\ntwo\nthree\nfour\n")]);
    repo.git(&["mv", "old.txt", "new.txt"]);
    repo.write("new.txt", "one\ntwo\nthree\nfour\nfive\n");
    repo.git(&["add", "new.txt"]);

    let result = file_contents_sync(
        &repo.path_str(),
        "new.txt",
        Some("old.txt"),
        &ContentSource::Staged,
    )
    .unwrap();

    assert_eq!(result.before, text("one\ntwo\nthree\nfour\n"));
    assert_eq!(result.after, text("one\ntwo\nthree\nfour\nfive\n"));
}

#[test]
fn conflicted_file_compares_head_with_the_worktree() {
    let repo = TestRepo::with_commit(&[("a.txt", "base\n")]);
    repo.git(&["checkout", "-q", "-b", "other"]);
    repo.write("a.txt", "theirs\n");
    repo.git(&["commit", "-q", "-am", "theirs"]);
    repo.git(&["checkout", "-q", "main"]);
    repo.write("a.txt", "ours\n");
    repo.git(&["commit", "-q", "-am", "ours"]);
    let merge = repo.git_output(&["merge", "-q", "other"]);
    assert!(!merge.status.success());

    let result = contents(&repo, "a.txt", ContentSource::Unstaged);

    assert_eq!(result.before, text("ours\n"));
    match result.after {
        SideContent::Text { text } => assert!(text.contains("<<<<<<<")),
        other => panic!("expected conflict markers, got {other:?}"),
    }
}

#[test]
fn binary_contents_are_replaced_by_a_marker() {
    let repo = TestRepo::with_commit(&[("a.txt", "one\n")]);
    repo.write_bytes("image.bin", &[0x89, b'P', b'N', b'G', 0, 1, 2, 3]);
    repo.git(&["add", "image.bin"]);
    repo.write_bytes("image.bin", &[0x89, b'P', b'N', b'G', 0, 9, 9]);

    let staged = contents(&repo, "image.bin", ContentSource::Staged);
    let unstaged = contents(&repo, "image.bin", ContentSource::Unstaged);

    assert_eq!(staged.after, SideContent::Binary);
    assert_eq!(unstaged.before, SideContent::Binary);
    assert_eq!(unstaged.after, SideContent::Binary);
}

#[test]
fn oversize_contents_are_replaced_by_a_marker() {
    let size = MAX_CONTENT_BYTES + 1;
    let big = "x".repeat(size as usize);
    let staged_repo = TestRepo::with_commit(&[("a.txt", "one\n")]);
    staged_repo.write("big.txt", &big);
    staged_repo.git(&["add", "big.txt"]);
    let untracked_repo = TestRepo::with_commit(&[("a.txt", "one\n")]);
    untracked_repo.write("big.txt", &big);

    let staged = contents(&staged_repo, "big.txt", ContentSource::Staged);
    let untracked = contents(&untracked_repo, "big.txt", ContentSource::Untracked);

    assert_eq!(staged.after, SideContent::TooLarge { bytes: size });
    assert_eq!(untracked.after, SideContent::TooLarge { bytes: size });
}

#[test]
fn rejects_unsafe_paths() {
    let repo = TestRepo::with_commit(&[("a.txt", "one\n")]);
    for path in ["", "/etc/passwd", "../outside.txt", "-rf", "a/../../b"] {
        let result = file_contents_sync(&repo.path_str(), path, None, &ContentSource::Unstaged);
        assert!(result.is_err(), "{path:?} should be rejected");
    }
    let original = file_contents_sync(
        &repo.path_str(),
        "a.txt",
        Some("../x"),
        &ContentSource::Staged,
    );
    assert!(original.is_err());
}

#[cfg(unix)]
#[test]
fn does_not_read_through_symlinked_directories_outside_the_project() {
    let repo = TestRepo::with_commit(&[("a.txt", "one\n")]);
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("secret.txt"), "secret\n").unwrap();
    std::os::unix::fs::symlink(outside.path(), repo.path().join("link")).unwrap();

    let result = file_contents_sync(
        &repo.path_str(),
        "link/secret.txt",
        None,
        &ContentSource::Untracked,
    );

    assert!(result.is_err(), "{result:?}");
}

#[test]
fn source_and_sides_use_tagged_json() {
    let source: ContentSource = serde_json::from_str(r#"{"kind":"staged"}"#).unwrap();
    assert_eq!(source, ContentSource::Staged);
    let side = serde_json::to_value(SideContent::TooLarge { bytes: 5 }).unwrap();
    assert_eq!(side, serde_json::json!({"kind": "tooLarge", "bytes": 5}));
}

fn branch(base: &str) -> ContentSource {
    ContentSource::Branch {
        base: base.to_string(),
    }
}

#[test]
fn branch_compares_the_merge_base_with_head() {
    let repo = TestRepo::with_commit(&[("a.txt", "one\n")]);
    repo.git(&["switch", "-q", "-c", "feature"]);
    repo.write("a.txt", "one\nfeature\n");
    repo.git(&["commit", "-q", "-am", "feature"]);
    repo.git(&["switch", "-q", "main"]);
    repo.write("a.txt", "one\nmain later\n");
    repo.git(&["commit", "-q", "-am", "main later"]);
    repo.git(&["switch", "-q", "feature"]);
    repo.write("a.txt", "uncommitted\n");

    let result = contents(&repo, "a.txt", branch("main"));

    assert_eq!(result.before, text("one\n"));
    assert_eq!(result.after, text("one\nfeature\n"));
}

#[test]
fn branch_reads_the_before_side_from_the_rename_source() {
    let repo = TestRepo::with_commit(&[("old.txt", "same\n")]);
    repo.git(&["switch", "-q", "-c", "feature"]);
    repo.git(&["mv", "old.txt", "new.txt"]);
    repo.git(&["commit", "-q", "-m", "rename"]);

    let result = file_contents_sync(
        &repo.path_str(),
        "new.txt",
        Some("old.txt"),
        &branch("main"),
    )
    .unwrap();

    assert_eq!(result.before, text("same\n"));
    assert_eq!(result.after, text("same\n"));
}

#[test]
fn branch_refuses_unsafe_bases() {
    let repo = TestRepo::with_commit(&[("a.txt", "one\n")]);

    let result = file_contents_sync(&repo.path_str(), "a.txt", None, &branch("--all"));

    assert!(result.is_err(), "{result:?}");
}

#[test]
fn branch_source_uses_tagged_json() {
    let source: ContentSource =
        serde_json::from_str(r#"{"kind":"branch","base":"origin/main"}"#).unwrap();
    assert_eq!(source, branch("origin/main"));
}
