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

fn basename(word: &str) -> &str {
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
    scan(line, 0)
}

fn scan(line: &str, depth: usize) -> Option<String> {
    if depth > MAX_DEPTH {
        return None;
    }
    let (tokens, nested) = lex(line);
    for inner in nested {
        if let Some(found) = scan(&inner, depth + 1) {
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
        if let Some(found) = scan_command(&words, depth) {
            return Some(found);
        }
    }
    None
}

fn scan_command(words: &[&str], depth: usize) -> Option<String> {
    let mut index = 0;
    while index < words.len() {
        let word = words[index];
        let name = basename(word);
        if is_assignment(word) || word.starts_with('-') || word.parse::<f64>().is_ok() {
            // `FOO=1 cmd`, a wrapper's flags (`nice -n 5`), `timeout 10 cmd`.
            index += 1;
            continue;
        }
        if ELEVATORS.contains(&name) {
            return Some(name.to_string());
        }
        if WRAPPERS.contains(&name) {
            index += 1;
            continue;
        }
        if SHELLS.contains(&name) {
            let script = words[index + 1..]
                .iter()
                .position(|arg| arg.starts_with('-') && !arg.starts_with("--") && arg.contains('c'))
                .and_then(|flag| words.get(index + 2 + flag));
            if let Some(script) = script {
                return scan(script, depth + 1);
            }
        }
        return None;
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
