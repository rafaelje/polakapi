use super::*;
use crate::code_review::test_repo::TestRepo;

fn overview(repo: &TestRepo) -> ChangesOverview {
    changes_overview_sync(&repo.path_str()).unwrap()
}

fn find<'a>(overview: &'a ChangesOverview, group: ChangeGroup, path: &str) -> &'a ChangedFile {
    overview
        .files
        .iter()
        .find(|file| file.group == group && file.path == path)
        .unwrap_or_else(|| panic!("{path} not in {group:?}: {:#?}", overview.files))
}

#[test]
fn clean_tree_has_no_changes_and_reports_the_branch() {
    let repo = TestRepo::with_commit(&[("a.txt", "one\n")]);
    let result = overview(&repo);
    assert!(result.files.is_empty());
    assert_eq!(result.branch.as_deref(), Some("main"));
}

#[test]
fn groups_staged_unstaged_and_untracked_files() {
    let repo = TestRepo::with_commit(&[("staged.txt", "a\n"), ("unstaged.txt", "a\nb\n")]);
    repo.write("staged.txt", "a\nb\nc\n");
    repo.git(&["add", "staged.txt"]);
    repo.write("unstaged.txt", "a\n");
    repo.write("new/untracked.txt", "x\ny\n");

    let result = overview(&repo);

    assert_eq!(result.files.len(), 3);
    let staged = find(&result, ChangeGroup::Staged, "staged.txt");
    assert_eq!(staged.status, ChangeStatus::Modified);
    assert_eq!((staged.insertions, staged.deletions), (2, 0));
    let unstaged = find(&result, ChangeGroup::Unstaged, "unstaged.txt");
    assert_eq!(unstaged.status, ChangeStatus::Modified);
    assert_eq!((unstaged.insertions, unstaged.deletions), (0, 1));
    let untracked = find(&result, ChangeGroup::Untracked, "new/untracked.txt");
    assert_eq!(untracked.status, ChangeStatus::Untracked);
    assert_eq!((untracked.insertions, untracked.deletions), (2, 0));
    assert!(!untracked.binary);
}

#[test]
fn partially_staged_file_appears_in_both_groups() {
    let repo = TestRepo::with_commit(&[("a.txt", "one\n")]);
    repo.write("a.txt", "one\ntwo\n");
    repo.git(&["add", "a.txt"]);
    repo.write("a.txt", "one\ntwo\nthree\nfour\n");

    let result = overview(&repo);

    assert_eq!(result.files.len(), 2);
    let staged = find(&result, ChangeGroup::Staged, "a.txt");
    assert_eq!((staged.insertions, staged.deletions), (1, 0));
    let unstaged = find(&result, ChangeGroup::Unstaged, "a.txt");
    assert_eq!((unstaged.insertions, unstaged.deletions), (2, 0));
}

#[test]
fn reports_added_and_deleted_files() {
    let repo = TestRepo::with_commit(&[("gone.txt", "x\ny\n"), ("removed.txt", "z\n")]);
    repo.write("added.txt", "new\n");
    repo.git(&["add", "added.txt"]);
    repo.git(&["rm", "-q", "gone.txt"]);
    std::fs::remove_file(repo.path().join("removed.txt")).unwrap();

    let result = overview(&repo);

    let added = find(&result, ChangeGroup::Staged, "added.txt");
    assert_eq!(added.status, ChangeStatus::Added);
    let gone = find(&result, ChangeGroup::Staged, "gone.txt");
    assert_eq!(gone.status, ChangeStatus::Deleted);
    assert_eq!((gone.insertions, gone.deletions), (0, 2));
    let removed = find(&result, ChangeGroup::Unstaged, "removed.txt");
    assert_eq!(removed.status, ChangeStatus::Deleted);
}

#[test]
fn reports_renames_with_their_source_and_spaces_in_names() {
    let content = "line 1\nline 2\nline 3\nline 4\nline 5\n";
    let repo = TestRepo::with_commit(&[("old name.txt", content)]);
    repo.write("new dir/new name.txt", &format!("{content}line 6\n"));
    std::fs::remove_file(repo.path().join("old name.txt")).unwrap();
    repo.git(&["add", "-A"]);

    let result = overview(&repo);

    assert_eq!(result.files.len(), 1, "{:#?}", result.files);
    let renamed = find(&result, ChangeGroup::Staged, "new dir/new name.txt");
    assert_eq!(renamed.status, ChangeStatus::Renamed);
    assert_eq!(renamed.original_path.as_deref(), Some("old name.txt"));
    assert_eq!((renamed.insertions, renamed.deletions), (1, 0));
}

#[test]
fn untracked_files_keep_spaces_and_unicode_in_their_names() {
    let repo = TestRepo::with_commit(&[("a.txt", "a\n")]);
    repo.write("with space/ñandú file.md", "hola");

    let result = overview(&repo);

    let file = find(&result, ChangeGroup::Untracked, "with space/ñandú file.md");
    assert_eq!(file.insertions, 1);
}

#[test]
fn flags_binary_files() {
    let repo = TestRepo::with_commit(&[("a.txt", "a\n")]);
    repo.write_bytes("image.bin", &[0, 1, 2, 0, 3]);
    repo.write_bytes("staged.bin", &[0, 9, 9, 0]);
    repo.git(&["add", "staged.bin"]);

    let result = overview(&repo);

    let untracked = find(&result, ChangeGroup::Untracked, "image.bin");
    assert!(untracked.binary);
    assert_eq!((untracked.insertions, untracked.deletions), (0, 0));
    assert!(find(&result, ChangeGroup::Staged, "staged.bin").binary);
}

#[test]
fn reports_conflicted_files_once_as_unstaged() {
    let repo = TestRepo::with_commit(&[("c.txt", "base\n")]);
    repo.git(&["checkout", "-q", "-b", "other"]);
    repo.write("c.txt", "other\n");
    repo.git(&["commit", "-q", "-am", "other"]);
    repo.git(&["checkout", "-q", "main"]);
    repo.write("c.txt", "main\n");
    repo.git(&["commit", "-q", "-am", "main"]);
    assert!(!repo.git_output(&["merge", "other"]).status.success());

    let result = overview(&repo);

    assert_eq!(result.files.len(), 1, "{:#?}", result.files);
    let conflicted = find(&result, ChangeGroup::Unstaged, "c.txt");
    assert_eq!(conflicted.status, ChangeStatus::Conflicted);
}

#[test]
fn works_before_the_first_commit() {
    let repo = TestRepo::new();
    repo.write("first.txt", "a\nb\n");
    repo.git(&["add", "first.txt"]);
    repo.write("loose.txt", "c\n");

    let result = overview(&repo);

    let first = find(&result, ChangeGroup::Staged, "first.txt");
    assert_eq!(first.status, ChangeStatus::Added);
    assert_eq!((first.insertions, first.deletions), (2, 0));
    find(&result, ChangeGroup::Untracked, "loose.txt");
    assert_eq!(result.branch.as_deref(), Some("main"));
}

#[test]
fn rejects_paths_that_are_not_git_repos() {
    let dir = tempfile::tempdir().unwrap();
    assert!(changes_overview_sync(&dir.path().to_string_lossy()).is_err());
    assert!(changes_overview_sync("/definitely/not/here").is_err());
}
