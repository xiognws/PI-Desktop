//! Provider retry policy: how long to wait before re-sending a failed request.
//!
//! Counterpart of `provider-retry.ts` + `packages/shared/src/provider-retry.ts`.
//! The kernel already classified failures (`AgentError::is_retryable`); this
//! module decides what happens next. Without it a transient gateway 502 or a
//! rate limit ends the user's turn, which is the most common way a real session
//! dies for a reason that had nothing to do with the work.
//!
//! Two budgets, not one. A rate limit and a transient fault are different
//! failures: the first is the provider telling us exactly how long to wait, the
//! second is a dropped socket or an upstream 502 that may need several attempts.
//! Sharing one counter would let a burst of 429s consume the budget that exists
//! for gateway faults.

use crate::error::{AgentError, ProviderErrorKind};

/// Retries after the first failure, for both budgets.
pub const PROVIDER_MAX_RETRIES: u32 = 10;

/// First wait after a rate limit, before jitter.
pub const RATE_LIMIT_INITIAL_DELAY_MS: u64 = 2_000;
/// A provider outage stays bounded even when it asks for an unusably long wait.
pub const RATE_LIMIT_MAX_DELAY_MS: u64 = 30_000;
/// Share of the delay added or removed at random, so a fleet of clients does not
/// retry in lockstep.
pub const RATE_LIMIT_JITTER_FACTOR: f64 = 0.25;

/// Non-rate-limit transient failures wait 1s, 2s, 4s, then 8s, and stay capped.
pub const TRANSIENT_INITIAL_DELAY_MS: u64 = 1_000;
pub const TRANSIENT_MAX_DELAY_MS: u64 = 8_000;

/// A body that ends without a terminator is not congestion, so it gets few
/// attempts and almost no wait: the request is re-sent immediately, and a provider
/// that truncates every long response fails fast instead of burning ten tries.
pub const TRUNCATED_MAX_RETRIES: u32 = 2;
pub const TRUNCATED_INITIAL_DELAY_MS: u64 = 500;
pub const TRUNCATED_MAX_DELAY_MS: u64 = 2_000;

/// Which budget a failure draws from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RetryBudget {
    /// The provider said "too many requests".
    RateLimit,
    /// A dropped socket, an upstream 502.
    Transient,
    /// The provider ended a response before sending a terminator.
    Truncated,
}

impl RetryBudget {
    pub fn max_retries(&self) -> u32 {
        match self {
            RetryBudget::Truncated => TRUNCATED_MAX_RETRIES,
            _ => PROVIDER_MAX_RETRIES,
        }
    }
}

/// Decide whether `error` may be retried, and from which budget.
///
/// `None` means the failure is terminal: quota, auth, a malformed request and a
/// cancellation are all things re-sending cannot fix.
pub fn budget_for(error: &AgentError) -> Option<RetryBudget> {
    // A body that stops before its terminator is the provider dropping half a
    // response. The step that failed executed no tool call, so re-sending the same
    // request repeats nothing — and without this arm the documented transient
    // policy never applied to the most common way a long turn dies.
    if matches!(error, AgentError::IncompleteStream) {
        return Some(RetryBudget::Truncated);
    }
    let AgentError::Provider { kind, status, .. } = error else {
        return None;
    };
    if status == &Some(429) {
        return Some(RetryBudget::RateLimit);
    }
    match kind {
        ProviderErrorKind::Retryable | ProviderErrorKind::Transport => Some(RetryBudget::Transient),
        _ => None,
    }
}

/// Wait before retry number `attempt` (1-based), honouring a server-stated delay.
///
/// `retry_after_ms` is what the response asked for, when it asked: it wins over
/// the exponential schedule unless it exceeds the budget cap, because a provider
/// that names a delay knows its own state better than a backoff curve does.
pub fn delay_ms(
    budget: RetryBudget,
    attempt: u32,
    retry_after_ms: Option<u64>,
    jitter: f64,
) -> u64 {
    let attempt = attempt.max(1);
    let (initial, cap) = match budget {
        RetryBudget::RateLimit => (RATE_LIMIT_INITIAL_DELAY_MS, RATE_LIMIT_MAX_DELAY_MS),
        RetryBudget::Transient => (TRANSIENT_INITIAL_DELAY_MS, TRANSIENT_MAX_DELAY_MS),
        RetryBudget::Truncated => (TRUNCATED_INITIAL_DELAY_MS, TRUNCATED_MAX_DELAY_MS),
    };
    if let Some(server) = retry_after_ms {
        return server.min(cap);
    }
    let base = initial
        .saturating_mul(1u64 << (attempt - 1).min(6))
        .min(cap);
    if budget == RetryBudget::RateLimit {
        // Jitter only the rate-limit curve: a transient retry is already short
        // enough that spreading it out buys nothing. The cap is applied *after*
        // the jitter, because a maximum that a random factor can exceed is not a
        // maximum.
        let factor = 1.0 + (jitter.clamp(-1.0, 1.0) * RATE_LIMIT_JITTER_FACTOR);
        let jittered = (base as f64) * factor;
        return (jittered.round().max(0.0) as u64).min(cap);
    }
    base
}

/// Parse the delay a provider response asked for.
///
/// Both numeric forms matter: `retry-after-ms` is the OpenRouter/Anthropic form
/// and `retry-after` is whole seconds. The HTTP-date form is deliberately not
/// parsed — it needs a clock, and every provider this app talks to sends one of
/// the numeric forms; a date is treated as "no stated delay".
pub fn parse_retry_after_ms(
    retry_after_ms: Option<&str>,
    retry_after: Option<&str>,
    cap_ms: u64,
) -> Option<u64> {
    if let Some(value) = retry_after_ms
        .map(str::trim)
        .filter(|text| !text.is_empty())
    {
        if let Ok(parsed) = value.parse::<f64>() {
            return Some(bound(parsed, cap_ms));
        }
    }
    let value = retry_after.map(str::trim).filter(|text| !text.is_empty())?;
    if let Ok(seconds) = value.parse::<f64>() {
        return Some(bound(seconds * 1_000.0, cap_ms));
    }
    None
}

fn bound(ms: f64, cap_ms: u64) -> u64 {
    if !ms.is_finite() || ms <= 0.0 {
        return 0;
    }
    (ms.round() as u64).min(cap_ms)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn provider(kind: ProviderErrorKind, status: Option<u16>) -> AgentError {
        AgentError::Provider {
            kind,
            message: "boom".into(),
            status,
            retry_after_ms: None,
        }
    }

    #[test]
    fn a_rate_limit_draws_the_rate_limit_budget() {
        assert_eq!(
            budget_for(&provider(ProviderErrorKind::Retryable, Some(429))),
            Some(RetryBudget::RateLimit)
        );
    }

    #[test]
    fn a_transport_fault_draws_the_transient_budget() {
        assert_eq!(
            budget_for(&provider(ProviderErrorKind::Transport, None)),
            Some(RetryBudget::Transient)
        );
        assert_eq!(
            budget_for(&provider(ProviderErrorKind::Retryable, Some(502))),
            Some(RetryBudget::Transient)
        );
    }

    #[test]
    fn a_truncated_stream_is_retried_from_its_own_small_budget() {
        let budget = budget_for(&AgentError::IncompleteStream).expect("a cut stream is worth another try");
        assert_eq!(budget, RetryBudget::Truncated);
        assert_eq!(
            budget.max_retries(),
            TRUNCATED_MAX_RETRIES,
            "a provider that cuts every response must fail fast"
        );
        assert!(
            TRUNCATED_MAX_RETRIES < PROVIDER_MAX_RETRIES,
            "truncation is not congestion"
        );
        // Retried immediately: waiting cannot make a provider finish a body.
        assert_eq!(delay_ms(budget, 1, None, 0.0), TRUNCATED_INITIAL_DELAY_MS);
        assert_eq!(delay_ms(budget, 9, None, 0.0), TRUNCATED_MAX_DELAY_MS);
    }

    #[test]
    fn auth_quota_and_malformed_requests_are_terminal() {
        assert_eq!(
            budget_for(&provider(ProviderErrorKind::Fatal, Some(401))),
            None
        );
        assert_eq!(
            budget_for(&provider(ProviderErrorKind::Fatal, Some(400))),
            None
        );
        assert_eq!(budget_for(&AgentError::Cancelled), None);
        assert_eq!(
            budget_for(&AgentError::Refused("nope".into())),
            None,
            "a refusal is the model's to fix, not a transport problem"
        );
    }

    #[test]
    fn a_transient_curve_is_one_two_four_then_capped() {
        let waits: Vec<u64> = (1..=5)
            .map(|attempt| delay_ms(RetryBudget::Transient, attempt, None, 0.0))
            .collect();
        assert_eq!(waits, vec![1_000, 2_000, 4_000, 8_000, 8_000]);
    }

    #[test]
    fn a_rate_limit_curve_starts_at_two_seconds_and_jitters() {
        assert_eq!(delay_ms(RetryBudget::RateLimit, 1, None, 0.0), 2_000);
        assert_eq!(delay_ms(RetryBudget::RateLimit, 2, None, 0.0), 4_000);
        // Full positive jitter adds a quarter; the cap still wins.
        assert_eq!(delay_ms(RetryBudget::RateLimit, 1, None, 1.0), 2_500);
        assert_eq!(delay_ms(RetryBudget::RateLimit, 6, None, 0.0), 30_000);
        assert_eq!(delay_ms(RetryBudget::RateLimit, 20, None, 1.0), 30_000);
    }

    #[test]
    fn a_server_stated_delay_wins_but_is_capped() {
        assert_eq!(delay_ms(RetryBudget::Transient, 1, Some(250), 0.0), 250);
        assert_eq!(
            delay_ms(RetryBudget::Transient, 1, Some(600_000), 0.0),
            TRANSIENT_MAX_DELAY_MS,
            "an unusable delay is bounded, not obeyed"
        );
        assert_eq!(
            delay_ms(RetryBudget::RateLimit, 3, Some(1_500), 0.0),
            1_500,
            "the server's answer beats the curve"
        );
    }

    #[test]
    fn retry_after_headers_are_parsed_in_both_forms() {
        assert_eq!(
            parse_retry_after_ms(Some("1500"), None, 30_000),
            Some(1_500)
        );
        assert_eq!(parse_retry_after_ms(None, Some("3"), 30_000), Some(3_000));
        assert_eq!(
            parse_retry_after_ms(None, Some("600"), 30_000),
            Some(30_000),
            "capped"
        );
        assert_eq!(parse_retry_after_ms(None, None, 30_000), None);
        assert_eq!(
            parse_retry_after_ms(Some("not a number"), Some("soon"), 30_000),
            None,
            "an HTTP date is not a number; the curve decides"
        );
    }

    #[test]
    fn a_negative_or_infinite_server_delay_collapses_to_zero() {
        assert_eq!(parse_retry_after_ms(Some("-5"), None, 30_000), Some(0));
        assert_eq!(
            parse_retry_after_ms(Some("inf"), None, 30_000),
            Some(0),
            "an unrepresentable delay must not become the cap"
        );
    }
}
