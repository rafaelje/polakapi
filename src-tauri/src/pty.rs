use parking_lot::Mutex;
use portable_pty::{Child, CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

pub struct PtySession {
    pub writer: Box<dyn Write + Send>,
    pub master: Box<dyn MasterPty + Send>,
    pub child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct PtyStore {
    pub sessions: Mutex<HashMap<String, PtySession>>,
}

#[derive(Clone, Serialize)]
pub struct PtyDataPayload {
    pub id: String,
    pub data: String,
}

#[derive(Clone, Serialize)]
pub struct PtyExitPayload {
    pub id: String,
}

pub fn spawn_session(
    app: AppHandle,
    store: Arc<PtyStore>,
    cols: u16,
    rows: u16,
    command: Option<String>,
    args: Option<Vec<String>>,
    cwd: Option<String>,
) -> Result<String, String> {
    let pty_system = NativePtySystem::default();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let shell = command
        .unwrap_or_else(|| std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string()));
    let mut cmd = CommandBuilder::new(shell);
    if let Some(a) = args {
        for arg in a {
            cmd.arg(arg);
        }
    }
    if let Some(dir) = cwd {
        cmd.cwd(dir);
    } else if let Ok(home) = std::env::var("HOME") {
        cmd.cwd(home);
    }
    cmd.env("TERM", "xterm-256color");

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;

    let id = uuid::Uuid::new_v4().to_string();

    {
        let mut sessions = store.sessions.lock();
        sessions.insert(
            id.clone(),
            PtySession {
                writer,
                master: pair.master,
                child,
            },
        );
    }

    let id_for_thread = id.clone();
    let app_for_thread = app.clone();
    let store_for_thread = store.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        let mut pending: Vec<u8> = Vec::with_capacity(64);
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    let chunk = drain_valid_utf8(&mut pending);
                    if !chunk.is_empty() {
                        let _ = app_for_thread.emit(
                            "pty:data",
                            PtyDataPayload {
                                id: id_for_thread.clone(),
                                data: chunk,
                            },
                        );
                    }
                }
                Err(_) => break,
            }
        }
        if !pending.is_empty() {
            let chunk = String::from_utf8_lossy(&pending).to_string();
            let _ = app_for_thread.emit(
                "pty:data",
                PtyDataPayload {
                    id: id_for_thread.clone(),
                    data: chunk,
                },
            );
        }
        let _ = app_for_thread.emit(
            "pty:exit",
            PtyExitPayload {
                id: id_for_thread.clone(),
            },
        );
        let mut sessions = store_for_thread.sessions.lock();
        sessions.remove(&id_for_thread);
    });

    Ok(id)
}

/// Drains the longest valid UTF-8 prefix from `buf` and returns it as a String.
/// Any trailing partial code-point bytes remain in `buf` for the next chunk.
fn drain_valid_utf8(buf: &mut Vec<u8>) -> String {
    match std::str::from_utf8(buf) {
        Ok(s) => {
            let out = s.to_owned();
            buf.clear();
            out
        }
        Err(e) => {
            let valid_up_to = e.valid_up_to();
            if valid_up_to == 0 {
                // Either the partial codepoint sits at index 0 with more bytes expected,
                // or we have an actually-invalid byte. If the partial fits a multi-byte
                // start, wait for more bytes; otherwise drop one byte as replacement.
                if let Some(first) = buf.first().copied() {
                    let needed = utf8_first_byte_width(first);
                    if needed > 0 && buf.len() < needed {
                        return String::new();
                    }
                }
                let bad = buf.remove(0);
                return char::REPLACEMENT_CHARACTER.to_string()
                    + &drain_valid_utf8_after_bad(buf, bad);
            }
            let out = std::str::from_utf8(&buf[..valid_up_to])
                .expect("validated")
                .to_owned();
            buf.drain(..valid_up_to);
            out
        }
    }
}

fn drain_valid_utf8_after_bad(buf: &mut Vec<u8>, _bad: u8) -> String {
    // After dropping one byte, retry the drain — recursive call is bounded by buf length.
    drain_valid_utf8(buf)
}

fn utf8_first_byte_width(b: u8) -> usize {
    if b < 0x80 {
        1
    } else if b & 0xE0 == 0xC0 {
        2
    } else if b & 0xF0 == 0xE0 {
        3
    } else if b & 0xF8 == 0xF0 {
        4
    } else {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drains_pure_ascii() {
        let mut buf = b"hello".to_vec();
        let out = drain_valid_utf8(&mut buf);
        assert_eq!(out, "hello");
        assert!(buf.is_empty());
    }

    #[test]
    fn holds_back_partial_multibyte() {
        // "é" in UTF-8 is 0xC3 0xA9
        let mut buf = vec![0xC3];
        let out = drain_valid_utf8(&mut buf);
        assert_eq!(out, "");
        assert_eq!(buf, vec![0xC3]);
        buf.push(0xA9);
        let out = drain_valid_utf8(&mut buf);
        assert_eq!(out, "é");
        assert!(buf.is_empty());
    }

    #[test]
    fn handles_partial_at_end_of_stream() {
        // "hello" then partial "é"
        let mut buf = vec![b'h', b'i', 0xC3];
        let out = drain_valid_utf8(&mut buf);
        assert_eq!(out, "hi");
        assert_eq!(buf, vec![0xC3]);
    }
}
