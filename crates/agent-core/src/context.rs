//! Context budget: how much room a request has, and where compaction starts.
//!
//! Upstream counterpart: `agent/context_compressor.py`. The numbers are the
//! desktop's own and are ported from `context-budget.ts` +
//! `pi-runtime-estimates.ts`, because they are a spend bound, not a stylistic
//! choice:
//!
//! * the window a session plans against is capped at 262,144 tokens, so a model
//!   advertising a million cannot carry half a million through hundreds of
//!   requests in one turn;
//! * `hardLimit` is the safety boundary — no provider request is issued at or
//!   above it;
//! * automatic compaction starts at **half** of `hardLimit` (the same 0.5 share
//!   the reference implementation uses for `compression.threshold`), not late in the window;
//! * the retained tail is a ratio of the safe budget, clamped so a small window
//!   still keeps a usable tail and a huge one does not drag the session along.
//!
//! This module is pure arithmetic over messages: it decides *whether* the next
//! request fits. Cutting the transcript and writing a checkpoint is the
//! compaction unit that builds on it.

use crate::message::{Message, Role};

/// Tokens held back for the request's own prompt and the model's output.
pub const COMPACTION_RESERVE_FLOOR_TOKENS: u64 = 16_384;
/// Retained-tail share of the safe budget.
pub const COMPACTION_KEEP_RECENT_RATIO: f64 = 0.2;
pub const COMPACTION_MIN_KEEP_RECENT_TOKENS: u64 = 8_000;
pub const COMPACTION_MAX_KEEP_RECENT_TOKENS: u64 = 64_000;
/// Cap on a user message carried across a compaction boundary.
pub const COMPACTION_RETAINED_USER_MESSAGE_MAX_TOKENS: u64 = 20_000;
/// Spend bound on the window a session plans against.
pub const COMPACTION_CONTEXT_WINDOW_CEILING: u64 = 262_144;
/// Share of `hardLimit` that starts automatic compaction.
pub const AUTO_COMPACTION_TRIGGER_RATIO: f64 = 0.5;
/// Character-per-token ratio used by the text estimator.
pub const ESTIMATED_TEXT_CHARS_PER_TOKEN: f64 = 3.5;
/// What one image costs in the same character currency.
pub const IMAGE_EQUIVALENT_CHARS: u64 = 4_800;

pub const DEFAULT_CONTEXT_WINDOW: u64 = 128_000;
pub const DEFAULT_MAX_TOKENS: u64 = 32_768;

/// The model facts the budget needs, plus the turn's compaction switch.
///
/// A catalog entry that never reported a window falls back to the package
/// defaults instead of producing nonsense.
///
/// `compaction_enabled` is not a model fact; it rides here because this struct
/// is what the engine turns into [`ContextLimits`] (`TurnEngine::with_model_limits`
/// → [`ContextLimits::for_model`]), and that conversion is where the trigger is
/// computed. It carries the user's `compactionSettings.enabled`: the Node runtime
/// reads the same field and nothing else from those settings
/// (`compactionEnabled` in `packages/agent-runtime/src/runtime.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ModelLimits {
    pub context_window: Option<u64>,
    pub max_tokens: Option<u64>,
    /// Whether this turn auto-compacts at the trigger. Defaults to on: the
    /// reference turns automatic protection on unless a caller disables it.
    pub compaction_enabled: bool,
}

impl Default for ModelLimits {
    fn default() -> Self {
        Self {
            context_window: None,
            max_tokens: None,
            compaction_enabled: true,
        }
    }
}

impl ModelLimits {
    pub fn new(context_window: u64, max_tokens: u64) -> Self {
        Self {
            context_window: Some(context_window),
            max_tokens: Some(max_tokens),
            compaction_enabled: true,
        }
    }

    /// Apply the launch's compaction switch (`compactionSettings.enabled`).
    pub fn with_compaction_enabled(mut self, enabled: bool) -> Self {
        self.compaction_enabled = enabled;
        self
    }
}

/// Where the next request stands against the budget.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BudgetDecision {
    /// Below the trigger: send the request as it is.
    Proceed,
    /// At or above the trigger but below the hard boundary: compact first.
    Compact,
    /// At or above the hard boundary: the request must not be issued.
    Overflow,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ContextLimits {
    /// Window actually planned against (after the ceiling).
    pub window: u64,
    /// Point where an uncompacted provider request is no longer allowed.
    pub hard_limit: u64,
    /// Tokens reserved for the request's own prompt and output.
    pub request_headroom: u64,
    /// Approximate recent-context tokens a checkpoint should retain.
    pub keep_recent_tokens: u64,
    /// Token count that starts automatic compaction.
    pub trigger: u64,
    /// Cap on the user message a checkpoint carries forward.
    pub retained_user_message_budget: u64,
    /// Whether reaching [`Self::trigger`] starts a compaction. `false` is the
    /// user's `compactionSettings.enabled: false`: automatic protection is off,
    /// so a request above the trigger is sent as it is. The hard boundary is
    /// unaffected — a request at it is still classified
    /// [`BudgetDecision::Overflow`], which is a safety limit rather than a
    /// compaction preference.
    pub compaction_enabled: bool,
}

impl ContextLimits {
    /// Derive the thresholds for a model window.
    pub fn for_model(model: ModelLimits) -> Self {
        let reported_window = model
            .context_window
            .unwrap_or(DEFAULT_CONTEXT_WINDOW)
            .max(1);
        // Spend bound, not a capability claim.
        let window = reported_window.min(COMPACTION_CONTEXT_WINDOW_CEILING);

        let model_output_budget = model
            .max_tokens
            .unwrap_or(DEFAULT_MAX_TOKENS)
            .max(1)
            .min(std::cmp::max(1, window / 4));

        let reserve_floor = COMPACTION_RESERVE_FLOOR_TOKENS.min(std::cmp::max(1, window / 2));

        // The larger of the reserve floor, the model's own output budget, and 5%
        // of the window: a 32K-output model needs that much room, and a very
        // large window needs proportionally more than the floor.
        // ceil(window * 0.05) without floating point.
        let five_percent = window / 20 + u64::from(!window.is_multiple_of(20));
        let request_headroom = window.saturating_sub(1).min(std::cmp::max(
            reserve_floor,
            std::cmp::max(model_output_budget, five_percent),
        ));

        let hard_limit = std::cmp::max(1, window - request_headroom);

        let keep_recent_tokens = std::cmp::max(
            COMPACTION_MIN_KEEP_RECENT_TOKENS,
            COMPACTION_MAX_KEEP_RECENT_TOKENS
                .min((hard_limit as f64 * COMPACTION_KEEP_RECENT_RATIO) as u64),
        )
        // A retained tail wider than half the safe budget leaves the summary no
        // room, so the min/max clamp above never wins on a small window.
        .min(std::cmp::max(1, hard_limit / 2));

        let trigger = std::cmp::max(
            1,
            (hard_limit as f64 * AUTO_COMPACTION_TRIGGER_RATIO) as u64,
        );
        let retained_user_message_budget = std::cmp::max(
            1,
            COMPACTION_RETAINED_USER_MESSAGE_MAX_TOKENS.min(hard_limit / 2),
        );

        Self {
            window,
            hard_limit,
            request_headroom,
            keep_recent_tokens,
            trigger,
            retained_user_message_budget,
            compaction_enabled: model.compaction_enabled,
        }
    }

    /// Classify a request of `tokens` estimated size.
    ///
    /// `decide` is where the user's compaction switch takes effect: with
    /// automatic compaction disabled, the trigger classifies as `Proceed` and no
    /// summary is requested. The hard boundary keeps classifying as `Overflow`
    /// regardless — a turned-off preference must not turn off the limit that
    /// keeps a request the provider would reject from being sent.
    pub fn decide(&self, tokens: u64) -> BudgetDecision {
        if tokens >= self.hard_limit {
            BudgetDecision::Overflow
        } else if self.compaction_enabled && tokens >= self.trigger {
            BudgetDecision::Compact
        } else {
            BudgetDecision::Proceed
        }
    }

    /// Share of the safe budget in use, for diagnostics. `1.0` means the next
    /// request would cross the hard boundary.
    pub fn usage_ratio(&self, tokens: u64) -> f64 {
        tokens as f64 / self.hard_limit.max(1) as f64
    }
}

/// Token estimate of the context, anchored on real provider usage when the last
/// assistant message reported one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UsageEstimate {
    pub tokens: u64,
    /// Tokens the provider actually billed for the anchored request.
    pub usage_tokens: u64,
    /// Estimated tokens of the messages after the anchor.
    pub trailing_tokens: u64,
    /// Index of the anchored message, when there was one.
    pub last_usage_index: Option<usize>,
}

/// Estimate one message. Text is charged at
/// [`ESTIMATED_TEXT_CHARS_PER_TOKEN`]; an image is charged as
/// [`IMAGE_EQUIVALENT_CHARS`] characters.
pub fn estimate_message_tokens(message: &Message) -> u64 {
    let mut chars = 0u64;
    for part in &message.parts {
        match part {
            crate::message::ContentPart::Text { text }
            | crate::message::ContentPart::Thinking { text } => {
                chars += text.chars().count() as u64;
            }
            crate::message::ContentPart::Image { .. } => {
                chars += IMAGE_EQUIVALENT_CHARS;
            }
            crate::message::ContentPart::ToolCall(call) => {
                chars += call.name.chars().count() as u64;
                chars += call
                    .raw_arguments
                    .as_deref()
                    .map(|raw| raw.chars().count() as u64)
                    .unwrap_or_else(|| call.arguments.to_string().chars().count() as u64);
            }
            crate::message::ContentPart::ToolResult(result) => {
                chars += result.name.chars().count() as u64;
                chars += result.content.chars().count() as u64;
            }
        }
    }
    // Per-message envelope (role, ids, separators) that the provider charges for
    // but no content part accounts for.
    const ENVELOPE_CHARS: u64 = 16;
    ((chars + ENVELOPE_CHARS) as f64 / ESTIMATED_TEXT_CHARS_PER_TOKEN).ceil() as u64
}

pub fn estimate_text_tokens(text: &str) -> u64 {
    (text.chars().count() as f64 / ESTIMATED_TEXT_CHARS_PER_TOKEN).ceil() as u64
}

/// Occupancy of the anchored request: the buckets the provider billed, falling
/// back to the total when no bucket is populated.
fn occupancy_tokens(usage: &crate::message::Usage) -> u64 {
    let buckets = usage.input_tokens
        + usage.output_tokens
        + usage.cache_read_tokens
        + usage.cache_write_tokens;
    if buckets > 0 {
        buckets
    } else {
        usage.total_tokens()
    }
}

/// Estimate the context the provider will carry.
///
/// A reported usage is an exact measurement of everything up to that assistant
/// message, so only the messages after it are estimated. Without an anchor every
/// message is estimated, which is the conservative reading.
pub fn estimate_context_tokens(messages: &[Message]) -> UsageEstimate {
    // A reported usage is the truth about how large the request was, but only when
    // it is a real measurement: an assistant message whose usage is all zeros came
    // from a provider (or a scripted stream) that reported nothing, and trusting it
    // makes the whole budget read as zero — which would disable both compaction and
    // the request-side aging that keeps a session inside its window.
    let anchor = messages.iter().enumerate().rev().find(|(_, message)| {
        message.role == Role::Assistant
            && message
                .usage
                .as_ref()
                .is_some_and(|usage| occupancy_tokens(usage) > 0)
    });

    match anchor {
        None => {
            let tokens: u64 = messages.iter().map(estimate_message_tokens).sum();
            UsageEstimate {
                tokens,
                usage_tokens: 0,
                trailing_tokens: tokens,
                last_usage_index: None,
            }
        }
        Some((index, message)) => {
            let usage_tokens = message
                .usage
                .map(|usage| occupancy_tokens(&usage))
                .unwrap_or(0);
            let trailing: u64 = messages[index + 1..]
                .iter()
                .map(estimate_message_tokens)
                .sum();
            UsageEstimate {
                tokens: usage_tokens + trailing,
                usage_tokens,
                trailing_tokens: trailing,
                last_usage_index: Some(index),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::message::{ContentPart, Message, StopReason, ToolCall, ToolResult, Usage};

    #[test]
    fn a_large_window_is_planned_against_the_ceiling() {
        let limits = ContextLimits::for_model(ModelLimits::new(1_000_000, 32_768));
        assert_eq!(limits.window, COMPACTION_CONTEXT_WINDOW_CEILING);
        // The model's own 32K output budget dominates the 16,384 floor and 5%.
        assert_eq!(limits.request_headroom, 32_768);
        assert_eq!(limits.hard_limit, 229_376);
        assert_eq!(limits.trigger, 114_688);
        // 20% of the safe budget, inside the 8k..64k clamp.
        assert_eq!(limits.keep_recent_tokens, 45_875);
        assert_eq!(limits.retained_user_message_budget, 20_000);
    }

    #[test]
    fn a_default_window_uses_the_output_budget_as_headroom() {
        let limits = ContextLimits::for_model(ModelLimits::default());
        assert_eq!(limits.window, 128_000);
        // max(16_384 floor, min(32_768 output, window/4 = 32_000), 6_400) = 32_000.
        assert_eq!(limits.request_headroom, 32_000);
        assert_eq!(limits.hard_limit, 96_000);
        assert_eq!(limits.trigger, 48_000);
        assert_eq!(limits.keep_recent_tokens, 19_200);
    }

    #[test]
    fn a_small_window_still_yields_positive_limits() {
        let limits = ContextLimits::for_model(ModelLimits::new(8_192, 8_192));
        assert_eq!(limits.window, 8_192);
        // floor = min(16_384, 4_096) = 4_096; output budget = min(8_192, 2_048).
        assert_eq!(limits.request_headroom, 4_096);
        assert_eq!(limits.hard_limit, 4_096);
        assert_eq!(limits.trigger, 2_048);
        // The tail never takes more than half the safe budget.
        assert_eq!(limits.keep_recent_tokens, 2_048);
        assert_eq!(limits.retained_user_message_budget, 2_048);
    }

    #[test]
    fn a_one_token_window_does_not_divide_by_zero() {
        let limits = ContextLimits::for_model(ModelLimits::new(1, 1));
        assert!(limits.hard_limit >= 1);
        assert!(limits.trigger >= 1);
        assert!(limits.keep_recent_tokens >= 1);
        assert!(limits.usage_ratio(0) >= 0.0);
    }

    #[test]
    fn decisions_split_at_half_and_at_the_hard_boundary() {
        let limits = ContextLimits::for_model(ModelLimits::default());
        assert_eq!(limits.decide(limits.trigger - 1), BudgetDecision::Proceed);
        assert_eq!(limits.decide(limits.trigger), BudgetDecision::Compact);
        assert_eq!(
            limits.decide(limits.hard_limit - 1),
            BudgetDecision::Compact
        );
        assert_eq!(limits.decide(limits.hard_limit), BudgetDecision::Overflow);
        assert_eq!(
            limits.decide(limits.hard_limit + 1_000),
            BudgetDecision::Overflow
        );
    }

    /// The user's `compactionSettings.enabled` is the one field of those settings
    /// the reference reads (`compactionEnabled`), and it has to be the one this
    /// budget reads too: `false` means the trigger never starts a compaction.
    #[test]
    fn a_disabled_compaction_switch_moves_the_trigger_without_moving_the_hard_limit() {
        let enabled = ContextLimits::for_model(ModelLimits::default());
        let disabled =
            ContextLimits::for_model(ModelLimits::default().with_compaction_enabled(false));

        assert_eq!(enabled.decide(enabled.trigger), BudgetDecision::Compact);
        assert_eq!(
            disabled.decide(disabled.trigger),
            BudgetDecision::Proceed,
            "a disabled session must not compact at the trigger"
        );
        assert_eq!(
            disabled.decide(disabled.trigger + 20_000),
            BudgetDecision::Proceed,
            "nor anywhere between the trigger and the hard boundary"
        );
        // The safety boundary is not a preference.
        assert_eq!(
            disabled.decide(disabled.hard_limit),
            BudgetDecision::Overflow
        );
        assert_eq!(
            disabled.trigger, enabled.trigger,
            "the trigger itself is unchanged"
        );
        assert_eq!(disabled.hard_limit, enabled.hard_limit);
    }

    #[test]
    fn text_is_estimated_at_the_pi_ratio() {
        // 35 chars / 3.5 = 10 tokens.
        assert_eq!(estimate_text_tokens(&"a".repeat(35)), 10);
        assert_eq!(estimate_text_tokens(""), 0);
        assert!(NON_ASCII_TEXT.chars().count() > 0 && estimate_text_tokens(NON_ASCII_TEXT) > 0);
    }

    const NON_ASCII_TEXT: &str = "中文文本按字符计，不按字节计";

    #[test]
    fn a_message_estimate_covers_every_content_kind() {
        let mut message = Message::new(Role::Assistant);
        message.parts.push(ContentPart::Text {
            text: "a".repeat(35),
        });
        let text_only = estimate_message_tokens(&message);
        assert!(text_only >= 10, "text plus envelope: {text_only}");

        message.parts.push(ContentPart::Image {
            mime_type: "image/png".into(),
            data: "AAAA".into(),
        });
        let with_image = estimate_message_tokens(&message);
        assert!(
            with_image
                >= text_only
                    + (IMAGE_EQUIVALENT_CHARS as f64 / ESTIMATED_TEXT_CHARS_PER_TOKEN) as u64,
            "an image must be charged: {with_image} vs {text_only}"
        );

        let mut tool = Message::new(Role::Assistant);
        tool.parts.push(ContentPart::ToolCall(ToolCall {
            id: "call_1".into(),
            name: "read_file".into(),
            arguments: serde_json::json!({"path": "a.txt"}),
            raw_arguments: None,
        }));
        assert!(estimate_message_tokens(&tool) > 0);

        let result = Message::tool_result(ToolResult {
            call_id: "call_1".into(),
            name: "read_file".into(),
            content: "b".repeat(350),
            is_error: false,
            truncated: false,
        });
        assert!(estimate_message_tokens(&result) >= 100);
    }

    #[test]
    fn without_an_anchor_every_message_is_estimated() {
        let messages = vec![
            Message::user_text("a".repeat(350)),
            Message::user_text("b".repeat(350)),
        ];
        let estimate = estimate_context_tokens(&messages);
        assert_eq!(estimate.last_usage_index, None);
        assert_eq!(estimate.usage_tokens, 0);
        assert_eq!(estimate.trailing_tokens, estimate.tokens);
        assert!(estimate.tokens >= 200, "got {}", estimate.tokens);
    }

    #[test]
    fn reported_usage_anchors_the_estimate_and_only_the_tail_is_estimated() {
        let mut assistant = Message::new(Role::Assistant);
        assistant.parts.push(ContentPart::Text {
            text: "answered".into(),
        });
        assistant.stop_reason = Some(StopReason::EndTurn);
        assistant.usage = Some(Usage {
            input_tokens: 10_000,
            output_tokens: 500,
            cache_read_tokens: 2_000,
            ..Usage::default()
        });
        let messages = vec![
            Message::user_text("a".repeat(3_500)),
            assistant,
            Message::user_text("b".repeat(350)),
        ];

        let estimate = estimate_context_tokens(&messages);
        assert_eq!(estimate.last_usage_index, Some(1));
        assert_eq!(estimate.usage_tokens, 12_500);
        assert!(estimate.trailing_tokens > 0 && estimate.trailing_tokens < 200);
        assert_eq!(estimate.tokens, 12_500 + estimate.trailing_tokens);
    }

    #[test]
    fn the_newest_assistant_usage_wins() {
        let mut first = Message::new(Role::Assistant);
        first.usage = Some(Usage {
            input_tokens: 1_000,
            output_tokens: 10,
            ..Usage::default()
        });
        let mut second = Message::new(Role::Assistant);
        second.usage = Some(Usage {
            input_tokens: 9_000,
            output_tokens: 20,
            ..Usage::default()
        });
        let estimate = estimate_context_tokens(&[first, Message::user_text("middle"), second]);
        assert_eq!(estimate.last_usage_index, Some(2));
        assert_eq!(estimate.usage_tokens, 9_020);
    }

    /// A provider that reports nothing must not make the budget read as zero.
    #[test]
    fn a_zero_usage_anchor_is_not_an_anchor() {
        let mut assistant = Message::new(Role::Assistant);
        assistant.push_text("done");
        // What a stream without usage events produces.
        assistant.usage = Some(crate::message::Usage::default());
        let messages = vec![
            Message::user_text("look at this"),
            Message::tool_result(crate::message::ToolResult {
                call_id: "c1".into(),
                name: "Bash".into(),
                content: "x".repeat(7_000),
                is_error: false,
                truncated: false,
            }),
            assistant,
        ];
        let estimate = estimate_context_tokens(&messages);
        assert!(
            estimate.tokens > 1_000,
            "an all-zero usage is missing data, not a free request: {}",
            estimate.tokens
        );
    }
}
