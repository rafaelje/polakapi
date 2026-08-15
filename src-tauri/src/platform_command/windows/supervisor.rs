use std::ffi::{OsStr, OsString};
use std::path::Path;

use super::{classify_program, CommandInvocation};
use crate::platform_command::{ProgramKind, ResolvedProgram};

pub(super) const WINDOWS_BATCH_PROXY_ARG: &str = "__polakapi_windows_batch_proxy";
const WINDOWS_PROCESS_SUPERVISOR_ARG: &str = "__polakapi_windows_process_supervisor";

pub(super) fn tokio_command(
    invocation: CommandInvocation,
) -> Result<tokio::process::Command, String> {
    let proxy = std::env::current_exe()
        .map_err(|error| format!("could not resolve polakapi executable: {error}"))?;
    let mut command = tokio::process::Command::new(proxy);
    command.arg(WINDOWS_PROCESS_SUPERVISOR_ARG);
    command.arg(invocation.program);
    command.args(invocation.prefix_args);
    Ok(command)
}

pub(super) fn portable_command(
    invocation: &CommandInvocation,
) -> Result<portable_pty::CommandBuilder, String> {
    let proxy = std::env::current_exe()
        .map_err(|error| format!("could not resolve polakapi executable: {error}"))?;
    let mut command = portable_pty::CommandBuilder::new(proxy);
    command.arg(WINDOWS_PROCESS_SUPERVISOR_ARG);
    command.arg(&invocation.program);
    for arg in &invocation.prefix_args {
        command.arg(arg);
    }
    Ok(command)
}

pub(super) fn batch_proxy_command(
    program: &ResolvedProgram,
) -> Result<portable_pty::CommandBuilder, String> {
    let proxy = std::env::current_exe()
        .map_err(|error| format!("could not resolve polakapi executable: {error}"))?;
    let mut command = portable_pty::CommandBuilder::new(proxy);
    command.arg(WINDOWS_BATCH_PROXY_ARG);
    command.arg(&program.path);
    Ok(command)
}

pub(super) fn run_process_supervisor(args: &[OsString]) -> Option<i32> {
    if args.first().and_then(|arg| arg.to_str()) != Some(WINDOWS_PROCESS_SUPERVISOR_ARG) {
        return None;
    }

    let Some(program) = args.get(1) else {
        eprintln!("polakapi: missing supervised Windows program");
        return Some(2);
    };
    let program = Path::new(program);
    if !is_native_program(program) {
        eprintln!("polakapi: invalid supervised Windows program");
        return Some(2);
    }

    let job = match WindowsProcessJob::assign_current_process() {
        Ok(job) => job,
        Err(error) => {
            eprintln!("polakapi: could not create Windows process job: {error}");
            return Some(1);
        }
    };
    let status = std::process::Command::new(program)
        .args(&args[2..])
        .status();
    job.keep_until_process_exit();
    Some(exit_code(status, program))
}

pub(super) fn run_batch_proxy(args: &[OsString]) -> Option<i32> {
    if args.first().and_then(|arg| arg.to_str()) != Some(WINDOWS_BATCH_PROXY_ARG) {
        return None;
    }

    let Some(program) = args.get(1) else {
        eprintln!("polakapi: missing Windows batch program");
        return Some(2);
    };
    let program = Path::new(program);
    if !program.is_absolute() || classify_program(program) != ProgramKind::WindowsBatch {
        eprintln!("polakapi: invalid Windows batch program");
        return Some(2);
    }

    let job = match WindowsProcessJob::assign_current_process() {
        Ok(job) => job,
        Err(error) => {
            eprintln!("polakapi: could not create Windows process job: {error}");
            return Some(1);
        }
    };
    let status = std::process::Command::new(program)
        .args(&args[2..])
        .status();
    job.keep_until_process_exit();
    Some(exit_code(status, program))
}

fn exit_code(status: std::io::Result<std::process::ExitStatus>, program: &Path) -> i32 {
    match status {
        Ok(status) => status.code().unwrap_or(1),
        Err(error) => {
            eprintln!("polakapi: could not launch {}: {error}", program.display());
            1
        }
    }
}

fn is_native_program(path: &Path) -> bool {
    path.is_absolute()
        && path.is_file()
        && matches!(
            path.extension()
                .and_then(OsStr::to_str)
                .map(str::to_ascii_lowercase)
                .as_deref(),
            Some("exe" | "com")
        )
}

struct WindowsProcessJob {
    handle: windows_sys::Win32::Foundation::HANDLE,
}

impl WindowsProcessJob {
    fn assign_current_process() -> Result<Self, String> {
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };
        use windows_sys::Win32::System::Threading::GetCurrentProcess;

        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let job = Self { handle };
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                job.handle,
                JobObjectExtendedLimitInformation,
                std::ptr::from_ref(&limits).cast(),
                std::mem::size_of_val(&limits) as u32,
            )
        };
        if configured == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let assigned = unsafe { AssignProcessToJobObject(job.handle, GetCurrentProcess()) };
        if assigned == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        Ok(job)
    }

    fn keep_until_process_exit(self) {
        // Closing this handle while the supervisor is alive would terminate the supervisor too.
        std::mem::forget(self);
    }
}

impl Drop for WindowsProcessJob {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.handle);
        }
    }
}
