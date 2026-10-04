use std::path::Path;

use sha2::{Digest, Sha256};

use crate::ctx::chunk::chunk_default;
use crate::ctx::router::{classify, route, DataKind, Policy, Route};
use crate::ctx::store::CtxStore;
use crate::ctx::summarize::summarize;

// Ties the pieces together: decide the route, write the raw bytes to disk for
// the user, index or summarise, and return the only thing the model sees.

/// How much of the text the classifier looks at before deciding.
const SAMPLE_BYTES: usize = 8 * 1024;

#[derive(Debug, Clone)]
pub struct OffloadResult {
    pub route: Route,
    /// The text that goes back into the model's context.
    pub context_text: String,
    pub raw_bytes: u64,
}

pub fn offload(
    store: &mut CtxStore,
    artifacts_dir: Option<&Path>,
    session_id: &str,
    source: &str,
    text: &str,
    policy: &Policy,
) -> Result<OffloadResult, String> {
    let raw_bytes = text.len() as u64;
    let sample = &text[..floor_char_boundary(text, SAMPLE_BYTES)];
    let kind = classify(source, sample);
    let decision = route(raw_bytes, kind, policy);

    if decision == Route::Bypass {
        // Nothing is recorded: there is no saving to account for, and the model
        // already has the content.
        return Ok(OffloadResult {
            route: decision,
            context_text: text.to_string(),
            raw_bytes,
        });
    }

    let artifact = artifacts_dir
        .and_then(|dir| write_artifact(dir, source, text).ok())
        .map(|path| path.to_string_lossy().into_owned());

    // Everything offloaded is indexed, whatever the model is handed back. A
    // summary is a convenience, never the only copy: the agent asked for this
    // output and has to be able to get all of it, exactly as it was.
    let chunks = chunk_default(text);
    // A log past the externalize threshold is still summarised: its failures
    // are what the agent needs, and a bare pointer would hide them.
    let context_text = if decision == Route::Summarize || kind == DataKind::Aggregate {
        format!("{}\n{}", summarize(source, text), retrieval_hint(source))
    } else {
        pointer(source, &chunks)
    };

    store.put_source(
        crate::ctx::store::NewSource {
            session_id,
            source,
            kind: kind_label(kind),
            raw_bytes,
            context_bytes: context_text.len() as u64,
            artifact: artifact.as_deref(),
        },
        &chunks,
    )?;

    Ok(OffloadResult {
        route: decision,
        context_text,
        raw_bytes,
    })
}

/// The largest index at or below `index` that does not split a UTF-8
/// character, so a byte budget can be applied to any text without panicking.
pub(crate) fn floor_char_boundary(text: &str, index: usize) -> usize {
    if index >= text.len() {
        return text.len();
    }
    let mut boundary = index;
    while !text.is_char_boundary(boundary) {
        boundary -= 1;
    }
    boundary
}

fn kind_label(kind: crate::ctx::router::DataKind) -> &'static str {
    match kind {
        crate::ctx::router::DataKind::ExactText => "exact",
        crate::ctx::router::DataKind::Aggregate => "aggregate",
    }
}

/// How to reach the full output, appended to a summary so the agent knows the
/// lines behind it are still available.
pub fn retrieval_hint(source: &str) -> String {
    let polakapi = polakapi_command();
    format!(
        "Full output kept: `{polakapi} ctx search <query> --source {source}`, \
         then `{polakapi} ctx read {source} <n>`."
    )
}

/// This binary, quoted for a shell. polakapi is rarely on PATH, so the model is
/// told the path it was actually run from.
pub fn polakapi_command() -> String {
    std::env::current_exe()
        .map(|bin| crate::ctx::intercept::shell_quote(&bin.to_string_lossy()))
        .unwrap_or_else(|_| "polakapi".to_string())
}

/// What replaces the raw bytes in the context. Deliberately carries no path to
/// the stored output: the handle is a query scope, so the model cannot read the
/// whole thing back in and undo the saving.
const MAX_LISTED_SECTIONS: usize = 12;
const MAX_SECTION_TITLE_CHARS: usize = 80;

pub fn pointer(source: &str, chunks: &[crate::ctx::store::NewChunk]) -> String {
    let with_code = chunks.iter().filter(|chunk| chunk.has_code).count();
    let polakapi = polakapi_command();
    let mut out = format!(
        "Indexed {} sections ({with_code} with code) from: {source}\n",
        chunks.len()
    );
    // Titles let the agent read the right section without a blind search.
    for (n, chunk) in chunks.iter().enumerate().take(MAX_LISTED_SECTIONS) {
        out.push_str(&format!("  {n} {}\n", section_title(chunk)));
    }
    if chunks.len() > MAX_LISTED_SECTIONS {
        out.push_str(&format!(
            "  … {} more\n",
            chunks.len() - MAX_LISTED_SECTIONS
        ));
    }
    out.push_str(&format!(
        "Search it with `{polakapi} ctx search <query> --source {source}`,\n\
         then read a section verbatim with `{polakapi} ctx read {source} <n>`."
    ));
    out
}

fn section_title(chunk: &crate::ctx::store::NewChunk) -> String {
    let title = chunk
        .heading
        .as_deref()
        .or_else(|| {
            chunk
                .body
                .lines()
                .map(str::trim)
                .find(|line| !line.is_empty())
        })
        .unwrap_or("");
    let clipped: String = title.chars().take(MAX_SECTION_TITLE_CHARS).collect();
    if clipped.len() < title.len() {
        format!("{clipped}…")
    } else {
        clipped
    }
}

fn write_artifact(dir: &Path, source: &str, text: &str) -> Result<std::path::PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    let mut hasher = Sha256::new();
    hasher.update(source.as_bytes());
    let digest = hasher.finalize();
    let name = format!("{:x}.txt", digest);
    let path = dir.join(&name[..name.len().min(20)]);
    std::fs::write(&path, text).map_err(|e| format!("could not write {}: {e}", path.display()))?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy() -> Policy {
        // A wide middle band, so these tests exercise the kind-based choice
        // rather than the size ceiling (which router.rs covers on its own).
        Policy {
            bypass_bytes: 100,
            externalize_bytes: 1_000_000,
        }
    }

    fn store() -> CtxStore {
        CtxStore::open_in_memory().unwrap()
    }

    #[test]
    fn small_output_passes_through_untouched_and_is_not_recorded() {
        let mut store = store();
        let result = offload(&mut store, None, "s1", "exec:shell", "tiny", &policy()).unwrap();
        assert_eq!(result.route, Route::Bypass);
        assert_eq!(result.context_text, "tiny");
        assert!(store.list_sources("s1").unwrap().is_empty());
    }

    #[test]
    fn log_data_comes_back_as_a_summary_far_smaller_than_the_input() {
        let mut store = store();
        let text: String = (0..300)
            .map(|i| format!("2026-09-16T10:00:00 INFO request {i} ok\n"))
            .collect();
        let result = offload(&mut store, None, "s1", "exec:shell", &text, &policy()).unwrap();
        assert_eq!(result.route, Route::Summarize);
        assert!(result.context_text.contains("300 lines"));
        assert!(result.context_text.len() * 10 < text.len());
        // Recorded, so the saving can be reported.
        assert_eq!(store.savings("s1").unwrap().0, text.len() as u64);
    }

    #[test]
    fn documentation_is_indexed_and_answered_by_a_pointer() {
        let mut store = store();
        let text = format!(
            "# Effects\n\n```js\nuseEffect(() => {{}})\n```\n{}",
            "prose ".repeat(200)
        );
        let result = offload(&mut store, None, "s1", "fetch:react", &text, &policy()).unwrap();
        assert_eq!(result.route, Route::Index);
        assert!(result.context_text.starts_with("Indexed "));
        assert!(result.context_text.contains("fetch:react"));
        // The pointer must not leak where the output is stored.
        assert!(!result.context_text.contains(".txt"));
        assert!(result.context_text.contains(&polakapi_command()));
        assert!(!result.context_text.contains("ctx_search"));
    }

    #[test]
    fn summarised_output_is_still_there_in_full() {
        // The user's point: we store everything, a summary is only what the
        // model is handed. Losing the lines behind it would be a data loss.
        let mut store = store();
        let text: String = (0..300)
            .map(|i| {
                format!(
                    "2026-09-16T10:00:00 INFO request {i} from tenant-{}\n",
                    i % 7
                )
            })
            .collect();
        let result = offload(&mut store, None, "s1", "log:web", &text, &policy()).unwrap();
        assert_eq!(result.route, Route::Summarize);
        assert!(result.context_text.contains("300 lines"));
        assert!(result.context_text.contains("ctx search"));

        // Every line is retrievable, not just the summary.
        let hits = store.search("s1", "tenant-3", None, 5).unwrap();
        assert!(!hits.is_empty(), "summarised output must stay searchable");
        let body = store.read_chunk("s1", "log:web", 0).unwrap().unwrap();
        assert!(body.contains("request 3 from tenant-3"));
    }

    #[test]
    fn nothing_offloaded_is_lost_whatever_the_route() {
        let mut store = store();
        let text: String = (0..200).map(|i| format!("plain line {i}\n")).collect();
        offload(&mut store, None, "s1", "exec:thing", &text, &policy()).unwrap();
        let stored: String = (0..)
            .map_while(|n| store.read_chunk("s1", "exec:thing", n).unwrap())
            .collect();
        assert_eq!(
            stored, text,
            "the stored copy must match the output exactly"
        );
    }

    #[test]
    fn an_indexed_source_is_searchable_afterwards() {
        let mut store = store();
        let text = format!(
            "# Effects\n\n```js\nuseEffect(cleanup)\n```\n{}",
            "prose ".repeat(200)
        );
        offload(&mut store, None, "s1", "fetch:react", &text, &policy()).unwrap();
        let hits = store.search("s1", "cleanup", None, 5).unwrap();
        assert_eq!(hits.len(), 1);
        assert!(hits[0].has_code);
    }

    #[test]
    fn the_raw_bytes_are_kept_on_disk_for_the_user() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = store();
        let text: String = (0..300).map(|i| format!("line {i}\n")).collect();
        offload(
            &mut store,
            Some(dir.path()),
            "s1",
            "exec:shell",
            &text,
            &policy(),
        )
        .unwrap();
        let written: Vec<_> = std::fs::read_dir(dir.path()).unwrap().flatten().collect();
        assert_eq!(written.len(), 1);
        assert_eq!(std::fs::read_to_string(written[0].path()).unwrap(), text);
    }

    #[test]
    fn a_multibyte_character_across_the_sample_limit_does_not_panic() {
        let mut store = store();
        let text = format!("{}é", "a".repeat(SAMPLE_BYTES - 1));
        offload(&mut store, None, "s1", "exec:shell", &text, &policy()).unwrap();
        assert_eq!(floor_char_boundary(&text, SAMPLE_BYTES), SAMPLE_BYTES - 1);
    }

    #[test]
    fn a_pointer_counts_the_code_sections() {
        let chunks = chunk_default("# A\n```\nx\n```\n\n# B\nprose");
        let text = pointer("exec:shell", &chunks);
        assert!(text.contains("2 sections (1 with code)"), "{text}");
    }
}
