//! Anthropic Messages API streaming decoder.
//!
//! Anthropic frames every payload with an `event:` name and indexes content
//! blocks, so the decoder maps block indexes onto tool-call slots and keeps
//! thinking blocks separate from text. Stop reasons map onto the same
//! [`StopReason`] set the OpenAI decoder produces.

use serde_json::Value;

use super::sse::SseFramer;
use super::StreamEvent;
use crate::error::{AgentError, ProviderErrorKind, Result};
use crate::message::{StopReason, Usage};

#[derive(Debug, Default)]
pub struct AnthropicStreamDecoder {
    framer: SseFramer,
    /// Block index -> tool-call slot, so a block index that only carries
    /// `input_json_delta` frames still lands in the right call.
    block_slots: std::collections::HashMap<usize, usize>,
    next_slot: usize,
    finished: bool,
    started: bool,
}

impl AnthropicStreamDecoder {
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
            let value: Value = serde_json::from_str(data).map_err(|error| {
                AgentError::provider(
                    ProviderErrorKind::Protocol,
                    format!("anthropic frame is not JSON: {error}"),
                )
            })?;
            let kind = value
                .get("type")
                .and_then(Value::as_str)
                .or(frame.event.as_deref())
                .unwrap_or("");
            self.decode(kind, &value, &mut events)?;
        }
        Ok(events)
    }

    fn decode(&mut self, kind: &str, value: &Value, events: &mut Vec<StreamEvent>) -> Result<()> {
        match kind {
            "message_start" => {
                self.started = true;
                if let Some(usage) = value.get("message").and_then(|m| m.get("usage")) {
                    if let Some(usage) = parse_input_usage(usage) {
                        events.push(StreamEvent::Usage(usage));
                    }
                }
            }
            "content_block_start" => {
                let block_index = value.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
                let block = value.get("content_block").cloned().unwrap_or(Value::Null);
                if block.get("type").and_then(Value::as_str) == Some("tool_use") {
                    let slot = self.next_slot;
                    self.next_slot += 1;
                    self.block_slots.insert(block_index, slot);
                    events.push(StreamEvent::ToolCallStart {
                        index: slot,
                        id: block
                            .get("id")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string(),
                        name: block
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string(),
                    });
                    // Some gateways deliver the whole input object up front.
                    if let Some(input) = block.get("input") {
                        if !input.is_null()
                            && input.as_object().map(|o| !o.is_empty()) == Some(true)
                        {
                            events.push(StreamEvent::ToolCallDelta {
                                index: slot,
                                arguments_delta: input.to_string(),
                            });
                        }
                    }
                }
            }
            "content_block_delta" => {
                let block_index = value.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
                let Some(delta) = value.get("delta") else {
                    return Ok(());
                };
                match delta.get("type").and_then(Value::as_str).unwrap_or("") {
                    "text_delta" => {
                        if let Some(text) = delta.get("text").and_then(Value::as_str) {
                            events.push(StreamEvent::TextDelta(text.to_string()));
                        }
                    }
                    "thinking_delta" => {
                        if let Some(text) = delta.get("thinking").and_then(Value::as_str) {
                            events.push(StreamEvent::ThinkingDelta(text.to_string()));
                        }
                    }
                    "input_json_delta" => {
                        let slot = self.block_slots.get(&block_index).copied().unwrap_or(0);
                        if let Some(chunk) = delta.get("partial_json").and_then(Value::as_str) {
                            events.push(StreamEvent::ToolCallDelta {
                                index: slot,
                                arguments_delta: chunk.to_string(),
                            });
                        }
                    }
                    // `signature_delta` and unknown delta types carry no
                    // model-visible content.
                    _ => {}
                }
            }
            "message_delta" => {
                if let Some(usage) = value.get("usage").and_then(parse_output_usage) {
                    events.push(StreamEvent::Usage(usage));
                }
                if let Some(reason) = value
                    .get("delta")
                    .and_then(|d| d.get("stop_reason"))
                    .and_then(Value::as_str)
                {
                    self.finished = true;
                    events.push(StreamEvent::Finish(map_stop_reason(reason)));
                }
            }
            "message_stop" => {
                if !self.finished {
                    self.finished = true;
                    events.push(StreamEvent::Finish(StopReason::EndTurn));
                }
            }
            "error" => {
                let message = value
                    .get("error")
                    .and_then(|e| e.get("message"))
                    .and_then(Value::as_str)
                    .unwrap_or("anthropic reported an error");
                let ty = value
                    .get("error")
                    .and_then(|e| e.get("type"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let retryable = matches!(ty, "overloaded_error" | "rate_limit_error" | "api_error");
                return Err(AgentError::provider(
                    if retryable {
                        ProviderErrorKind::Retryable
                    } else {
                        ProviderErrorKind::Fatal
                    },
                    message.to_string(),
                ));
            }
            // `ping` and forward-compatible unknown events are ignored.
            _ => {}
        }
        Ok(())
    }

    pub fn saw_message_start(&self) -> bool {
        self.started
    }
}

fn map_stop_reason(reason: &str) -> StopReason {
    match reason {
        "end_turn" | "stop_sequence" => StopReason::EndTurn,
        "tool_use" => StopReason::ToolUse,
        "max_tokens" => StopReason::MaxOutputTokens,
        "refusal" => StopReason::ContentFilter,
        other => StopReason::Other(other.to_string()),
    }
}

fn parse_input_usage(usage: &Value) -> Option<Usage> {
    let input = usage
        .get("input_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let cache_read = usage
        .get("cache_read_input_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let cache_write = usage
        .get("cache_creation_input_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    if input == 0 && cache_read == 0 && cache_write == 0 {
        return None;
    }
    Some(Usage {
        input_tokens: input,
        cache_read_tokens: cache_read,
        cache_write_tokens: cache_write,
        ..Usage::default()
    })
}

fn parse_output_usage(usage: &Value) -> Option<Usage> {
    let output = usage
        .get("output_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    if output == 0 {
        return None;
    }
    Some(Usage {
        output_tokens: output,
        ..Usage::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode(raw: &str) -> Vec<StreamEvent> {
        let mut decoder = AnthropicStreamDecoder::new();
        decoder.push_chunk(raw).expect("fixture must decode")
    }

    #[test]
    fn decodes_thinking_then_text_then_stop() {
        let raw = concat!(
            "event: message_start\n",
            "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":9,",
            "\"cache_read_input_tokens\":4}}}\n\n",
            "event: content_block_start\n",
            "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\"}}\n\n",
            "event: content_block_delta\n",
            "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"hmm\"}}\n\n",
            "event: content_block_start\n",
            "data: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"text\"}}\n\n",
            "event: content_block_delta\n",
            "data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"text_delta\",\"text\":\"ok\"}}\n\n",
            "event: message_delta\n",
            "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":3}}\n\n",
            "event: message_stop\n",
            "data: {\"type\":\"message_stop\"}\n\n",
        );
        let events = decode(raw);
        assert!(events.contains(&StreamEvent::ThinkingDelta("hmm".into())));
        assert!(events.contains(&StreamEvent::TextDelta("ok".into())));
        assert!(events.contains(&StreamEvent::Finish(StopReason::EndTurn)));
        assert!(events.contains(&StreamEvent::Usage(Usage {
            input_tokens: 9,
            cache_read_tokens: 4,
            ..Usage::default()
        })));
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(event, StreamEvent::Finish(_)))
                .count(),
            1
        );
    }

    #[test]
    fn tool_use_blocks_route_json_deltas_to_the_right_slot() {
        let raw = concat!(
            "event: content_block_start\n",
            "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\"}}\n\n",
            "event: content_block_start\n",
            "data: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"tool_use\",",
            "\"id\":\"toolu_1\",\"name\":\"read_file\"}}\n\n",
            "event: content_block_delta\n",
            "data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"input_json_delta\",",
            "\"partial_json\":\"{\\\"path\\\":\"}}\n\n",
            "event: content_block_delta\n",
            "data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"input_json_delta\",",
            "\"partial_json\":\"\\\"a.txt\\\"}\"}}\n\n",
            "event: message_delta\n",
            "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"}}\n\n",
        );
        let events = decode(raw);
        assert_eq!(
            events[0],
            StreamEvent::ToolCallStart {
                index: 0,
                id: "toolu_1".into(),
                name: "read_file".into(),
            }
        );
        let joined: String = events
            .iter()
            .filter_map(|event| match event {
                StreamEvent::ToolCallDelta {
                    index: 0,
                    arguments_delta,
                } => Some(arguments_delta.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(joined, "{\"path\":\"a.txt\"}");
        assert!(events.contains(&StreamEvent::Finish(StopReason::ToolUse)));
    }

    #[test]
    fn message_stop_alone_still_finishes_the_stream() {
        let events = decode("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n");
        assert_eq!(events, vec![StreamEvent::Finish(StopReason::EndTurn)]);
    }

    #[test]
    fn overloaded_errors_are_retryable() {
        let mut decoder = AnthropicStreamDecoder::new();
        let error = decoder
            .push_chunk("event: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"busy\"}}\n\n")
            .unwrap_err();
        assert!(error.is_retryable());
    }

    #[test]
    fn invalid_json_is_a_protocol_error_not_a_panic() {
        let mut decoder = AnthropicStreamDecoder::new();
        let error = decoder.push_chunk("data: {not json}\n\n").unwrap_err();
        assert_eq!(error.code(), "PROVIDER_ERROR");
    }
}
