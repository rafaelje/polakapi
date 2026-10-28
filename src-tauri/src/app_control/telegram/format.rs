use super::api::{Api, ApiError};
use super::turn::{chunks, TELEGRAM_MESSAGE_LIMIT};

// Answers are written in light Markdown; Telegram shows them as HTML so that
// fenced blocks render monospaced, the way a terminal shows command output.
// Only fences, inline code and bold are converted; everything else is escaped,
// so a stray `<` can never break the message. When Telegram still rejects a
// chunk, it is resent as plain text.

/// Room left for the tags and entities escaping adds.
const MARKDOWN_CHUNK: usize = 3000;

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn is_fence(line: &str) -> bool {
    line.trim_start().starts_with("```")
}

fn inline(line: &str) -> String {
    let escaped = escape(line);
    // An unmatched backtick is just a character.
    if line.matches('`').count() % 2 == 1 {
        return bold(&escaped);
    }
    let mut out = String::new();
    for (index, part) in escaped.split('`').enumerate() {
        if index % 2 == 1 {
            out.push_str("<code>");
            out.push_str(part);
            out.push_str("</code>");
        } else {
            out.push_str(&bold(part));
        }
    }
    out
}

fn bold(text: &str) -> String {
    let parts: Vec<&str> = text.split("**").collect();
    if parts.len() < 3 {
        return text.to_string();
    }
    let mut out = String::new();
    for (index, part) in parts.iter().enumerate() {
        let closed = index % 2 == 1 && index + 1 < parts.len();
        if closed {
            out.push_str("<b>");
            out.push_str(part);
            out.push_str("</b>");
        } else {
            if index % 2 == 1 {
                out.push_str("**");
            }
            out.push_str(part);
        }
    }
    out
}

pub fn to_html(markdown: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut block: Option<Vec<String>> = None;
    for line in markdown.lines() {
        if is_fence(line) {
            match block.take() {
                Some(lines) => out.push(format!("<pre>{}</pre>", lines.join("\n"))),
                None => block = Some(Vec::new()),
            }
            continue;
        }
        match block.as_mut() {
            Some(lines) => lines.push(escape(line)),
            None => out.push(inline(line)),
        }
    }
    if let Some(lines) = block {
        out.push(format!("<pre>{}</pre>", lines.join("\n")));
    }
    out.join("\n")
}

/// Splits Markdown into message-sized pieces, closing a fence at the end of a
/// piece and reopening it in the next so every piece renders on its own.
pub fn markdown_chunks(markdown: &str) -> Vec<String> {
    let mut open = false;
    chunks(markdown, MARKDOWN_CHUNK)
        .into_iter()
        .map(|chunk| {
            let mut piece = String::new();
            if open {
                piece.push_str("```\n");
            }
            piece.push_str(&chunk);
            if chunk.lines().filter(|line| is_fence(line)).count() % 2 == 1 {
                open = !open;
            }
            if open {
                piece.push_str("\n```");
            }
            piece
        })
        .collect()
}

/// A command transcript as one monospaced block.
pub fn terminal_block(transcript: &str) -> String {
    format!("```\n{}\n```", transcript.replace("```", "ˋˋˋ"))
}

pub async fn send_rich(api: &Api, chat_id: i64, markdown: &str) -> Result<(), ApiError> {
    for piece in markdown_chunks(markdown) {
        let html = to_html(&piece);
        let sent = if html.encode_utf16().count() <= TELEGRAM_MESSAGE_LIMIT {
            api.send_html(chat_id, &html).await
        } else {
            Err(ApiError::Other("too long once formatted".into()))
        };
        if let Err(error) = sent {
            if matches!(error, ApiError::Unauthorized) {
                return Err(error);
            }
            for plain in chunks(&piece, TELEGRAM_MESSAGE_LIMIT) {
                api.send_message(chat_id, &plain).await?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fences_become_pre_and_everything_is_escaped() {
        let markdown = "Status of **polakapi**:\n```bash\n$ git status\nOn branch <main> & co\n```\nUse `git push`.";
        assert_eq!(
            to_html(markdown),
            "Status of <b>polakapi</b>:\n<pre>$ git status\nOn branch &lt;main&gt; &amp; co</pre>\nUse <code>git push</code>."
        );
    }

    #[test]
    fn unbalanced_markers_stay_literal() {
        assert_eq!(to_html("a ` b"), "a ` b");
        assert_eq!(to_html("2 ** 3"), "2 ** 3");
        assert_eq!(to_html("```\nno close"), "<pre>no close</pre>");
    }

    #[test]
    fn long_fenced_output_is_reopened_in_every_piece() {
        let body: String = (0..400)
            .map(|i| format!("line {i:04} of output\n"))
            .collect();
        let markdown = format!("Here:\n```\n{body}```\ndone");
        let pieces = markdown_chunks(&markdown);
        assert!(pieces.len() > 1);
        for piece in &pieces {
            let fences = piece.lines().filter(|line| is_fence(line)).count();
            assert_eq!(fences % 2, 0, "unbalanced piece: {piece}");
            assert!(to_html(piece).encode_utf16().count() <= TELEGRAM_MESSAGE_LIMIT);
        }
        assert!(pieces[1].starts_with("```\n"));
    }

    #[test]
    fn transcripts_cannot_close_their_own_block() {
        let block = terminal_block("$ cat README.md\n```js\nx\n```");
        assert_eq!(block.lines().filter(|line| is_fence(line)).count(), 2);
    }
}
