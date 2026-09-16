use serde::Serialize;

// Decides what happens to a tool result: leave it alone, replace it with a
// computed summary, or index it and hand back a pointer.
//
// The split is not about size alone. Text whose exact wording matters — docs,
// code, tool schemas — is indexed even when it is large, because a summary
// saying "3 sections about cleanup" is useless for writing code. Data that
// aggregates well — logs, CSV, test output — is summarised, because the shape
// matters and the individual lines do not.

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Route {
    /// Small enough that offloading would cost more context than it saves.
    Bypass,
    /// Replaced by a computed summary; the raw bytes stay on disk for the user.
    Summarize,
    /// Indexed and replaced by a pointer the model queries.
    Index,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DataKind {
    /// Wording must survive intact.
    ExactText,
    /// Only the shape matters.
    Aggregate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Policy {
    pub bypass_bytes: u64,
    pub externalize_bytes: u64,
}

impl Default for Policy {
    fn default() -> Self {
        Self {
            bypass_bytes: 1024,
            externalize_bytes: 100 * 1024,
        }
    }
}

pub fn route(bytes: u64, kind: DataKind, policy: &Policy) -> Route {
    if bytes < policy.bypass_bytes {
        return Route::Bypass;
    }
    // Never summarise text that has to stay verbatim, and never summarise
    // something huge — at that size a summary throws away too much.
    if kind == DataKind::ExactText || bytes > policy.externalize_bytes {
        return Route::Index;
    }
    Route::Summarize
}

/// Best guess at whether the wording matters, from the source label and a
/// sample of the content.
pub fn classify(source: &str, sample: &str) -> DataKind {
    let label = source.to_ascii_lowercase();
    // Anything fetched or read is reference material by default.
    if label.starts_with("fetch:") || label.starts_with("read:") || label.starts_with("docs:") {
        return DataKind::ExactText;
    }
    if sample.contains("```") {
        return DataKind::ExactText;
    }
    if looks_tabular(sample) || looks_like_log(sample) {
        return DataKind::Aggregate;
    }
    if has_markdown_headings(sample) {
        return DataKind::ExactText;
    }
    DataKind::Aggregate
}

fn has_markdown_headings(sample: &str) -> bool {
    sample
        .lines()
        .any(|line| line.starts_with("# ") || line.starts_with("## ") || line.starts_with("### "))
}

/// Comma or tab separated with a stable column count across most lines.
fn looks_tabular(sample: &str) -> bool {
    let lines: Vec<&str> = sample
        .lines()
        .filter(|line| !line.trim().is_empty())
        .take(20)
        .collect();
    if lines.len() < 3 {
        return false;
    }
    for separator in [',', '\t'] {
        let counts: Vec<usize> = lines
            .iter()
            .map(|line| line.matches(separator).count())
            .collect();
        let first = counts[0];
        if first >= 1 && counts.iter().all(|count| *count == first) {
            return true;
        }
    }
    false
}

/// Most lines opening with a timestamp or a level marker.
fn looks_like_log(sample: &str) -> bool {
    let lines: Vec<&str> = sample
        .lines()
        .filter(|line| !line.trim().is_empty())
        .take(20)
        .collect();
    if lines.len() < 3 {
        return false;
    }
    let matching = lines
        .iter()
        .filter(|line| starts_with_timestamp(line) || has_level_marker(line))
        .count();
    matching * 2 > lines.len()
}

fn starts_with_timestamp(line: &str) -> bool {
    let bytes = line.as_bytes();
    // "2026-09-16…" or "12:34:56…" or a bracketed/quoted prefix as in access logs.
    if bytes.len() >= 10 && bytes[..4].iter().all(u8::is_ascii_digit) && bytes[4] == b'-' {
        return true;
    }
    if bytes.len() >= 8 && bytes[..2].iter().all(u8::is_ascii_digit) && bytes[2] == b':' {
        return true;
    }
    line.starts_with('[') || line.contains(" - - [")
}

fn has_level_marker(line: &str) -> bool {
    const LEVELS: &[&str] = &["ERROR", "WARN", "INFO", "DEBUG", "TRACE", "FATAL"];
    let head: String = line
        .chars()
        .take(64)
        .collect::<String>()
        .to_ascii_uppercase();
    LEVELS.iter().any(|level| head.contains(level))
}

#[cfg(test)]
mod tests {
    use super::*;

    const POLICY: Policy = Policy {
        bypass_bytes: 1024,
        externalize_bytes: 100 * 1024,
    };

    #[test]
    fn small_output_is_left_alone() {
        // Measured upstream: at 0.4 KB the machinery saves 13%, which is noise.
        assert_eq!(route(400, DataKind::Aggregate, &POLICY), Route::Bypass);
        assert_eq!(route(400, DataKind::ExactText, &POLICY), Route::Bypass);
    }

    #[test]
    fn exact_text_is_indexed_never_summarised() {
        assert_eq!(route(50_000, DataKind::ExactText, &POLICY), Route::Index);
    }

    #[test]
    fn aggregate_data_in_the_middle_band_is_summarised() {
        assert_eq!(
            route(50_000, DataKind::Aggregate, &POLICY),
            Route::Summarize
        );
    }

    #[test]
    fn very_large_output_is_indexed_even_when_it_aggregates() {
        assert_eq!(route(500_000, DataKind::Aggregate, &POLICY), Route::Index);
    }

    #[test]
    fn fetched_and_read_sources_keep_their_wording() {
        assert_eq!(
            classify("fetch:react-docs", "plain prose"),
            DataKind::ExactText
        );
        assert_eq!(
            classify("read:src/main.rs", "plain prose"),
            DataKind::ExactText
        );
    }

    #[test]
    fn code_fences_mark_content_as_exact() {
        assert_eq!(
            classify("exec:shell", "before\n```js\ncode\n```\nafter"),
            DataKind::ExactText
        );
    }

    #[test]
    fn csv_is_recognised_as_aggregate() {
        let csv = "a,b,c\n1,2,3\n4,5,6\n7,8,9";
        assert_eq!(classify("exec:shell", csv), DataKind::Aggregate);
    }

    #[test]
    fn log_lines_are_recognised_as_aggregate() {
        let log = "2026-09-16T10:00:00 INFO started\n2026-09-16T10:00:01 WARN slow\n2026-09-16T10:00:02 ERROR failed";
        assert_eq!(classify("exec:shell", log), DataKind::Aggregate);
    }

    #[test]
    fn markdown_documents_keep_their_wording() {
        let doc = "# Title\n\nsome prose\n\n## Section\n\nmore prose";
        assert_eq!(classify("exec:shell", doc), DataKind::ExactText);
    }

    #[test]
    fn a_couple_of_comma_lines_are_not_a_table() {
        assert_eq!(
            classify("exec:shell", "hello, world\nbye, now"),
            DataKind::Aggregate
        );
    }
}
