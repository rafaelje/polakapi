use std::collections::HashMap;

// Computes what to hand the model in place of aggregate data. The point is the
// shape — how much, how varied, what went wrong — not the lines themselves,
// which stay on disk for the user.

const MAX_REPEATS: usize = 3;
const SAMPLE_LINES: usize = 2;
const MAX_LINE_CHARS: usize = 160;

pub fn summarize(source: &str, text: &str) -> String {
    let lines: Vec<&str> = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .collect();
    let bytes = text.len();
    if lines.is_empty() {
        return format!("{source}: {bytes} bytes, no content lines.");
    }

    let mut out = Vec::new();
    let distinct: HashMap<&str, usize> = lines.iter().fold(HashMap::new(), |mut acc, line| {
        *acc.entry(*line).or_insert(0) += 1;
        acc
    });
    out.push(format!(
        "{source}: {} lines ({} distinct), {} bytes.",
        lines.len(),
        distinct.len(),
        bytes
    ));

    let levels = level_counts(&lines);
    if !levels.is_empty() {
        out.push(format!("Levels: {}.", levels.join(", ")));
    }

    let mut repeats: Vec<(&str, usize)> = distinct
        .into_iter()
        .filter(|(_, count)| *count > 1)
        .collect();
    if !repeats.is_empty() {
        repeats.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(b.0)));
        out.push("Most repeated:".to_string());
        for (line, count) in repeats.into_iter().take(MAX_REPEATS) {
            out.push(format!("  {count}x {}", clip(line)));
        }
    }

    out.push("First:".to_string());
    for line in lines.iter().take(SAMPLE_LINES) {
        out.push(format!("  {}", clip(line)));
    }
    if lines.len() > SAMPLE_LINES * 2 {
        out.push("Last:".to_string());
        for line in lines.iter().rev().take(SAMPLE_LINES).rev() {
            out.push(format!("  {}", clip(line)));
        }
    }
    out.join("\n")
}

fn level_counts(lines: &[&str]) -> Vec<String> {
    const LEVELS: &[&str] = &["FATAL", "ERROR", "WARN", "INFO", "DEBUG"];
    let mut out = Vec::new();
    for level in LEVELS {
        let count = lines
            .iter()
            .filter(|line| line.to_ascii_uppercase().contains(level))
            .count();
        if count > 0 {
            out.push(format!("{level} {count}"));
        }
    }
    out
}

fn clip(line: &str) -> String {
    let trimmed = line.trim();
    if trimmed.chars().count() <= MAX_LINE_CHARS {
        return trimmed.to_string();
    }
    let head: String = trimmed.chars().take(MAX_LINE_CHARS).collect();
    format!("{head}…")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_volume_and_variety() {
        let text = "alpha\nbeta\nalpha\ngamma";
        let summary = summarize("exec:shell", text);
        assert!(summary.contains("4 lines (3 distinct)"), "{summary}");
    }

    #[test]
    fn counts_log_levels() {
        let text = "INFO ok\nERROR boom\nERROR boom again\nWARN slow";
        let summary = summarize("exec:shell", text);
        assert!(summary.contains("ERROR 2"), "{summary}");
        assert!(summary.contains("WARN 1"), "{summary}");
    }

    #[test]
    fn surfaces_the_most_repeated_line() {
        let mut text = String::new();
        for _ in 0..5 {
            text.push_str("connection refused\n");
        }
        text.push_str("done\n");
        let summary = summarize("exec:shell", &text);
        assert!(summary.contains("5x connection refused"), "{summary}");
    }

    #[test]
    fn is_far_smaller_than_the_input() {
        let text: String = (0..2_000)
            .map(|i| format!("request {i} served in 12ms\n"))
            .collect();
        let summary = summarize("exec:shell", &text);
        assert!(
            summary.len() * 20 < text.len(),
            "summary {} vs input {}",
            summary.len(),
            text.len()
        );
    }

    #[test]
    fn clips_very_long_lines() {
        let text = format!("{}\nshort\n", "x".repeat(500));
        let summary = summarize("exec:shell", &text);
        assert!(summary.contains('…'));
        assert!(!summary.contains(&"x".repeat(300)));
    }

    #[test]
    fn handles_empty_and_blank_input() {
        assert!(summarize("exec:shell", "").contains("no content lines"));
        assert!(summarize("exec:shell", "  \n\n ").contains("no content lines"));
    }

    #[test]
    fn skips_the_last_sample_when_everything_already_showed() {
        let summary = summarize("exec:shell", "one\ntwo");
        assert!(summary.contains("First:"));
        assert!(!summary.contains("Last:"));
    }
}
