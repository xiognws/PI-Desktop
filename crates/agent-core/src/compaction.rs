//! Compaction: choosing what to summarize, what to keep, and building the
//! summary request.
//!
//! Upstream counterpart: `agent/context_compressor.py`. The rules are ported from
//! the desktop's `compaction-tail.ts` and `compaction-summary-input.ts` because
//! they are the difference between a checkpoint the provider accepts and one it
//! rejects:
//!
//! * a **successful** checkpoint leaves the summary plus at most the latest user
//!   message (`ActiveTurn`), or no message at all when the turn is over
//!   (`CompletedTurn`);
//! * a **retained-tail fallback** (the summary failed) keeps the newest
//!   contiguous run of messages, every role, within a token budget — a single
//!   user sentence would drop every decision and path the turn had established;
//! * a tail never carries a tool result whose call is not in the window, and
//!   never carries an assistant message the provider would drop, because either
//!   one makes the rebuilt context invalid;
//! * the summary prompt is sized the way it is *sent* — tool results capped at
//!   2,000 characters — so a session that is mostly tool output is not mistaken
//!   for an oversized one and recovered without ever asking the model;
//! * when even the reduced input does not fit, the range is split into chunks
//!   that each do, so the budget decides how many requests a summary takes
//!   rather than whether the model is asked at all.

use crate::context::{
    estimate_context_tokens, estimate_message_tokens, ContextLimits, ModelLimits,
    ESTIMATED_TEXT_CHARS_PER_TOKEN,
};
use crate::message::{ContentPart, Message, Role, StopReason};

/// `details` marker for a tail holding the real recent window.
pub const COMPACTION_RETAINED_TAIL_SHAPE: &str = "recent_window";
/// Appended when one message alone exceeds the tail budget.
pub const CHECKPOINT_TRUNCATION_MARKER: &str =
    "\n\n[checkpoint truncated: this message crossed the retained context budget]\n\n";

pub const COMPACTION_SUMMARY_MAX_RETRIES: u32 = 3;
pub const COMPACTION_SUMMARY_RETRY_BASE_MS: u64 = 2_000;
/// Per-tool-result character cap on the reduced summary input.
pub const COMPACTION_REDUCED_TOOL_RESULT_CHARS: usize = 500;
pub const REDUCED_TOOL_RESULT_SUFFIX: &str =
    "\n\n[... tool output truncated for the summary request]";
/// Held back from the window for the summary prompt template itself.
pub const COMPACTION_SUMMARY_PROMPT_SAFETY_TOKENS: u64 = 2_048;
pub const COMPACTION_SUMMARY_MAX_CHUNKS: usize = 16;
pub const COMPACTION_SUMMARY_CHUNK_MARGIN: f64 = 0.9;
pub const SUMMARY_CHUNK_TRUNCATION_MARKER: &str =
    "\n\n[message truncated: the summary request budget could not carry it whole]";
/// Header of the message installed as a checkpoint.
pub const CHECKPOINT_HEADER: &str = "[context checkpoint]";
/// What the installed checkpoint tells the model to do first, so a compaction
/// boundary forces a re-anchor instead of an unanchored continuation: the
/// summary carries the decisions, but the model is what must still hold them.
pub const CHECKPOINT_REANCHOR_DIRECTIVE: &str = "This checkpoint replaced an earlier stretch of the conversation. Before your next action, reconcile against it in one line: confirm the objective still holds and name the open-work item you are acting on.";
/// The message a successful checkpoint installs in place of the summarized range.
pub fn checkpoint_message(summary: &str) -> Message {
    Message::user_text(format!(
        "{CHECKPOINT_HEADER}\n\n{}\n\n{CHECKPOINT_REANCHOR_DIRECTIVE}",
        summary.trim()
    ))
}
/// Installed ahead of a retained-tail fallback, so the model knows the earlier
/// conversation was dropped without a summary rather than never existing.
pub const RETAINED_TAIL_NOTICE: &str = "The earlier part of this conversation was compacted without a summary because the summary request failed. What follows is the most recent context; earlier decisions and file paths may be missing, so re-read anything you need.";
/// pi's own cap when serializing a conversation for a summary request.
pub const SERIALIZED_TOOL_RESULT_CAP_CHARS: usize = 2_000;

/// What a checkpoint is allowed to leave behind.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompactionMode {
    /// Created while the provider must continue the current task.
    ActiveTurn,
    /// Created at a terminal turn boundary, before a new prompt, or manually.
    CompletedTurn,
    /// Deliberate no-summary exception: nothing is carried.
    FreshWindow,
}

impl CompactionMode {
    /// Whether the mode carries the active task's user message forward.
    pub fn retains_latest_user_message(self) -> bool {
        matches!(self, Self::ActiveTurn)
    }
}

/// Stop reasons the provider drops from a rebuilt context. A tail must not
/// carry those messages, or the rebuilt context disagrees with the summary.
fn is_dropped_assistant(message: &Message) -> bool {
    if message.role != Role::Assistant {
        return false;
    }
    matches!(
        &message.stop_reason,
        Some(StopReason::Other(reason)) if reason == "error" || reason == "aborted" || reason == "deferred"
    )
}

fn is_replayable(message: &Message) -> bool {
    !is_dropped_assistant(message)
}

/// Tool-call ids announced by assistant messages of `messages`.
fn owned_call_ids(messages: &[Message]) -> std::collections::HashSet<String> {
    let mut ids = std::collections::HashSet::new();
    for message in messages {
        if message.role != Role::Assistant {
            continue;
        }
        for call in message.tool_calls() {
            ids.insert(call.id.clone());
        }
    }
    ids
}

/// Drop tool results whose call is not in `messages`: a provider rejects a
/// result it cannot pair with its call.
pub fn prune_orphan_tool_results(messages: &[Message]) -> Vec<Message> {
    let owned = owned_call_ids(messages);
    messages
        .iter()
        .filter(|message| {
            message.role != Role::Tool
                || message
                    .tool_results()
                    .iter()
                    .all(|result| owned.contains(&result.call_id))
        })
        .cloned()
        .collect()
}

/// Cut a message's text to a token budget, keeping tool-call identity intact so
/// the result is still a provider-valid message.
pub fn truncate_message_to_tail(message: &Message, max_tokens: u64) -> Message {
    let char_budget = std::cmp::max(
        64,
        (std::cmp::max(1, max_tokens) as f64 * ESTIMATED_TEXT_CHARS_PER_TOKEN) as usize,
    );
    let mut remaining = char_budget;
    let mut truncated = false;
    let mut parts: Vec<ContentPart> = Vec::with_capacity(message.parts.len());

    for part in &message.parts {
        match part {
            ContentPart::Text { text } | ContentPart::Thinking { text } => {
                let chars: Vec<char> = text.chars().collect();
                if chars.len() <= remaining {
                    remaining -= chars.len();
                    parts.push(part.clone());
                } else {
                    let kept: String = chars[..remaining].iter().collect();
                    remaining = 0;
                    truncated = true;
                    if !kept.is_empty() {
                        parts.push(match part {
                            ContentPart::Text { .. } => ContentPart::Text { text: kept },
                            _ => ContentPart::Thinking { text: kept },
                        });
                    }
                }
            }
            ContentPart::ToolResult(result) => {
                let chars: Vec<char> = result.content.chars().collect();
                if chars.len() <= remaining {
                    remaining -= chars.len();
                    parts.push(part.clone());
                } else {
                    let mut kept: String = chars[..remaining].iter().collect();
                    kept.push_str(REDUCED_TOOL_RESULT_SUFFIX);
                    remaining = 0;
                    truncated = true;
                    parts.push(ContentPart::ToolResult(crate::message::ToolResult {
                        content: kept,
                        truncated: true,
                        ..result.clone()
                    }));
                }
            }
            // Tool calls and images keep their identity: a truncated call is not
            // a call the provider would accept, and an image has no text to cut.
            other => parts.push(other.clone()),
        }
    }

    if truncated && message.role != Role::Tool {
        parts.push(ContentPart::Text {
            text: CHECKPOINT_TRUNCATION_MARKER.to_string(),
        });
    }

    let mut truncated_message = message.clone();
    truncated_message.parts = parts;
    truncated_message
}

/// Remove the tool calls of an assistant message. Only a last-resort single
/// message needs this: results are not retained, so the calls they answer
/// cannot be kept either.
pub fn strip_dangling_tool_calls(message: &Message) -> Message {
    if message.role != Role::Assistant || message.tool_calls().is_empty() {
        return message.clone();
    }
    let mut stripped = message.clone();
    stripped
        .parts
        .retain(|part| !matches!(part, ContentPart::ToolCall(_)));
    stripped.stop_reason = None;
    stripped
}

fn latest_user_index(messages: &[Message]) -> Option<usize> {
    messages
        .iter()
        .rposition(|message| message.role == Role::User)
}

fn sole_replayable_message(messages: &[Message], latest_user_goal: bool) -> Option<Message> {
    let roles: [Role; 2] = if latest_user_goal {
        [Role::User, Role::Assistant]
    } else {
        [Role::Assistant, Role::User]
    };
    for role in roles {
        for message in messages.iter().rev() {
            if message.role != role || !is_replayable(message) {
                continue;
            }
            return Some(if role == Role::Assistant {
                strip_dangling_tool_calls(message)
            } else {
                message.clone()
            });
        }
    }
    None
}

/// The newest contiguous run of `messages` that fits `max_tokens`.
///
/// Always keeps the newest replayable message — truncating it when one message
/// alone exceeds the budget — so a fallback can never install an empty tail.
pub fn select_recent_tail(
    messages: &[Message],
    max_tokens: u64,
    latest_user_goal: bool,
) -> Vec<Message> {
    let budget = std::cmp::max(1, max_tokens);
    let mut start = messages.len();
    let mut tokens = 0u64;

    while start > 0 {
        let candidate = &messages[start - 1];
        if !is_replayable(candidate) {
            start -= 1;
            continue;
        }
        let cost = std::cmp::max(1, estimate_message_tokens(candidate));
        // The newest message is always kept; every older one has to fit.
        if tokens + cost > budget && start < messages.len() {
            break;
        }
        tokens += cost;
        start -= 1;
    }

    let mut window: Vec<Message> = messages[start..]
        .iter()
        .filter(|message| is_replayable(message))
        .cloned()
        .collect();

    if latest_user_goal && !window.iter().any(|message| message.role == Role::User) {
        if let Some(index) = latest_user_index(messages) {
            window.insert(
                0,
                truncate_message_to_tail(&messages[index], std::cmp::max(1, budget / 2)),
            );
        }
    }

    let window: Vec<Message> = window
        .into_iter()
        .map(|message| {
            if estimate_message_tokens(&message) > budget {
                truncate_message_to_tail(&message, budget)
            } else {
                message
            }
        })
        .collect();
    let tail = prune_orphan_tool_results(&window);
    if !tail.is_empty() {
        return tail;
    }
    // A truncated window can prune down to nothing when its only message was a
    // tool result whose call fell outside the budget. Keep one message of its
    // own, so the checkpoint still restores something the provider accepts.
    match sole_replayable_message(messages, latest_user_goal) {
        Some(solo) => vec![truncate_message_to_tail(&solo, budget)],
        None => Vec::new(),
    }
}

/// One summary request's worth of input.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct SummaryInput {
    pub messages_to_summarize: Vec<Message>,
    /// The previous checkpoint's summary, when this summary extends one.
    pub previous_summary: Option<String>,
}

/// Structural description of what a summary request will carry.
#[derive(Debug, Clone, PartialEq)]
pub struct SummaryRequest {
    /// System instructions for the summarizer.
    pub system: String,
    /// Serialized conversation, tool results capped the way the adapter sends
    /// them.
    pub user: String,
}

const SUMMARY_SYSTEM_PROMPT: &str = "You are compacting a long agent conversation so the same agent can continue the task with less context.\n\
Write a dense summary of the conversation below. Keep: the user's objective and constraints, decisions taken and why, files and paths touched, commands that mattered and their results, unfinished work and the next concrete step. Drop: greetings, restated instructions, and any tool output that did not change a decision.\n\
Write plain prose under these headings: Objective, Decisions, Files and commands, Open work. Do not add commentary about summarizing.";

/// Serialize the conversation the way a summary request carries it: every role
/// labelled, tool results capped, thinking dropped.
pub fn serialize_conversation(messages: &[Message]) -> String {
    let mut out = String::new();
    for message in messages {
        let role = message.role.as_str();
        let mut body = String::new();
        for part in &message.parts {
            match part {
                ContentPart::Text { text } | ContentPart::Thinking { text } => {
                    // Thinking is not summarized: it is not part of the record
                    // the checkpoint covers.
                    if matches!(part, ContentPart::Text { .. }) {
                        body.push_str(text);
                    }
                }
                ContentPart::ToolCall(call) => {
                    body.push_str(&format!(
                        "\n[call {} {}]",
                        call.name,
                        call.raw_arguments
                            .clone()
                            .unwrap_or_else(|| call.arguments.to_string())
                    ));
                }
                ContentPart::ToolResult(result) => {
                    let capped = cap_chars(&result.content, SERIALIZED_TOOL_RESULT_CAP_CHARS);
                    body.push_str(&format!("\n[result {}: {}]", result.name, capped));
                }
                ContentPart::Image { mime_type, .. } => {
                    body.push_str(&format!("\n[image {mime_type}]"));
                }
            }
        }
        if body.trim().is_empty() {
            continue;
        }
        out.push_str(&format!("{role}: {}\n\n", body.trim_end()));
    }
    out.trim_end().to_string()
}

fn cap_chars(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_string();
    }
    let kept: String = text.chars().take(limit).collect();
    format!("{kept}…")
}

/// Build the request for one summary input.
pub fn build_summary_request(input: &SummaryInput) -> SummaryRequest {
    let mut user = String::new();
    if let Some(previous) = &input.previous_summary {
        user.push_str("Earlier summary of the same session (extend it, do not repeat it):\n");
        user.push_str(previous.trim());
        user.push_str("\n\n");
    }
    user.push_str(&serialize_conversation(&input.messages_to_summarize));
    SummaryRequest {
        system: SUMMARY_SYSTEM_PROMPT.to_string(),
        user,
    }
}

/// Tokens the summary request will carry, using the serialized form rather than
/// the raw messages, so a session that is mostly tool output is not sized as if
/// it were mostly prose.
pub fn estimate_summary_prompt_tokens(input: &SummaryInput) -> u64 {
    let request = build_summary_request(input);
    let chars = request.system.chars().count() + request.user.chars().count();
    (chars as f64 / ESTIMATED_TEXT_CHARS_PER_TOKEN).ceil() as u64
}

/// One bounded reduction: tool results keep a short prefix, assistant thinking
/// is dropped. Returns `None` when nothing was reducible, so the caller can fall
/// back without a pointless second request.
pub fn reduce_summary_input(input: &SummaryInput) -> Option<SummaryInput> {
    let mut changed = false;
    let mut reduce_message = |message: &Message| -> Message {
        let mut reduced = message.clone();
        reduced.parts = message
            .parts
            .iter()
            .filter_map(|part| match part {
                ContentPart::Thinking { .. } => {
                    changed = true;
                    None
                }
                ContentPart::ToolResult(result)
                    if result.content.chars().count() > COMPACTION_REDUCED_TOOL_RESULT_CHARS
                        && !result.content.ends_with(REDUCED_TOOL_RESULT_SUFFIX) =>
                {
                    changed = true;
                    Some(ContentPart::ToolResult(crate::message::ToolResult {
                        content: format!(
                            "{}{}",
                            cap_chars(&result.content, COMPACTION_REDUCED_TOOL_RESULT_CHARS),
                            REDUCED_TOOL_RESULT_SUFFIX
                        ),
                        truncated: true,
                        ..result.clone()
                    }))
                }
                other => Some(other.clone()),
            })
            .collect();
        reduced
    };

    let messages = input
        .messages_to_summarize
        .iter()
        .map(&mut reduce_message)
        .collect::<Vec<_>>();
    if !changed {
        return None;
    }
    Some(SummaryInput {
        messages_to_summarize: messages,
        previous_summary: input.previous_summary.clone(),
    })
}

/// Split a summary input into pieces that each fit one request's budget.
///
/// The budget is the model's window minus the prompt safety tokens, filled to
/// [`COMPACTION_SUMMARY_CHUNK_MARGIN`]. A range needing more than
/// [`COMPACTION_SUMMARY_MAX_CHUNKS`] pieces is not a compaction any more and
/// yields `None`, which the caller turns into a retained-tail fallback.
pub fn chunk_summary_input(
    input: &SummaryInput,
    limits: &ContextLimits,
) -> Option<Vec<SummaryInput>> {
    if estimate_summary_prompt_tokens(input) <= summary_budget(limits) {
        return Some(vec![input.clone()]);
    }
    // Size chunks by the same serialized characters the preflight measures, so a
    // chunk cannot be planned to fit and then measured as too large.
    let per_chunk_chars = ((summary_budget(limits) as f64 * COMPACTION_SUMMARY_CHUNK_MARGIN)
        * ESTIMATED_TEXT_CHARS_PER_TOKEN) as usize;
    let fixed_chars = {
        let empty = build_summary_request(&SummaryInput {
            messages_to_summarize: Vec::new(),
            previous_summary: input.previous_summary.clone(),
        });
        empty.system.chars().count() + empty.user.chars().count()
    };

    let mut chunks: Vec<SummaryInput> = Vec::new();
    let mut current: Vec<Message> = Vec::new();
    let mut current_chars = fixed_chars;

    for message in &input.messages_to_summarize {
        let mut candidate = message.clone();
        let mut cost = serialized_chars(&candidate);
        if cost + fixed_chars > per_chunk_chars {
            // One message larger than a chunk: cut it rather than lose the
            // range, and say so in the text.
            let allowance = per_chunk_chars.saturating_sub(fixed_chars).max(1);
            let tokens = ((allowance as f64) * 0.8 / ESTIMATED_TEXT_CHARS_PER_TOKEN) as u64;
            candidate = truncate_message_to_tail(&candidate, tokens.max(1));
            if let Some(last) = candidate
                .parts
                .iter_mut()
                .rev()
                .find_map(|part| match part {
                    ContentPart::Text { text } => Some(text),
                    _ => None,
                })
            {
                last.push_str(SUMMARY_CHUNK_TRUNCATION_MARKER);
            }
            cost = serialized_chars(&candidate);
        }
        if current_chars + cost > per_chunk_chars && !current.is_empty() {
            chunks.push(SummaryInput {
                messages_to_summarize: std::mem::take(&mut current),
                previous_summary: input.previous_summary.clone(),
            });
            current_chars = fixed_chars;
            if chunks.len() >= COMPACTION_SUMMARY_MAX_CHUNKS {
                return None;
            }
        }
        current_chars += cost;
        current.push(candidate);
    }
    if !current.is_empty() {
        chunks.push(SummaryInput {
            messages_to_summarize: current,
            previous_summary: input.previous_summary.clone(),
        });
    }
    if chunks.len() > COMPACTION_SUMMARY_MAX_CHUNKS {
        return None;
    }
    Some(chunks)
}

/// Characters one message contributes to a serialized conversation, including
/// the separator a multi-message body inserts.
fn serialized_chars(message: &Message) -> usize {
    serialize_conversation(std::slice::from_ref(message))
        .chars()
        .count()
        + 2
}

fn summary_budget(limits: &ContextLimits) -> u64 {
    limits
        .window
        .saturating_sub(COMPACTION_SUMMARY_PROMPT_SAFETY_TOKENS)
        .max(1)
}

/// What a checkpoint would do, before anything is generated.
#[derive(Debug, Clone, PartialEq)]
pub struct CompactionPlan {
    pub mode: CompactionMode,
    /// Messages the summary must cover.
    pub summary_input: SummaryInput,
    /// Messages the checkpoint keeps verbatim.
    pub retained: Vec<Message>,
    pub tokens_before: u64,
    /// Last summarized message; `None` when nothing is summarized.
    pub through_message_id: Option<String>,
    /// First retained message; `None` when the tail is empty.
    pub first_kept_message_id: Option<String>,
}

/// What a successful compaction produced, in the shape the store keeps.
///
/// The installed checkpoint lives in the transcript for the rest of the run, but
/// a restart rebuilds that transcript from the store. Without this record the
/// summary is discarded and the resumed model reads the raw rows the summary had
/// already replaced — a different history than the one it compacted, chosen
/// afresh on every restart.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompactionOutcome {
    pub summary: String,
    pub tokens_before: u64,
    /// Last message the summary replaced. The store resumes after it.
    pub through_message_id: String,
    /// First message kept verbatim, when the checkpoint kept any.
    pub first_kept_message_id: Option<String>,
    /// Every message kept verbatim, in transcript order. Stored as ids: a
    /// restart re-reads the real rows instead of a second copy of them.
    pub retained_ids: Vec<String>,
}

/// Decide the cut point and build the summary input for `mode`.
///
/// `ActiveTurn` keeps the latest user message so the continuation never loses
/// its goal; `CompletedTurn` keeps nothing, because the summary is authoritative
/// for finished work and the next prompt is the only new task; `FreshWindow`
/// summarizes nothing.
pub fn plan_compaction(
    messages: &[Message],
    limits: &ContextLimits,
    mode: CompactionMode,
) -> Option<CompactionPlan> {
    if messages.is_empty() {
        return None;
    }
    let tokens_before = estimate_context_tokens(messages).tokens;

    if mode == CompactionMode::FreshWindow {
        return Some(CompactionPlan {
            mode,
            summary_input: SummaryInput::default(),
            retained: Vec::new(),
            tokens_before,
            through_message_id: messages.last().map(|message| message.id.clone()),
            first_kept_message_id: None,
        });
    }

    let retain_index = if mode.retains_latest_user_message() {
        latest_user_index(messages)
    } else {
        None
    };

    let summary_messages: Vec<Message> = messages
        .iter()
        .enumerate()
        .filter(|(index, _)| Some(*index) != retain_index)
        .map(|(_, message)| message.clone())
        .collect();
    let retained = match retain_index {
        Some(index) => vec![truncate_message_to_tail(
            &messages[index],
            limits.retained_user_message_budget,
        )],
        None => Vec::new(),
    };

    // A summary of nothing is not a checkpoint.
    if summary_messages.is_empty() {
        return None;
    }

    Some(CompactionPlan {
        mode,
        summary_input: SummaryInput {
            messages_to_summarize: summary_messages,
            previous_summary: None,
        },
        retained,
        tokens_before,
        through_message_id: messages.last().map(|message| message.id.clone()),
        first_kept_message_id: retain_index.map(|index| messages[index].id.clone()),
    })
}

/// The retained tail a *failed* summary installs, sized by the budget left after
/// the recovery notice.
pub fn retained_tail_fallback(
    messages: &[Message],
    limits: &ContextLimits,
    mode: CompactionMode,
) -> Vec<Message> {
    select_recent_tail(
        messages,
        limits.keep_recent_tokens,
        mode.retains_latest_user_message(),
    )
}

/// Convenience for callers holding only model facts.
pub fn plan_for_model(
    messages: &[Message],
    model: ModelLimits,
    mode: CompactionMode,
) -> Option<CompactionPlan> {
    plan_compaction(messages, &ContextLimits::for_model(model), mode)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::ContextLimits;
    use crate::message::{ToolCall, ToolResult, Usage};

    fn limits() -> ContextLimits {
        ContextLimits::for_model(ModelLimits::new(128_000, 32_768))
    }

    fn assistant_call(id: &str) -> Message {
        let mut message = Message::new(Role::Assistant);
        message.push_tool_call(ToolCall {
            id: id.into(),
            name: "read_file".into(),
            arguments: serde_json::json!({"path": "a.txt"}),
            raw_arguments: None,
        });
        message
    }

    fn tool_result(id: &str, content: &str) -> Message {
        Message::tool_result(ToolResult {
            call_id: id.into(),
            name: "read_file".into(),
            content: content.into(),
            is_error: false,
            truncated: false,
        })
    }

    fn big_text(tokens: u64) -> String {
        "a".repeat((tokens as f64 * ESTIMATED_TEXT_CHARS_PER_TOKEN) as usize)
    }

    #[test]
    fn a_completed_turn_checkpoint_keeps_no_history() {
        let messages = vec![
            Message::user_text("do the thing"),
            assistant_call("call_1"),
            tool_result("call_1", "ok"),
        ];
        let plan =
            plan_compaction(&messages, &limits(), CompactionMode::CompletedTurn).expect("a plan");
        assert!(plan.retained.is_empty());
        assert_eq!(plan.summary_input.messages_to_summarize.len(), 3);
        assert_eq!(
            plan.through_message_id.as_deref(),
            Some(messages[2].id.as_str())
        );
        assert!(plan.first_kept_message_id.is_none());
    }

    #[test]
    fn an_active_turn_checkpoint_keeps_only_the_latest_user_message() {
        let messages = vec![
            Message::user_text("first task"),
            Message::user_text("the current task"),
            assistant_call("call_1"),
            tool_result("call_1", "ok"),
        ];
        let plan =
            plan_compaction(&messages, &limits(), CompactionMode::ActiveTurn).expect("a plan");
        assert_eq!(plan.retained.len(), 1);
        assert_eq!(plan.retained[0].text(), "the current task");
        assert_eq!(plan.summary_input.messages_to_summarize.len(), 3);
        assert_eq!(
            plan.first_kept_message_id.as_deref(),
            Some(messages[1].id.as_str())
        );
        assert_eq!(
            plan.through_message_id.as_deref(),
            Some(messages[3].id.as_str())
        );
        assert_eq!(
            plan.first_kept_message_id.as_deref(),
            Some(messages[1].id.as_str()),
            "the checkpoint's boundary names the message it keeps"
        );
    }

    #[test]
    fn an_oversized_retained_user_message_is_truncated_not_dropped() {
        let messages = vec![
            Message::user_text("history"),
            Message::user_text(big_text(200_000)),
        ];
        let plan =
            plan_compaction(&messages, &limits(), CompactionMode::ActiveTurn).expect("a plan");
        assert_eq!(plan.retained.len(), 1);
        assert!(plan.retained[0].text().contains("checkpoint truncated"));
        assert!(estimate_message_tokens(&plan.retained[0]) < 200_000);
    }

    #[test]
    fn a_fresh_window_summarizes_nothing() {
        let messages = vec![Message::user_text("a"), Message::user_text("b")];
        let plan =
            plan_compaction(&messages, &limits(), CompactionMode::FreshWindow).expect("a plan");
        assert!(plan.summary_input.messages_to_summarize.is_empty());
        assert!(plan.retained.is_empty());
    }

    #[test]
    fn nothing_to_summarize_is_not_a_plan() {
        // A single user message in ActiveTurn mode leaves no history to cover.
        let messages = vec![Message::user_text("only one")];
        assert!(plan_compaction(&messages, &limits(), CompactionMode::ActiveTurn).is_none());
        assert!(plan_compaction(&[], &limits(), CompactionMode::CompletedTurn).is_none());
    }

    #[test]
    fn an_installed_checkpoint_forces_a_reanchor() {
        let message = checkpoint_message("Objective: port the trigger.\nOpen work: the c item.");
        assert!(message.text().starts_with(CHECKPOINT_HEADER));
        assert!(message.text().contains("Objective: port the trigger."));
        assert!(
            message.text().contains(CHECKPOINT_REANCHOR_DIRECTIVE),
            "the boundary must tell the model to reconcile before acting: {}",
            message.text()
        );
    }

    #[test]
    fn the_recent_tail_keeps_newest_messages_within_budget() {
        let messages: Vec<Message> = (0..10)
            .map(|index| Message::user_text(format!("message {index} {}", big_text(500))))
            .collect();
        let tail = select_recent_tail(&messages, 1_600, false);
        assert!(!tail.is_empty());
        assert!(estimate_context_tokens(&tail).tokens <= 1_600 + 200);
        // The newest message is always there.
        assert!(tail.last().unwrap().text().starts_with("message 9"));
    }

    #[test]
    fn the_tail_always_keeps_the_newest_message_even_when_it_alone_exceeds_budget() {
        let messages = vec![Message::user_text(big_text(50_000))];
        let tail = select_recent_tail(&messages, 100, false);
        assert_eq!(tail.len(), 1);
        assert!(estimate_message_tokens(&tail[0]) <= 200);
        assert!(tail[0].text().contains("checkpoint truncated"));
    }

    #[test]
    fn the_tail_drops_orphan_tool_results() {
        // The assistant call is outside the retained window; its result is not.
        let messages = vec![
            assistant_call("call_old"),
            Message::user_text(big_text(2_000)),
            tool_result("call_old", "stale"),
        ];
        let tail = select_recent_tail(&messages, 200, false);
        assert!(
            !tail.iter().any(|message| message.role == Role::Tool),
            "a result with no call in the window must not survive"
        );
    }

    #[test]
    fn an_active_turn_tail_carries_the_user_goal_ahead_of_the_window() {
        // The window itself is assistant text, so the goal has to be prepended.
        let mut first = Message::new(Role::Assistant);
        first.push_text(&big_text(2_000));
        let mut second = Message::new(Role::Assistant);
        second.push_text(&big_text(2_000));
        let messages = vec![Message::user_text("the goal"), first, second];
        let tail = select_recent_tail(&messages, 1_000, true);
        assert_eq!(tail.first().unwrap().text(), "the goal");
        assert!(tail.len() >= 2);
    }

    #[test]
    fn an_assistant_message_the_provider_drops_is_not_retained() {
        let mut dropped = Message::new(Role::Assistant);
        dropped.push_text("aborted");
        dropped.stop_reason = Some(StopReason::Other("aborted".into()));
        let messages = vec![Message::user_text("question"), dropped];
        let tail = select_recent_tail(&messages, 10_000, false);
        assert_eq!(tail.len(), 1);
        assert_eq!(tail[0].role, Role::User);
    }

    #[test]
    fn pruning_keeps_paired_results_and_drops_the_rest() {
        let messages = vec![
            assistant_call("call_1"),
            tool_result("call_1", "paired"),
            tool_result("call_2", "orphan"),
        ];
        let pruned = prune_orphan_tool_results(&messages);
        assert_eq!(pruned.len(), 2);
        assert_eq!(pruned[1].tool_results()[0].content, "paired");
    }

    #[test]
    fn a_stripped_assistant_keeps_its_text_but_loses_the_call() {
        let mut message = Message::new(Role::Assistant);
        message.push_text("thinking out loud");
        message.push_tool_call(ToolCall {
            id: "call_1".into(),
            name: "read_file".into(),
            arguments: serde_json::json!({}),
            raw_arguments: None,
        });
        let stripped = strip_dangling_tool_calls(&message);
        assert!(stripped.tool_calls().is_empty());
        assert_eq!(stripped.text(), "thinking out loud");
        assert!(stripped.stop_reason.is_none());
    }

    #[test]
    fn the_summary_request_sizes_tool_output_the_way_it_sends_it() {
        let huge = tool_result("call_1", &"x".repeat(50_000));
        let messages = vec![assistant_call("call_1"), huge];
        let input = SummaryInput {
            messages_to_summarize: messages,
            previous_summary: None,
        };
        let request = build_summary_request(&input);
        // Capped at 2,000 characters, not 50,000.
        assert!(
            request.user.chars().count() < 3_000,
            "{}",
            request.user.len()
        );
        assert!(request.user.contains("[result read_file:"));
        assert!(request.system.contains("Objective"));
    }

    #[test]
    fn a_previous_summary_is_carried_and_labelled() {
        let input = SummaryInput {
            messages_to_summarize: vec![Message::user_text("next step")],
            previous_summary: Some("earlier decisions".into()),
        };
        let request = build_summary_request(&input);
        assert!(request.user.starts_with("Earlier summary"));
        assert!(request.user.contains("earlier decisions"));
        assert!(request.user.contains("user: next step"));
    }

    #[test]
    fn reducing_drops_thinking_and_caps_tool_results_once() {
        let mut assistant = Message::new(Role::Assistant);
        assistant.push_thinking("long reasoning");
        assistant.push_text("answer");
        let input = SummaryInput {
            messages_to_summarize: vec![
                big_tool_result(5_000),
                assistant,
                Message::user_text("keep me whole"),
            ],
            previous_summary: None,
        };
        let reduced = reduce_summary_input(&input).expect("something was reducible");
        assert!(reduced.messages_to_summarize[0].tool_results()[0]
            .content
            .contains("truncated for the summary request"));
        assert!(reduced.messages_to_summarize[1].thinking().is_none());
        assert_eq!(reduced.messages_to_summarize[2].text(), "keep me whole");
        // A second pass finds nothing left to reduce.
        assert!(reduce_summary_input(&reduced).is_none());
    }

    fn big_tool_result(chars: usize) -> Message {
        let mut assistant = assistant_call("call_big");
        let _ = &mut assistant;
        tool_result("call_big", &"y".repeat(chars))
    }

    #[test]
    fn an_input_that_already_fits_is_one_chunk() {
        let input = SummaryInput {
            messages_to_summarize: vec![Message::user_text("short")],
            previous_summary: None,
        };
        let chunks = chunk_summary_input(&input, &limits()).expect("one chunk");
        assert_eq!(chunks.len(), 1);
    }

    #[test]
    fn a_range_too_large_for_one_request_is_split_and_keeps_order() {
        let limits = limits();
        // 40 messages of ~2,000 tokens each exceed the 128k window's summary
        // budget, so the range has to be split.
        let messages: Vec<Message> = (0..40)
            .map(|index| Message::user_text(format!("part {index} {}", big_text(4_000))))
            .collect();
        let input = SummaryInput {
            messages_to_summarize: messages,
            previous_summary: None,
        };
        let chunks = chunk_summary_input(&input, &limits).expect("chunks");
        assert!(
            chunks.len() > 1,
            "expected several chunks, got {}",
            chunks.len()
        );
        for chunk in &chunks {
            assert!(estimate_summary_prompt_tokens(chunk) <= summary_budget(&limits));
        }
        let joined: String = chunks
            .iter()
            .flat_map(|chunk| chunk.messages_to_summarize.iter())
            .map(|message| message.text())
            .collect::<Vec<_>>()
            .join("|");
        let first = joined.find("part 0").unwrap();
        let last = joined.find("part 39").unwrap();
        assert!(first < last, "chunking must preserve order");
    }

    #[test]
    fn the_fallback_tail_is_sized_by_the_keep_recent_target() {
        let messages: Vec<Message> = (0..20)
            .map(|index| Message::user_text(format!("m{index} {}", big_text(1_000))))
            .collect();
        let tail = retained_tail_fallback(&messages, &limits(), CompactionMode::CompletedTurn);
        assert!(!tail.is_empty());
        assert!(estimate_context_tokens(&tail).tokens <= limits().keep_recent_tokens);
    }

    #[test]
    fn usage_anchored_messages_do_not_inflate_the_tokens_before() {
        let mut assistant = Message::new(Role::Assistant);
        assistant.push_text("done");
        assistant.stop_reason = Some(StopReason::EndTurn);
        assistant.usage = Some(Usage {
            input_tokens: 40_000,
            output_tokens: 100,
            ..Usage::default()
        });
        let messages = vec![Message::user_text(big_text(10_000)), assistant];
        let plan =
            plan_compaction(&messages, &limits(), CompactionMode::CompletedTurn).expect("a plan");
        assert_eq!(plan.tokens_before, 40_100);
    }
}
