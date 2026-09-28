use std::collections::HashMap;

// Computes what to hand the model in place of aggregate data. The point is the
// shape — how much, how varied, what went wrong — not the lines themselves,
// which stay on disk for the user.

const MAX_REPEATS: usize = 3;
const SAMPLE_LINES: usize = 2;
/// Test and build tools print their totals last.
const LAST_LINES: usize = 6;
const MAX_LINE_CHARS: usize = 160;
const MAX_PROBLEM_LINES: usize = 40;
/// Lines that name a failure, and how many lines after each carry its detail
/// (an assertion's values, a panic's message).
const PROBLEM_MARKERS: &[&str] = &[
    "error",
    "fail",
    "panic",
    "assert",
    "exception",
    "traceback",
    "warning",
    "✗",
    "×",
];
const PROBLEM_CONTEXT: usize = 1;

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

    let totals = total_lines(&lines);
    if !totals.is_empty() {
        out.push("Totals:".to_string());
        out.extend(totals.iter().map(|line| format!("  {}", clip(line))));
    }

    let (problems, more) = problem_lines(&lines);
    if !problems.is_empty() {
        out.push("Problems:".to_string());
        out.extend(problems.iter().map(|line| format!("  {}", clip(line))));
        if more > 0 {
            out.push(format!("  … {more} more problem lines stored"));
        }
    }

    out.push("First:".to_string());
    for line in lines.iter().take(SAMPLE_LINES) {
        out.push(format!("  {}", clip(line)));
    }
    if lines.len() > SAMPLE_LINES + LAST_LINES {
        out.push("Last:".to_string());
        for line in lines.iter().rev().take(LAST_LINES).rev() {
            out.push(format!("  {}", clip(line)));
        }
    } else if lines.len() > SAMPLE_LINES {
        out.push("Last:".to_string());
        for line in &lines[SAMPLE_LINES..] {
            out.push(format!("  {}", clip(line)));
        }
    }
    out.join("\n")
}

/// Every line naming a failure with the line after it, each once, so a test
/// run's summary says which tests failed and why. The rest is counted.
fn problem_lines<'a>(lines: &[&'a str]) -> (Vec<&'a str>, usize) {
    let mut picked: Vec<&str> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut more = 0;
    let mut context_left = 0;
    for line in lines {
        let lower = line.to_lowercase();
        let is_problem =
            !reports_success(&lower) && PROBLEM_MARKERS.iter().any(|marker| lower.contains(marker));
        if !is_problem && context_left == 0 {
            continue;
        }
        context_left = if is_problem {
            PROBLEM_CONTEXT
        } else {
            context_left - 1
        };
        if !seen.insert(line.trim()) {
            continue;
        }
        if picked.len() < MAX_PROBLEM_LINES {
            picked.push(line);
        } else {
            more += 1;
        }
    }
    (picked, more)
}

const MAX_TOTAL_LINES: usize = 6;

/// The counts a test or build run ends with, empty ones skipped.
fn total_lines<'a>(lines: &[&'a str]) -> Vec<&'a str> {
    let mut seen = std::collections::HashSet::new();
    lines
        .iter()
        .copied()
        .filter(|line| {
            let lower = line.to_lowercase();
            (lower.contains(" passed") || lower.trim_start().starts_with("test result"))
                && !lower.contains(" 0 passed")
        })
        .filter(|line| seen.insert(line.trim()))
        .take(MAX_TOTAL_LINES)
        .collect()
}

/// A passing check named after what it guards, like `test rejects_bad_input_with_an_error ... ok`.
fn reports_success(lower: &str) -> bool {
    let trimmed = lower.trim();
    trimmed.ends_with("... ok")
        || trimmed.ends_with("... ignored")
        || trimmed.starts_with('✓')
        || trimmed.starts_with('✔')
        || trimmed.starts_with("pass ")
        || trimmed.starts_with("ok ")
        || trimmed.contains(" 0 failed")
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
    fn names_the_failing_tests_and_why() {
        let mut text = String::from("running 152 tests\n");
        for i in 0..150 {
            text.push_str(&format!("test many::ok_{i} ... ok\n"));
        }
        text.push_str(
            "test many::broken ... FAILED\n\
             thread 'many::broken' panicked at src/lib.rs:156:34:\n\
             assertion `left == right` failed: math is off\n  left: 2\n right: 3\n\
             test result: FAILED. 151 passed; 1 failed; 0 ignored\n",
        );
        let summary = summarize("log:cargo-test", &text);
        for expected in [
            "many::broken ... FAILED",
            "math is off",
            "left: 2",
            "test result: FAILED",
        ] {
            assert!(summary.contains(expected), "{expected}: {summary}");
        }
        assert!(!summary.contains("ok_42"), "{summary}");
    }

    #[test]
    fn passing_checks_named_after_errors_are_not_problems() {
        let mut text = String::new();
        for i in 0..20 {
            text.push_str(&format!("test rejects_input_{i}_with_an_error ... ok\n"));
        }
        text.push_str(" ✓ src/a.test.ts > reports a failure 2ms\n");
        text.push_str("test result: ok. 21 passed; 0 failed; 0 ignored\n");
        let summary = summarize("log:cargo-test", &text);
        assert!(!summary.contains("Problems:"), "{summary}");
        assert!(
            summary.contains("Totals:\n  test result: ok. 21 passed"),
            "{summary}"
        );
    }

    #[test]
    fn caps_the_problem_lines() {
        let text: String = (0..200).map(|i| format!("warning: unused {i}\n")).collect();
        let summary = summarize("log:clippy", &text);
        assert!(summary.contains("more problem lines stored"), "{summary}");
        assert!(summary.len() < 8 * 1024, "{}", summary.len());
    }

    #[test]
    fn skips_the_last_sample_when_everything_already_showed() {
        let summary = summarize("exec:shell", "one\ntwo");
        assert!(summary.contains("First:"));
        assert!(!summary.contains("Last:"));
    }
}
