use std::collections::VecDeque;

// What a terminal showed recently, kept per PTY so a webview that attaches
// later can catch up. xterm's scrollback lives in the webview that rendered
// it, so moving a project's grid to another window would otherwise start it
// blank. Bounded, and only ever cut at a character boundary, since the
// consumer is a UTF-8 terminal parser.

pub const REPLAY_CAPACITY: usize = 256 * 1024;

#[derive(Debug)]
pub struct ReplayBuffer {
    bytes: VecDeque<u8>,
    capacity: usize,
}

impl Default for ReplayBuffer {
    fn default() -> Self {
        Self::with_capacity(REPLAY_CAPACITY)
    }
}

impl ReplayBuffer {
    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            bytes: VecDeque::with_capacity(capacity.min(4096)),
            capacity,
        }
    }

    pub fn push(&mut self, chunk: &str) {
        let incoming = chunk.as_bytes();
        if incoming.len() >= self.capacity {
            self.bytes.clear();
            self.bytes
                .extend(tail_at_char_boundary(incoming, self.capacity));
            return;
        }
        let overflow = (self.bytes.len() + incoming.len()).saturating_sub(self.capacity);
        if overflow > 0 {
            self.bytes.drain(..overflow);
            self.drop_partial_char();
        }
        self.bytes.extend(incoming);
    }

    pub fn snapshot(&self) -> String {
        let (head, tail) = self.bytes.as_slices();
        let mut out = Vec::with_capacity(self.bytes.len());
        out.extend_from_slice(head);
        out.extend_from_slice(tail);
        String::from_utf8(out).unwrap_or_default()
    }

    /// After a raw drain the front may be the middle of a multi-byte character;
    /// continuation bytes are `10xxxxxx`.
    fn drop_partial_char(&mut self) {
        while self
            .bytes
            .front()
            .is_some_and(|byte| byte & 0b1100_0000 == 0b1000_0000)
        {
            self.bytes.pop_front();
        }
    }
}

fn tail_at_char_boundary(bytes: &[u8], max: usize) -> &[u8] {
    let mut start = bytes.len().saturating_sub(max);
    while start < bytes.len() && bytes[start] & 0b1100_0000 == 0b1000_0000 {
        start += 1;
    }
    &bytes[start..]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_everything_while_under_capacity() {
        let mut buffer = ReplayBuffer::with_capacity(64);
        buffer.push("hello ");
        buffer.push("world");
        assert_eq!(buffer.snapshot(), "hello world");
    }

    #[test]
    fn keeps_only_the_most_recent_bytes() {
        let mut buffer = ReplayBuffer::with_capacity(10);
        for i in 0..5 {
            buffer.push(&format!("line{i}\n"));
        }
        let kept = buffer.snapshot();
        assert!(kept.len() <= 10);
        assert!(kept.ends_with("line4\n"), "{kept:?}");
    }

    #[test]
    fn never_cuts_a_character_in_half() {
        let mut buffer = ReplayBuffer::with_capacity(8);
        buffer.push("ab");
        buffer.push("ñçü"); // 6 bytes; total 8, fits
        buffer.push("x"); // pushes 1 byte out: the 'a'
        assert_eq!(buffer.snapshot(), "bñçüx");
        buffer.push("y"); // pushes out 'b'
        assert_eq!(buffer.snapshot(), "ñçüxy");
        buffer.push("z"); // would split 'ñ': both bytes go
        assert_eq!(buffer.snapshot(), "çüxyz");
    }

    #[test]
    fn a_chunk_larger_than_the_buffer_keeps_its_tail() {
        let mut buffer = ReplayBuffer::with_capacity(6);
        buffer.push("0123456789");
        assert_eq!(buffer.snapshot(), "456789");
        buffer.push("ññññ"); // 8 bytes > 6: tail at a boundary
        assert_eq!(buffer.snapshot(), "ñññ");
    }

    #[test]
    fn snapshot_of_an_empty_buffer_is_empty() {
        assert_eq!(ReplayBuffer::default().snapshot(), "");
    }
}
