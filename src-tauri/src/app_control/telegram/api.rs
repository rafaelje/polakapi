use std::fmt;
use std::time::Duration;

use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};

// Minimal Telegram Bot API client: only the methods the operator bot uses.
// The token is part of every URL, so transport errors are stripped of their
// URL before they are turned into text.

const API_BASE: &str = "https://api.telegram.org";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(60);
pub const POLL_TIMEOUT_SECS: u64 = 50;

#[derive(Debug, Clone, PartialEq)]
pub enum ApiError {
    /// The token was revoked or mistyped.
    Unauthorized,
    /// Another process is polling the same token.
    Conflict,
    RetryAfter(u64),
    Other(String),
}

impl fmt::Display for ApiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unauthorized => write!(f, "Telegram rejected the bot token"),
            Self::Conflict => write!(
                f,
                "another client is already reading updates for this bot token"
            ),
            Self::RetryAfter(secs) => write!(f, "rate limited by Telegram for {secs}s"),
            Self::Other(message) => write!(f, "{message}"),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct User {
    pub id: i64,
    #[serde(default)]
    pub first_name: String,
    #[serde(default)]
    pub username: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Chat {
    pub id: i64,
    #[serde(rename = "type")]
    pub kind: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Message {
    pub chat: Chat,
    #[serde(default)]
    pub from: Option<User>,
    #[serde(default)]
    pub text: Option<String>,
    /// Unix seconds.
    #[serde(default)]
    pub date: i64,
    #[serde(default)]
    pub voice: Option<AudioFile>,
    #[serde(default)]
    pub audio: Option<AudioFile>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AudioFile {
    pub file_id: String,
    /// Seconds.
    #[serde(default)]
    pub duration: u64,
    #[serde(default)]
    pub file_size: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
struct FileInfo {
    #[serde(default)]
    file_path: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CallbackMessage {
    pub message_id: i64,
    pub chat: Chat,
    #[serde(default)]
    pub text: Option<String>,
}

/// A press on an inline button.
#[derive(Debug, Clone, Deserialize)]
pub struct CallbackQuery {
    pub id: String,
    pub from: User,
    #[serde(default)]
    pub message: Option<CallbackMessage>,
    #[serde(default)]
    pub data: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Update {
    pub update_id: i64,
    #[serde(default)]
    pub message: Option<Message>,
    #[serde(default)]
    pub callback_query: Option<CallbackQuery>,
}

#[derive(Clone)]
pub struct Api {
    client: reqwest::Client,
    base: String,
    files: String,
}

impl Api {
    pub fn new(token: &str) -> Result<Self, ApiError> {
        Self::with_base(API_BASE, token)
    }

    pub fn with_base(base: &str, token: &str) -> Result<Self, ApiError> {
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .build()
            .map_err(|e| ApiError::Other(format!("http client: {}", e.without_url())))?;
        Ok(Self {
            client,
            base: format!("{}/bot{token}", base.trim_end_matches('/')),
            files: format!("{}/file/bot{token}", base.trim_end_matches('/')),
        })
    }

    async fn call<T: DeserializeOwned>(
        &self,
        method: &str,
        body: Value,
        timeout: Duration,
    ) -> Result<T, ApiError> {
        let response = self
            .client
            .post(format!("{}/{method}", self.base))
            .json(&body)
            .timeout(timeout)
            .send()
            .await
            .map_err(|e| ApiError::Other(format!("{method}: {}", e.without_url())))?;
        let status = response.status().as_u16();
        let text = response
            .text()
            .await
            .map_err(|e| ApiError::Other(format!("{method}: {}", e.without_url())))?;
        parse_envelope(status, &text)
    }

    /// The bytes of a file a user sent, by its `file_id`.
    pub async fn download(&self, file_id: &str) -> Result<Vec<u8>, ApiError> {
        let info: FileInfo = self
            .call("getFile", json!({ "file_id": file_id }), REQUEST_TIMEOUT)
            .await?;
        let path = info
            .file_path
            .ok_or_else(|| ApiError::Other("Telegram did not return the file".to_string()))?;
        let response = self
            .client
            .get(format!("{}/{path}", self.files))
            .timeout(DOWNLOAD_TIMEOUT)
            .send()
            .await
            .map_err(|e| ApiError::Other(format!("download: {}", e.without_url())))?;
        if !response.status().is_success() {
            return Err(ApiError::Other(format!(
                "download: HTTP {}",
                response.status().as_u16()
            )));
        }
        let body = response
            .bytes()
            .await
            .map_err(|e| ApiError::Other(format!("download: {}", e.without_url())))?;
        Ok(body.to_vec())
    }

    pub async fn get_me(&self) -> Result<User, ApiError> {
        self.call("getMe", json!({}), REQUEST_TIMEOUT).await
    }

    pub async fn get_updates(&self, offset: i64) -> Result<Vec<Update>, ApiError> {
        self.call(
            "getUpdates",
            json!({
                "offset": offset,
                "timeout": POLL_TIMEOUT_SECS,
                "allowed_updates": ["message", "callback_query"],
            }),
            Duration::from_secs(POLL_TIMEOUT_SECS + 20),
        )
        .await
    }

    /// Plain text on purpose: an answer full of Markdown cannot break the
    /// request the way an unbalanced `parse_mode` entity would.
    pub async fn send_message(&self, chat_id: i64, text: &str) -> Result<(), ApiError> {
        self.call::<Value>(
            "sendMessage",
            json!({ "chat_id": chat_id, "text": text, "link_preview_options": { "is_disabled": true } }),
            REQUEST_TIMEOUT,
        )
        .await
        .map(|_| ())
    }

    pub async fn send_html(&self, chat_id: i64, html: &str) -> Result<(), ApiError> {
        self.call::<Value>(
            "sendMessage",
            json!({
                "chat_id": chat_id,
                "text": html,
                "parse_mode": "HTML",
                "link_preview_options": { "is_disabled": true },
            }),
            REQUEST_TIMEOUT,
        )
        .await
        .map(|_| ())
    }

    /// One row of inline buttons, each `(label, callback data)`.
    pub async fn send_with_buttons(
        &self,
        chat_id: i64,
        text: &str,
        buttons: &[(&str, String)],
    ) -> Result<(), ApiError> {
        let row: Vec<(String, String)> = buttons
            .iter()
            .map(|(label, data)| (label.to_string(), data.clone()))
            .collect();
        self.send_with_keyboard(chat_id, text, &[row]).await
    }

    /// Several rows of inline buttons, each `(label, callback data)`.
    pub async fn send_with_keyboard(
        &self,
        chat_id: i64,
        text: &str,
        rows: &[Vec<(String, String)>],
    ) -> Result<(), ApiError> {
        let keyboard: Vec<Vec<Value>> = rows
            .iter()
            .map(|row| {
                row.iter()
                    .map(|(label, data)| json!({ "text": label, "callback_data": data }))
                    .collect()
            })
            .collect();
        self.call::<Value>(
            "sendMessage",
            json!({
                "chat_id": chat_id,
                "text": text,
                "link_preview_options": { "is_disabled": true },
                "reply_markup": { "inline_keyboard": keyboard },
            }),
            REQUEST_TIMEOUT,
        )
        .await
        .map(|_| ())
    }

    /// Replaces a message's text; leaving out `reply_markup` drops its buttons.
    pub async fn edit_text(
        &self,
        chat_id: i64,
        message_id: i64,
        text: &str,
    ) -> Result<(), ApiError> {
        self.call::<Value>(
            "editMessageText",
            json!({ "chat_id": chat_id, "message_id": message_id, "text": text }),
            REQUEST_TIMEOUT,
        )
        .await
        .map(|_| ())
    }

    /// Stops the button's spinner; `text` shows as a short toast.
    pub async fn answer_callback(&self, callback_id: &str, text: &str) -> Result<(), ApiError> {
        self.call::<Value>(
            "answerCallbackQuery",
            json!({ "callback_query_id": callback_id, "text": text }),
            REQUEST_TIMEOUT,
        )
        .await
        .map(|_| ())
    }

    pub async fn send_typing(&self, chat_id: i64) -> Result<(), ApiError> {
        self.call::<Value>(
            "sendChatAction",
            json!({ "chat_id": chat_id, "action": "typing" }),
            REQUEST_TIMEOUT,
        )
        .await
        .map(|_| ())
    }

    pub async fn set_commands(&self, commands: &[(&str, &str)]) -> Result<(), ApiError> {
        let commands: Vec<Value> = commands
            .iter()
            .map(|(command, description)| json!({ "command": command, "description": description }))
            .collect();
        self.call::<Value>(
            "setMyCommands",
            json!({ "commands": commands }),
            REQUEST_TIMEOUT,
        )
        .await
        .map(|_| ())
    }
}

pub fn parse_envelope<T: DeserializeOwned>(status: u16, body: &str) -> Result<T, ApiError> {
    let value: Value = serde_json::from_str(body)
        .map_err(|_| ApiError::Other(format!("Telegram answered HTTP {status} without JSON")))?;
    if value.get("ok").and_then(Value::as_bool) == Some(true) {
        let result = value.get("result").cloned().unwrap_or(Value::Null);
        return serde_json::from_value(result)
            .map_err(|e| ApiError::Other(format!("unexpected Telegram result: {e}")));
    }
    let code = value
        .get("error_code")
        .and_then(Value::as_u64)
        .unwrap_or(u64::from(status));
    match code {
        401 | 404 => Err(ApiError::Unauthorized),
        409 => Err(ApiError::Conflict),
        429 => Err(ApiError::RetryAfter(
            value
                .pointer("/parameters/retry_after")
                .and_then(Value::as_u64)
                .unwrap_or(5),
        )),
        _ => Err(ApiError::Other(
            value
                .get("description")
                .and_then(Value::as_str)
                .map(|text| format!("Telegram error {code}: {text}"))
                .unwrap_or_else(|| format!("Telegram error {code}")),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_updates() {
        let body = r#"{"ok":true,"result":[{"update_id":7,"message":{"message_id":1,"chat":{"id":42,"type":"private"},"from":{"id":42,"is_bot":false,"first_name":"Ana"},"text":"hola"}},{"update_id":8,"edited_message":{}}]}"#;
        let updates: Vec<Update> = parse_envelope(200, body).unwrap();
        assert_eq!(updates.len(), 2);
        let message = updates[0].message.as_ref().unwrap();
        assert_eq!(message.chat.kind, "private");
        assert_eq!(message.from.as_ref().unwrap().id, 42);
        assert_eq!(message.text.as_deref(), Some("hola"));
        assert!(updates[1].message.is_none());
    }

    #[test]
    fn parses_button_presses() {
        let body = r#"{"ok":true,"result":[{"update_id":9,"callback_query":{"id":"cb1","from":{"id":42,"is_bot":false,"first_name":"Ana"},"message":{"message_id":5,"chat":{"id":42,"type":"private"},"text":"needs permission"},"data":"perm:3:allow"}}]}"#;
        let updates: Vec<Update> = parse_envelope(200, body).unwrap();
        let press = updates[0].callback_query.as_ref().unwrap();
        assert_eq!(press.from.id, 42);
        assert_eq!(press.data.as_deref(), Some("perm:3:allow"));
        assert_eq!(press.message.as_ref().unwrap().message_id, 5);
    }

    #[test]
    fn maps_error_codes() {
        let unauthorized = parse_envelope::<Value>(
            401,
            r#"{"ok":false,"error_code":401,"description":"Unauthorized"}"#,
        );
        assert_eq!(unauthorized.unwrap_err(), ApiError::Unauthorized);
        let conflict = parse_envelope::<Value>(409, r#"{"ok":false,"error_code":409}"#);
        assert_eq!(conflict.unwrap_err(), ApiError::Conflict);
        let limited = parse_envelope::<Value>(
            429,
            r#"{"ok":false,"error_code":429,"parameters":{"retry_after":12}}"#,
        );
        assert_eq!(limited.unwrap_err(), ApiError::RetryAfter(12));
        let other = parse_envelope::<Value>(
            400,
            r#"{"ok":false,"error_code":400,"description":"Bad Request: chat not found"}"#,
        );
        assert_eq!(
            other.unwrap_err(),
            ApiError::Other("Telegram error 400: Bad Request: chat not found".into())
        );
        assert!(matches!(
            parse_envelope::<Value>(502, "<html>"),
            Err(ApiError::Other(_))
        ));
    }
}
