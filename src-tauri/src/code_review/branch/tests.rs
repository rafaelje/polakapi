use super::*;
use crate::code_review::remote_fixture::RemoteFixture;
use crate::code_review::test_repo::TestRepo;

fn default_base(repo: &TestRepo) -> Option<String> {
    default_base_sync(&repo.path_str()).unwrap()
}

#[test]
fn default_base_is_main_when_it_exists() {
    let repo = TestRepo::with_commit(&[("a.txt", "one\n")]);
    repo.git(&["branch", "master"]);

    assert_eq!(default_base(&repo).as_deref(), Some("main"));
}

#[test]
fn default_base_falls_back_to_master() {
    let repo = TestRepo::with_commit(&[("a.txt", "one\n")]);
    repo.git(&["branch", "-m", "main", "master"]);

    assert_eq!(default_base(&repo).as_deref(), Some("master"));
}

#[test]
fn default_base_is_none_without_main_or_master() {
    let repo = TestRepo::with_commit(&[("a.txt", "one\n")]);
    repo.git(&["branch", "-m", "main", "develop"]);

    assert_eq!(default_base(&repo), None);
}

#[test]
fn default_base_uses_origin_main_when_main_is_only_remote() {
    let fixture = RemoteFixture::new();
    fixture.repo.git(&["switch", "-q", "-c", "feature"]);
    fixture.repo.git(&["branch", "-D", "main"]);

    assert_eq!(default_base(&fixture.repo).as_deref(), Some("origin/main"));
}

#[test]
fn default_base_prefers_local_master_over_remote_only_main() {
    let fixture = RemoteFixture::new();
    fixture.repo.git(&["branch", "-m", "main", "master"]);

    assert_eq!(default_base(&fixture.repo).as_deref(), Some("master"));
}

#[test]
fn default_base_uses_origin_master_when_only_it_exists() {
    let fixture = RemoteFixture::new();
    fixture.repo.git(&["switch", "-q", "-c", "feature"]);
    fixture.repo.git(&["branch", "-D", "main"]);
    fixture
        .repo
        .git(&["update-ref", "refs/remotes/origin/master", "HEAD"]);
    fixture
        .repo
        .git(&["update-ref", "-d", "refs/remotes/origin/main"]);

    assert_eq!(
        default_base(&fixture.repo).as_deref(),
        Some("origin/master")
    );
}

fn feature_repo() -> TestRepo {
    let repo = TestRepo::with_commit(&[
        ("a.txt", "one\n"),
        ("old name.txt", "same\ncontent\nhere\n"),
    ]);
    repo.git(&["switch", "-q", "-c", "feature"]);
    repo
}

fn commit(repo: &TestRepo, message: &str) {
    repo.git(&["add", "-A"]);
    repo.git(&["commit", "-q", "-m", message]);
}

fn file<'a>(overview: &'a BranchOverview, path: &str) -> &'a BranchFile {
    overview
        .files
        .iter()
        .find(|file| file.path == path)
        .unwrap_or_else(|| panic!("{path} missing from {:?}", overview.files))
}

#[test]
fn overview_lists_files_changed_since_the_merge_base() {
    let repo = feature_repo();
    repo.write("a.txt", "one\ntwo\nthree\n");
    repo.write("dir/b.txt", "new\n");
    commit(&repo, "feature work");
    repo.git(&["switch", "-q", "main"]);
    repo.write("later.txt", "main moved on\n");
    commit(&repo, "main moves on");
    repo.git(&["switch", "-q", "feature"]);

    let overview = branch_overview_sync(&repo.path_str(), "main").unwrap();

    assert_eq!(overview.base, "main");
    let paths: Vec<&str> = overview.files.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(paths, vec!["a.txt", "dir/b.txt"]);
    let modified = file(&overview, "a.txt");
    assert_eq!(modified.status, ChangeStatus::Modified);
    assert_eq!((modified.insertions, modified.deletions), (2, 0));
    let added = file(&overview, "dir/b.txt");
    assert_eq!(added.status, ChangeStatus::Added);
    assert_eq!((added.insertions, added.deletions), (1, 0));
}

#[test]
fn overview_reports_deleted_files() {
    let repo = feature_repo();
    repo.git(&["rm", "-q", "a.txt"]);
    commit(&repo, "remove a");

    let overview = branch_overview_sync(&repo.path_str(), "main").unwrap();

    let deleted = file(&overview, "a.txt");
    assert_eq!(deleted.status, ChangeStatus::Deleted);
    assert_eq!((deleted.insertions, deleted.deletions), (0, 1));
}

#[test]
fn overview_reports_renames_with_their_source() {
    let repo = feature_repo();
    repo.git(&["mv", "old name.txt", "new name.txt"]);
    commit(&repo, "rename");

    let overview = branch_overview_sync(&repo.path_str(), "main").unwrap();

    assert_eq!(overview.files.len(), 1);
    let renamed = file(&overview, "new name.txt");
    assert_eq!(renamed.status, ChangeStatus::Renamed);
    assert_eq!(renamed.original_path.as_deref(), Some("old name.txt"));
}

#[test]
fn overview_flags_binary_files() {
    let repo = feature_repo();
    repo.write_bytes("image.bin", &[0, 1, 2, 0, 3]);
    commit(&repo, "binary");

    let overview = branch_overview_sync(&repo.path_str(), "main").unwrap();

    let binary = file(&overview, "image.bin");
    assert!(binary.binary);
    assert_eq!((binary.insertions, binary.deletions), (0, 0));
}

#[test]
fn overview_ignores_uncommitted_changes() {
    let repo = feature_repo();
    repo.write("a.txt", "dirty\n");
    repo.write("untracked.txt", "x\n");

    let overview = branch_overview_sync(&repo.path_str(), "main").unwrap();

    assert!(overview.files.is_empty());
}

#[test]
fn overview_refuses_unsafe_base_refs() {
    let repo = feature_repo();

    for base in ["--output=/tmp/x", "main..feature", "main:a.txt", ""] {
        let error = branch_overview_sync(&repo.path_str(), base).unwrap_err();
        assert!(error.contains("invalid base branch"), "{base}: {error}");
    }
}

#[test]
fn overview_refuses_unknown_base_refs() {
    let repo = feature_repo();

    let error = branch_overview_sync(&repo.path_str(), "nope").unwrap_err();

    assert!(error.contains("unknown ref"), "{error}");
}
