use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::actions::tool_text;
use super::bot::TelegramService;

// `polakapi_chat_send_file`, a tool only Telegram turns see: uploads a file
// from this computer to the chat as a document.

pub const SEND_FILE_TOOL: &str = "polakapi_chat_send_file";
/// The Bot API refuses uploads above 50 MB.
const MAX_BYTES: u64 = 50 * 1024 * 1024;

pub fn send_file_tool() -> Value {
    json!({
        "name": SEND_FILE_TOOL,
        "description": "Send a file from this computer to the Telegram chat as a document. Use it when the user asks for a file, or when a file is the answer (a log, a build, an export, a screenshot). Relative paths start at the chat's project folder.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Absolute path, ~/…, or a path relative to the chat's project." },
                "caption": { "type": "string", "description": "Optional short text shown under the file." }
            },
            "required": ["path"],
            "additionalProperties": false
        }
    })
}

pub fn send(service: &TelegramService, chat_id: i64, arguments: &Value) -> Value {
    let arg = |key: &str| {
        arguments
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
    };
    let base = service
        .focus(chat_id)
        .map(|focus| PathBuf::from(focus.path));
    let path = match resolve(arg("path"), base.as_deref(), home().as_deref()) {
        Ok(path) => path,
        Err(error) => return tool_text(error, true),
    };
    let bytes = match read(&path) {
        Ok(bytes) => bytes,
        Err(error) => return tool_text(error, true),
    };
    let Some(api) = service.api() else {
        return tool_text("the Telegram bot is not running", true);
    };
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".to_string());
    let caption = Some(arg("caption")).filter(|caption| !caption.is_empty());
    match tauri::async_runtime::block_on(api.send_document(chat_id, &name, bytes, caption)) {
        Ok(()) => tool_text(
            format!(
                "Sent {} to the chat. Do not paste its contents again.",
                path.display()
            ),
            false,
        ),
        Err(error) => tool_text(format!("could not send {}: {error}", path.display()), true),
    }
}

fn home() -> Option<PathBuf> {
    crate::platform_command::user_home_dir()
}

fn resolve(raw: &str, base: Option<&Path>, home: Option<&Path>) -> Result<PathBuf, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("no path given".to_string());
    }
    if let Some(rest) = raw.strip_prefix("~/").or((raw == "~").then_some("")) {
        let home = home.ok_or("could not resolve the home folder")?;
        return Ok(home.join(rest));
    }
    let path = PathBuf::from(raw);
    if path.is_absolute() {
        return Ok(path);
    }
    base.map(|base| base.join(&path)).ok_or_else(|| {
        format!("{raw} is relative and this chat has no project; give an absolute path")
    })
}

fn read(path: &Path) -> Result<Vec<u8>, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("{}: {e}", path.display()))?;
    if !meta.is_file() {
        return Err(format!("{} is not a file", path.display()));
    }
    if meta.len() == 0 {
        return Err(format!("{} is empty", path.display()));
    }
    if meta.len() > MAX_BYTES {
        return Err(format!(
            "{} is {} MB; Telegram bots can send up to 50 MB",
            path.display(),
            meta.len() / (1024 * 1024)
        ));
    }
    std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_paths_against_the_project_and_home() {
        let base = Path::new("/repos/app");
        let home = Path::new("/home/ana");
        assert_eq!(
            resolve("dist/app.zip", Some(base), Some(home)).unwrap(),
            PathBuf::from("/repos/app/dist/app.zip")
        );
        assert_eq!(
            resolve("~/notes.txt", Some(base), Some(home)).unwrap(),
            PathBuf::from("/home/ana/notes.txt")
        );
        let absolute = if cfg!(windows) {
            r"C:\tmp\log.txt"
        } else {
            "/tmp/log.txt"
        };
        assert_eq!(
            resolve(absolute, None, None).unwrap(),
            PathBuf::from(absolute)
        );
        assert!(resolve("log.txt", None, Some(home)).is_err());
        assert!(resolve("  ", Some(base), Some(home)).is_err());
    }

    #[test]
    fn refuses_folders_and_missing_files() {
        let dir = std::env::temp_dir();
        assert!(read(&dir).unwrap_err().contains("is not a file"));
        assert!(read(&dir.join("polakapi-missing-file")).is_err());
    }

    #[test]
    fn the_send_file_tool_has_a_valid_schema() {
        let tool = send_file_tool();
        assert_eq!(tool["name"], SEND_FILE_TOOL);
        assert_eq!(tool["inputSchema"]["required"][0], "path");
    }
}
