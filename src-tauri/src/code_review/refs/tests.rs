use super::*;
use crate::code_review::remote_fixture::RemoteFixture;
use crate::code_review::test_repo::TestRepo;

fn remote(name: &str, remote: &str, branch: &str) -> RemoteBranch {
    RemoteBranch {
        name: name.into(),
        remote: remote.into(),
        branch: branch.into(),
    }
}

#[test]
fn lists_local_branches_with_the_current_one() {
    let repo = TestRepo::with_commit(&[("a.txt", "one\n")]);
    repo.git(&["branch", "feature/login"]);
    repo.git(&["branch", "develop"]);

    let refs = branch_refs_sync(&repo.path_str()).unwrap();

    assert_eq!(refs.current.as_deref(), Some("main"));
    assert_eq!(refs.local, vec!["develop", "feature/login", "main"]);
    assert!(refs.remote.is_empty());
}

#[test]
fn lists_remote_branches_without_symbolic_heads() {
    let fixture = RemoteFixture::new();
    fixture.peer_git(&["switch", "-q", "-c", "feature/x"]);
    fixture.peer_commit("x.txt", "x\n");
    fixture.peer_git(&["push", "-q", "origin", "feature/x"]);
    fixture.repo.git(&["fetch", "-q", "origin"]);
    fixture.repo.git(&["remote", "set-head", "origin", "main"]);

    let refs = branch_refs_sync(&fixture.repo.path_str()).unwrap();

    assert_eq!(refs.local, vec!["main"]);
    assert_eq!(
        refs.remote,
        vec![
            remote("origin/feature/x", "origin", "feature/x"),
            remote("origin/main", "origin", "main"),
        ]
    );
}

#[test]
fn current_is_none_on_a_detached_head() {
    let repo = TestRepo::with_commit(&[("a.txt", "one\n")]);
    repo.git(&["switch", "-q", "--detach", "HEAD"]);

    let refs = branch_refs_sync(&repo.path_str()).unwrap();

    assert_eq!(refs.current, None);
    assert_eq!(refs.local, vec!["main"]);
}

#[test]
fn rejects_a_path_that_is_not_a_repo() {
    let dir = tempfile::tempdir().unwrap();
    assert!(branch_refs_sync(dir.path().to_str().unwrap()).is_err());
}
