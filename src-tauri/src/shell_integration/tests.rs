use super::*;

#[test]
fn apply_is_noop_for_unsupported_shells() {
    for shell in ["fish", "sh", "dash", "ksh", "tcsh", "csh", "cmd.exe"] {
        let mut cmd = CommandBuilder::new(shell);
        let before = cmd.get_argv().clone();
        let tmp = tempfile::tempdir().unwrap();
        apply(tmp.path(), &mut cmd, shell);
        assert_eq!(
            cmd.get_argv(),
            &before,
            "no args should be added for {shell}"
        );
        assert!(!tmp.path().join("integration.bash").exists());
    }
}

#[test]
fn apply_adds_init_file_for_bash_and_materializes_scripts() {
    let tmp = tempfile::tempdir().unwrap();
    let mut cmd = CommandBuilder::new("bash");
    apply(tmp.path(), &mut cmd, "/bin/bash");

    let argv = cmd.get_argv();
    let init_file_idx = argv.iter().position(|a| a == "--init-file");
    assert!(
        init_file_idx.is_some(),
        "expected --init-file in argv: {argv:?}"
    );
    let script_path = &argv[init_file_idx.unwrap() + 1];
    assert_eq!(script_path, &tmp.path().join("integration.bash"));
    assert!(tmp.path().join("integration.bash").exists());
    assert_eq!(
        std::fs::read_to_string(tmp.path().join("integration.bash")).unwrap(),
        INTEGRATION_BASH
    );
}

#[test]
fn apply_sets_zdotdir_for_zsh_and_materializes_wrapper() {
    let tmp = tempfile::tempdir().unwrap();
    let mut cmd = CommandBuilder::new("zsh");
    apply(tmp.path(), &mut cmd, "/usr/bin/zsh");

    assert_eq!(
        cmd.get_env("ZDOTDIR"),
        Some(std::ffi::OsStr::new(tmp.path().as_os_str()))
    );
    assert!(tmp.path().join(".zshrc").exists());
    assert!(tmp.path().join("integration.zsh").exists());
}

#[test]
fn apply_matches_shell_case_insensitively_and_by_basename() {
    let tmp = tempfile::tempdir().unwrap();
    let mut cmd = CommandBuilder::new("zsh");
    apply(tmp.path(), &mut cmd, "/usr/local/bin/ZSH");
    assert!(cmd.get_env("ZDOTDIR").is_some());
}
