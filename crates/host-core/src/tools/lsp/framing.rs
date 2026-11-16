/**
 * LSP wire framing, and nothing else.
 *
 * The Language Server Protocol puts JSON-RPC messages on a stream as
 * `Content-Length: N\r\n\r\n<N bytes>` frames. Getting that wrong is invisible
 * until a real server desynchronizes halfway through a session and every later
 * request answers the wrong one, so the codec lives alone here with tests rather
 * than inside the session code where reading a stream is mixed with process
 * lifecycle.
 *
 * This module has no I/O: it takes bytes and returns messages, or takes a message
 * and returns bytes. That is what makes the failure cases (a partial frame, a
 * header without a length, a body shorter than its declared length) testable
 * without spawning a language server.
 */

/** A decoded frame: the JSON payload only; headers other than the length are ignored. */
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub payload: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FrameError {
    /// The header block is not terminated yet: keep reading, this is not an error.
    Incomplete,
    /// A header block arrived without a usable `Content-Length`.
    MissingContentLength,
    /// `Content-Length` is present but not a number.
    InvalidContentLength(String),
    /// The body is shorter than the declared length: keep reading.
    ShortBody { declared: usize, have: usize },
}

impl std::fmt::Display for FrameError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FrameError::Incomplete => write!(f, "incomplete frame"),
            FrameError::MissingContentLength => write!(f, "frame is missing Content-Length"),
            FrameError::InvalidContentLength(value) => {
                write!(f, "Content-Length is not a number: {value:?}")
            }
            FrameError::ShortBody { declared, have } => {
                write!(f, "frame body is {have} bytes, declared {declared}")
            }
        }
    }
}

impl std::error::Error for FrameError {}

/// Encode one payload as a frame, headers included.
///
/// The length is the byte length of `payload`, not its character count: an LSP
/// message carrying a non-ASCII path would otherwise be cut short by the server.
pub fn encode(payload: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len() + 32);
    out.extend_from_slice(format!("Content-Length: {}\r\n\r\n", payload.len()).as_bytes());
    out.extend_from_slice(payload.as_bytes());
    out
}

/// Try to read one frame off the front of `buffer`.
///
/// On success returns the frame and how many bytes it consumed, so the caller can
/// drain its buffer and try again — a single read can carry several messages, and
/// dropping the remainder loses a response the caller is waiting for.
pub fn decode(buffer: &[u8]) -> Result<(Frame, usize), FrameError> {
    let header_end = find_header_end(buffer).ok_or(FrameError::Incomplete)?;
    let headers = &buffer[..header_end];
    let declared = parse_content_length(headers)?;
    let body_start = header_end + HEADER_TERMINATOR.len();
    let have = buffer.len() - body_start;
    if have < declared {
        return Err(FrameError::ShortBody { declared, have });
    }
    let body = &buffer[body_start..body_start + declared];
    let payload = String::from_utf8_lossy(body).into_owned();
    Ok((Frame { payload }, body_start + declared))
}

const HEADER_TERMINATOR: &[u8] = b"\r\n\r\n";

fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer
        .windows(HEADER_TERMINATOR.len())
        .position(|window| window == HEADER_TERMINATOR)
}

fn parse_content_length(headers: &[u8]) -> Result<usize, FrameError> {
    let text = String::from_utf8_lossy(headers);
    for line in text.split("\r\n") {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        if name.trim().eq_ignore_ascii_case("content-length") {
            let raw = value.trim();
            return raw
                .parse::<usize>()
                .map_err(|_| FrameError::InvalidContentLength(raw.to_string()));
        }
    }
    Err(FrameError::MissingContentLength)
}

#[cfg(test)]
mod tests {
    use super::{decode, encode, Frame, FrameError};

    #[test]
    fn round_trips_a_message() {
        let payload = r#"{"jsonrpc":"2.0","id":1,"method":"initialize"}"#;
        let bytes = encode(payload);
        let (frame, consumed) = decode(&bytes).expect("decodes");
        assert_eq!(frame.payload, payload);
        assert_eq!(consumed, bytes.len());
    }

    #[test]
    fn length_is_bytes_not_characters() {
        // A Windows project path is the common case for a non-ASCII payload.
        let payload = r#"{"root":"D:\\代码\\项目"}"#;
        let bytes = encode(payload);
        let header = String::from_utf8_lossy(&bytes[..32]).to_string();
        assert!(header.contains(&format!("Content-Length: {}", payload.len())));
        assert!(payload.len() > payload.chars().count());
        let (frame, consumed) = decode(&bytes).expect("decodes");
        assert_eq!(frame.payload, payload);
        assert_eq!(consumed, bytes.len());
    }

    #[test]
    fn a_partial_header_asks_for_more_bytes() {
        assert_eq!(
            decode(b"Content-Length: 42").unwrap_err(),
            FrameError::Incomplete
        );
    }

    #[test]
    fn a_body_shorter_than_declared_asks_for_more_bytes() {
        let bytes = encode("{\"a\":1}");
        let cut = bytes.len() - 3;
        assert_eq!(
            decode(&bytes[..cut]).unwrap_err(),
            FrameError::ShortBody {
                declared: 7,
                have: 4
            }
        );
    }

    #[test]
    fn a_header_without_a_length_is_an_error_not_a_stall() {
        let bytes = b"Content-Type: application/json\r\n\r\n{}";
        assert_eq!(decode(bytes).unwrap_err(), FrameError::MissingContentLength);
    }

    #[test]
    fn a_non_numeric_length_names_the_value() {
        let bytes = b"Content-Length: twelve\r\n\r\n{}";
        assert_eq!(
            decode(bytes).unwrap_err(),
            FrameError::InvalidContentLength("twelve".to_string())
        );
    }

    #[test]
    fn a_second_message_in_the_same_read_is_not_lost() {
        let mut buffer = encode("{\"id\":1}");
        let second = encode("{\"id\":2}");
        buffer.extend_from_slice(&second);

        let (first_frame, consumed) = decode(&buffer).expect("first decodes");
        assert_eq!(
            first_frame,
            Frame {
                payload: "{\"id\":1}".to_string()
            }
        );

        let (second_frame, _) = decode(&buffer[consumed..]).expect("second decodes");
        assert_eq!(second_frame.payload, "{\"id\":2}");
    }

    #[test]
    fn header_names_are_case_insensitive_and_extra_headers_are_ignored() {
        let bytes = b"Content-Type: application/vscode-jsonrpc\r\ncontent-length: 2\r\n\r\n{}";
        let (frame, consumed) = decode(bytes).expect("decodes");
        assert_eq!(frame.payload, "{}");
        assert_eq!(consumed, bytes.len());
    }
}
