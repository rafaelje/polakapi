#![cfg(target_os = "windows")]

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows_sys::Win32::System::Threading::{
    OpenProcess, TerminateProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
};

const SUPERVISOR_ARG: &str = "__polakapi_windows_process_supervisor";

struct ChildGuard(Child);

impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

struct ProcessGuard(u32);

impl Drop for ProcessGuard {
    fn drop(&mut self) {
        let handle = unsafe { OpenProcess(PROCESS_TERMINATE, 0, self.0) };
        if !handle.is_null() {
            unsafe {
                TerminateProcess(handle, 1);
                CloseHandle(handle);
            }
        }
    }
}

#[test]
fn supervisor_preserves_crlf_arguments_without_cmd() {
    let directory = tempfile::tempdir().unwrap();
    let script = directory.path().join("write-argument.js");
    let output = directory.path().join("argument.txt");
    std::fs::write(
        &script,
        "const fs = require('node:fs');\nfs.writeFileSync(process.argv[2], process.argv[3], 'utf8');\n",
    )
    .unwrap();
    let prompt = "first line\r\nsecond & \"quoted\" ! café";

    let status = Command::new(env!("CARGO_BIN_EXE_polakapi"))
        .arg(SUPERVISOR_ARG)
        .arg(node_executable())
        .arg(&script)
        .arg(&output)
        .arg(prompt)
        .status()
        .unwrap();

    assert!(status.success());
    assert_eq!(std::fs::read_to_string(output).unwrap(), prompt);
}

#[test]
fn killing_supervisor_terminates_descendant_processes() {
    let directory = tempfile::tempdir().unwrap();
    let parent_script = directory.path().join("parent.js");
    let child_script = directory.path().join("child.js");
    let pid_file = directory.path().join("child.pid");
    std::fs::write(
        &parent_script,
        "const fs = require('node:fs');\nconst { spawn } = require('node:child_process');\nconst child = spawn(process.execPath, [process.argv[2]], { stdio: 'ignore' });\nfs.writeFileSync(process.argv[3], String(child.pid));\nsetInterval(() => {}, 1000);\n",
    )
    .unwrap();
    std::fs::write(&child_script, "setInterval(() => {}, 1000);\n").unwrap();

    let child = Command::new(env!("CARGO_BIN_EXE_polakapi"))
        .arg(SUPERVISOR_ARG)
        .arg(node_executable())
        .arg(&parent_script)
        .arg(&child_script)
        .arg(&pid_file)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut supervisor = ChildGuard(child);
    let pid = wait_for_pid(&pid_file, Duration::from_secs(10));
    let descendant = ProcessGuard(pid);
    assert!(process_is_running(pid));

    supervisor.0.kill().unwrap();
    supervisor.0.wait().unwrap();

    assert!(wait_for_process_exit(pid, Duration::from_secs(5)));
    std::mem::forget(descendant);
}

fn node_executable() -> PathBuf {
    let output = Command::new("where.exe")
        .arg("node.exe")
        .output()
        .expect("where.exe should be available");
    assert!(output.status.success(), "node.exe must be installed");
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .map(PathBuf::from)
        .find(|path| path.is_file())
        .expect("where.exe did not return a node.exe path")
        .canonicalize()
        .unwrap()
}

fn wait_for_pid(path: &Path, timeout: Duration) -> u32 {
    let deadline = Instant::now() + timeout;
    loop {
        if let Ok(value) = std::fs::read_to_string(path) {
            if let Ok(pid) = value.trim().parse() {
                return pid;
            }
        }
        assert!(Instant::now() < deadline, "timed out waiting for child PID");
        std::thread::sleep(Duration::from_millis(25));
    }
}

fn process_is_running(pid: u32) -> bool {
    let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
    if handle.is_null() {
        return false;
    }
    let result = unsafe { WaitForSingleObject(handle, 0) };
    unsafe {
        CloseHandle(handle);
    }
    result == WAIT_TIMEOUT
}

fn wait_for_process_exit(pid: u32, timeout: Duration) -> bool {
    let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
    if handle.is_null() {
        return true;
    }
    let millis = timeout.as_millis().min(u32::MAX as u128) as u32;
    let result = unsafe { WaitForSingleObject(handle, millis) };
    unsafe {
        CloseHandle(handle);
    }
    result == WAIT_OBJECT_0
}
