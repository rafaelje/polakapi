use std::path::Path;

use sha2::{Digest, Sha256};

use crate::ctx::chunk::chunk_default;
use crate::ctx::router::{classify, route, Policy, Route};
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
    let sample = &text[..text.len().min(SAMPLE_BYTES)];
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

    let (context_text, chunks) = match decision {
        Route::Summarize => (summarize(source, text), Vec::new()),
        _ => {
            let chunks = chunk_default(text);
            (pointer(source, &chunks), chunks)
        }
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

fn kind_label(kind: crate::ctx::router::DataKind) -> &'static str {
    match kind {
        crate::ctx::router::DataKind::ExactText => "exact",
        crate::ctx::router::DataKind::Aggregate => "aggregate",
    }
}

/// What replaces the raw bytes in the context. Deliberately carries no file
/// path: the handle is a query scope, so the model cannot read the whole thing
/// back in and undo the saving.
pub fn pointer(source: &str, chunks: &[crate::ctx::store::NewChunk]) -> String {
    let with_code = chunks.iter().filter(|chunk| chunk.has_code).count();
    format!(
        "Indexed {} sections ({with_code} with code) from: {source}\n\
         Search it with `polakapi ctx search <query> --source {source}` (or ctx_search),\n\
         then read a section verbatim with `polakapi ctx read {source} <n>`.",
        chunks.len()
    )
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
        // The pointer must not leak a filesystem path.
        assert!(!result.context_text.contains('/'));
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
    fn a_pointer_counts_the_code_sections() {
        let chunks = chunk_default("# A\n```\nx\n```\n\n# B\nprose");
        let text = pointer("exec:shell", &chunks);
        assert!(text.contains("2 sections (1 with code)"), "{text}");
    }
}
