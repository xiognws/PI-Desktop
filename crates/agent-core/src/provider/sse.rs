//! Server-sent-events framing.
//!
//! Both provider families the desktop speaks (OpenAI-compatible and Anthropic)
//! use SSE, but chunk boundaries arrive wherever the socket decides, so the
//! frame parser has to survive a frame split across two reads, `\r\n` line
//! endings, comment lines and multi-line `data:` payloads.
//!
//! `readNdjsonLines` in `@pi-workspace/shared` solves the analogous problem for
//! the RPC channel; this is the SSE equivalent, kept here so provider decoders
//! stay pure byte-in/event-out.

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SseFrame {
    pub event: Option<String>,
    pub data: String,
    pub id: Option<String>,
}

/// Incremental SSE frame parser. Feed it whatever bytes the transport yields;
/// it returns every frame that became complete.
#[derive(Debug, Default)]
pub struct SseFramer {
    buf: String,
    pending_event: Option<String>,
    pending_id: Option<String>,
    pending_data: Vec<String>,
}

impl SseFramer {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push_chunk(&mut self, chunk: &str) -> Vec<SseFrame> {
        self.buf.push_str(chunk);
        let mut frames = Vec::new();
        while let Some(cut) = next_line_end(&self.buf) {
            // Copy the line out before truncating the buffer: `take_line`
            // borrows `self` mutably.
            let line = self.buf[..cut.0].to_string();
            let remainder = self.buf[cut.1..].to_string();
            self.buf = remainder;
            if let Some(frame) = self.take_line(&line) {
                frames.push(frame);
            }
        }
        frames
    }

    fn take_line(&mut self, line: &str) -> Option<SseFrame> {
        if line.is_empty() {
            // A blank line terminates the current frame.
            if self.pending_data.is_empty() && self.pending_event.is_none() {
                return None;
            }
            let frame = SseFrame {
                event: self.pending_event.take(),
                data: self.pending_data.join("\n"),
                id: self.pending_id.take(),
            };
            self.pending_data.clear();
            return Some(frame);
        }
        if let Some(comment) = line.strip_prefix(':') {
            let _ = comment; // keep-alive / diagnostics
            return None;
        }
        let (field, value) = match line.split_once(':') {
            Some((field, value)) => (field, value.strip_prefix(' ').unwrap_or(value)),
            None => (line, ""),
        };
        match field {
            "event" => self.pending_event = Some(value.to_string()),
            "data" => self.pending_data.push(value.to_string()),
            "id" => self.pending_id = Some(value.to_string()),
            // `retry:` and unknown fields do not affect the event stream here.
            _ => {}
        }
        None
    }
}

/// Returns (line_end_index, bytes_to_skip_after_line).
fn next_line_end(buf: &str) -> Option<(usize, usize)> {
    let bytes = buf.as_bytes();
    for (index, byte) in bytes.iter().enumerate() {
        if *byte == b'\n' {
            let end = if index > 0 && bytes[index - 1] == b'\r' {
                index - 1
            } else {
                index
            };
            return Some((end, index + 1));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_two_frames_from_one_chunk() {
        let mut framer = SseFramer::new();
        let frames = framer.push_chunk("data: {\"a\":1}\n\ndata: [DONE]\n\n");
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0].data, "{\"a\":1}");
        assert_eq!(frames[1].data, "[DONE]");
    }

    #[test]
    fn survives_a_frame_split_across_chunks() {
        let mut framer = SseFramer::new();
        assert!(framer
            .push_chunk("event: content_block_delta\ndata: {\"x\":")
            .is_empty());
        let frames = framer.push_chunk("1}\n\n");
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].event.as_deref(), Some("content_block_delta"));
        assert_eq!(frames[0].data, "{\"x\":1}");
    }

    #[test]
    fn handles_crlf_and_multiline_data() {
        let mut framer = SseFramer::new();
        let frames = framer.push_chunk("data: line one\r\ndata: line two\r\n\r\n");
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].data, "line one\nline two");
    }

    #[test]
    fn ignores_comments_and_blank_keepalives() {
        let mut framer = SseFramer::new();
        assert!(framer.push_chunk(": ping\n\n").is_empty());
        let frames = framer.push_chunk("data: x\n\n");
        assert_eq!(frames.len(), 1);
    }

    #[test]
    fn partial_line_stays_buffered() {
        let mut framer = SseFramer::new();
        assert!(framer.push_chunk("data: half").is_empty());
        let frames = framer.push_chunk(" line\n\n");
        assert_eq!(frames[0].data, "half line");
    }
}
