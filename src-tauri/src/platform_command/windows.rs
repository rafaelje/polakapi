mod supervisor;

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

use super::{ProgramKind, ResolvedProgram};

#[derive(Clone, Debug, Eq, PartialEq)]
struct CommandInvocation {
    program: PathBuf,
    prefix_args: Vec<OsString>,
}

pub(super) fn resolve_program(program: &OsStr) -> Option<ResolvedProgram> {
    let path = Path::new(program);
    let extensions = windows_executable_extensions(std::env::var_os("PATHEXT").as_deref());

    if is_qualified(path) {
        return resolve_qualified_program(path, &extensions);
    }

    let directories = windows_search_directories();
    resolve_program_in(program, &directories, &extensions)
}

pub(super) fn tokio_command(
    logical_name: &OsStr,
    resolved: &ResolvedProgram,
) -> Result<tokio::process::Command, String> {
    let invocation = resolve_cli_invocation(logical_name, resolved)?;
    supervisor::tokio_command(invocation)
}

pub(super) fn portable_command(
    program: &ResolvedProgram,
    args: &[String],
    supervise_tree: bool,
) -> Result<portable_pty::CommandBuilder, String> {
    let mut command = if supervise_tree {
        let logical_name = program
            .path
            .file_stem()
            .unwrap_or_else(|| program.path.as_os_str());
        match resolve_cli_invocation(logical_name, program) {
            Ok(invocation) => supervisor::portable_command(&invocation)?,
            Err(_) if program.kind == ProgramKind::WindowsBatch => {
                supervisor::batch_proxy_command(program)?
            }
            Err(error) => return Err(error),
        }
    } else if program.kind == ProgramKind::WindowsBatch {
        supervisor::batch_proxy_command(program)?
    } else {
        portable_pty::CommandBuilder::new(&program.path)
    };

    for arg in args {
        command.arg(arg);
    }
    Ok(command)
}

pub(super) fn run_process_supervisor(args: &[OsString]) -> Option<i32> {
    supervisor::run_process_supervisor(args)
}

pub(super) fn run_batch_proxy(args: &[OsString]) -> Option<i32> {
    supervisor::run_batch_proxy(args)
}

fn resolve_cli_invocation(
    logical_name: &OsStr,
    resolved: &ResolvedProgram,
) -> Result<CommandInvocation, String> {
    if resolved.kind == ProgramKind::Native {
        return Ok(CommandInvocation {
            program: resolved.path.clone(),
            prefix_args: Vec::new(),
        });
    }

    let cli_name = Path::new(logical_name)
        .file_stem()
        .and_then(OsStr::to_str)
        .ok_or_else(|| "CLI name is not valid Unicode".to_string())?;
    let target = read_npm_cmd_shim_target(&resolved.path, cli_name)?;
    match target
        .extension()
        .and_then(OsStr::to_str)
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("exe" | "com") if has_pe_header(&target) => Ok(CommandInvocation {
            program: target,
            prefix_args: Vec::new(),
        }),
        Some("js" | "cjs" | "mjs") if has_node_shebang(&target) => {
            let node = resolve_node_for_shim(&resolved.path)?;
            Ok(CommandInvocation {
                program: node,
                prefix_args: vec![target.into_os_string()],
            })
        }
        _ => Err(format!(
            "unsupported Windows CLI shim target: {}",
            target.display()
        )),
    }
}

fn read_npm_cmd_shim_target(shim: &Path, cli_name: &str) -> Result<PathBuf, String> {
    const MAX_SHIM_BYTES: u64 = 64 * 1024;

    let metadata = std::fs::metadata(shim)
        .map_err(|error| format!("could not inspect {}: {error}", shim.display()))?;
    if metadata.len() > MAX_SHIM_BYTES {
        return Err(format!("Windows CLI shim is too large: {}", shim.display()));
    }
    let contents = std::fs::read_to_string(shim)
        .map_err(|error| format!("could not read {}: {error}", shim.display()))?;
    if contents.contains('\0') {
        return Err(format!("Windows CLI shim contains NUL: {}", shim.display()));
    }
    let shim_root = shim
        .parent()
        .ok_or_else(|| format!("Windows CLI shim has no parent: {}", shim.display()))?
        .canonicalize()
        .map_err(|error| format!("could not resolve shim directory: {error}"))?;

    for line in contents.lines().filter(|line| line.contains("%*")) {
        for token in quoted_tokens(line) {
            let Some(candidate) = expand_cmd_shim_path(token, &shim_root) else {
                continue;
            };
            let Ok(candidate) = candidate.canonicalize() else {
                continue;
            };
            if !candidate.starts_with(&shim_root) || !candidate.is_file() {
                continue;
            }
            if package_bin_matches(&candidate, &shim_root, cli_name) {
                return Ok(candidate);
            }
        }
    }

    Err(format!(
        "could not resolve npm entrypoint from Windows CLI shim: {}",
        shim.display()
    ))
}

fn quoted_tokens(line: &str) -> Vec<&str> {
    let mut tokens = Vec::new();
    let mut rest = line;
    while let Some(start) = rest.find('"') {
        rest = &rest[start + 1..];
        let Some(end) = rest.find('"') else {
            break;
        };
        tokens.push(&rest[..end]);
        rest = &rest[end + 1..];
    }
    tokens
}

fn expand_cmd_shim_path(token: &str, shim_root: &Path) -> Option<PathBuf> {
    let lower = token.to_ascii_lowercase();
    let rest = if lower.starts_with("%dp0%") || lower.starts_with("%~dp0") {
        &token[5..]
    } else {
        return None;
    };
    if rest.contains('%') || rest.contains('\0') {
        return None;
    }
    Some(shim_root.join(rest.trim_start_matches(['/', '\\'])))
}

fn package_bin_matches(target: &Path, shim_root: &Path, cli_name: &str) -> bool {
    for package_root in target.ancestors().skip(1) {
        if !package_root.starts_with(shim_root) {
            break;
        }
        let package_json = package_root.join("package.json");
        if !package_json.is_file() {
            continue;
        }
        let Ok(contents) = std::fs::read_to_string(&package_json) else {
            continue;
        };
        let Ok(root) = serde_json::from_str::<serde_json::Value>(&contents) else {
            continue;
        };
        let bin_path = match root.get("bin") {
            Some(serde_json::Value::String(path)) => Some(path.as_str()),
            Some(serde_json::Value::Object(entries)) => {
                entries.get(cli_name).and_then(serde_json::Value::as_str)
            }
            _ => None,
        };
        let Some(bin_path) = bin_path else {
            continue;
        };
        let Ok(declared_target) = package_root.join(bin_path).canonicalize() else {
            continue;
        };
        if declared_target == target {
            return true;
        }
    }
    false
}

fn resolve_node_for_shim(shim: &Path) -> Result<PathBuf, String> {
    if let Some(root) = shim.parent() {
        let local_node = root.join("node.exe");
        if local_node.is_file() && has_pe_header(&local_node) {
            return local_node
                .canonicalize()
                .map_err(|error| format!("could not resolve local node.exe: {error}"));
        }
    }
    let node = resolve_program(OsStr::new("node.exe"))
        .filter(|program| program.kind == ProgramKind::Native && has_pe_header(&program.path))
        .ok_or_else(|| "native node.exe not found in PATH".to_string())?;
    Ok(node.path)
}

fn has_pe_header(path: &Path) -> bool {
    use std::io::Read;

    let Ok(mut file) = std::fs::File::open(path) else {
        return false;
    };
    let mut header = [0u8; 2];
    file.read_exact(&mut header).is_ok() && header == *b"MZ"
}

fn has_node_shebang(path: &Path) -> bool {
    use std::io::BufRead;

    let Ok(file) = std::fs::File::open(path) else {
        return false;
    };
    let mut first_line = String::new();
    if std::io::BufReader::new(file)
        .read_line(&mut first_line)
        .is_err()
    {
        return false;
    }
    matches!(
        first_line.trim_end(),
        "#!/usr/bin/env node" | "#!/usr/bin/node" | "#!node"
    )
}

fn resolve_qualified_program(program: &Path, extensions: &[OsString]) -> Option<ResolvedProgram> {
    if program.extension().is_some() {
        return program.is_file().then(|| resolved(program.to_path_buf()));
    }

    for extension in extensions {
        let candidate = append_extension(program.as_os_str(), extension);
        if candidate.is_file() {
            return Some(resolved(candidate));
        }
    }
    program.is_file().then(|| resolved(program.to_path_buf()))
}

fn resolve_program_in(
    program: &OsStr,
    directories: &[PathBuf],
    extensions: &[OsString],
) -> Option<ResolvedProgram> {
    let path = Path::new(program);
    if path.extension().is_some() {
        return directories.iter().find_map(|directory| {
            let candidate = directory.join(path);
            candidate.is_file().then(|| resolved(candidate))
        });
    }

    for directory in directories {
        for extension in extensions {
            let candidate = directory.join(append_extension(program, extension));
            if candidate.is_file() {
                return Some(resolved(candidate));
            }
        }
    }

    directories.iter().find_map(|directory| {
        let candidate = directory.join(path);
        candidate.is_file().then(|| resolved(candidate))
    })
}

fn windows_search_directories() -> Vec<PathBuf> {
    let mut directories = Vec::new();
    if let Ok(executable) = std::env::current_exe() {
        if let Some(parent) = executable.parent() {
            directories.push(parent.to_path_buf());
        }
    }
    if let Some(root) = std::env::var_os("SystemRoot") {
        let root = PathBuf::from(root);
        directories.push(root.join("System32"));
        directories.push(root);
    }
    if let Some(path) = std::env::var_os("PATH") {
        directories.extend(std::env::split_paths(&path));
    }
    directories
}

fn windows_executable_extensions(value: Option<&OsStr>) -> Vec<OsString> {
    let raw = value
        .map(|value| value.to_string_lossy().into_owned())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| ".COM;.EXE;.BAT;.CMD".to_string());
    raw.split(';')
        .map(str::trim)
        .filter(|extension| {
            matches!(
                extension.to_ascii_uppercase().as_str(),
                ".COM" | ".EXE" | ".BAT" | ".CMD"
            )
        })
        .map(|extension| OsString::from(extension.to_ascii_lowercase()))
        .collect()
}

fn append_extension(program: &OsStr, extension: &OsStr) -> PathBuf {
    let mut value = program.to_os_string();
    value.push(extension);
    PathBuf::from(value)
}

fn is_qualified(path: &Path) -> bool {
    path.is_absolute() || path.components().count() > 1
}

fn resolved(path: PathBuf) -> ResolvedProgram {
    let kind = classify_program(&path);
    ResolvedProgram { path, kind }
}

fn classify_program(path: &Path) -> ProgramKind {
    match path
        .extension()
        .and_then(OsStr::to_str)
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("bat" | "cmd") => ProgramKind::WindowsBatch,
        _ => ProgramKind::Native,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_cmd_before_an_extensionless_npm_shim() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("claude"), "#!/bin/sh\n").unwrap();
        std::fs::write(directory.path().join("claude.cmd"), "@echo off\r\n").unwrap();

        let resolved = resolve_program_in(
            OsStr::new("claude"),
            &[directory.path().to_path_buf()],
            &windows_executable_extensions(Some(OsStr::new(".EXE;.CMD"))),
        )
        .unwrap();

        assert_eq!(resolved.path(), directory.path().join("claude.cmd"));
        assert_eq!(resolved.kind, ProgramKind::WindowsBatch);
    }

    #[test]
    fn respects_pathext_order_for_native_and_batch_commands() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("tool.exe"), []).unwrap();
        std::fs::write(directory.path().join("tool.cmd"), []).unwrap();

        let resolved = resolve_program_in(
            OsStr::new("tool"),
            &[directory.path().to_path_buf()],
            &windows_executable_extensions(Some(OsStr::new(".CMD;.EXE"))),
        )
        .unwrap();

        assert_eq!(resolved.path(), directory.path().join("tool.cmd"));
    }

    #[test]
    fn portable_batch_commands_use_the_internal_proxy() {
        let program = ResolvedProgram {
            path: PathBuf::from(r"C:\Program Files\tool.cmd"),
            kind: ProgramKind::WindowsBatch,
        };
        let command =
            portable_command(&program, &["--flag".to_string(), "a b".to_string()], false).unwrap();
        let argv = command.get_argv();

        assert_eq!(argv[1], supervisor::WINDOWS_BATCH_PROXY_ARG);
        assert_eq!(argv[2], program.path);
        assert_eq!(argv[3], "--flag");
        assert_eq!(argv[4], "a b");
    }

    #[test]
    fn unwraps_native_npm_cmd_shims() {
        let directory = tempfile::tempdir().unwrap();
        let package = directory.path().join("node_modules").join("example-cli");
        let executable = package.join("bin").join("claude.exe");
        std::fs::create_dir_all(executable.parent().unwrap()).unwrap();
        std::fs::write(&executable, b"MZfixture").unwrap();
        std::fs::write(
            package.join("package.json"),
            r#"{"bin":{"claude":"bin/claude.exe"}}"#,
        )
        .unwrap();
        let shim = directory.path().join("claude.cmd");
        std::fs::write(
            &shim,
            "@echo off\r\n\"%dp0%\\node_modules\\example-cli\\bin\\claude.exe\" %*\r\n",
        )
        .unwrap();
        let resolved = ResolvedProgram {
            path: shim,
            kind: ProgramKind::WindowsBatch,
        };

        let invocation = resolve_cli_invocation(OsStr::new("claude"), &resolved).unwrap();

        assert_eq!(invocation.program, executable.canonicalize().unwrap());
        assert!(invocation.prefix_args.is_empty());
    }

    #[test]
    fn unwraps_node_npm_cmd_shims() {
        let directory = tempfile::tempdir().unwrap();
        let package = directory.path().join("node_modules").join("example-cli");
        let entrypoint = package.join("bin").join("codex.js");
        std::fs::create_dir_all(entrypoint.parent().unwrap()).unwrap();
        std::fs::write(&entrypoint, "#!/usr/bin/env node\n").unwrap();
        std::fs::write(
            package.join("package.json"),
            r#"{"bin":{"codex":"bin/codex.js"}}"#,
        )
        .unwrap();
        let node = directory.path().join("node.exe");
        std::fs::write(&node, b"MZfixture").unwrap();
        let shim = directory.path().join("codex.cmd");
        std::fs::write(
            &shim,
            "@echo off\r\n\"%_prog%\" \"%dp0%\\node_modules\\example-cli\\bin\\codex.js\" %*\r\n",
        )
        .unwrap();
        let resolved = ResolvedProgram {
            path: shim,
            kind: ProgramKind::WindowsBatch,
        };

        let invocation = resolve_cli_invocation(OsStr::new("codex"), &resolved).unwrap();

        assert_eq!(invocation.program, node.canonicalize().unwrap());
        assert_eq!(
            invocation.prefix_args,
            [entrypoint.canonicalize().unwrap().into_os_string()]
        );
    }
}
