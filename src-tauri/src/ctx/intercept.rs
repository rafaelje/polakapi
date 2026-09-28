// Decides which shell commands an agent runs get routed through
// `polakapi ctx exec`, and builds the replacement command line.
//
// Deliberately narrow. A command is only rerouted when it is known to produce
// large, self-contained output and rerouting cannot change what it does:
//   - `cd` would lose its effect, because the rerouted command runs in a
//     subshell and the agent's shell keeps its old directory;
//   - following or watching commands never finish, so their output never
//     arrives;
//   - output already bounded by `head`, `wc` or a redirect is small anyway;
//   - `sudo` may prompt for a password the subshell cannot answer.
// Missing a saving is cheap; breaking a command the agent relied on is not.

/// What a routed command's output is: text to keep verbatim, or a log to
/// summarise. Carried as the source label prefix the router classifies on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputKind {
    Exact,
    Log,
}

impl OutputKind {
    pub fn label_prefix(self) -> &'static str {
        match self {
            OutputKind::Exact => "read",
            OutputKind::Log => "log",
        }
    }
}

const BLOCKED_FRAGMENTS: &[&str] = &[
    "polakapi", "<<", ">>", " > ", "| head", "|head", "| tail", "|tail", "| wc", "|wc", "| less",
    "| more", "--follow", " -f ", "tail -f", "watch ",
];

pub fn classify_command(command: &str) -> Option<OutputKind> {
    classify(command).ok()
}

/// Like `classify_command`, but says why a command is left alone. The reason
/// goes to the diagnostics log, so "context mode did nothing" is never a
/// mystery.
pub fn classify(command: &str) -> Result<OutputKind, String> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Err("empty command".into());
    }
    if trimmed.contains('\n') {
        return Err("multi-line command".into());
    }
    let padded = format!(" {trimmed} ");
    if let Some(fragment) = BLOCKED_FRAGMENTS
        .iter()
        .find(|fragment| padded.contains(*fragment))
    {
        return Err(match *fragment {
            "polakapi" => "already goes through polakapi".into(),
            _ => format!("contains {:?}", fragment.trim()),
        });
    }
    if trimmed.ends_with('&') {
        return Err("runs in the background".into());
    }
    if trimmed.ends_with(" -f") {
        return Err("follows output".into());
    }

    // Every segment of a compound command has to be safe, and the first one
    // decides what kind of output this is.
    let segments: Vec<&str> = trimmed
        .split(['&', ';', '|'])
        .map(str::trim)
        .filter(|segment| !segment.is_empty())
        .collect();
    if let Some(segment) = segments
        .iter()
        .find(|segment| matches!(program(segment), "cd" | "sudo" | "pushd" | "popd"))
    {
        return Err(format!("uses {}", program(segment)));
    }
    let first = segments
        .first()
        .ok_or_else(|| "empty command".to_string())?;
    classify_segment(first)
        .ok_or_else(|| format!("{} is not a command known to print a lot", program(first)))
}

/// Just the program a command runs, without its path or arguments: what the
/// diagnostics log records, since arguments and inline variables can carry
/// secrets.
pub fn program_name(command: &str) -> &str {
    let program = program(command);
    program.rsplit(['/', '\\']).next().unwrap_or(program)
}

fn program(segment: &str) -> &str {
    segment
        .split_whitespace()
        .find(|word| !word.contains('='))
        .unwrap_or("")
}

fn classify_segment(segment: &str) -> Option<OutputKind> {
    let words: Vec<&str> = segment
        .split_whitespace()
        .skip_while(|word| word.contains('='))
        .collect();
    let first = *words.first()?;
    let second = words.get(1).copied().unwrap_or("");
    let has = |flag: &str| words.contains(&flag);

    match first {
        "cat" | "find" | "tree" | "rg" | "curl" | "gh" => Some(OutputKind::Exact),
        "git" if matches!(second, "log" | "diff" | "show" | "blame") => Some(OutputKind::Exact),
        "grep" if has("-r") || has("-R") || has("-rn") || has("-Rn") => Some(OutputKind::Exact),
        "ls" if words
            .iter()
            .any(|word| word.starts_with('-') && word.contains('R')) =>
        {
            Some(OutputKind::Exact)
        }
        "journalctl" | "dmesg" => Some(OutputKind::Log),
        "docker" if second == "logs" => Some(OutputKind::Log),
        "kubectl" if second == "logs" => Some(OutputKind::Log),
        _ => None,
    }
}

/// Single-quotes a string for POSIX `sh`, so the command reaches `ctx exec`
/// byte for byte whatever quotes or `$` it contains.
pub fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

/// The command that replaces the original: same text, run and offloaded by
/// `polakapi ctx exec` under a label that tells the router how to treat it.
pub fn rewrite(bin: &str, command: &str, kind: OutputKind) -> String {
    let label = format!(
        "{}:{}",
        kind.label_prefix(),
        crate::ctx::mcp::source_slug(command)
    );
    format!(
        "{} ctx exec --source {} {}",
        shell_quote(bin),
        shell_quote(&label),
        shell_quote(command.trim())
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_skipped_command_comes_with_its_reason() {
        assert_eq!(classify("cd src && cat main.rs").unwrap_err(), "uses cd");
        assert_eq!(
            classify("git log | head").unwrap_err(),
            "contains \"| head\""
        );
        assert_eq!(
            classify("npm test").unwrap_err(),
            "npm is not a command known to print a lot"
        );
        assert!(classify("tail -f app.log").unwrap_err().contains("-f"));
        assert!(classify("git log --oneline").is_ok());
    }

    #[test]
    fn routes_commands_known_to_produce_large_output() {
        for command in [
            "git log --oneline",
            "git diff HEAD~3",
            "gh issue list --json title,body",
            "cat src/main.rs",
            "find . -name '*.ts'",
            "grep -rn TODO src",
            "ls -laR",
            "curl https://example.com/api",
        ] {
            assert_eq!(
                classify_command(command),
                Some(OutputKind::Exact),
                "{command}"
            );
        }
        assert_eq!(classify_command("docker logs web"), Some(OutputKind::Log));
        assert_eq!(
            classify_command("journalctl -u nginx"),
            Some(OutputKind::Log)
        );
    }

    #[test]
    fn leaves_everything_else_alone() {
        for command in [
            "",
            "cargo test",
            "npm run build",
            "ls",
            "git status",
            "echo hi",
            "python script.py",
        ] {
            assert_eq!(classify_command(command), None, "{command:?}");
        }
    }

    #[test]
    fn never_reroutes_a_directory_change() {
        // The subshell would swallow the cd and the agent's shell would not move.
        assert_eq!(classify_command("cd src && cat main.rs"), None);
        assert_eq!(classify_command("cat a.txt; cd /tmp"), None);
    }

    #[test]
    fn never_reroutes_something_that_does_not_finish() {
        assert_eq!(classify_command("docker logs -f web"), None);
        assert_eq!(classify_command("kubectl logs --follow pod"), None);
        assert_eq!(classify_command("journalctl -f"), None);
        assert_eq!(classify_command("tail -f app.log"), None);
        assert_eq!(classify_command("cat big.log &"), None);
    }

    #[test]
    fn leaves_output_that_is_already_bounded() {
        assert_eq!(classify_command("git log | head -20"), None);
        assert_eq!(classify_command("cat file.txt | wc -l"), None);
        assert_eq!(classify_command("git diff > patch.diff"), None);
    }

    #[test]
    fn leaves_commands_that_may_prompt_or_are_already_routed() {
        assert_eq!(classify_command("sudo cat /etc/shadow"), None);
        assert_eq!(classify_command("'/bin/polakapi' ctx exec 'git log'"), None);
        assert_eq!(classify_command("cat <<EOF\nx\nEOF"), None);
    }

    #[test]
    fn env_assignments_do_not_hide_the_program() {
        assert_eq!(
            classify_command("GIT_PAGER=cat git log"),
            Some(OutputKind::Exact)
        );
    }

    #[test]
    fn the_logged_program_name_carries_no_arguments_or_variables() {
        assert_eq!(
            program_name("TOKEN=secret /usr/bin/curl -H 'Authorization: x' url"),
            "curl"
        );
        assert_eq!(program_name("git log --oneline"), "git");
        assert_eq!(program_name(""), "");
    }

    #[test]
    fn quoting_survives_single_quotes_and_dollars() {
        assert_eq!(shell_quote("it's $HOME"), r"'it'\''s $HOME'");
    }

    #[cfg(unix)]
    #[test]
    fn a_quoted_command_reaches_the_shell_unchanged() {
        let original = r#"printf '%s|%s' "a b" 'c'\''d' $((1+1))"#;
        let out = std::process::Command::new("sh")
            .arg("-c")
            .arg(format!("sh -c {}", shell_quote(original)))
            .output()
            .unwrap();
        let direct = std::process::Command::new("sh")
            .arg("-c")
            .arg(original)
            .output()
            .unwrap();
        assert_eq!(out.stdout, direct.stdout);
    }

    #[test]
    fn the_rewrite_carries_the_label_and_the_original_command() {
        let line = rewrite("/opt/polakapi", "git log --oneline", OutputKind::Exact);
        assert!(line.starts_with("'/opt/polakapi' ctx exec --source 'read:git-log-oneline-"));
        assert!(line.ends_with(" 'git log --oneline'"));
    }
}
