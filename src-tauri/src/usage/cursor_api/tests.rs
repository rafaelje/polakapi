use super::*;
use serde_json::json;

#[test]
fn session_cookie_rejects_a_token_without_a_usable_sub_claim() {
    assert!(session_cookie_for("not-a-jwt").is_err());
}

#[test]
fn parses_summary_with_plan_percents() {
    let raw = json!({
        "membershipType": "pro",
        "billingCycleEnd": 1_800_000_000_i64,
        "individualUsage": {
            "plan": {
                "totalPercentUsed": 41.5,
                "autoPercentUsed": 60.0,
                "apiPercentUsed": 23.0
            }
        }
    });
    let out = parse_summary(&raw);
    assert_eq!(out.membership_type.as_deref(), Some("pro"));
    let plan = out.plan.unwrap();
    assert!((plan.used_percent - 41.5).abs() < f64::EPSILON);
    assert_eq!(plan.resets_at, Some(1_800_000_000));
    assert!((out.auto.unwrap().used_percent - 60.0).abs() < f64::EPSILON);
    assert!((out.api.unwrap().used_percent - 23.0).abs() < f64::EPSILON);
}

#[test]
fn summary_headline_falls_back_to_used_limit_ratio() {
    let raw = json!({
        "billingCycleEnd": "2026-09-01T00:00:00Z",
        "individualUsage": { "plan": { "used": 25, "limit": 100 } }
    });
    let out = parse_summary(&raw);
    assert!((out.plan.unwrap().used_percent - 25.0).abs() < f64::EPSILON);
    assert!(out.auto.is_none());
    assert!(out.api.is_none());
}

#[test]
fn summary_without_usage_has_no_windows() {
    let out = parse_summary(&json!({}));
    assert!(out.plan.is_none());
    assert!(out.membership_type.is_none());
}

#[test]
fn parses_v3_csv_into_daily_buckets() {
    let csv = "\
Date,Cloud Agent ID,Automation ID,Kind,Model,Max Mode,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost
2026-08-20T10:00:00.000Z,,,\"Included\",claude-4-sonnet,No,\"1,000\",200,5000,300,6500,$0.12
2026-08-20T11:00:00.000Z,,,\"Included\",gpt-5,No,0,100,0,50,150,$0.01
2026-08-19T09:00:00.000Z,,,\"Errored\",claude-4-sonnet,No,0,0,0,0,0,$0.00
2026-08-19T08:00:00.000Z,,,\"Included\",claude-4-sonnet,No,10,20,30,40,100,$0.02
";
    let days = parse_usage_csv(csv);
    assert_eq!(days.len(), 2);
    let day20 = &days["2026-08-20"];
    assert_eq!(day20.cache_write, 1_000);
    assert_eq!(day20.input, 300);
    assert_eq!(day20.cache_read, 5_000);
    assert_eq!(day20.output, 350);
    assert_eq!(day20.total, 6_650);
    assert_eq!(days["2026-08-19"].total, 100);
}

#[test]
fn csv_with_reordered_columns_still_parses() {
    let csv = "\
Date,Model,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost,Cost to you
2026-08-18,claude-4,5,10,15,20,50,$0.01,$0.00
";
    let days = parse_usage_csv(csv);
    assert_eq!(days["2026-08-18"].total, 50);
}

#[test]
fn csv_without_date_header_is_empty() {
    assert!(parse_usage_csv("Model,Tokens\nx,1\n").is_empty());
}

#[test]
fn user_id_comes_from_jwt_sub_tail() {
    let payload = json!({"sub": "auth0|user_abc123", "exp": 4_000_000_000_i64});
    let token = fake_jwt(&payload);
    assert_eq!(user_id_from_jwt(&token).as_deref(), Some("user_abc123"));
    assert!(!token_expires_within(&token, 60));
}

#[test]
fn expired_jwt_is_detected() {
    let token = fake_jwt(&json!({"sub": "auth0|user_x", "exp": 1_000_000_000_i64}));
    assert!(token_expires_within(&token, 60));
}

#[test]
fn normalize_token_unwraps_json_encoded_strings() {
    assert_eq!(normalize_token("\"abc\"").as_deref(), Some("abc"));
    assert_eq!(normalize_token("abc").as_deref(), Some("abc"));
    assert_eq!(normalize_token("  "), None);
}

#[tokio::test]
async fn auth_failure_tries_the_next_credential() {
    use std::cell::Cell;
    use std::rc::Rc;

    let first = fake_jwt(&json!({"sub": "auth0|first", "exp": 4_000_000_000_i64}));
    let second = fake_jwt(&json!({"sub": "auth0|second", "exp": 4_000_000_000_i64}));
    let attempts = Rc::new(Cell::new(0));
    let seen = attempts.clone();

    let result = fetch_from_tokens(vec![first, second], move |_| {
        let attempt = seen.get() + 1;
        seen.set(attempt);
        std::future::ready(if attempt == 1 {
            Err(CursorRequestError::Auth("revoked".to_string()))
        } else {
            Ok(CursorData {
                daily: BTreeMap::new(),
                summary: Some(parse_summary(&json!({"membershipType": "pro"}))),
                warnings: Vec::new(),
            })
        })
    })
    .await
    .unwrap();

    assert_eq!(attempts.get(), 2);
    assert_eq!(
        result
            .and_then(|data| data.summary)
            .and_then(|summary| summary.membership_type)
            .as_deref(),
        Some("pro")
    );
}

fn fake_jwt(payload: &Value) -> String {
    let encode = |bytes: &[u8]| {
        const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        let mut out = String::new();
        for chunk in bytes.chunks(3) {
            let b = [
                chunk[0],
                chunk.get(1).copied().unwrap_or(0),
                chunk.get(2).copied().unwrap_or(0),
            ];
            let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
            out.push(ALPHABET[(n >> 18) as usize & 63] as char);
            out.push(ALPHABET[(n >> 12) as usize & 63] as char);
            if chunk.len() > 1 {
                out.push(ALPHABET[(n >> 6) as usize & 63] as char);
            }
            if chunk.len() > 2 {
                out.push(ALPHABET[n as usize & 63] as char);
            }
        }
        out
    };
    format!(
        "{}.{}.sig",
        encode(b"{\"alg\":\"none\"}"),
        encode(payload.to_string().as_bytes())
    )
}
