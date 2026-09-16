use crate::ctx::store::NewChunk;

// Splits offloaded text into retrievable chunks.
//
// Two rules do most of the work: a markdown heading starts a new chunk, and a
// fenced code block is never split. Returning half a code block would defeat
// the reason exact text is indexed rather than summarised.

const DEFAULT_MAX_CHARS: usize = 2_000;

pub fn chunk_text(text: &str, max_chars: usize) -> Vec<NewChunk> {
    let max_chars = max_chars.max(200);
    let mut chunks = Vec::new();
    let mut heading: Option<String> = None;
    let mut body = String::new();
    let mut in_fence = false;

    for line in text.lines() {
        let fence = line.trim_start().starts_with("```");
        if fence {
            in_fence = !in_fence;
        }

        if !in_fence && !fence {
            if let Some(title) = heading_title(line) {
                flush(&mut chunks, &mut heading, &mut body);
                heading = Some(title);
                continue;
            }
        }

        // Only break on size outside a fence, so code survives intact. The
        // closing fence has already flipped `in_fence` back off, so it has to
        // be excluded explicitly or the block loses its last line.
        if !in_fence
            && !fence
            && !body.is_empty()
            && body.chars().count() + line.chars().count() > max_chars
        {
            flush(&mut chunks, &mut heading.clone(), &mut body);
        }
        body.push_str(line);
        body.push('\n');
    }
    flush(&mut chunks, &mut heading, &mut body);
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

fn flush(chunks: &mut Vec<NewChunk>, heading: &mut Option<String>, body: &mut String) {
    let text = body.trim_end();
    if text.is_empty() {
        body.clear();
        return;
    }
    chunks.push(NewChunk {
        heading: heading.clone(),
        has_code: text.contains("```"),
        body: text.to_string(),
    });
    body.clear();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_on_markdown_headings() {
        let text = "# One\nalpha\n\n# Two\nbeta";
        let chunks = chunk_text(text, 2_000);
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].heading.as_deref(), Some("One"));
        assert!(chunks[0].body.contains("alpha"));
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
    fn empty_input_produces_nothing() {
        assert!(chunk_text("", 2_000).is_empty());
        assert!(chunk_text("   \n\n  ", 2_000).is_empty());
    }
}
