use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

#[cfg(target_os = "windows")]
mod windows;

#[cfg(target_os = "windows")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum ProgramKind {
    Native,
    WindowsBatch,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ResolvedProgram {
    path: PathBuf,
    #[cfg(target_os = "windows")]
    kind: ProgramKind,
}

impl ResolvedProgram {
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    pub(crate) fn display_name(&self) -> String {
        self.path.to_string_lossy().into_owned()
    }
}

pub(crate) fn resolve_program(program: impl AsRef<OsStr>) -> Result<ResolvedProgram, String> {
    let program = program.as_ref();
    if program.is_empty() || program.to_string_lossy().contains('\0') {
        return Err("program name is empty or contains NUL".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        windows::resolve_program(program)
            .ok_or_else(|| format!("program not found in PATH: {}", program.to_string_lossy()))
    }

    #[cfg(not(target_os = "windows"))]
    {
        Ok(ResolvedProgram {
            path: PathBuf::from(program),
        })
    }
}

pub(crate) fn tokio_command(program: impl AsRef<OsStr>) -> Result<tokio::process::Command, String> {
    let program = program.as_ref();
    let resolved = resolve_program(program)?;

    #[cfg(target_os = "windows")]
    {
        windows::tokio_command(program, &resolved)
    }

    #[cfg(not(target_os = "windows"))]
    {
        Ok(tokio::process::Command::new(resolved.path))
    }
}

pub(crate) fn portable_command(
    program: &ResolvedProgram,
    args: &[String],
    supervise_tree: bool,
) -> Result<portable_pty::CommandBuilder, String> {
    #[cfg(target_os = "windows")]
    {
        windows::portable_command(program, args, supervise_tree)
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = supervise_tree;
        let mut command = portable_pty::CommandBuilder::new(&program.path);
        for arg in args {
            command.arg(arg);
        }
        Ok(command)
    }
}

#[cfg(target_os = "windows")]
pub fn run_windows_process_supervisor(args: &[OsString]) -> Option<i32> {
    windows::run_process_supervisor(args)
}

#[cfg(target_os = "windows")]
pub fn run_windows_batch_proxy(args: &[OsString]) -> Option<i32> {
    windows::run_batch_proxy(args)
}

pub(crate) fn external_path(path: &Path) -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        let value = path.to_string_lossy();
        if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{rest}"));
        }
        if let Some(rest) = value.strip_prefix(r"\\?\") {
            return PathBuf::from(rest);
        }
    }
    path.to_path_buf()
}

pub(crate) fn user_home_dir() -> Option<PathBuf> {
    home_dir_from_values(
        std::env::var_os("USERPROFILE"),
        std::env::var_os("HOME"),
        std::env::var_os("HOMEDRIVE"),
        std::env::var_os("HOMEPATH"),
    )
}

fn home_dir_from_values(
    profile: Option<OsString>,
    home: Option<OsString>,
    drive: Option<OsString>,
    home_path: Option<OsString>,
) -> Option<PathBuf> {
    let profile = nonempty_os_string(profile);
    let home = nonempty_os_string(home);

    #[cfg(target_os = "windows")]
    {
        profile.or(home).map(PathBuf::from).or_else(|| {
            let mut combined = nonempty_os_string(drive)?;
            combined.push(nonempty_os_string(home_path)?);
            Some(PathBuf::from(combined))
        })
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (drive, home_path);
        home.or(profile).map(PathBuf::from)
    }
}

fn nonempty_os_string(value: Option<OsString>) -> Option<OsString> {
    value.filter(|value| !value.is_empty() && !value.to_string_lossy().trim().is_empty())
}

#[cfg(all(test, target_os = "windows"))]
mod windows_tests {
    use super::*;

    #[test]
    fn windows_home_prefers_profile_and_discards_empty_values() {
        assert_eq!(
            home_dir_from_values(
                Some(OsString::from(r"C:\Users\tester")),
                Some(OsString::from(r"C:\msys-home")),
                None,
                None,
            ),
            Some(PathBuf::from(r"C:\Users\tester"))
        );
        assert_eq!(
            home_dir_from_values(
                Some(OsString::from("   ")),
                Some(OsString::from(r"C:\fallback")),
                None,
                None,
            ),
            Some(PathBuf::from(r"C:\fallback"))
        );
        assert_eq!(
            home_dir_from_values(
                None,
                None,
                Some(OsString::from("C:")),
                Some(OsString::from(r"\Users\tester")),
            ),
            Some(PathBuf::from(r"C:\Users\tester"))
        );
    }

    #[test]
    fn strips_windows_verbatim_prefixes_for_external_tools() {
        assert_eq!(
            external_path(Path::new(r"\\?\C:\code\polakapi")),
            PathBuf::from(r"C:\code\polakapi")
        );
        assert_eq!(
            external_path(Path::new(r"\\?\UNC\server\share\polakapi")),
            PathBuf::from(r"\\server\share\polakapi")
        );
    }
}
