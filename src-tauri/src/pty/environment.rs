use portable_pty::CommandBuilder;

pub(super) fn configure_terminal_environment(cmd: &mut CommandBuilder) {
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env_remove("NO_COLOR");

    #[cfg(unix)]
    if cmd.get_env("LANG").is_none_or(|value| value.is_empty()) {
        #[cfg(target_os = "macos")]
        cmd.env("LANG", "en_US.UTF-8");
        #[cfg(not(target_os = "macos"))]
        cmd.env("LANG", "C.UTF-8");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;

    #[test]
    fn terminal_environment_enables_color_output() {
        let mut cmd = CommandBuilder::new("zsh");
        cmd.env("NO_COLOR", "1");

        configure_terminal_environment(&mut cmd);

        assert_eq!(cmd.get_env("TERM"), Some(OsStr::new("xterm-256color")));
        assert_eq!(cmd.get_env("COLORTERM"), Some(OsStr::new("truecolor")));
        assert_eq!(cmd.get_env("NO_COLOR"), None);
    }

    #[cfg(unix)]
    #[test]
    fn missing_or_empty_lang_gets_a_utf8_default() {
        for lang in [None, Some("")] {
            let mut cmd = CommandBuilder::new("sh");
            cmd.env_clear();
            if let Some(lang) = lang {
                cmd.env("LANG", lang);
            }

            configure_terminal_environment(&mut cmd);

            #[cfg(target_os = "macos")]
            assert_eq!(cmd.get_env("LANG"), Some(OsStr::new("en_US.UTF-8")));
            #[cfg(not(target_os = "macos"))]
            assert_eq!(cmd.get_env("LANG"), Some(OsStr::new("C.UTF-8")));
            assert_eq!(cmd.get_env("LC_ALL"), None);
            assert_eq!(cmd.get_env("LC_CTYPE"), None);
        }
    }

    #[test]
    fn explicit_locale_preferences_are_preserved() {
        for lang in [None, Some("fr_FR.UTF-8"), Some("C"), Some("POSIX")] {
            let mut cmd = CommandBuilder::new("sh");
            cmd.env_clear();
            if let Some(lang) = lang {
                cmd.env("LANG", lang);
            }
            cmd.env("LC_ALL", "de_DE.UTF-8");
            cmd.env("LC_CTYPE", "UTF-8");
            cmd.env("LC_TIME", "en_GB.UTF-8");

            configure_terminal_environment(&mut cmd);

            if let Some(lang) = lang {
                assert_eq!(cmd.get_env("LANG"), Some(OsStr::new(lang)));
            }
            assert_eq!(cmd.get_env("LC_ALL"), Some(OsStr::new("de_DE.UTF-8")));
            assert_eq!(cmd.get_env("LC_CTYPE"), Some(OsStr::new("UTF-8")));
            assert_eq!(cmd.get_env("LC_TIME"), Some(OsStr::new("en_GB.UTF-8")));
        }
    }

    #[cfg(unix)]
    #[test]
    fn pty_child_uses_utf8_without_an_inherited_locale() {
        use portable_pty::{NativePtySystem, PtySize, PtySystem};
        use std::io::Read;

        let pair = NativePtySystem::default()
            .openpty(PtySize::default())
            .unwrap();
        let mut cmd = CommandBuilder::new("locale");
        cmd.arg("charmap");
        cmd.env_clear();
        if let Some(path) = std::env::var_os("PATH") {
            cmd.env("PATH", path);
        }
        configure_terminal_environment(&mut cmd);

        let mut child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut output = String::new();
        if let Err(error) = reader.read_to_string(&mut output) {
            assert_eq!(error.raw_os_error(), Some(libc::EIO));
        }

        assert!(child.wait().unwrap().success());
        assert_eq!(output.trim(), "UTF-8");
    }

    #[cfg(windows)]
    #[test]
    fn windows_does_not_add_a_posix_locale() {
        let mut cmd = CommandBuilder::new("cmd.exe");
        cmd.env_clear();

        configure_terminal_environment(&mut cmd);

        assert_eq!(cmd.get_env("LANG"), None);
    }
}
