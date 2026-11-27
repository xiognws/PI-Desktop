//! Chunk-safe UTF-8 decoding for a byte stream.
//!
//! A provider body arrives in chunks whose boundaries have nothing to do with
//! character boundaries. A gateway that sends one SSE event per token can hand a
//! three-byte CJK character over as two or three separate chunks, and decoding
//! each chunk on its own with `String::from_utf8_lossy` turns that character into
//! one replacement character per orphan byte — which is how a Chinese sentence
//! loses a word inside the model's own output, and how a corrupted character ends
//! up quoted back into a file edit.
//!
//! `Utf8Stream` decodes as much as is complete and carries the split tail into
//! the next chunk. Bytes that are genuinely invalid become U+FFFD, as any decoder
//! must; an incomplete sequence is never judged until the stream ends.

#[derive(Default)]
pub struct Utf8Stream {
    pending: Vec<u8>,
}

impl Utf8Stream {
    pub fn new() -> Self {
        Self::default()
    }

    /// Decode everything complete in the buffer now, keeping a split character
    /// for the next call.
    pub fn push(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        let mut out = String::with_capacity(self.pending.len());
        loop {
            match std::str::from_utf8(&self.pending) {
                Ok(text) => {
                    out.push_str(text);
                    self.pending.clear();
                    break;
                }
                Err(error) => {
                    let valid = error.valid_up_to();
                    if valid > 0 {
                        out.push_str(
                            std::str::from_utf8(&self.pending[..valid])
                                .expect("the validated prefix is UTF-8"),
                        );
                    }
                    match error.error_len() {
                        // The bytes are invalid, not merely unfinished: replace them
                        // the way a lossy decoder would and move past them.
                        Some(len) => {
                            out.push('\u{FFFD}');
                            self.pending.drain(..valid + len);
                        }
                        // The tail is the beginning of a character whose remaining
                        // bytes are in a later chunk. Hold it.
                        None => {
                            self.pending.drain(..valid);
                            break;
                        }
                    }
                }
            }
        }
        out
    }

    /// Whatever is still held when the body ends. A stream that stops inside a
    /// character cannot be completed, so this is the one lossy step.
    pub fn finish(&mut self) -> String {
        if self.pending.is_empty() {
            return String::new();
        }
        let text = String::from_utf8_lossy(&self.pending).into_owned();
        self.pending.clear();
        text
    }

    pub fn pending_len(&self) -> usize {
        self.pending.len()
    }
}

#[cfg(test)]
mod tests {
    use super::Utf8Stream;

    /// The failure this module exists for: one character split across chunks.
    #[test]
    fn a_character_split_across_chunks_survives() {
        let text = "本闸不判红，但会在输出里提示";
        let bytes = text.as_bytes();

        // Split at every byte boundary in turn, including inside 3-byte characters.
        for split in 0..=bytes.len() {
            let mut stream = Utf8Stream::new();
            let mut decoded = stream.push(&bytes[..split]);
            decoded.push_str(&stream.push(&bytes[split..]));
            decoded.push_str(&stream.finish());
            assert_eq!(decoded, text, "split at {split}");
            assert!(!decoded.contains('\u{FFFD}'), "split at {split} produced a replacement char");
        }
    }

    #[test]
    fn a_character_split_one_byte_per_chunk_survives() {
        let text = "中文测试 ⇒ 🚀";
        let mut stream = Utf8Stream::new();
        let mut decoded = String::new();
        for byte in text.as_bytes() {
            decoded.push_str(&stream.push(&[*byte]));
        }
        decoded.push_str(&stream.finish());
        assert_eq!(decoded, text);
    }

    /// The old behaviour, pinned so the reason for this module stays visible:
    /// lossy per chunk is what wrote `���` into a transcript.
    #[test]
    fn lossy_per_chunk_is_what_corrupted_the_transcript() {
        let character = "但".as_bytes();
        let pieces = [
            String::from_utf8_lossy(&character[..1]).into_owned(),
            String::from_utf8_lossy(&character[1..2]).into_owned(),
            String::from_utf8_lossy(&character[2..]).into_owned(),
        ];
        assert_eq!(pieces.concat(), "\u{FFFD}\u{FFFD}\u{FFFD}");
    }

    #[test]
    fn invalid_bytes_are_replaced_and_the_rest_still_decodes() {
        let mut stream = Utf8Stream::new();
        let mut decoded = stream.push(b"ok\xff\xfeok");
        decoded.push_str(&stream.finish());
        assert_eq!(decoded, "ok\u{FFFD}\u{FFFD}ok");
        assert_eq!(stream.pending_len(), 0);
    }

    #[test]
    fn a_stream_that_ends_mid_character_flushes_lossily() {
        let mut stream = Utf8Stream::new();
        let bytes = "但".as_bytes();
        assert_eq!(stream.push(&bytes[..1]), "");
        assert_eq!(stream.pending_len(), 1);
        assert_eq!(stream.finish(), "\u{FFFD}");
        assert_eq!(stream.pending_len(), 0);
    }

    #[test]
    fn empty_chunks_are_harmless() {
        let mut stream = Utf8Stream::new();
        assert_eq!(stream.push(b""), "");
        assert_eq!(stream.push("中".as_bytes()), "中");
        assert_eq!(stream.push(b""), "");
    }
}
