use std::fs::File;
use std::io::Read;
use std::path::Path;

use serde::Serialize;

pub(super) const VERDICT_SCAN_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Verdict {
    Go,
    NoGo,
    Pending,
}

pub(super) fn read_verdict(path: &Path) -> Verdict {
    let Ok(file) = File::open(path) else {
        return Verdict::Pending;
    };
    let mut head = Vec::with_capacity(VERDICT_SCAN_BYTES);
    if file
        .take(VERDICT_SCAN_BYTES as u64)
        .read_to_end(&mut head)
        .is_err()
    {
        return Verdict::Pending;
    }
    parse_verdict(&String::from_utf8_lossy(&head))
}

pub(super) fn parse_verdict(html: &str) -> Verdict {
    let lower = html.to_ascii_lowercase();
    let mut from = 0;
    while let Some(offset) = lower[from..].find("<meta") {
        let start = from + offset + "<meta".len();
        let Some(length) = html[start..].find('>') else {
            return Verdict::Pending;
        };
        let tag = &html[start..start + length];
        from = start + length;
        if !tag.starts_with(|c: char| c.is_ascii_whitespace()) {
            continue;
        }
        let attributes = parse_attributes(tag);
        let named_verdict = attributes
            .iter()
            .any(|(name, value)| name == "name" && value.trim().eq_ignore_ascii_case("verdict"));
        if named_verdict {
            return attributes
                .iter()
                .find(|(name, _)| name == "content")
                .map_or(Verdict::Pending, |(_, value)| verdict_from(value));
        }
    }
    Verdict::Pending
}

fn verdict_from(value: &str) -> Verdict {
    let normalized: String = value
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_uppercase();
    match normalized.as_str() {
        "GO" => Verdict::Go,
        "NOGO" => Verdict::NoGo,
        _ => Verdict::Pending,
    }
}

fn parse_attributes(tag: &str) -> Vec<(String, String)> {
    let mut attributes = Vec::new();
    let mut rest = tag;
    loop {
        rest = rest.trim_start_matches(|c: char| c.is_ascii_whitespace() || c == '/');
        let name_end = rest
            .find(|c: char| c.is_ascii_whitespace() || c == '=' || c == '/')
            .unwrap_or(rest.len());
        if name_end == 0 {
            return attributes;
        }
        let name = rest[..name_end].to_ascii_lowercase();
        rest = rest[name_end..].trim_start();
        let Some(after_equals) = rest.strip_prefix('=') else {
            attributes.push((name, String::new()));
            continue;
        };
        let (value, remaining) = attribute_value(after_equals.trim_start());
        attributes.push((name, value.to_string()));
        rest = remaining;
    }
}

fn attribute_value(raw: &str) -> (&str, &str) {
    if let Some(quote) = raw.chars().next().filter(|c| *c == '"' || *c == '\'') {
        let body = &raw[1..];
        return match body.find(quote) {
            Some(end) => (&body[..end], &body[end + 1..]),
            None => (body, ""),
        };
    }
    let end = raw
        .find(|c: char| c.is_ascii_whitespace())
        .unwrap_or(raw.len());
    (&raw[..end], &raw[end..])
}

#[cfg(test)]
mod tests;
