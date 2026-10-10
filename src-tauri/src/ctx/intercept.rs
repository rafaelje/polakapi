// Decides which shell commands an agent runs get routed through
// `polakapi ctx exec`, and builds the replacement command line.
//
// Broad by design: output under the bypass threshold comes back unchanged, so
// routing a command that prints little costs nothing, and a command that
// unexpectedly prints a lot is caught. A command is left alone only when
// routing could change what it does or cannot help:
//   - `cd`, `export`, `source` and friends would lose their effect, because
//     the routed command runs in a subshell;
//   - interactive, following or background commands never hand back output;
//   - heredocs and `<` need a stdin the subshell does not have;
//   - output already written to a file has nothing to offload;
//   - aliases and shell functions do not exist in the subshell;
//   - commands that always print a line or two are not worth a rewrite.

/// How a routed command's output is handled, carried as the source label
/// prefix the router classifies on: text to keep verbatim, a log to summarise,
/// or anything else, judged by what it printed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputKind {
    Exact,
    Log,
    Auto,
}

impl OutputKind {
    pub fn label_prefix(self) -> &'static str {
        match self {
            OutputKind::Exact => "read",
            OutputKind::Log => "log",
            OutputKind::Auto => "run",
        }
    }
}

const BLOCKED_FRAGMENTS: &[&str] = &["polakapi", "<<", "--follow", " -f ", "tail -f"];

/// Change the calling shell's state, so a subshell would swallow them.
const STATEFUL: &[&str] = &[
    "cd", "pushd", "popd", "export", "source", ".", "alias", "unalias", "unset", "set", "exit",
    "exec", "ulimit", "umask", "shopt", "trap", "declare", "typeset", "local", "readonly",
];

/// Wait for a person, a terminal or an event that never comes.
const INTERACTIVE: &[&str] = &[
    "sudo", "su", "vim", "vi", "nvim", "nano", "emacs", "less", "more", "man", "top", "htop",
    "btop", "watch", "ssh", "tmux", "screen", "fzf",
];

/// Always print a line or two; routing them only makes the call harder to read.
const QUIET: &[&str] = &[
    "pwd", "whoami", "hostname", "id", "date", "echo", "printf", "which", "type", "true", "false",
    "mkdir", "touch", "mv", "cp", "rm", "ln", "chmod", "sleep", "test", "[", "basename", "dirname",
    "realpath", "readlink", "kill",
];

const QUIET_GIT: &[&str] = &[
    "status",
    "add",
    "commit",
    "checkout",
    "switch",
    "branch",
    "stash",
    "rev-parse",
    "remote",
    "config",
    "tag",
    "restore",
    "reset",
    "init",
    "mv",
    "rm",
    "fetch",
    "push",
    "pull",
    "merge",
    "rebase",
    "cherry-pick",
    "worktree",
];

/// Print text whose exact wording matters: files, diffs, listings, API answers.
const EXACT: &[&str] = &[
    "cat", "head", "tail", "sed", "awk", "nl", "bat", "find", "fd", "tree", "ls", "rg", "grep",
    "ag", "gh", "curl", "wget", "jq", "yq", "diff", "xxd", "od", "strings", "column",
];

/// Build, test, lint and log output: its shape and its failures matter, not
/// every line.
const LOGS: &[&str] = &[
    "cargo",
    "npm",
    "pnpm",
    "yarn",
    "npx",
    "bun",
    "bunx",
    "deno",
    "pytest",
    "go",
    "make",
    "cmake",
    "ninja",
    "tsc",
    "eslint",
    "prettier",
    "vitest",
    "jest",
    "mocha",
    "playwright",
    "gradle",
    "gradlew",
    "mvn",
    "mvnw",
    "sbt",
    "dotnet",
    "swift",
    "xcodebuild",
    "flutter",
    "dart",
    "mix",
    "rake",
    "bundle",
    "composer",
    "pip",
    "pip3",
    "uv",
    "poetry",
    "tox",
    "ruff",
    "mypy",
    "terraform",
    "ansible-playbook",
    "docker",
    "kubectl",
    "journalctl",
    "dmesg",
];

pub fn classify_command(command: &str) -> Option<OutputKind> {
    classify(command).ok()
}

/// Like `classify_command`, but says why a command is left alone. The reason
/// goes to the diagnostics log, so "context mode did nothing" is never a
/// mystery.
pub fn classify(command: &str) -> Result<OutputKind, String> {
    classify_with(command, is_on_path)
}

pub fn classify_with(
    command: &str,
    is_program: impl Fn(&str) -> bool,
) -> Result<OutputKind, String> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Err("empty command".into());
    }
    let padded = format!(" {trimmed} ");
    if let Some(fragment) = BLOCKED_FRAGMENTS
        .iter()
        .find(|fragment| padded.contains(*fragment))
    {
        return Err(match *fragment {
            "polakapi" => "already goes through polakapi".into(),
            "<<" => "reads a heredoc".into(),
            _ => "follows output".into(),
        });
    }
    if trimmed.ends_with('&') || padded.contains(" & ") {
        return Err("runs in the background".into());
    }
    if trimmed.ends_with(" -f") {
        return Err("follows output".into());
    }
    let words: Vec<&str> = trimmed.split_whitespace().collect();
    if words.contains(&"<") {
        return Err("reads its input from a file".into());
    }
    if words.iter().any(|word| writes_stdout_to_file(word)) {
        return Err("writes its output to a file".into());
    }

    let segments: Vec<&str> = trimmed
        .split(['&', ';', '|', '\n'])
        .map(str::trim)
        .filter(|segment| !segment.is_empty())
        .collect();
    for segment in &segments {
        let name = program_name(segment);
        if STATEFUL.contains(&name) {
            return Err(format!("uses {name}"));
        }
        if INTERACTIVE.contains(&name) {
            return Err(format!("{name} is interactive"));
        }
    }
    let first = segments
        .first()
        .ok_or_else(|| "empty command".to_string())?;
    if segments.iter().all(|segment| is_quiet(segment)) {
        return Err(format!("{} prints little", program_name(first)));
    }
    if let Some(missing) = segments
        .iter()
        .map(|segment| program(segment))
        .find(|name| !name.is_empty() && !is_program(name))
    {
        return Err(format!("{missing} is not a program on PATH"));
    }
    Ok(kind_of(first))
}

/// The program's basename, for the diagnostics log: no path, arguments or
/// inline variables, which may carry secrets.
pub fn program_name(command: &str) -> &str {
    let program = program(command);
    program.rsplit(['/', '\\']).next().unwrap_or(program)
}

/// Shell syntax around a command; `for`, `case` and closers carry none.
const PREFIX_KEYWORDS: &[&str] = &[
    "if", "then", "else", "elif", "do", "while", "until", "!", "time", "{", "(",
];
const NO_PROGRAM_KEYWORDS: &[&str] = &["for", "case", "select", "done", "fi", "esac", "}", ")"];

fn words(segment: &str) -> impl Iterator<Item = &str> {
    segment
        .split_whitespace()
        .map(|word| word.trim_start_matches(['(', '{']))
        .filter(|word| !word.is_empty())
        .skip_while(|word| word.contains('=') || PREFIX_KEYWORDS.contains(word))
}

fn program(segment: &str) -> &str {
    match words(segment).next() {
        Some(word) if NO_PROGRAM_KEYWORDS.contains(&word) => "",
        Some(word) => word,
        None => "",
    }
}

fn arguments(segment: &str) -> Vec<&str> {
    words(segment).skip(1).collect()
}

/// `>`, `>>`, `1>` or `&>` followed by a file; `2>`, `>&2` and `2>&1` keep
/// stdout where it was.
fn writes_stdout_to_file(word: &str) -> bool {
    let target = word
        .strip_prefix("&>")
        .or_else(|| word.strip_prefix("1>"))
        .or_else(|| word.strip_prefix('>'));
    match target {
        Some(rest) => !rest.starts_with('&'),
        None => false,
    }
}

fn is_quiet(segment: &str) -> bool {
    let name = program_name(segment);
    if name == "git" {
        let args = arguments(segment);
        return args
            .iter()
            .find(|arg| !arg.starts_with('-'))
            .is_some_and(|sub| QUIET_GIT.contains(sub))
            && !args.contains(&"-v")
            && !args.contains(&"--verbose");
    }
    QUIET.contains(&name)
}

fn kind_of(segment: &str) -> OutputKind {
    let name = program_name(segment);
    if name == "git" {
        return OutputKind::Exact;
    }
    if EXACT.contains(&name) {
        OutputKind::Exact
    } else if LOGS.contains(&name) {
        OutputKind::Log
    } else {
        OutputKind::Auto
    }
}

/// Paths are taken as given; bare names must be a builtin or on PATH, which
/// rules out the agent's aliases and shell functions.
fn is_on_path(name: &str) -> bool {
    const BUILTINS: &[&str] = &[
        "echo", "printf", "test", "[", "true", "false", "type", "command",
    ];
    if name.contains('/') {
        return std::path::Path::new(name).exists();
    }
    if BUILTINS.contains(&name) {
        return true;
    }
    std::env::var_os("PATH").is_some_and(|path| {
        std::env::split_paths(&path).any(|dir| {
            let candidate = dir.join(name);
            candidate.is_file() || (cfg!(windows) && candidate.with_extension("exe").is_file())
        })
    })
}

pub fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

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

    fn route(command: &str) -> Result<OutputKind, String> {
        classify_with(command, |_| true)
    }

    fn routed(command: &str) -> Option<OutputKind> {
        route(command).ok()
    }

    #[test]
    fn a_skipped_command_comes_with_its_reason() {
        assert_eq!(route("cd src && cat main.rs").unwrap_err(), "uses cd");
        assert_eq!(route("git status").unwrap_err(), "git prints little");
        assert_eq!(route("vim notes.md").unwrap_err(), "vim is interactive");
        assert_eq!(
            classify_with("ll -a", |name| name != "ll").unwrap_err(),
            "ll is not a program on PATH"
        );
        assert!(route("tail -f app.log").unwrap_err().contains("follows"));
    }

    #[test]
    fn routes_text_whose_wording_matters_verbatim() {
        for command in [
            "git log --oneline",
            "git diff HEAD~3",
            "gh issue list --json title,body",
            "cat src/main.rs",
            "sed -n 1,200p src/main.rs",
            "find . -name '*.ts'",
            "grep -rn TODO src",
            "rg -n invoke src",
            "ls -la",
            "curl https://example.com/api",
            "git log | head -20",
        ] {
            assert_eq!(routed(command), Some(OutputKind::Exact), "{command}");
        }
    }

    #[test]
    fn routes_builds_tests_and_logs_as_logs() {
        for command in [
            "cargo test",
            "pnpm run build",
            "npx vitest run",
            "pytest -x",
            "go test ./...",
            "tsc --noEmit",
            "docker logs web",
            "journalctl -u nginx",
            "cargo clippy --all-targets 2>&1",
        ] {
            assert_eq!(routed(command), Some(OutputKind::Log), "{command}");
        }
    }

    #[test]
    fn anything_else_is_judged_by_what_it_prints() {
        assert_eq!(routed("python script.py"), Some(OutputKind::Auto));
        assert_eq!(routed("ps aux"), Some(OutputKind::Auto));
        assert_eq!(
            routed("for f in *.log; do wc -l $f; done"),
            Some(OutputKind::Auto)
        );
    }

    #[test]
    fn leaves_commands_that_always_print_little() {
        for command in [
            "",
            "pwd",
            "echo hi",
            "mkdir -p build",
            "git add . && git commit -m 'x'",
            "git status",
        ] {
            assert_eq!(routed(command), None, "{command:?}");
        }
        assert_eq!(
            routed("git add . && git diff --cached"),
            Some(OutputKind::Exact)
        );
    }

    #[test]
    fn never_reroutes_a_change_to_the_shell_itself() {
        // The subshell would swallow it and the agent's shell would not change.
        assert_eq!(routed("cd src && cat main.rs"), None);
        assert_eq!(routed("cat a.txt; cd /tmp"), None);
        assert_eq!(routed("export FOO=1 && cargo test"), None);
        assert_eq!(routed("source .env && npm test"), None);
        assert_eq!(routed("(cd src && ls -R)"), None);
    }

    #[test]
    fn never_reroutes_something_that_does_not_finish() {
        assert_eq!(routed("docker logs -f web"), None);
        assert_eq!(routed("kubectl logs --follow pod"), None);
        assert_eq!(routed("journalctl -f"), None);
        assert_eq!(routed("tail -f app.log"), None);
        assert_eq!(routed("cat big.log &"), None);
        assert_eq!(routed("npm run dev & sleep 2"), None);
        assert_eq!(routed("git log | less"), None);
    }

    #[test]
    fn leaves_output_that_goes_to_a_file() {
        assert_eq!(routed("git diff > patch.diff"), None);
        assert_eq!(routed("cargo build &>build.log"), None);
        assert_eq!(routed("sort < names.txt"), None);
        assert_eq!(routed("cargo test 2>/dev/null"), Some(OutputKind::Log));
        assert_eq!(routed("cargo test 2>&1"), Some(OutputKind::Log));
    }

    #[test]
    fn leaves_commands_that_may_prompt_or_are_already_routed() {
        assert_eq!(routed("sudo cat /etc/shadow"), None);
        assert_eq!(routed("'/bin/polakapi' ctx exec 'git log'"), None);
        assert_eq!(routed("cat <<EOF\nx\nEOF"), None);
    }

    #[test]
    fn env_assignments_do_not_hide_the_program() {
        assert_eq!(routed("GIT_PAGER=cat git log"), Some(OutputKind::Exact));
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
