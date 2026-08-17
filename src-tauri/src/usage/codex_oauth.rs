use serde::Serialize;
use serde_json::Value;
use std::time::Duration;

use super::{CodexRateLimits, CodexRateWindow};
use crate::platform_command;

// Authoritative Codex CLI usage fetch. Contract used by Codex Desktop itself
// — see stablyai/orca's src/main/rate-limits/codex-fetcher.ts. The JSONL
// snapshot we already parse is authoritative-at-write-time but goes stale
// between sessions; this endpoint returns the live counters on demand.
//
// GET https://chatgpt.com/backend-api/wham/usage
//   Authorization: Bearer <access_token>
//   User-Agent: codex-cli
//   OpenAI-Beta: codex-1
//   originator: Codex Desktop
//   ChatGPT-Account-Id: <account_id>  (when present in auth.json)
//
// Response (only the fields we surface):
//   {
//     "plan_type": "plus",
//     "rate_limit": {
//       "primary_window":  { "used_percent": 3, "limit_window_seconds": 300, "reset_at": ... },
//       "secondary_window":{ "used_percent": 30, "limit_window_seconds": 604800, "reset_at": ... }
//     }
//   }
//
// Credentials: $CODEX_HOME/auth.json → tokens.{access_token,account_id}
// (falls back to ~/.codex/auth.json when CODEX_HOME is unset).

const USAGE_URL: &str = "https://chatgpt.com/backend-api/wham/usage";
const USER_AGENT: &str = "codex-cli";
const OPENAI_BETA: &str = "codex-1";
const ORIGINATOR: &str = "Codex Desktop";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CodexAuthoritative {
    pub plan_type: Option<String>,
    pub primary: Option<CodexRateWindow>,
    pub secondary: Option<CodexRateWindow>,
}

pub async fn fetch() -> Result<Option<CodexAuthoritative>, String> {
    let Some(auth) = read_auth()? else {
        return Ok(None);
    };
    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|e| format!("http client init: {e}"))?;
    let mut request = client
        .get(USAGE_URL)
        .bearer_auth(&auth.access_token)
        .header("User-Agent", USER_AGENT)
        .header("OpenAI-Beta", OPENAI_BETA)
        .header("originator", ORIGINATOR);
    if let Some(account_id) = &auth.account_id {
        request = request.header("ChatGPT-Account-Id", account_id);
    }
    let response = request
        .send()
        .await
        .map_err(|e| format!("wham/usage request failed: {e}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("wham/usage returned HTTP {}", status.as_u16()));
    }
    let raw: Value = response
        .json()
        .await
        .map_err(|e| format!("wham/usage parse error: {e}"))?;
    Ok(Some(parse_response(&raw)))
}

/// Convert an authoritative response into the same `CodexRateLimits` shape
/// the JSONL snapshot uses, so the UI can consume either interchangeably.
pub fn as_rate_limits(source: &CodexAuthoritative) -> CodexRateLimits {
    CodexRateLimits {
        plan_type: source.plan_type.clone(),
        captured_at: None,
        primary: source.primary.clone(),
        secondary: source.secondary.clone(),
        source: "live".to_string(),
    }
}

pub(crate) fn parse_response(raw: &Value) -> CodexAuthoritative {
    CodexAuthoritative {
        plan_type: raw
            .get("plan_type")
            .and_then(Value::as_str)
            .map(str::to_string),
        primary: parse_window(raw.pointer("/rate_limit/primary_window")),
        secondary: parse_window(raw.pointer("/rate_limit/secondary_window")),
    }
}

fn parse_window(value: Option<&Value>) -> Option<CodexRateWindow> {
    let window = value?;
    if window.is_null() {
        return None;
    }
    let used_percent = window.get("used_percent").and_then(Value::as_f64)?;
    Some(CodexRateWindow {
        used_percent: used_percent.clamp(0.0, 100.0),
        window_minutes: window
            .get("limit_window_seconds")
            .and_then(Value::as_u64)
            .map(|seconds| seconds.div_ceil(60)),
        resets_at: window.get("reset_at").and_then(Value::as_i64),
    })
}

struct CodexAuth {
    access_token: String,
    account_id: Option<String>,
}

fn read_auth() -> Result<Option<CodexAuth>, String> {
    let home = platform_command::user_home_dir()
        .ok_or_else(|| "user home directory is unavailable".to_string())?;
    let base = std::env::var_os("CODEX_HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| home.join(".codex"));
    let path = base.join("auth.json");
    let Ok(contents) = std::fs::read_to_string(&path) else {
        return Ok(None);
    };
    Ok(extract_auth(&contents))
}

fn extract_auth(payload: &str) -> Option<CodexAuth> {
    let value: Value = serde_json::from_str(payload).ok()?;
    let access_token = value
        .pointer("/tokens/access_token")
        .and_then(Value::as_str)?
        .to_string();
    let account_id = value
        .pointer("/tokens/account_id")
        .and_then(Value::as_str)
        .map(str::to_string);
    Some(CodexAuth {
        access_token,
        account_id,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_windows_with_plan_type() {
        let raw = json!({
            "plan_type": "plus",
            "rate_limit": {
                "primary_window": {
                    "used_percent": 3.0,
                    "limit_window_seconds": 300,
                    "reset_at": 1_800_000_000_i64
                },
                "secondary_window": {
                    "used_percent": 30.0,
                    "limit_window_seconds": 604_800,
                    "reset_at": 1_800_100_000_i64
                }
            }
        });
        let out = parse_response(&raw);
        assert_eq!(out.plan_type.as_deref(), Some("plus"));
        let p = out.primary.unwrap();
        assert!((p.used_percent - 3.0).abs() < f64::EPSILON);
        assert_eq!(p.window_minutes, Some(5));
        assert_eq!(p.resets_at, Some(1_800_000_000));
        let s = out.secondary.unwrap();
        assert_eq!(s.window_minutes, Some(10080));
    }

    #[test]
    fn missing_secondary_is_none() {
        let raw = json!({
            "plan_type": "pro",
            "rate_limit": {
                "primary_window": { "used_percent": 42, "limit_window_seconds": 300 },
                "secondary_window": null
            }
        });
        let out = parse_response(&raw);
        assert!(out.primary.is_some());
        assert!(out.secondary.is_none());
    }

    #[test]
    fn extract_auth_reads_tokens_block() {
        let json = r#"{"tokens":{"access_token":"tok","account_id":"acct"}}"#;
        let auth = extract_auth(json).unwrap();
        assert_eq!(auth.access_token, "tok");
        assert_eq!(auth.account_id.as_deref(), Some("acct"));
        assert!(extract_auth("{}").is_none());
    }

    #[test]
    fn as_rate_limits_projects_authoritative_source() {
        let source = CodexAuthoritative {
            plan_type: Some("pro".to_string()),
            primary: Some(CodexRateWindow {
                used_percent: 12.0,
                window_minutes: Some(5),
                resets_at: Some(1_800_000_000),
            }),
            secondary: None,
        };
        let projected = as_rate_limits(&source);
        assert_eq!(projected.plan_type.as_deref(), Some("pro"));
        assert!(projected.primary.is_some());
        assert!(projected.captured_at.is_none());
    }
}
