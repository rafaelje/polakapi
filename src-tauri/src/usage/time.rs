use serde_json::Value;

pub(super) fn as_u64(value: Option<&Value>) -> u64 {
    match value {
        Some(v) => v.as_u64().unwrap_or_else(|| {
            v.as_i64()
                .map(|n| if n < 0 { 0 } else { n as u64 })
                .unwrap_or(0)
        }),
        None => 0,
    }
}

pub(super) fn date_from_iso(value: &str) -> Option<String> {
    // ISO 8601: "YYYY-MM-DDTHH:MM:SS...". Take the leading date portion.
    let (date, rest) = value.split_once('T')?;
    if date.len() != 10 {
        return None;
    }
    if !rest.chars().next()?.is_ascii_digit() {
        return None;
    }
    let valid = date.chars().enumerate().all(|(i, c)| match i {
        4 | 7 => c == '-',
        _ => c.is_ascii_digit(),
    });
    valid.then(|| date.to_string())
}

/// Convert an ISO 8601 UTC timestamp ("YYYY-MM-DDTHH:MM:SS[.fff]Z" or with an
/// explicit `+00:00` offset) to epoch seconds. Returns None on any deviation
/// — we only need this for local Claude/Codex logs, which always emit UTC.
pub(crate) fn iso_to_epoch_seconds(value: &str) -> Option<i64> {
    let (date, rest) = value.split_once('T')?;
    if date.len() != 10 {
        return None;
    }
    let year: i64 = date.get(0..4)?.parse().ok()?;
    let month: u32 = date.get(5..7)?.parse().ok()?;
    let day: u32 = date.get(8..10)?.parse().ok()?;

    // Time portion: HH:MM:SS, trailing fractional seconds and 'Z' or '+00:00'
    // suffix are tolerated.
    let time_part = rest.split('.').next().unwrap_or(rest);
    let time_part = time_part
        .strip_suffix('Z')
        .or_else(|| time_part.strip_suffix("+00:00"))
        .unwrap_or(time_part);
    let mut segments = time_part.splitn(3, ':');
    let hour: i64 = segments.next()?.parse().ok()?;
    let minute: i64 = segments.next()?.parse().ok()?;
    let second: i64 = segments.next().unwrap_or("0").parse().ok()?;

    let days = days_from_civil(year, month, day)?;
    Some(days * 86_400 + hour * 3_600 + minute * 60 + second)
}

// Howard Hinnant's date algorithm — proleptic Gregorian, no external deps.
// Returns the number of days since 1970-01-01, or None on malformed input.
fn days_from_civil(y: i64, m: u32, d: u32) -> Option<i64> {
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400; // 0..399
    let m = m as i64;
    let d = d as i64;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146_097 + doe - 719_468)
}

pub(super) fn unknown_date() -> String {
    "unknown".to_string()
}
