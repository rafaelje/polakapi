use super::privilege::{basename, program, walk};

// Commands that destroy data or disrupt the computer, on Linux, macOS and
// Windows (cmd and PowerShell). Telegram never runs one without Run / Cancel
// buttons, even when the user typed it. The rules lean on purpose towards
// asking too often: a needless tap is cheap, a lost folder is not.

const DELETES: &str = "deletes files or folders";
const OVERWRITES: &str = "moves or overwrites files";
const DISKS: &str = "erases or repartitions disks";
const PERMISSIONS: &str = "changes ownership or permissions";
const PROCESSES: &str = "stops processes";
const POWER: &str = "shuts down, restarts or logs off the computer";
const SERVICES: &str = "stops or changes system services";
const ACCOUNTS: &str = "changes user accounts";
const PACKAGES: &str = "uninstalls software";
const SECURITY: &str = "weakens system protection, the firewall or boot settings";
const GIT: &str = "can throw away git history or uncommitted work";
const REMOTE: &str = "deletes, stops or replaces remote or container resources";
const DATABASE: &str = "deletes or resets database data";
const PIPE_SHELL: &str = "pipes text straight into a shell or interpreter";

/// Cloud, container and infrastructure CLIs: any of these verbs is asked.
const REMOTE_CLIS: &[&str] = &[
    "aws",
    "gcloud",
    "gsutil",
    "az",
    "doctl",
    "fly",
    "flyctl",
    "heroku",
    "vercel",
    "netlify",
    "railway",
    "wrangler",
    "firebase",
    "supabase",
    "gh",
    "glab",
    "kubectl",
    "oc",
    "helm",
    "docker",
    "docker-compose",
    "podman",
    "podman-compose",
    "nerdctl",
    "terraform",
    "tofu",
    "pulumi",
    "vagrant",
    "multipass",
    "virsh",
    "vboxmanage",
    "lxc",
    "incus",
    "s3cmd",
    "mc",
    "b2",
    "eksctl",
    "minikube",
    "kind",
    "k3d",
    "stripe",
    "rclone",
    "coolify",
];
const REMOTE_VERBS: &[&str] = &[
    "rm",
    "rmi",
    "rb",
    "del",
    "delete",
    "destroy",
    "remove",
    "terminate",
    "purge",
    "prune",
    "kill",
    "stop",
    "down",
    "uninstall",
    "drain",
    "wipe",
    "reset",
    "erase",
    "undeploy",
    "apply",
    "replace",
    "rollback",
    "sync",
    "move",
    "mv",
    "cleanup",
    "deletefile",
    "rmdir",
    "rmdirs",
    "halt",
    "deprovision",
    "scale",
];
const SHELLS: &[&str] = &[
    "sh",
    "bash",
    "zsh",
    "dash",
    "ksh",
    "fish",
    "python",
    "python3",
    "perl",
    "ruby",
    "node",
    "php",
    "iex",
    "invoke-expression",
    "pwsh",
    "powershell",
    "cmd",
    "osascript",
];
const DATABASE_WORDS: &[&str] = &[
    "drop table",
    "drop database",
    "drop schema",
    "drop index",
    "drop view",
    "drop user",
    "drop role",
    "drop collection",
    "drop owned",
    "truncate ",
    "delete from",
    "dropdatabase(",
    ".drop(",
    "flushall",
    "flushdb",
    "db:drop",
    "db:reset",
    "db:wipe",
    "db:rollback",
    "migrate:fresh",
    "migrate:reset",
    "migrate:rollback",
    "migrate:refresh",
    "migrate reset",
    "--force-reset",
    "db reset",
    "manage.py flush",
    "dropdb",
    "dropuser",
    "deletemany(",
    "remove({",
];
const SAFE_TARGETS: &[&str] = &[
    "/dev/null",
    "/dev/stdout",
    "/dev/stderr",
    "/dev/tty",
    "nul",
    "$null",
];

/// Why a command line is destructive, if it is.
pub fn assess(line: &str) -> Option<String> {
    if let Some(reason) = line_rules(line) {
        return Some(reason.to_string());
    }
    let mut visit = |words: &[&str]| {
        redirect(words)
            .or_else(|| program(words).and_then(|(name, args)| check(&name, &args)))
            .map(str::to_string)
    };
    // Read once as a POSIX shell would, and once with Windows paths intact,
    // where `\` separates folders instead of escaping.
    walk(line, &mut visit).or_else(|| {
        line.contains('\\')
            .then(|| walk(&line.replace('\\', "/"), &mut visit))
            .flatten()
    })
}

fn line_rules(line: &str) -> Option<&'static str> {
    let lower = line.to_lowercase();
    if DATABASE_WORDS.iter().any(|word| lower.contains(word))
        || (lower.contains("alter table") && lower.contains(" drop "))
    {
        return Some(DATABASE);
    }
    let compact: String = lower.chars().filter(|c| !c.is_whitespace()).collect();
    if compact.contains(":(){") || compact.contains("<(curl") || compact.contains("<(wget") {
        return Some(PIPE_SHELL);
    }
    let piped_into_shell = lower.split('|').skip(1).any(|segment| {
        segment
            .split_whitespace()
            .find(|word| !matches!(*word, "sudo" | "doas" | "env" | "-e" | "-u" | "-s"))
            .map(|word| {
                let name = basename(word.trim_start_matches(['(', '{']));
                SHELLS.contains(&name.strip_suffix(".exe").unwrap_or(name))
            })
            .unwrap_or(false)
    });
    piped_into_shell.then_some(PIPE_SHELL)
}

/// `> file` and `>| file` replace a file's contents; `>>` only appends.
fn redirect(words: &[&str]) -> Option<&'static str> {
    for (index, word) in words.iter().enumerate() {
        let Some(at) = word.rfind('>') else {
            continue;
        };
        if word[..at].ends_with('>') || word.contains("->") || word.contains("=>") {
            continue;
        }
        let rest = word[at + 1..].trim_start_matches('|');
        let target = if rest.is_empty() {
            match words.get(index + 1) {
                Some(next) => *next,
                None => continue,
            }
        } else {
            rest
        };
        let target = target.to_lowercase();
        if target.starts_with('&')
            || target.starts_with("/dev/fd/")
            || SAFE_TARGETS.contains(&target.as_str())
        {
            continue;
        }
        return Some(OVERWRITES);
    }
    None
}

fn is_flag(arg: &str) -> bool {
    arg.starts_with('-') || (arg.starts_with('/') && arg.len() <= 3 && !arg[1..].contains('/'))
}

/// Short flags bundle (`-rf`), long ones do not.
fn has_short(args: &[String], letters: &[char]) -> bool {
    args.iter().any(|arg| {
        arg.starts_with('-')
            && !arg.starts_with("--")
            && arg.chars().skip(1).any(|c| letters.contains(&c))
    })
}

fn has_any(args: &[String], words: &[&str]) -> bool {
    // Uppercase patterns are exact (`-D` is not `-d`); lowercase ones also
    // match Windows' any-case flags (`/MIR`).
    args.iter().any(|arg| {
        words.iter().any(|word| {
            *word == arg
                || (!word.chars().any(char::is_uppercase) && word.eq_ignore_ascii_case(arg))
        })
    })
}

fn subcommands(args: &[String]) -> Vec<String> {
    args.iter()
        .filter(|arg| !is_flag(arg))
        .map(|arg| arg.to_lowercase())
        .collect()
}

fn first_sub(args: &[String]) -> String {
    subcommands(args).into_iter().next().unwrap_or_default()
}

fn check(name: &str, args: &[String]) -> Option<&'static str> {
    let sub = first_sub(args);
    let sub = sub.as_str();
    let subs = subcommands(args);
    let any_sub = |words: &[&str]| subs.iter().any(|arg| words.contains(&arg.as_str()));
    if let Some(reason) = powershell_verb(name) {
        return Some(reason);
    }
    let reason = match name {
        "rm" | "unlink" | "srm" | "shred" | "wipe" | "sdelete" | "del" | "erase" | "rmdir"
        | "rd" | "ri" | "trash" | "gio"
            if name != "gio" || sub == "trash" =>
        {
            DELETES
        }
        "mv" | "move" | "mi" | "rename" | "ren" => OVERWRITES,
        "cp" | "copy" | "xcopy" | "cpi" | "install"
            if has_short(args, &['f']) || has_any(args, &["--force", "/y", "-force"]) =>
        {
            OVERWRITES
        }
        "ln" if has_short(args, &['f']) || has_any(args, &["--force"]) => OVERWRITES,
        "truncate" | "tee"
            if name == "truncate" || !(has_short(args, &['a']) || has_any(args, &["--append"])) =>
        {
            if name == "tee" && subs.iter().all(|arg| arg.starts_with("/dev/")) {
                return None;
            }
            OVERWRITES
        }
        "sed" | "perl"
            if has_short(args, &['i']) || args.iter().any(|arg| arg.starts_with("--in-place")) =>
        {
            OVERWRITES
        }
        "dd" | "wipefs" | "mke2fs" | "mkswap" | "fdisk" | "sfdisk" | "gdisk" | "sgdisk"
        | "cfdisk" | "parted" | "blkdiscard" | "format" | "diskpart" | "lvremove" | "vgremove"
        | "pvremove" | "badblocks" | "hdparm" | "nvme" => DISKS,
        n if n.starts_with("mkfs") => DISKS,
        "zpool" | "zfs" if any_sub(&["destroy", "rollback", "labelclear"]) => DISKS,
        "cryptsetup" if any_sub(&["luksformat", "erase", "lukskillslot", "luksremovekey"]) => DISKS,
        "diskutil"
            if subs.iter().any(|arg| {
                [
                    "erase",
                    "zero",
                    "partition",
                    "reformat",
                    "delete",
                    "format",
                    "secureerase",
                    "split",
                    "merge",
                ]
                .iter()
                .any(|word| arg.contains(word))
            }) =>
        {
            DISKS
        }
        "find" if has_any(args, &["-delete", "-exec", "-execdir", "-ok", "-okdir"]) => DELETES,
        "rsync"
            if args
                .iter()
                .any(|arg| arg.starts_with("--delete") || arg == "--remove-source-files") =>
        {
            DELETES
        }
        "robocopy" if has_any(args, &["/mir", "/purge", "/move", "/mov"]) => DELETES,
        "cipher" if args.iter().any(|arg| arg.to_lowercase().starts_with("/w")) => DISKS,
        "chown" | "chgrp" | "takeown" | "icacls" | "cacls" | "setfacl" | "chattr" | "chflags" => {
            PERMISSIONS
        }
        "chmod"
            if has_short(args, &['R'])
                || has_any(args, &["--recursive"])
                || subs.iter().any(|arg| {
                    arg.starts_with('/')
                        || arg.starts_with('~')
                        || arg.contains("..")
                        || arg == "."
                        || arg == "*"
                        || arg.starts_with('0')
                        || arg.contains("777")
                        || arg.contains("-")
                }) =>
        {
            PERMISSIONS
        }
        "kill" | "killall" | "pkill" | "xkill" | "skill" | "taskkill" | "tskill" | "spps"
        | "fuser"
            if name != "fuser" || has_short(args, &['k']) =>
        {
            PROCESSES
        }
        "shutdown" | "reboot" | "poweroff" | "halt" | "logoff" | "logout" | "suspend" => POWER,
        "init" | "telinit" if any_sub(&["0", "1", "6", "s", "single"]) => POWER,
        "systemctl"
            if any_sub(&[
                "poweroff",
                "reboot",
                "halt",
                "kexec",
                "suspend",
                "hibernate",
                "hybrid-sleep",
                "soft-reboot",
                "rescue",
                "emergency",
                "stop",
                "disable",
                "mask",
                "kill",
                "isolate",
                "restart",
                "try-restart",
                "reload-or-restart",
                "default",
                "reset-failed",
                "clean",
                "freeze",
            ]) =>
        {
            SERVICES
        }
        "service" | "rc-service" | "sv" if any_sub(&["stop", "restart", "zap", "down", "kill"]) => {
            SERVICES
        }
        "launchctl"
            if any_sub(&[
                "unload", "bootout", "remove", "disable", "kill", "stop", "reboot",
            ]) =>
        {
            SERVICES
        }
        "sc" if any_sub(&["delete", "stop", "config", "failure", "pause"]) => SERVICES,
        "net" if any_sub(&["stop", "pause", "user", "localgroup", "share", "use"]) => SERVICES,
        "loginctl"
            if subs
                .iter()
                .any(|arg| arg.starts_with("terminate") || arg.starts_with("kill")) =>
        {
            POWER
        }
        "userdel" | "deluser" | "groupdel" | "delgroup" | "passwd" | "chpasswd" | "usermod"
        | "sysadminctl" | "dscl" | "pw" | "vipw" => ACCOUNTS,
        "crontab" if has_short(args, &['r']) => DELETES,
        "schtasks" if has_any(args, &["/delete", "/change"]) => SERVICES,
        "iptables" | "ip6tables" | "nft" | "ufw" | "firewall-cmd" | "pfctl" | "netsh"
        | "setenforce" | "csrutil" | "spctl" | "bcdedit" | "nvram" | "bootcfg" | "efibootmgr"
        | "grub-install" | "update-grub" | "auditctl" => SECURITY,
        "tmutil"
            if subs.iter().any(|arg| {
                arg.starts_with("delete") || arg == "disable" || arg == "thinlocalsnapshots"
            }) =>
        {
            DELETES
        }
        "vssadmin" | "wbadmin" if any_sub(&["delete", "resize"]) => DELETES,
        "reg" if any_sub(&["delete", "add", "import", "restore", "unload", "copy"]) => SECURITY,
        "regedit" | "fsutil" | "wevtutil" | "auditpol" => SECURITY,
        "wmic" if any_sub(&["delete", "call", "set"]) => SERVICES,
        "defaults" if any_sub(&["delete", "write", "import"]) => SECURITY,
        "security" if subs.iter().any(|arg| arg.starts_with("delete")) => SECURITY,
        "apt" | "apt-get" | "aptitude" | "nala"
            if any_sub(&[
                "remove",
                "purge",
                "autoremove",
                "autopurge",
                "full-upgrade",
                "dist-upgrade",
            ]) =>
        {
            PACKAGES
        }
        "dpkg" if has_short(args, &['r', 'P']) || has_any(args, &["--remove", "--purge"]) => {
            PACKAGES
        }
        "dnf" | "yum" | "microdnf" | "rpm"
            if any_sub(&["remove", "erase", "autoremove"]) || has_short(args, &['e']) =>
        {
            PACKAGES
        }
        "pacman" | "yay" | "paru"
            if args
                .iter()
                .any(|arg| arg.starts_with("-R") || arg == "--remove") =>
        {
            PACKAGES
        }
        "zypper" | "snap" | "flatpak" | "brew" | "port" | "npm" | "pnpm" | "yarn" | "bun"
        | "pip" | "pip3" | "uv" | "pipx" | "conda" | "mamba" | "gem" | "cargo" | "composer"
        | "choco" | "winget" | "scoop" | "apk" | "emerge" | "xbps-remove" | "mas" | "nix-env"
            if any_sub(&[
                "remove",
                "rm",
                "uninstall",
                "un",
                "r",
                "purge",
                "cleanup",
                "autoremove",
                "untap",
                "prune",
                "unlink",
                "del",
                "erase",
            ]) || (name == "nix-env" && has_short(args, &['e'])) =>
        {
            PACKAGES
        }
        "nix-collect-garbage" | "xbps-remove" => PACKAGES,
        "go" if sub == "clean" => DELETES,
        "git" => return git(args),
        n if REMOTE_CLIS.contains(&n) => {
            let verbs = subs.iter().any(|arg| {
                REMOTE_VERBS.contains(&arg.as_str())
                    || [
                        "delete",
                        "destroy",
                        "remove",
                        "terminate",
                        "purge",
                        "deregister",
                        "detach",
                        "revoke",
                        "disable",
                    ]
                    .iter()
                    .any(|verb| arg.starts_with(verb))
            });
            let flags = has_any(
                args,
                &["-destroy", "--force", "-f", "--prune", "--all", "-a"],
            ) && (n == "terraform" || n == "tofu" || n == "kubectl" || n == "helm");
            if verbs || flags || (n == "pulumi" && any_sub(&["up", "refresh"])) {
                REMOTE
            } else {
                return None;
            }
        }
        _ => return None,
    };
    Some(reason)
}

/// PowerShell verbs that remove, stop or reset things, whatever the noun.
fn powershell_verb(name: &str) -> Option<&'static str> {
    let (verb, noun) = name.split_once('-')?;
    if noun.is_empty() || !noun.chars().all(|c| c.is_ascii_alphanumeric()) {
        return None;
    }
    Some(match verb {
        "remove" | "clear" | "uninstall" | "unregister" | "dismount" => DELETES,
        "stop" | "suspend" | "disable" | "restart" => PROCESSES,
        "reset" | "initialize" | "format" | "set" | "move" | "rename" | "out" => OVERWRITES,
        _ => return None,
    })
}

fn git(args: &[String]) -> Option<&'static str> {
    let mut index = 0;
    while index < args.len() && args[index].starts_with('-') {
        let takes_value = matches!(
            args[index].as_str(),
            "-C" | "-c" | "--git-dir" | "--work-tree"
        );
        index += if takes_value { 2 } else { 1 };
    }
    let sub = args.get(index)?.to_lowercase();
    let rest = &args[index + 1..];
    let has = |words: &[&str]| has_any(rest, words);
    let short = |letters: &[char]| has_short(rest, letters);
    let risky = match sub.as_str() {
        "reset" | "rebase" | "filter-branch" | "filter-repo" | "rm" | "replace" | "prune"
        | "gc" | "update-ref" | "reflog" | "worktree" | "submodule" | "lfs" | "remote" => {
            match sub.as_str() {
                "reflog" => has(&["expire", "delete"]),
                "worktree" => has(&["remove", "prune"]),
                "submodule" => has(&["deinit"]),
                "lfs" => has(&["prune"]),
                "remote" => has(&["remove", "rm", "prune", "set-url"]),
                "gc" => rest.iter().any(|arg| arg.starts_with("--prune")),
                "update-ref" => short(&['d']),
                _ => true,
            }
        }
        "clean" => !(short(&['n']) || has(&["--dry-run"])),
        "checkout" => has(&["--", ".", "--force", "-B", "--ours", "--theirs"]) || short(&['f']),
        "switch" => has(&["--discard-changes", "--force", "-C", "--force-create"]) || short(&['f']),
        "restore" => !has(&["--staged", "-S"]) || has(&["--worktree", "-W"]),
        "push" => {
            has(&[
                "--force",
                "--force-with-lease",
                "--force-if-includes",
                "--delete",
                "--mirror",
                "--prune",
            ]) || rest
                .iter()
                .any(|arg| arg.starts_with("--force") || arg.starts_with('+') || arg.contains(":"))
                || short(&['f', 'd'])
        }
        "branch" => has(&["--delete", "--force", "-D", "-M", "-C"]) || short(&['d', 'f']),
        "tag" => has(&["--delete", "--force"]) || short(&['d', 'f']),
        "stash" => has(&["drop", "clear"]),
        "commit" => has(&["--amend"]),
        "merge" | "cherry-pick" | "revert" | "am" => has(&["--abort", "--quit", "--skip"]),
        "apply" => has(&["--reverse", "-R"]),
        "add" | "status" | "log" | "diff" | "show" | "fetch" | "pull" | "clone" | "init" => false,
        _ => false,
    };
    risky.then_some(GIT)
}

#[cfg(test)]
#[path = "danger_tests.rs"]
mod tests;
