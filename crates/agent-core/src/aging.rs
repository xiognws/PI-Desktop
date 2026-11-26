//! Keeping old tool output from crowding out the work.
//!
//! A long session's history is dominated by what tools returned — measured on a
//! 40-turn transcript, tool output was **94.6%** of the request's tokens. Almost
//! none of that is read again: a build log from twenty steps ago is there because
//! it happened, not because the model will consult it. Sending it whole on every
//! step costs the budget that the next turn needs.
//!
//! This module ages tool results **in the request only**. The transcript keeps every
//! byte, so the same conversation can be exported, re-read from the store, or
//! compacted later, and a model that actually needs an old output can re-run the
//! command. The newest few results stay whole, because that is where the model is
//! working.
//!
//! Two rules make the saving free rather than merely smaller:
//!
//! - **Nothing changes until the request is under pressure.** A request below the
//!   aging threshold is byte-identical to what it would have been, so the provider's
//!   prompt cache keeps hitting. Aging starts when the window is genuinely at risk,
//!   which is exactly when one extra cache write is worth paying.
//! - **Aging is a pure function of the messages and the limits.** The same
//!   conversation and the same model produce the same request, so a retry or a
//!   second comparison sees the same bytes.

use crate::context::{estimate_context_tokens, ContextLimits};

/// The share of the compaction trigger below which a *small* window still asks
/// for aging. Only ever lowers the absolute threshold, never raises it.
const LEGACY_TRIGGER_SHARE: f64 = 0.6;
use crate::message::Message;

/// How much of an aged tool result is kept.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ToolResultAging {
    /// Newest results left whole: this is the window the model is working in.
    pub keep_recent: usize,
    /// Characters of an aged result that survive, from its head.
    ///
    /// The head is where a command echoed what it was asked to do.
    pub head_chars: usize,
    /// Characters kept from the tail, where a build log puts the failure.
    ///
    /// Cutting only from the end would drop exactly the lines a model needs to
    /// diagnose the next step, so an aged result keeps both ends and loses the
    /// middle.
    pub tail_chars: usize,
    /// Prompt size, in tokens, at which aging starts.
    ///
    /// Absolute on purpose. A share of the window made the relief arrive *later* on a
    /// bigger model — a 1M-token window kept 740k tokens of history in every step for
    /// the whole turn, paying for the whole transcript a dozen times, because 0.6 of a
    /// ~800k trigger meant nothing aged until the request was already enormous. Aging
    /// costs no request at all, so it should start as soon as the prompt is no longer
    /// small; compaction (which does cost a summary request) keeps its own, later
    /// trigger.
    pub trigger_tokens: u64,
    /// Characters above which one result is aged **even when it is one of the newest**.
    ///
    /// Also absolute. As a share of the window this was 600k characters on a 1M model,
    /// so a 110KB Bash result — 27k tokens, re-sent on every later step — counted as
    /// normal. A result that large is never needed whole in the request: the head and
    /// tail carry the command and the failure, and the spill file still holds the rest.
    pub oversize_chars: usize,
}

impl Default for ToolResultAging {
    fn default() -> Self {
        Self {
            // One: only the result the model is answering right now stays whole. The
            // step before it is usually already read, and keeping it whole was the
            // difference between ~40k and ~25k per request on long turns.
            keep_recent: 1,
            head_chars: 400,
            tail_chars: 400,
            // 32k: the system prompt alone is ~9.4k tokens here, so this starts
            // eliding while the request is still small.
            trigger_tokens: 32_000,
            oversize_chars: 8_000,
        }
    }
}

/// What aging did, for a caller that wants to report or assert it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AgingOutcome {
    pub messages: Vec<Message>,
    pub aged: usize,
    pub chars_elided: usize,
}

impl AgingOutcome {
    fn untouched(messages: &[Message]) -> Self {
        Self {
            messages: messages.to_vec(),
            aged: 0,
            chars_elided: 0,
        }
    }

    pub fn changed(&self) -> bool {
        self.aged > 0
    }
}

/// The marker an aged result carries, so the model knows the output was cut and
/// how to get it back rather than assuming the command printed nothing.
pub fn elision_marker(elided: usize) -> String {
    // `\n` on both sides: the marker must not run into the head or the tail it
    // sits between.
    format!("\n…[{elided} chars of this output are not in this context; re-run the command if you need them]\n")
}

/// Age old tool results when the request is under pressure.
///
/// Without model limits there is no way to know what "under pressure" means, and a
/// guess would silently truncate a conversation on a model that had room for it —
/// so an unknown window means no aging.
pub fn age_tool_results(
    messages: &[Message],
    limits: Option<&ContextLimits>,
    policy: ToolResultAging,
) -> AgingOutcome {
    let estimate = estimate_context_tokens(messages).tokens;
    // The absolute threshold is the one that pays the bills; the window only ever
    // makes the relief arrive *earlier* than the absolute rule would, never later.
    // An unknown window therefore no longer disables aging: the estimate is still
    // meaningful, and leaving a 700k-token request untouched because the model did
    // not report its limits is the expensive default.
    let threshold = match limits {
        Some(limits) => policy
            .trigger_tokens
            .min((limits.trigger as f64 * LEGACY_TRIGGER_SHARE) as u64),
        None => policy.trigger_tokens,
    };
    if estimate < threshold {
        return AgingOutcome::untouched(messages);
    }

    let results: Vec<usize> = messages
        .iter()
        .enumerate()
        .filter(|(_, message)| !message.tool_results().is_empty())
        .map(|(index, _)| index)
        .collect();
    // A single result that eats a large share of the window cannot be left whole even
    // when it is one of the newest: keeping it guarantees the next request is over
    // budget, and compaction cannot shrink it (the same bytes return on the next step
    // and trigger another compaction). Measured before this rule: five compaction
    // rounds followed by `STEP_LIMIT`, with the model re-running the same command each
    // step because every output was compacted away before it could be used.
    let oversize_chars = policy.oversize_chars;
    let keep_from = results.len().saturating_sub(policy.keep_recent);
    let ageable: Vec<usize> = results
        .iter()
        .enumerate()
        .filter(|(rank, index)| {
            *rank < keep_from
                || messages[**index]
                    .tool_results()
                    .iter()
                    .any(|result| result.content.chars().count() > oversize_chars)
        })
        .map(|(_, index)| *index)
        .collect();
    if ageable.is_empty() {
        return AgingOutcome::untouched(messages);
    }

    let mut aged_messages = messages.to_vec();
    let mut aged = 0usize;
    let mut chars_elided = 0usize;
    for index in &ageable {
        let message = &mut aged_messages[*index];
        let mut rewritten = false;
        for result in message.tool_results_mut() {
            let chars: usize = result.content.chars().count();
            if chars <= policy.head_chars + policy.tail_chars {
                continue;
            }
            let head: String = result.content.chars().take(policy.head_chars).collect();
            // From the end, so the newest lines of a log survive.
            let tail: String = result
                .content
                .chars()
                .rev()
                .take(policy.tail_chars)
                .collect::<Vec<char>>()
                .into_iter()
                .rev()
                .collect();
            let elided = chars - head.chars().count() - tail.chars().count();
            result.content = format!("{head}{}{tail}", elision_marker(elided));
            chars_elided += elided;
            rewritten = true;
        }
        if rewritten {
            aged += 1;
        }
    }

    if aged == 0 {
        return AgingOutcome::untouched(messages);
    }
    AgingOutcome {
        messages: aged_messages,
        aged,
        chars_elided,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::message::{Role, ToolResult};

    /// A transcript of `turns` user/tool pairs, each tool result `chars` long.
    fn transcript(turns: usize, chars: usize) -> Vec<Message> {
        let mut messages = Vec::new();
        for index in 0..turns {
            messages.push(Message::user_text(format!("step {index}")));
            messages.push(Message::tool_result(ToolResult {
                call_id: format!("call-{index}"),
                name: "Bash".into(),
                content: "x".repeat(chars),
                is_error: false,
                truncated: false,
            }));
        }
        messages
    }

    fn policy() -> ToolResultAging {
        ToolResultAging {
            keep_recent: 1,
            head_chars: 400,
            tail_chars: 400,
            trigger_tokens: 32_000,
            oversize_chars: 8_000,
        }
    }

    /// A limit set whose aging threshold sits at 60% of the trigger used below.
    fn limit(trigger: u64) -> ContextLimits {
        ContextLimits {
            window: trigger * 2,
            hard_limit: trigger * 2,
            request_headroom: trigger,
            keep_recent_tokens: 4_000,
            trigger,
            retained_user_message_budget: 2_000,
            compaction_enabled: true,
        }
    }

    #[test]
    fn a_single_oversized_result_is_aged_even_when_it_is_the_newest() {
        // 回归：只有一条超大工具结果时，`keep_recent` 会把它整条留下 → 请求永远超预算
        // → 压缩反复触发（实测 5 轮后 STEP_LIMIT）。超大结果必须无视 keep_recent 被老化。
        let messages = transcript(1, 60_000);
        let outcome = age_tool_results(&messages, Some(&limit(20_000)), policy());
        assert!(
            outcome.changed(),
            "the newest and only result is oversized and must be aged"
        );
        assert_eq!(outcome.aged, 1);
        let content = &outcome.messages[1].tool_results()[0].content;
        assert!(
            content.contains("are not in this context"),
            "an aged result must carry the recovery marker: {:?}",
            &content.chars().take(80).collect::<String>()
        );
        assert!(
            content.chars().count() < 60_000,
            "the result must actually shrink; still {} chars",
            content.chars().count()
        );
    }

    #[test]
    fn a_request_with_room_is_sent_untouched() {
        // The cache is the point: below the threshold the bytes must not move.
        let messages = transcript(5, 4_000);
        let outcome = age_tool_results(&messages, Some(&limit(1_000_000)), policy());
        assert_eq!(outcome.aged, 0);
        assert_eq!(outcome.messages, messages);
    }

    #[test]
    fn a_small_request_stays_untouched_even_without_limits() {
        let messages = transcript(20, 4_000);
        let outcome = age_tool_results(&messages, None, policy());
        assert_eq!(outcome.aged, 0);
        assert_eq!(outcome.messages, messages);
    }

    #[test]
    fn an_unknown_window_still_ages_past_the_absolute_threshold() {
        // The absolute threshold is what pays the bills: a model that never reported
        // its window used to keep every byte, so the request grew without relief.
        let messages = transcript(20, 20_000);
        let outcome = age_tool_results(&messages, None, policy());
        assert!(
            outcome.changed(),
            "past the absolute threshold aging must run with or without limits"
        );
        // Every result here is 20k characters, past the absolute oversize rule, so
        // even the newest two are aged — that is the point of an absolute size.
        assert_eq!(outcome.aged, 20);
    }

    #[test]
    fn under_pressure_only_the_recent_working_set_stays_whole() {
        let messages = transcript(20, 4_000);
        let outcome = age_tool_results(&messages, Some(&limit(20_000)), policy());
        assert!(outcome.changed(), "20 turns of 4k output is over the limit");
        // 20 results, the newest one stays whole.
        assert_eq!(outcome.aged, 19);
        let tool_rows: Vec<&Message> = outcome
            .messages
            .iter()
            .filter(|message| !message.tool_results().is_empty())
            .collect();
        for (index, message) in tool_rows.iter().enumerate() {
            let content = &message.tool_results()[0].content;
            let whole = index >= tool_rows.len() - 1;
            assert_eq!(
                !content.contains("are not in this context"),
                whole,
                "row {index} whole={whole}: {:?}",
                content.chars().take(60).collect::<String>()
            );
        }
    }

    #[test]
    fn an_aged_result_says_what_was_dropped_and_keeps_its_identity() {
        let messages = transcript(20, 4_000);
        let outcome = age_tool_results(&messages, Some(&limit(20_000)), policy());
        let aged = outcome
            .messages
            .iter()
            .find(|message| !message.tool_results().is_empty())
            .expect("a tool row");
        let result = &aged.tool_results()[0];
        assert_eq!(result.call_id, "call-0", "the call it answers is unchanged");
        assert_eq!(result.name, "Bash");
        assert!(
            result
                .content
                .contains("chars of this output are not in this context"),
            "{}",
            result.content
        );
        assert!(result.content.starts_with('x'), "the head is kept");
        assert!(result.content.ends_with('x'), "the tail is kept too");
    }

    #[test]
    fn the_saving_is_reported_and_is_a_real_reduction() {
        let messages = transcript(20, 4_000);
        let before = estimate_context_tokens(&messages).tokens;
        let outcome = age_tool_results(&messages, Some(&limit(20_000)), policy());
        let after = estimate_context_tokens(&outcome.messages).tokens;
        assert!(
            after * 3 < before,
            "aging should cut most of the old output: {before} -> {after}"
        );
        // 19 aged results lose everything except both ends (400 + 400 characters).
        assert!(
            outcome.chars_elided > 19 * 3_000,
            "elided {} chars",
            outcome.chars_elided
        );
    }

    #[test]
    fn the_transcript_itself_is_never_modified() {
        let messages = transcript(20, 4_000);
        let original = messages.clone();
        let _ = age_tool_results(&messages, Some(&limit(20_000)), policy());
        assert_eq!(
            messages, original,
            "the caller's messages are what the store and the next turn see"
        );
    }

    /// A build log puts the failure in its last lines: aging must not be a
    /// truncation that drops them.
    #[test]
    fn the_tail_of_an_aged_result_carries_the_failure() {
        let mut messages = transcript(20, 4_000);
        for index in [1usize, 3] {
            if let Some(result) = messages[index].tool_results_mut().first_mut() {
                result.content = format!(
                    "{}{}",
                    "compile line
"
                    .repeat(300),
                    "error: unresolved import `x`
at the very end"
                );
            }
        }
        let outcome = age_tool_results(&messages, Some(&limit(20_000)), policy());
        let aged = &outcome.messages[1].tool_results()[0].content;
        assert!(aged.ends_with("at the very end"), "tail kept: {aged:?}");
        assert!(aged.contains("are not in this context"));
    }

    #[test]
    fn a_short_result_is_left_alone_even_when_old() {
        let mut messages = transcript(20, 4_000);
        // Make the oldest result short: there is nothing to save by aging it.
        if let Some(result) = messages[1].tool_results_mut().first_mut() {
            result.content = "ok".into();
        }
        let outcome = age_tool_results(&messages, Some(&limit(20_000)), policy());
        assert_eq!(
            outcome.messages[1].tool_results()[0].content,
            "ok",
            "a result shorter than the head budget is already cheap"
        );
    }

    #[test]
    fn an_assistant_tool_call_row_is_never_aged() {
        let messages = transcript(20, 4_000);
        let outcome = age_tool_results(&messages, Some(&limit(20_000)), policy());
        for (before, after) in messages.iter().zip(outcome.messages.iter()) {
            if after.tool_results().is_empty() {
                assert_eq!(before, after, "only tool results are aged");
            }
            assert_eq!(before.role, after.role);
        }
    }

    #[test]
    fn the_role_of_every_message_survives() {
        let messages = transcript(20, 4_000);
        let outcome = age_tool_results(&messages, Some(&limit(20_000)), policy());
        assert_eq!(
            outcome
                .messages
                .iter()
                .filter(|m| m.role == Role::Tool)
                .count(),
            20
        );
    }
}
