use super::*;
use crate::code_review::remote_fixture::RemoteFixture;
use crate::code_review::test_repo::TestRepo;

fn head(repo: &TestRepo) -> String {
    let output = repo.git_output(&["rev-parse", "HEAD"]);
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

fn upstream(repo: &TestRepo, branch: &str) -> String {
    let spec = format!("{branch}@{{upstream}}");
    let output = repo.git_output(&["rev-parse", "--abbrev-ref", &spec]);
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

#[test]
fn pull_fast_forwards_from_the_upstream() {
    let fixture = RemoteFixture::new();
    fixture.peer_commit("b.txt", "two\n");
    fixture.peer_git(&["push", "-q", "origin", "main"]);

    pull_sync(&fixture.repo.path_str()).unwrap();

    let pulled = std::fs::read_to_string(fixture.repo.path().join("b.txt")).unwrap();
    assert_eq!(pulled, "two\n");
}

#[test]
fn pull_refuses_a_diverged_branch_with_a_readable_error() {
    let fixture = RemoteFixture::new();
    fixture.peer_commit("b.txt", "remote\n");
    fixture.peer_git(&["push", "-q", "origin", "main"]);
    fixture.repo.write("c.txt", "local\n");
    fixture.repo.git(&["add", "c.txt"]);
    fixture.repo.git(&["commit", "-q", "-m", "local"]);
    fixture.repo.git(&["config", "pull.rebase", "true"]);
    let before = head(&fixture.repo);

    let error = pull_sync(&fixture.repo.path_str()).unwrap_err();

    assert!(error.contains("cannot be fast-forwarded"), "{error}");
    assert_eq!(head(&fixture.repo), before);
    assert!(!fixture.repo.path().join("b.txt").exists());
}

#[test]
fn pull_explains_a_missing_upstream() {
    let repo = TestRepo::with_commit(&[("a.txt", "one\n")]);

    let error = pull_sync(&repo.path_str()).unwrap_err();

    assert!(error.contains("no upstream"), "{error}");
}

#[test]
fn switch_moves_to_another_local_branch_on_a_clean_tree() {
    let repo = TestRepo::with_commit(&[("a.txt", "one\n")]);
    repo.git(&["branch", "feature/login"]);

    let branch = switch_branch_sync(&repo.path_str(), "feature/login").unwrap();

    assert_eq!(branch, "feature/login");
    assert_eq!(
        current_branch_name(repo.path()).as_deref(),
        Some("feature/login")
    );
}

#[test]
fn switch_is_refused_while_the_tree_is_dirty() {
    let dirty_states: [fn(&TestRepo); 3] = [
        |repo| repo.write("a.txt", "changed\n"),
        |repo| {
            repo.write("a.txt", "staged\n");
            repo.git(&["add", "a.txt"]);
        },
        |repo| repo.write("new.txt", "untracked\n"),
    ];
    for make_dirty in dirty_states {
        let repo = TestRepo::with_commit(&[("a.txt", "one\n")]);
        repo.git(&["branch", "other"]);
        make_dirty(&repo);

        let error = switch_branch_sync(&repo.path_str(), "other").unwrap_err();

        assert!(error.contains("uncommitted changes"), "{error}");
        assert_eq!(current_branch_name(repo.path()).as_deref(), Some("main"));
    }
}

#[test]
fn switch_to_a_remote_branch_creates_a_tracking_branch() {
    let fixture = RemoteFixture::new();
    fixture.peer_git(&["switch", "-q", "-c", "feature/x"]);
    fixture.peer_commit("x.txt", "x\n");
    fixture.peer_git(&["push", "-q", "origin", "feature/x"]);
    fixture.repo.git(&["fetch", "-q", "origin"]);

    let branch = switch_branch_sync(&fixture.repo.path_str(), "origin/feature/x").unwrap();

    assert_eq!(branch, "feature/x");
    assert_eq!(upstream(&fixture.repo, "feature/x"), "origin/feature/x");
    assert!(fixture.repo.path().join("x.txt").exists());
}

#[test]
fn switch_to_a_remote_branch_reuses_an_existing_local_branch() {
    let fixture = RemoteFixture::new();
    fixture.repo.git(&["switch", "-q", "-c", "other"]);

    let branch = switch_branch_sync(&fixture.repo.path_str(), "origin/main").unwrap();

    assert_eq!(branch, "main");
    assert_eq!(
        current_branch_name(fixture.repo.path()).as_deref(),
        Some("main")
    );
}

#[test]
fn switch_rejects_unsafe_and_unknown_branches() {
    let repo = TestRepo::with_commit(&[("a.txt", "one\n")]);

    for name in ["-f", "a..b", "", "main:other", "bad name"] {
        let error = switch_branch_sync(&repo.path_str(), name).unwrap_err();
        assert!(error.contains("invalid branch name"), "{name}: {error}");
    }
    let error = switch_branch_sync(&repo.path_str(), "missing").unwrap_err();
    assert!(error.contains("unknown branch"), "{error}");
    let error = switch_branch_sync(&repo.path_str(), "HEAD~1").unwrap_err();
    assert!(error.contains("unknown branch"), "{error}");
}

#[test]
fn no_push_command_is_registered() {
    let registered = [
        include_str!("../../code_review.rs"),
        include_str!("../../lib.rs"),
    ];
    for source in registered {
        let commands = source
            .lines()
            .filter(|line| line.contains("code_review_"))
            .collect::<Vec<_>>();
        assert!(!commands.is_empty());
        assert!(
            commands.iter().all(|line| !line.contains("push")),
            "{commands:?}"
        );
    }
}
