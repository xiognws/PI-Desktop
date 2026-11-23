//! OpenAI-compatible `chat/completions` streaming decoder.
//!
//! This is the shape most of the desktop's configured providers speak
//! (`docs/spec/03-runtime/11-provider-model-system.md`), including the
//! compatible gateways that only differ in `baseUrl` and auth header. The
//! decoder is byte-chunk in, [`StreamEvent`] out, so it can be tested from
//! recorded fixtures without a socket.

use serde_json::Value;

use super::sse::SseFramer;
use super::StreamEvent;
use crate::error::{AgentError, ProviderErrorKind, Result};
use crate::message::{StopReason, Usage};

#[derive(Debug, Default)]
pub struct OpenAiStreamDecoder {
    framer: SseFramer,
    finished: bool,
}

impl OpenAiStreamDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push_chunk(&mut self, chunk: &str) -> Result<Vec<StreamEvent>> {
        let mut events = Vec::new();
        for frame in self.framer.push_chunk(chunk) {
            let data = frame.data.trim();
            if data.is_empty() {
                continue;
            }
            if data == "[DONE]" {
                // Gateways that never send `finish_reason` still terminate.
                if !self.finished {
                    self.finished = true;
                    events.push(StreamEvent::Finish(StopReason::EndTurn));
                }
                continue;
            }
            let value: Value = serde_json::from_str(data).map_err(|error| {
                AgentError::provider(
                    ProviderErrorKind::Protocol,
                    format!("openai chunk is not JSON: {error}"),
                )
            })?;
            self.decode(&value, &mut events)?;
        }
        Ok(events)
    }

    fn decode(&mut self, value: &Value, events: &mut Vec<StreamEvent>) -> Result<()> {
        // Provider error frames ride the same channel as content.
        if let Some(error) = value.get("error") {
            let message = error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("provider reported an error");
            let status = error
                .get("status")
                .and_then(Value::as_u64)
                .map(|v| v as u16);
            return Err(match status {
                Some(code) => AgentError::provider_status(
                    ProviderErrorKind::Retryable,
                    code,
                    message.to_string(),
                ),
                None => AgentError::provider(ProviderErrorKind::Fatal, message.to_string()),
            });
        }

        if let Some(usage) = value.get("usage").and_then(parse_usage) {
            events.push(StreamEvent::Usage(usage));
        }

        let Some(choice) = value
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|choices| choices.first())
        else {
            return Ok(());
        };

        if let Some(delta) = choice.get("delta") {
            if let Some(text) = delta.get("content").and_then(Value::as_str) {
                if !text.is_empty() {
                    events.push(StreamEvent::TextDelta(text.to_string()));
                }
            }
            // `reasoning_content` is the widely-deployed spelling; `reasoning`
            // appears on a few compatible gateways.
            for key in ["reasoning_content", "reasoning"] {
                if let Some(thinking) = delta.get(key).and_then(Value::as_str) {
                    if !thinking.is_empty() {
                        events.push(StreamEvent::ThinkingDelta(thinking.to_string()));
                    }
                }
            }
            if let Some(calls) = delta.get("tool_calls").and_then(Value::as_array) {
                for call in calls {
                    let index = call.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
                    let id = call.get("id").and_then(Value::as_str).unwrap_or("");
                    let function = call.get("function");
                    let name = function
                        .and_then(|f| f.get("name"))
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    if !id.is_empty() || !name.is_empty() {
                        events.push(StreamEvent::ToolCallStart {
                            index,
                            id: id.to_string(),
                            name: name.to_string(),
                        });
                    }
                    if let Some(arguments) = function
                        .and_then(|f| f.get("arguments"))
                        .and_then(Value::as_str)
                    {
                        if !arguments.is_empty() {
                            events.push(StreamEvent::ToolCallDelta {
                                index,
                                arguments_delta: arguments.to_string(),
                            });
                        }
                    }
                }
            }
        }

        if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
            self.finished = true;
            events.push(StreamEvent::Finish(map_finish_reason(reason)));
        }
        Ok(())
    }
}

fn map_finish_reason(reason: &str) -> StopReason {
    match reason {
        "stop" => StopReason::EndTurn,
        "tool_calls" | "function_call" => StopReason::ToolUse,
        "length" => StopReason::MaxOutputTokens,
        "content_filter" => StopReason::ContentFilter,
        other => StopReason::Other(other.to_string()),
    }
}

fn parse_usage(value: &Value) -> Option<Usage> {
    let input = value
        .get("prompt_tokens")
        .or_else(|| value.get("input_tokens"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let output = value
        .get("completion_tokens")
        .or_else(|| value.get("output_tokens"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    if input == 0 && output == 0 {
        return None;
    }
    let details = value.get("prompt_tokens_details");
    let completion_details = value.get("completion_tokens_details");
    // `prompt_tokens` counts the cached slice *inside* itself, while every consumer
    // of `Usage` treats the three input numbers as disjoint parts of one prompt —
    // the shape Anthropic's fields already have. Leaving it whole would bill a
    // cached turn twice and make the context meter report a session twice as full as
    // it is, so the cached slice is subtracted here, once, at the wire boundary.
    let cached = details
        .and_then(|d| d.get("cached_tokens"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    Some(Usage {
        input_tokens: input.saturating_sub(cached),
        output_tokens: output,
        cache_read_tokens: cached,
        cache_write_tokens: 0,
        reasoning_tokens: completion_details
            .and_then(|d| d.get("reasoning_tokens"))
            .and_then(Value::as_u64)
            .unwrap_or(0),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode(raw: &str) -> Vec<StreamEvent> {
        let mut decoder = OpenAiStreamDecoder::new();
        decoder.push_chunk(raw).expect("fixture must decode")
    }

    #[test]
    fn decodes_text_reasoning_usage_and_finish() {
        let raw = concat!(
            "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"think \"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"lo\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],",
            "\"usage\":{\"prompt_tokens\":11,\"completion_tokens\":7,",
            "\"prompt_tokens_details\":{\"cached_tokens\":3},",
            "\"completion_tokens_details\":{\"reasoning_tokens\":2}}}\n\n",
            "data: [DONE]\n\n",
        );
        let events = decode(raw);
        assert!(events.contains(&StreamEvent::TextDelta("Hel".into())));
        assert!(events.contains(&StreamEvent::ThinkingDelta("think ".into())));
        assert!(events.contains(&StreamEvent::Finish(StopReason::EndTurn)));
        assert!(events.contains(&StreamEvent::Usage(Usage {
            input_tokens: 8,
            // Disjoint parts of one 11-token prompt: the cached 3 are not billed
            // a second time as input.
            output_tokens: 7,
            cache_read_tokens: 3,
            cache_write_tokens: 0,
            reasoning_tokens: 2,
        })));
        // `[DONE]` after a real finish reason must not add a second finish.
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(event, StreamEvent::Finish(_)))
                .count(),
            1
        );
    }

    #[test]
    fn decodes_streamed_tool_call_fragments() {
        let raw = concat!(
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",",
            "\"type\":\"function\",\"function\":{\"name\":\"read_file\",\"arguments\":\"\"}}]}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,",
            "\"function\":{\"arguments\":\"{\\\"path\\\":\"}}]}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,",
            "\"function\":{\"arguments\":\"\\\"a.txt\\\"}\"}}]}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n",
        );
        let events = decode(raw);
        assert_eq!(
            events[0],
            StreamEvent::ToolCallStart {
                index: 0,
                id: "call_1".into(),
                name: "read_file".into(),
            }
        );
        assert!(events.contains(&StreamEvent::Finish(StopReason::ToolUse)));
    }

    #[test]
    fn done_sentinel_without_finish_reason_still_terminates() {
        let events =
            decode("data: {\"choices\":[{\"delta\":{\"content\":\"x\"}}]}\n\ndata: [DONE]\n\n");
        assert_eq!(
            events.last(),
            Some(&StreamEvent::Finish(StopReason::EndTurn))
        );
    }

    #[test]
    fn error_frames_become_provider_errors() {
        let mut decoder = OpenAiStreamDecoder::new();
        let error = decoder
            .push_chunk("data: {\"error\":{\"message\":\"rate limited\",\"status\":429}}\n\n")
            .unwrap_err();
        assert!(error.is_retryable());
        assert!(error.to_string().contains("rate limited"));
    }

    #[test]
    fn length_and_filter_map_to_their_own_stop_reasons() {
        assert_eq!(map_finish_reason("length"), StopReason::MaxOutputTokens);
        assert_eq!(
            map_finish_reason("content_filter"),
            StopReason::ContentFilter
        );
        assert_eq!(
            map_finish_reason("weird"),
            StopReason::Other("weird".into())
        );
    }
}
