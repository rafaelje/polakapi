use serde::Serialize;
use serde_json::Value;
use std::time::Duration;

use crate::platform_command;

// Authoritative Claude Code usage fetch. Same contract Claude's own `/usage`
// slash command uses — see stablyai/orca's src/main/rate-limits/claude-fetcher.ts
// which pioneered this approach in the community.
//
// GET https://api.anthropic.com/api/oauth/usage
//   Authorization: Bearer <access_token>
//   anthropic-beta: oauth-2025-04-20
//   User-Agent: claude-code/<version>
//
// Response (only the fields we surface):
//   { "five_hour": {"utilization": 14, "resets_at": "..."},
//     "seven_day": {"utilization": 2,  "resets_at": "..."},
//     "fable_weekly": {"utilization": 0, "resets_at": "..."},
//     "limits": [ ... structured scoped limits ... ] }
//
// Credential sources tried in order:
//   1. ~/.claude/.credentials.json → claudeAiOauth.accessToken
//   2. macOS Keychain → generic password. Claude Code 2.1+ scopes the
//      service name to `Claude Code-credentials-<hash8>` where hash8 is
//      the first 8 hex chars of sha256(CLAUDE_CONFIG_DIR). We try the
//      scoped service first (when the env var is set), then the legacy
//      unscoped `Claude Code-credentials` name that older installs use.

const OAUTH_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA: &str = "oauth-2025-04-20";
const USER_AGENT: &str = "claude-code/2.1.0";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeAuthoritative {
    pub session: Option<AuthoritativeWindow>,
    pub weekly: Option<AuthoritativeWindow>,
    pub fable_weekly: Option<AuthoritativeWindow>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AuthoritativeWindow {
    pub used_percent: f64,
    /// Unix epoch seconds when the window resets.
    pub resets_at: Option<i64>,
}

pub async fn fetch() -> Result<Option<ClaudeAuthoritative>, String> {
    let Some(token) = read_token()? else {
        return Ok(None);
    };
    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|e| format!("http client init: {e}"))?;
    let response = client
        .get(OAUTH_URL)
        .bearer_auth(&token)
        .header("anthropic-beta", OAUTH_BETA)
        .header("User-Agent", USER_AGENT)
        .send()
        .await
        .map_err(|e| format!("oauth/usage request failed: {e}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("oauth/usage returned HTTP {}", status.as_u16()));
    }
    let raw: Value = response
        .json()
        .await
        .map_err(|e| format!("oauth/usage parse error: {e}"))?;
    Ok(Some(parse_response(&raw)))
}

pub(crate) fn parse_response(raw: &Value) -> ClaudeAuthoritative {
    ClaudeAuthoritative {
        session: raw.get("five_hour").and_then(parse_window),
        weekly: raw.get("seven_day").and_then(parse_window),
        fable_weekly: fable_weekly(raw),
    }
}

fn fable_weekly(raw: &Value) -> Option<AuthoritativeWindow> {
    // Structured scoped limits are the new home for per-model quotas; fall
    // back to the legacy fable_weekly / fable_seven_day / seven_day_fable
    // keys for older accounts. Inactive scoped entries still hold a real
    // percentage and reset — do not filter by `is_active`.
    if let Some(items) = raw.get("limits").and_then(Value::as_array) {
        for limit in items {
            let is_weekly = limit.get("kind").and_then(Value::as_str) == Some("weekly_scoped");
            let is_fable = limit
                .pointer("/scope/model/display_name")
                .and_then(Value::as_str)
                .map(str::trim)
                .map(str::to_ascii_lowercase)
                .as_deref()
                == Some("fable");
            let pct = limit.get("percent").and_then(Value::as_f64);
            if is_weekly && is_fable {
                if let Some(p) = pct {
                    return Some(AuthoritativeWindow {
                        used_percent: clamp_percent(p),
                        resets_at: parse_resets_at(limit.get("resets_at")),
                    });
                }
            }
        }
    }
    for legacy in ["fable_weekly", "fable_seven_day", "seven_day_fable"] {
        if let Some(window) = raw.get(legacy).and_then(parse_window) {
            return Some(window);
        }
    }
    None
}

fn parse_window(value: &Value) -> Option<AuthoritativeWindow> {
    let pct = value
        .get("utilization")
        .and_then(Value::as_f64)
        .or_else(|| value.get("used_percentage").and_then(Value::as_f64))?;
    Some(AuthoritativeWindow {
        used_percent: clamp_percent(pct),
        resets_at: parse_resets_at(value.get("resets_at")),
    })
}

fn clamp_percent(value: f64) -> f64 {
    if !value.is_finite() {
        return 0.0;
    }
    value.clamp(0.0, 100.0)
}

fn parse_resets_at(value: Option<&Value>) -> Option<i64> {
    let value = value?;
    // The API sends either a numeric epoch (seconds OR milliseconds) or an
    // ISO 8601 string. Distinguish s vs ms by magnitude: 1e10 sits between
    // any plausible seconds epoch (<2286) and any millisecond epoch (>2001).
    if let Some(number) = value.as_f64() {
        return Some(numeric_to_seconds(number));
    }
    let string = value.as_str()?;
    if let Ok(parsed) = string.trim().parse::<f64>() {
        return Some(numeric_to_seconds(parsed));
    }
    super::time::iso_to_epoch_seconds(string)
}

fn numeric_to_seconds(value: f64) -> i64 {
    let secs = if value > 10_000_000_000.0 {
        value / 1000.0
    } else {
        value
    };
    secs as i64
}

fn read_token() -> Result<Option<String>, String> {
    let home = platform_command::user_home_dir()
        .ok_or_else(|| "user home directory is unavailable".to_string())?;
    let file_path = home.join(".claude/.credentials.json");
    if let Ok(contents) = std::fs::read_to_string(&file_path) {
        if let Some(token) = extract_token(&contents) {
            return Ok(Some(token));
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Some(token) = read_from_macos_keychain() {
            return Ok(Some(token));
        }
    }
    Ok(None)
}

fn extract_token(payload: &str) -> Option<String> {
    let value: Value = serde_json::from_str(payload).ok()?;
    value
        .pointer("/claudeAiOauth/accessToken")
        .and_then(Value::as_str)
        .map(str::to_string)
}

#[cfg(target_os = "macos")]
fn read_from_macos_keychain() -> Option<String> {
    for service in keychain_service_candidates() {
        if let Some(token) = read_keychain_service(&service) {
            return Some(token);
        }
    }
    None
}

#[cfg(target_os = "macos")]
fn keychain_service_candidates() -> Vec<String> {
    const LEGACY: &str = "Claude Code-credentials";
    let mut services = Vec::new();
    if let Some(dir) = std::env::var_os("CLAUDE_CONFIG_DIR") {
        services.push(scoped_service_name(LEGACY, &dir.to_string_lossy()));
    }
    // Also try the default config dir (~/.claude) — Claude Code 2.1+ scopes
    // by that even when CLAUDE_CONFIG_DIR is unset.
    if let Some(home) = platform_command::user_home_dir() {
        let default_dir = home.join(".claude");
        services.push(scoped_service_name(LEGACY, &default_dir.to_string_lossy()));
    }
    services.push(LEGACY.to_string());
    services
}

#[cfg(target_os = "macos")]
fn scoped_service_name(base: &str, config_dir: &str) -> String {
    // First 8 hex chars of sha256(CLAUDE_CONFIG_DIR). Matches Claude Code
    // 2.1+'s keychain scoping so we can find the current install's token.
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(config_dir.as_bytes());
    let mut hex = String::with_capacity(8);
    for byte in &digest[..4] {
        hex.push_str(&format!("{byte:02x}"));
    }
    format!("{base}-{hex}")
}

#[cfg(target_os = "macos")]
fn read_keychain_service(service: &str) -> Option<String> {
    let output = std::process::Command::new("security")
        .args(["find-generic-password", "-s", service, "-w"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let raw = String::from_utf8(output.stdout).ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    extract_token(trimmed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_response_with_legacy_fable_field() {
        let raw = json!({
            "five_hour": {"utilization": 14.5, "resets_at": 1_800_000_000_i64},
            "seven_day": {"used_percentage": 2, "resets_at": "2026-08-22T23:00:00Z"},
            "fable_weekly": {"utilization": 0, "resets_at": 1_800_050_000_i64}
        });
        let out = parse_response(&raw);
        assert!((out.session.as_ref().unwrap().used_percent - 14.5).abs() < f64::EPSILON);
        assert_eq!(out.session.as_ref().unwrap().resets_at, Some(1_800_000_000));
        assert!((out.weekly.as_ref().unwrap().used_percent - 2.0).abs() < f64::EPSILON);
        assert!(out.weekly.as_ref().unwrap().resets_at.is_some());
        assert!((out.fable_weekly.as_ref().unwrap().used_percent - 0.0).abs() < f64::EPSILON);
    }

    #[test]
    fn parses_response_with_scoped_limits_for_fable() {
        let raw = json!({
            "five_hour": {"utilization": 5},
            "seven_day": {"utilization": 1},
            "limits": [
                {"kind": "weekly_scoped", "percent": 42,
                 "resets_at": 1_800_000_000_i64,
                 "scope": {"model": {"display_name": "Fable"}}}
            ]
        });
        let out = parse_response(&raw);
        assert!((out.fable_weekly.as_ref().unwrap().used_percent - 42.0).abs() < f64::EPSILON);
    }

    #[test]
    fn milliseconds_epoch_is_downconverted_to_seconds() {
        assert_eq!(numeric_to_seconds(1_800_000_000_000.0), 1_800_000_000);
        assert_eq!(numeric_to_seconds(1_800_000_000.0), 1_800_000_000);
    }

    #[test]
    fn clamp_percent_is_defensive() {
        assert!((clamp_percent(150.0) - 100.0).abs() < f64::EPSILON);
        assert!((clamp_percent(-3.0) - 0.0).abs() < f64::EPSILON);
        assert!((clamp_percent(f64::NAN) - 0.0).abs() < f64::EPSILON);
    }

    #[test]
    fn extract_token_reads_claude_ai_oauth_access_token() {
        let json = r#"{"claudeAiOauth": {"accessToken": "abc", "refreshToken": "r"}}"#;
        assert_eq!(extract_token(json).as_deref(), Some("abc"));
        assert_eq!(extract_token("{}"), None);
        assert_eq!(extract_token("not json"), None);
    }
}
