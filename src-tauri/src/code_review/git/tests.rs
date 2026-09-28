use super::*;
use crate::code_review::test_repo::TestRepo;

fn unattended_env(repo: &TestRepo) -> String {
    let output = git_unattended(repo.path(), &["-c", "alias.showenv=!env", "showenv"]).unwrap();
    assert!(output.status.success());
    lossy(&output.stdout)
}

fn user_sets_ssh() -> bool {
    ["GIT_SSH_COMMAND", "GIT_SSH"]
        .iter()
        .any(|name| std::env::var_os(name).is_some_and(|value| !value.is_empty()))
}

#[test]
fn unattended_git_never_asks_for_ssh_input() {
    let repo = TestRepo::new();
    let env = unattended_env(&repo);
    assert!(env.lines().any(|line| line == "SSH_ASKPASS_REQUIRE=never"));
    assert!(env.lines().any(|line| line == "GIT_TERMINAL_PROMPT=0"));
    if !user_sets_ssh() {
        let expected = format!("GIT_SSH_COMMAND={BATCH_SSH_COMMAND}");
        assert!(env.lines().any(|line| line == expected));
    }
}

#[test]
fn unattended_git_keeps_a_configured_ssh_command() {
    let repo = TestRepo::new();
    repo.git(&["config", "core.sshCommand", "ssh -i /tmp/key"]);
    assert!(has_custom_ssh(repo.path()));
    let env = unattended_env(&repo);
    let batch = format!("GIT_SSH_COMMAND={BATCH_SSH_COMMAND}");
    assert!(!env.lines().any(|line| line == batch));
}
