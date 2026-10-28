// Finds commands that would run with elevated privileges, so the bot can refuse
// them unless the user allowed it in settings. This reads the command line the
// way a shell splits it: separators, pipes, subshells, command substitution,
// `VAR=value` prefixes, wrappers like `env` or `nohup`, and `sh -c "…"`
// scripts. It cannot see through aliases, functions or scripts that call sudo
// themselves; the settings help says so.

const ELEVATORS: &[&str] = &["sudo", "doas", "su", "pkexec", "run0", "sudoedit"];
const WRAPPERS: &[&str] = &[
    "env", "command", "exec", "nohup", "time", "nice", "ionice", "stdbuf", "timeout", "xargs",
    "setsid", "chrt", "builtin", "eval",
];
const SHELLS: &[&str] = &["sh", "bash", "zsh", "dash", "ksh", "fish"];
const MAX_DEPTH: usize = 4;

#[derive(Debug, Clone, PartialEq)]
enum Token {
    Word(String),
    Separator,
}

/// Splits like a shell: quotes group, separators break commands. The text of
/// `$( … )` and backticks is returned separately: it runs too, even inside
/// double quotes.
fn lex(line: &str) -> (Vec<Token>, Vec<String>) {
    let chars: Vec<char> = line.chars().collect();
    let mut tokens = Vec::new();
    let mut nested = Vec::new();
    let mut word = String::new();
    let mut has_word = false;
    let mut i = 0;
    let flush = |word: &mut String, has_word: &mut bool, tokens: &mut Vec<Token>| {
        if *has_word {
            tokens.push(Token::Word(std::mem::take(word)));
            *has_word = false;
        }
    };
    while i < chars.len() {
        let c = chars[i];
        match c {
            '\\' if i + 1 < chars.len() => {
                word.push(chars[i + 1]);
                has_word = true;
                i += 2;
                continue;
            }
            '\'' => {
                has_word = true;
                i += 1;
                while i < chars.len() && chars[i] != '\'' {
                    word.push(chars[i]);
                    i += 1;
                }
            }
            '"' => {
                has_word = true;
                i += 1;
                while i < chars.len() && chars[i] != '"' {
                    if chars[i] == '\\' && i + 1 < chars.len() {
                        word.push(chars[i + 1]);
                        i += 2;
                        continue;
                    }
                    if let Some((inner, end)) = substitution(&chars, i) {
                        nested.push(inner);
                        i = end;
                        continue;
                    }
                    word.push(chars[i]);
                    i += 1;
                }
            }
            '$' | '`' if substitution(&chars, i).is_some() => {
                let (inner, end) = substitution(&chars, i).unwrap_or_default();
                nested.push(inner);
                flush(&mut word, &mut has_word, &mut tokens);
                tokens.push(Token::Separator);
                i = end;
                continue;
            }
            ';' | '&' | '|' | '(' | ')' | '{' | '}' | '\n' | '!' => {
                flush(&mut word, &mut has_word, &mut tokens);
                tokens.push(Token::Separator);
            }
            c if c.is_whitespace() => flush(&mut word, &mut has_word, &mut tokens),
            c => {
                word.push(c);
                has_word = true;
            }
        }
        i += 1;
    }
    flush(&mut word, &mut has_word, &mut tokens);
    (tokens, nested)
}

/// `$( … )` or `` ` … ` `` starting at `start`: the inner text and the index
/// after it.
fn substitution(chars: &[char], start: usize) -> Option<(String, usize)> {
    if chars[start] == '`' {
        let end = (start + 1..chars.len()).find(|&i| chars[i] == '`')?;
        return Some((chars[start + 1..end].iter().collect(), end + 1));
    }
    if chars[start] != '$' || chars.get(start + 1) != Some(&'(') {
        return None;
    }
    let mut depth = 0;
    for i in start + 1..chars.len() {
        match chars[i] {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 {
                    return Some((chars[start + 2..i].iter().collect(), i + 1));
                }
            }
            _ => {}
        }
    }
    Some((chars[start + 2..].iter().collect(), chars.len()))
}

pub fn basename(word: &str) -> &str {
    word.rsplit(['/', '\\']).next().unwrap_or(word)
}

fn is_assignment(word: &str) -> bool {
    match word.split_once('=') {
        Some((name, _)) => {
            !name.is_empty()
                && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
                && !name.starts_with(|c: char| c.is_ascii_digit())
        }
        None => false,
    }
}

/// The elevating program a command line would run, if any.
pub fn elevation(line: &str) -> Option<String> {
    walk(line, &mut |words| {
        let program = words
            .iter()
            .map(|word| basename(word))
            .find(|word| !is_prefix(word))?;
        ELEVATORS.contains(&program).then(|| program.to_string())
    })
}

/// Words that come before the program: `FOO=1`, a wrapper and its flags
/// (`nice -n 5`), `timeout 10`.
fn is_prefix(word: &str) -> bool {
    is_assignment(word)
        || word.starts_with('-')
        || word.parse::<f64>().is_ok()
        || WRAPPERS.contains(&word)
}

/// Calls `visit` with the words of every simple command `line` would run:
/// each part of a list or pipeline, command substitutions, and the scripts
/// of `sh -c`, `cmd /c` and `powershell -Command`. The first answer wins.
pub fn walk(line: &str, visit: &mut dyn FnMut(&[&str]) -> Option<String>) -> Option<String> {
    walk_at(line, 0, visit)
}

fn walk_at(
    line: &str,
    depth: usize,
    visit: &mut dyn FnMut(&[&str]) -> Option<String>,
) -> Option<String> {
    if depth > MAX_DEPTH {
        return None;
    }
    let (tokens, nested) = lex(line);
    for inner in nested {
        if let Some(found) = walk_at(&inner, depth + 1, visit) {
            return Some(found);
        }
    }
    for segment in tokens.split(|token| *token == Token::Separator) {
        let words: Vec<&str> = segment
            .iter()
            .filter_map(|token| match token {
                Token::Word(word) => Some(word.as_str()),
                Token::Separator => None,
            })
            .collect();
        if words.is_empty() {
            continue;
        }
        if let Some(found) = visit(&words) {
            return Some(found);
        }
        if let Some(script) = inner_script(&words) {
            if let Some(found) = walk_at(&script, depth + 1, visit) {
                return Some(found);
            }
        }
    }
    None
}

/// The program of a simple command, past assignments, wrappers and
/// elevators, with what follows it. Lowercase and without `.exe`, so Windows
/// names compare too.
pub fn program(words: &[&str]) -> Option<(String, Vec<String>)> {
    let mut index = 0;
    while index < words.len() {
        let name = program_name(words[index]);
        if is_prefix(&name) {
            index += 1;
            continue;
        }
        if ELEVATORS.contains(&name.as_str()) {
            index += 1;
            // `sudo -u root cmd`: flags that take a value.
            while index < words.len() && words[index].starts_with('-') {
                let takes_value = matches!(words[index], "-u" | "-g" | "-C" | "-h" | "-p" | "-U");
                index += if takes_value { 2 } else { 1 };
            }
            continue;
        }
        let rest = words[index + 1..]
            .iter()
            .map(|word| word.to_string())
            .collect();
        return Some((name, rest));
    }
    None
}

fn program_name(word: &str) -> String {
    let name = basename(word).to_lowercase();
    name.strip_suffix(".exe")
        .map(str::to_string)
        .unwrap_or(name)
}

fn inner_script(words: &[&str]) -> Option<String> {
    let (name, rest) = program(words)?;
    let is_flag = |arg: &&String, flags: &[&str]| flags.contains(&arg.to_lowercase().as_str());
    let after = |position: usize| -> Option<String> {
        let tail = &rest[position + 1..];
        (!tail.is_empty()).then(|| tail.join(" "))
    };
    if SHELLS.contains(&name.as_str()) {
        let flag = rest
            .iter()
            .position(|arg| arg.starts_with('-') && !arg.starts_with("--") && arg.contains('c'))?;
        return rest.get(flag + 1).cloned();
    }
    if name == "cmd" {
        return after(rest.iter().position(|arg| is_flag(&arg, &["/c", "/k"]))?);
    }
    if name == "powershell" || name == "pwsh" {
        let flag = rest
            .iter()
            .position(|arg| is_flag(&arg, &["-command", "-c", "/c", "/command"]));
        return match flag {
            Some(position) => after(position),
            None => (!rest.is_empty() && !rest[0].starts_with('-')).then(|| rest.join(" ")),
        };
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_elevation_anywhere_a_command_can_start() {
        for line in [
            "sudo apt update",
            "  sudo -E make install",
            "/usr/bin/sudo ls",
            "cd /etc && sudo vim hosts",
            "make; doas make install",
            "true || pkexec reboot",
            "cat x | sudo tee /etc/x",
            "FOO=1 BAR=2 sudo env",
            "env FOO=1 sudo ls",
            "nohup sudo service x restart &",
            "timeout 10 sudo ls",
            "nice -n 5 sudo ls",
            "(sudo ls)",
            "{ sudo ls; }",
            "echo $(sudo cat /etc/shadow)",
            "echo \"$(sudo whoami)\"",
            "echo `sudo id`",
            "bash -c 'sudo rm -rf /tmp/x'",
            "sh -lc \"cd /; sudo ls\"",
            "su -",
            "run0 systemctl restart x",
            "s\\udo ls",
            "'sudo' ls",
            "xargs sudo rm < list",
        ] {
            assert!(elevation(line).is_some(), "missed: {line}");
        }
    }

    #[test]
    fn leaves_ordinary_commands_alone() {
        for line in [
            "git status",
            "git commit -m \"fix sudo docs\"",
            "echo sudo",
            "grep -r sudo .",
            "cat sudoers.md",
            "ls ~/.sudo_as_admin_successful",
            "npm run sudo-check",
            "FOO=sudo make",
            "bash -c 'echo sudo'",
            "",
        ] {
            assert_eq!(elevation(line), None, "false positive: {line}");
        }
    }

    #[test]
    fn names_the_program() {
        assert_eq!(elevation("cd x && doas ls").as_deref(), Some("doas"));
    }
}
