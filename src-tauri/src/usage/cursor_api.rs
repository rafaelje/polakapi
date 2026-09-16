use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::future::Future;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use super::time::{date_from_iso, iso_to_epoch_seconds, unknown_date};
use super::TokenTotals;
use crate::platform_command;

// Cursor usage fetch against the cursor.com dashboard API — the same
// endpoints the web dashboard uses:
//   GET https://cursor.com/api/usage-summary
//   GET https://cursor.com/api/dashboard/export-usage-events-csv?strategy=tokens
// Both authenticate with a `WorkosCursorSessionToken={userId}%3A%3A{jwt}`
// cookie. The JWT is the local Cursor login, tried in order:
//   1. Cursor IDE state.vscdb (ItemTable key `cursorAuth/accessToken`)
//   2. cursor-agent CLI auth.json ($XDG_CONFIG_HOME/{cursor,cursor-agent},
//      ~/.cursor) → accessToken / access_token
// The user id is the tail of the JWT `sub` claim (e.g. `auth0|user_x`).

const SUMMARY_URL: &str = "https://cursor.com/api/usage-summary";
const CSV_URL: &str = "https://cursor.com/api/dashboard/export-usage-events-csv?strategy=tokens";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const USER_AGENT: &str = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CursorSummary {
    pub membership_type: Option<String>,
    pub plan: Option<CursorWindow>,
    pub auto: Option<CursorWindow>,
    pub api: Option<CursorWindow>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CursorWindow {
    pub used_percent: f64,
    /// Unix epoch seconds when the billing cycle ends.
    pub resets_at: Option<i64>,
}

pub struct CursorData {
    pub daily: BTreeMap<String, TokenTotals>,
    pub summary: Option<CursorSummary>,
    pub warnings: Vec<String>,
}

enum CursorRequestError {
    Auth(String),
    Other(String),
}

impl CursorRequestError {
    fn message(self) -> String {
        match self {
            Self::Auth(message) | Self::Other(message) => message,
        }
    }
}

pub async fn fetch() -> Result<Option<CursorData>, String> {
    let tokens = tokio::task::spawn_blocking(access_token_candidates)
        .await
        .map_err(|error| format!("credential lookup task failed: {error}"))?;
    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|e| format!("http client init: {e}"))?;
    fetch_from_tokens(tokens, |cookie| {
        let client = client.clone();
        async move { fetch_with_cookie(&client, &cookie).await }
    })
    .await
}

async fn fetch_from_tokens<F, Fut>(
    tokens: Vec<String>,
    mut fetcher: F,
) -> Result<Option<CursorData>, String>
where
    F: FnMut(String) -> Fut,
    Fut: Future<Output = Result<CursorData, CursorRequestError>>,
{
    if tokens.is_empty() {
        return Ok(None);
    }
    let mut last_error = None;
    for token in tokens {
        let cookie = match session_cookie_for(&token) {
            Ok(cookie) => cookie,
            Err(error) => {
                last_error = Some(error);
                continue;
            }
        };
        match fetcher(cookie).await {
            Ok(data) => return Ok(Some(data)),
            Err(CursorRequestError::Auth(message)) => last_error = Some(message),
            Err(error) => return Err(error.message()),
        }
    }
    Err(last_error.unwrap_or_else(|| "no usable Cursor credentials found".to_string()))
}

async fn fetch_with_cookie(
    client: &reqwest::Client,
    cookie: &str,
) -> Result<CursorData, CursorRequestError> {
    let (summary, csv) = tokio::join!(fetch_summary(client, cookie), fetch_csv(client, cookie));
    if let Err(CursorRequestError::Auth(message)) = &summary {
        return Err(CursorRequestError::Auth(message.clone()));
    }
    if let Err(CursorRequestError::Auth(message)) = &csv {
        return Err(CursorRequestError::Auth(message.clone()));
    }
    let mut warnings = Vec::new();
    let summary = match summary {
        Ok(value) => Some(value),
        Err(error) => {
            warnings.push(error.message());
            None
        }
    };
    let daily = match csv {
        Ok(text) => parse_usage_csv(&text),
        Err(error) => {
            warnings.push(error.message());
            BTreeMap::new()
        }
    };
    Ok(CursorData {
        daily,
        summary,
        warnings,
    })
}

async fn fetch_summary(
    client: &reqwest::Client,
    cookie: &str,
) -> Result<CursorSummary, CursorRequestError> {
    let raw: Value = get(client, cookie, SUMMARY_URL, "usage-summary")
        .await?
        .json()
        .await
        .map_err(|e| CursorRequestError::Other(format!("usage-summary parse error: {e}")))?;
    Ok(parse_summary(&raw))
}

async fn fetch_csv(client: &reqwest::Client, cookie: &str) -> Result<String, CursorRequestError> {
    get(client, cookie, CSV_URL, "usage-events export")
        .await?
        .text()
        .await
        .map_err(|e| CursorRequestError::Other(format!("usage-events export read error: {e}")))
}

async fn get(
    client: &reqwest::Client,
    cookie: &str,
    url: &str,
    label: &str,
) -> Result<reqwest::Response, CursorRequestError> {
    let response = client
        .get(url)
        .header("Cookie", cookie)
        .header("Accept", "*/*")
        .header("Referer", "https://cursor.com/dashboard")
        .header("User-Agent", USER_AGENT)
        .send()
        .await
        .map_err(|e| CursorRequestError::Other(format!("{label} request failed: {e}")))?;
    let status = response.status();
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return Err(CursorRequestError::Auth(format!(
            "{label} auth failed (HTTP {}) — sign in to Cursor again",
            status.as_u16()
        )));
    }
    if !status.is_success() {
        return Err(CursorRequestError::Other(format!(
            "{label} returned HTTP {}",
            status.as_u16()
        )));
    }
    Ok(response)
}

pub(crate) fn parse_summary(raw: &Value) -> CursorSummary {
    let resets_at = parse_resets_at(raw.get("billingCycleEnd"));
    let plan = raw.pointer("/individualUsage/plan");
    let plan_pct = pct(plan, "totalPercentUsed");
    let auto_pct = pct(plan, "autoPercentUsed");
    let api_pct = pct(plan, "apiPercentUsed");
    // Headline precedence mirrors the dashboard: explicit total → avg of the
    // auto/api splits → either split → used/limit ratios.
    let headline = plan_pct
        .or_else(|| match (auto_pct, api_pct) {
            (Some(a), Some(b)) => Some((a + b) / 2.0),
            _ => None,
        })
        .or(api_pct)
        .or(auto_pct)
        .or_else(|| ratio_pct(plan))
        .or_else(|| ratio_pct(raw.pointer("/individualUsage/overall")))
        .or_else(|| ratio_pct(raw.pointer("/teamUsage/pooled")));
    let window = |value: Option<f64>| {
        value.map(|used_percent| CursorWindow {
            used_percent: clamp_percent(used_percent),
            resets_at,
        })
    };
    CursorSummary {
        membership_type: raw
            .get("membershipType")
            .and_then(Value::as_str)
            .map(str::to_string),
        plan: window(headline),
        auto: window(auto_pct),
        api: window(api_pct),
    }
}

fn pct(value: Option<&Value>, key: &str) -> Option<f64> {
    let number = value?.get(key)?.as_f64()?;
    number.is_finite().then_some(number)
}

fn ratio_pct(value: Option<&Value>) -> Option<f64> {
    let value = value?;
    let used = value.get("used")?.as_f64()?;
    let limit = value.get("limit")?.as_f64()?;
    (limit > 0.0 && used.is_finite() && limit.is_finite()).then(|| (used / limit) * 100.0)
}

fn clamp_percent(value: f64) -> f64 {
    if !value.is_finite() {
        return 0.0;
    }
    value.clamp(0.0, 100.0)
}

fn parse_resets_at(value: Option<&Value>) -> Option<i64> {
    let value = value?;
    if let Some(number) = value.as_f64() {
        return Some(numeric_to_seconds(number));
    }
    let string = value.as_str()?;
    if let Ok(parsed) = string.trim().parse::<f64>() {
        return Some(numeric_to_seconds(parsed));
    }
    iso_to_epoch_seconds(string)
}

fn numeric_to_seconds(value: f64) -> i64 {
    let secs = if value > 10_000_000_000.0 {
        value / 1000.0
    } else {
        value
    };
    secs as i64
}

// CSV columns (v3): Date, Cloud Agent ID, Automation ID, Kind, Model,
// Max Mode, Input (w/ Cache Write), Input (w/o Cache Write), Cache Read,
// Output Tokens, Total Tokens, Cost. Older exports drop leading columns, so
// fields are located by header name rather than position.
pub(crate) fn parse_usage_csv(text: &str) -> BTreeMap<String, TokenTotals> {
    let mut days: BTreeMap<String, TokenTotals> = BTreeMap::new();
    let mut lines = text.lines().filter(|line| !line.trim().is_empty());
    let Some(header) = lines.next() else {
        return days;
    };
    let columns: Vec<String> = split_csv_line(header)
        .into_iter()
        .map(|c| c.trim().trim_matches('"').to_string())
        .collect();
    let index = |name: &str| columns.iter().position(|c| c == name);
    let Some(date_column) = index("Date") else {
        return days;
    };
    let input_column = index("Input (w/o Cache Write)");
    let cache_write_column = index("Input (w/ Cache Write)");
    let cache_read_column = index("Cache Read");
    let output_column = index("Output Tokens");
    for line in lines {
        let fields = split_csv_line(line);
        let Some(raw_date) = fields.get(date_column) else {
            continue;
        };
        let date = csv_date(raw_date.trim().trim_matches('"'));
        let number = |column: Option<usize>| {
            column
                .and_then(|i| fields.get(i))
                .map(|f| parse_count(f))
                .unwrap_or(0)
        };
        let mut tokens = TokenTotals {
            input: number(input_column),
            output: number(output_column),
            cache_read: number(cache_read_column),
            cache_write: number(cache_write_column),
            reasoning: 0,
            total: 0,
        };
        tokens.recompute_total();
        if tokens.total == 0 {
            continue;
        }
        days.entry(date).or_default().add(&tokens);
    }
    days
}

fn split_csv_line(line: &str) -> Vec<&str> {
    let mut fields = Vec::new();
    let mut start = 0;
    let mut in_quotes = false;
    for (i, byte) in line.bytes().enumerate() {
        match byte {
            b'"' => in_quotes = !in_quotes,
            b',' if !in_quotes => {
                fields.push(&line[start..i]);
                start = i + 1;
            }
            _ => {}
        }
    }
    fields.push(&line[start..]);
    fields
}

fn parse_count(field: &str) -> u64 {
    let cleaned: String = field.chars().filter(|c| c.is_ascii_digit()).collect();
    cleaned.parse().unwrap_or(0)
}

fn csv_date(value: &str) -> String {
    if let Some(date) = date_from_iso(value) {
        return date;
    }
    let is_plain_date = value.len() == 10
        && value.chars().enumerate().all(|(i, c)| match i {
            4 | 7 => c == '-',
            _ => c.is_ascii_digit(),
        });
    if is_plain_date {
        return value.to_string();
    }
    unknown_date()
}

/// Cookie for `token`, or the reason it cannot be used.
fn session_cookie_for(token: &str) -> Result<String, String> {
    if token_expires_within(token, 60) {
        return Err("Cursor login expired — sign in to Cursor or run `cursor-agent login`".into());
    }
    let Some(user_id) = user_id_from_jwt(token) else {
        return Err("could not derive user id from Cursor access token".into());
    };
    Ok(format!("WorkosCursorSessionToken={user_id}%3A%3A{token}"))
}

/// Every token found on disk, IDE state first, then the `cursor-agent` CLI.
fn access_token_candidates() -> Vec<String> {
    let mut tokens: Vec<String> = Vec::new();
    for path in state_vscdb_candidates() {
        if let Some(token) = read_token_from_vscdb(&path) {
            tokens.push(token);
        }
    }
    for path in auth_json_candidates() {
        if let Some(token) = read_token_from_auth_json(&path) {
            tokens.push(token);
        }
    }
    tokens.dedup();
    tokens
}

fn state_vscdb_candidates() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    let Some(home) = platform_command::user_home_dir() else {
        return paths;
    };
    #[cfg(target_os = "macos")]
    paths.push(home.join("Library/Application Support/Cursor/User/globalStorage/state.vscdb"));
    #[cfg(target_os = "windows")]
    {
        let appdata = std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData/Roaming"));
        paths.push(appdata.join("Cursor/User/globalStorage/state.vscdb"));
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let config = std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".config"));
        paths.push(config.join("Cursor/User/globalStorage/state.vscdb"));
    }
    paths
}

fn auth_json_candidates() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    let Some(home) = platform_command::user_home_dir() else {
        return paths;
    };
    #[cfg(target_os = "windows")]
    {
        let appdata = std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData/Roaming"));
        paths.push(appdata.join("cursor/auth.json"));
        paths.push(appdata.join("cursor-agent/auth.json"));
    }
    #[cfg(not(target_os = "windows"))]
    {
        let config = std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".config"));
        paths.push(config.join("cursor/auth.json"));
        paths.push(config.join("cursor-agent/auth.json"));
    }
    paths.push(home.join(".cursor/auth.json"));
    paths
}

fn read_token_from_vscdb(path: &std::path::Path) -> Option<String> {
    if !path.is_file() {
        return None;
    }
    let conn =
        rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .ok()?;
    let value: String = conn
        .query_row(
            "SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken'",
            [],
            |row| row.get(0),
        )
        .ok()?;
    normalize_token(&value)
}

fn read_token_from_auth_json(path: &std::path::Path) -> Option<String> {
    let contents = std::fs::read_to_string(path).ok()?;
    let value: Value = serde_json::from_str(&contents).ok()?;
    let token = value
        .get("accessToken")
        .or_else(|| value.get("access_token"))
        .and_then(Value::as_str)?;
    normalize_token(token)
}

/// Some Cursor stores keep the token JSON-encoded (`"abc"`); unwrap one level.
fn normalize_token(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(Value::String(inner)) = serde_json::from_str::<Value>(trimmed) {
        let inner = inner.trim().to_string();
        return (!inner.is_empty()).then_some(inner);
    }
    Some(trimmed.to_string())
}

pub(crate) fn user_id_from_jwt(token: &str) -> Option<String> {
    let sub = jwt_payload(token)?;
    let sub = sub.get("sub").and_then(Value::as_str)?;
    let id = sub.rsplit('|').next()?.trim();
    let valid = !id.is_empty()
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    valid.then(|| id.to_string())
}

fn token_expires_within(token: &str, margin_seconds: i64) -> bool {
    let Some(exp) = jwt_payload(token).and_then(|p| p.get("exp").and_then(Value::as_i64)) else {
        return false;
    };
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    exp <= now + margin_seconds
}

fn jwt_payload(token: &str) -> Option<Value> {
    let part = token.split('.').nth(1)?;
    let bytes = base64url_decode(part)?;
    serde_json::from_slice(&bytes).ok()
}

fn base64url_decode(input: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(input.len() * 3 / 4);
    let mut buffer: u32 = 0;
    let mut bits = 0;
    for c in input.chars() {
        let value = match c {
            'A'..='Z' => c as u32 - 'A' as u32,
            'a'..='z' => c as u32 - 'a' as u32 + 26,
            '0'..='9' => c as u32 - '0' as u32 + 52,
            '-' | '+' => 62,
            '_' | '/' => 63,
            '=' => continue,
            _ => return None,
        };
        buffer = (buffer << 6) | value;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests;
