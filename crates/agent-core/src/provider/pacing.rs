//! Provider pacing: keep a gateway's quota from being discovered the hard way.
//!
//! A provider that reports a rate limit is telling the truth about its own capacity,
//! and the truthful response is to wait — not to re-send and collect another error.
//! This module holds that decision per provider+model, so the *next* request already
//! knows, instead of every step rediscovering the same wall.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// Wait imposed after a quota error that names no delay.
///
/// Ten requests per minute is six seconds each; the observed gateway enforces exactly
/// that, and a longer wait only slows a turn that is already legal.
pub const DEFAULT_QUOTA_WAIT: Duration = Duration::from_secs(6);

/// Ceiling on a single wait, so a provider that asks for an hour cannot park a turn.
pub const MAX_QUOTA_WAIT: Duration = Duration::from_secs(60);

fn slots() -> &'static Mutex<HashMap<String, Instant>> {
    static SLOTS: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
    SLOTS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// How long `key` has left before its next request is allowed.
pub fn wait_remaining(key: &str) -> Duration {
    let Ok(slots) = slots().lock() else {
        return Duration::ZERO;
    };
    match slots.get(key) {
        Some(until) => until.saturating_duration_since(Instant::now()),
        None => Duration::ZERO,
    }
}

/// Note that `key` is out of quota: its next request waits `delay`.
pub fn note_quota(key: &str, delay: Option<Duration>) {
    let delay = delay.unwrap_or(DEFAULT_QUOTA_WAIT).min(MAX_QUOTA_WAIT);
    if let Ok(mut slots) = slots().lock() {
        let until = Instant::now() + delay;
        // Never shorten a wait another step already asked for.
        let entry = slots.entry(key.to_string()).or_insert(until);
        if *entry < until {
            *entry = until;
        }
    }
}

/// Forget a key's wait (tests, or a provider that just answered promptly).
pub fn clear(key: &str) {
    if let Ok(mut slots) = slots().lock() {
        slots.remove(key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_quota_error_parks_the_next_request_for_that_key_only() {
        let key = "test-quota-1";
        clear(key);
        assert_eq!(wait_remaining(key), Duration::ZERO);
        note_quota(key, Some(Duration::from_millis(50)));
        assert!(wait_remaining(key) > Duration::ZERO);
        assert_eq!(
            wait_remaining("test-quota-other"),
            Duration::ZERO,
            "one endpoint's quota is not another endpoint's"
        );
        std::thread::sleep(Duration::from_millis(80));
        assert_eq!(wait_remaining(key), Duration::ZERO);
        clear(key);
    }

    #[test]
    fn a_stated_delay_wins_but_is_capped() {
        let key = "test-quota-2";
        clear(key);
        note_quota(key, Some(Duration::from_secs(3_600)));
        let remaining = wait_remaining(key);
        assert!(
            remaining <= MAX_QUOTA_WAIT,
            "an hour-long wait must not park the turn: {remaining:?}"
        );
        clear(key);
    }
}
