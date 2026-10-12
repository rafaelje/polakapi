use crate::ctx::store::NewChunk;

// Splits offloaded text into retrievable chunks.
//
// Chunks are exact slices of the input: concatenating them reproduces the
// original byte for byte. That is the contract the index route rests on — an
// agent that asked to read a file must be able to get that file back, not an
// approximation of it. A markdown heading starts a new chunk and names it, but
// the heading line itself stays in the body, because in a shell or Python file
// that line is a comment, not a title. A fenced code block is never split.

const DEFAULT_MAX_CHARS: usize = 2_000;

pub fn chunk_text(text: &str, max_chars: usize) -> Vec<NewChunk> {
    if text.trim().is_empty() {
        return Vec::new();
    }
    let max_chars = max_chars.max(200);
    let mut chunks = Vec::new();
    let mut heading: Option<String> = None;
    let mut start = 0usize;
    let mut offset = 0usize;
    let mut in_fence = false;

    // `split_inclusive` keeps the line endings, so the slices join back up.
    for line in text.split_inclusive('\n') {
        let trimmed = line.trim_end_matches(['\n', '\r']);
        let fence = trimmed.trim_start().starts_with("```");
        let title = (!in_fence && !fence)
            .then(|| heading_title(trimmed))
            .flatten();
        let too_long = !in_fence
            && !fence
            && offset > start
            && (text[start..offset].chars().count() + trimmed.chars().count()) > max_chars;

        if title.is_some() || too_long {
            push(&mut chunks, &text[start..offset], &heading);
            start = offset;
            // A size split continues under the same heading; a new heading
            // replaces it.
            if let Some(title) = title {
                heading = Some(title);
            }
        }
        if fence {
            in_fence = !in_fence;
        }
        offset += line.len();
    }
    push(&mut chunks, &text[start..], &heading);
    chunks
}

pub fn chunk_default(text: &str) -> Vec<NewChunk> {
    chunk_text(text, DEFAULT_MAX_CHARS)
}

fn heading_title(line: &str) -> Option<String> {
    let trimmed = line.trim_start();
    if !trimmed.starts_with('#') {
        return None;
    }
    let hashes = trimmed.chars().take_while(|c| *c == '#').count();
    if !(1..=6).contains(&hashes) {
        return None;
    }
    let rest = trimmed[hashes..].trim();
    // `#tag` is not a heading; a heading needs a space after the hashes.
    if rest.is_empty() || !trimmed[hashes..].starts_with(char::is_whitespace) {
        return None;
    }
    Some(rest.to_string())
}

fn push(chunks: &mut Vec<NewChunk>, body: &str, heading: &Option<String>) {
    if body.is_empty() {
        return;
    }
    chunks.push(NewChunk {
        heading: heading.clone(),
        has_code: body.contains("```"),
        body: body.to_string(),
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The whole point of the index route: what goes in must come out.
    fn roundtrip(text: &str, max: usize) -> String {
        chunk_text(text, max)
            .iter()
            .map(|chunk| chunk.body.as_str())
            .collect()
    }

    #[test]
    fn chunks_put_back_together_reproduce_the_file() {
        let file = "# Title\n\nprose line\n\n```rust\nfn main() {\n    let x = 1;\n}\n```\n\n## Next\n\tindented\nlast line";
        assert_eq!(roundtrip(file, 2_000), file);
        // Same when the size limit forces several chunks.
        assert_eq!(roundtrip(file, 200), file);
    }

    #[test]
    fn a_long_source_file_survives_chunking_byte_for_byte() {
        let file: String = (0..400)
            .map(|i| format!("    let value_{i} = compute({i}); // keeps  double  spaces\n"))
            .collect();
        let file = format!("fn main() {{\n{file}}}\n");
        assert_eq!(roundtrip(&file, 500), file);
    }

    #[test]
    fn splits_on_markdown_headings() {
        let text = "# One\nalpha\n\n# Two\nbeta";
        let chunks = chunk_text(text, 2_000);
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].heading.as_deref(), Some("One"));
        assert!(chunks[0].body.contains("alpha"));
        // The line itself stays: in a shell script it is a comment, not a title.
        assert!(chunks[0].body.starts_with("# One"));
        assert_eq!(chunks[1].heading.as_deref(), Some("Two"));
    }

    #[test]
    fn keeps_a_code_block_whole_even_past_the_size_limit() {
        let code: String = (0..80).map(|i| format!("line {i} of code\n")).collect();
        let text = format!("# Title\n```js\n{code}```\n");
        let chunks = chunk_text(&text, 200);
        let fenced: Vec<&NewChunk> = chunks.iter().filter(|c| c.has_code).collect();
        assert_eq!(fenced.len(), 1, "the fence must not be split");
        assert!(fenced[0].body.contains("line 0 of code"));
        assert!(fenced[0].body.contains("line 79 of code"));
    }

    #[test]
    fn breaks_long_prose_into_several_chunks() {
        let text: String = (0..100).map(|i| format!("sentence number {i}\n")).collect();
        let chunks = chunk_text(&text, 200);
        assert!(chunks.len() > 1);
        assert!(chunks.iter().all(|c| !c.body.is_empty()));
    }

    #[test]
    fn carries_the_heading_across_a_size_split() {
        let text = format!(
            "# Long\n{}",
            (0..100).map(|i| format!("line {i}\n")).collect::<String>()
        );
        let chunks = chunk_text(&text, 200);
        assert!(chunks.len() > 1);
        assert!(chunks.iter().all(|c| c.heading.as_deref() == Some("Long")));
    }

    #[test]
    fn marks_chunks_that_contain_code() {
        let chunks = chunk_text("# T\n```\nx\n```", 2_000);
        assert!(chunks[0].has_code);
        assert!(!chunk_text("# T\nplain", 2_000)[0].has_code);
    }

    #[test]
    fn a_hash_without_a_space_is_not_a_heading() {
        let chunks = chunk_text("#tag still prose\nmore", 2_000);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].heading, None);
    }

    #[test]
    fn a_heading_inside_a_fence_does_not_split() {
        let chunks = chunk_text("# Real\n```sh\n# not a heading\necho hi\n```", 2_000);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].heading.as_deref(), Some("Real"));
    }

    #[test]
    fn a_shell_script_keeps_its_comments() {
        let script = "#!/bin/sh\n# install deps\nnpm ci\n# run\nnpm test\n";
        assert_eq!(roundtrip(script, 2_000), script);
        assert!(chunk_text(script, 2_000)
            .iter()
            .any(|chunk| chunk.body.contains("# install deps")));
    }

    #[test]
    fn empty_input_produces_nothing() {
        assert!(chunk_text("", 2_000).is_empty());
        assert!(chunk_text("   \n\n  ", 2_000).is_empty());
    }
}
