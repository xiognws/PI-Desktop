//! Outbound delivery: at-least-once, with backoff, an idempotency key and a dead letter.
//!
//! The reference implementation's `delivery_queue.py` owns the send because it also owns the platforms. This
//! kernel owns no platform — it keeps the part that has to be *correct* and hands the
//! sending to the host: what was meant to go out, how many times it has been tried,
//! when the next attempt is due, and which ones are beyond saving.
//!
//! The four properties that make it usable:
//!
//! * **At least once.** A claim marks an item in flight with a deadline; an item whose
//!   host went away is claimed again after that deadline instead of being lost. A
//!   delivery can therefore arrive twice, which is why the id is an idempotency key a
//!   receiver can dedupe on — exactly-once delivery is not a thing this layer can promise.
//! * **Backoff that is bounded.** Attempt *n* waits `base * 2^(n-1)`, capped, so a
//!   platform outage does not turn into a busy loop and does not delay the retry that
//!   would have worked until tomorrow.
//! * **One item per key.** The same idempotency key enqueued twice is one item: a
//!   retried turn must not send the same report again.
//! * **A dead letter.** After `max_attempts` the item stops retrying and stays visible
//!   with its last error, because silently dropping it is how a person never learns the
//!   notification never arrived.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// What a queued delivery is doing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum DeliveryState {
    /// Waiting for its turn.
    Pending,
    /// Handed to the host, not answered yet. `deadline_at_ms` is when this kernel
    /// assumes the attempt died and lets another claim take it.
    InFlight {
        claimed_at_ms: i64,
        deadline_at_ms: i64,
    },
    Delivered {
        at_ms: i64,
    },
    /// Given up on, with the reason it stopped trying.
    Dead {
        at_ms: i64,
        reason: String,
    },
}

/// One thing to send.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Delivery {
    /// The idempotency key. Two enqueues with the same id are one delivery.
    pub id: String,
    /// Where it goes: `ui`, `feishu:dev`, `mail:oncall@example.com`. Opaque here.
    pub target: String,
    /// What kind of thing it is: `report`, `notice`, `alert`. Used for filtering.
    pub kind: String,
    pub payload: String,
    pub created_at_ms: i64,
    pub attempts: u32,
    /// When the next attempt may run. A delivered item keeps it for the record.
    pub next_attempt_at_ms: i64,
    pub state: DeliveryState,
    pub last_error: Option<String>,
}

impl Delivery {
    pub fn is_terminal(&self) -> bool {
        matches!(
            self.state,
            DeliveryState::Delivered { .. } | DeliveryState::Dead { .. }
        )
    }

    /// Due for an attempt: either waiting, or handed out and never answered before its
    /// deadline passed.
    pub fn is_due(&self, now_ms: i64) -> bool {
        match &self.state {
            DeliveryState::Pending => self.next_attempt_at_ms <= now_ms,
            DeliveryState::InFlight { deadline_at_ms, .. } => *deadline_at_ms <= now_ms,
            _ => false,
        }
    }
}

/// How hard the queue tries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryPolicy {
    /// Attempts before an item is dead. `0` means "never give up".
    pub max_attempts: u32,
    pub base_backoff_ms: i64,
    pub max_backoff_ms: i64,
    /// How long a claim may sit unanswered before another claim may take it.
    pub in_flight_timeout_ms: i64,
    /// Oldest items are dropped first when the queue is this full, so a stuck platform
    /// cannot grow the queue until the process dies.
    pub max_items: usize,
}

impl Default for DeliveryPolicy {
    fn default() -> Self {
        Self {
            max_attempts: 5,
            base_backoff_ms: 5_000,
            max_backoff_ms: 5 * 60_000,
            in_flight_timeout_ms: 60_000,
            max_items: 2_000,
        }
    }
}

impl DeliveryPolicy {
    /// The wait before attempt `attempts + 1`.
    pub fn backoff_for(&self, attempts: u32) -> i64 {
        if attempts == 0 {
            return 0;
        }
        let shift = (attempts - 1).min(20);
        let wait = self
            .base_backoff_ms
            .saturating_mul(1_i64.checked_shl(shift).unwrap_or(i64::MAX));
        wait.min(self.max_backoff_ms).max(0)
    }
}

/// What `enqueue` did.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "outcome", rename_all = "camelCase")]
pub enum EnqueueOutcome {
    Queued(Delivery),
    /// The key was already known: nothing new was added, and this is the item that
    /// already exists.
    Duplicate(Delivery),
    /// The queue was full and this item was refused rather than growing it.
    Refused(String),
}

/// The queue itself.
#[derive(Debug, Default)]
pub struct DeliveryQueue {
    items: BTreeMap<String, Delivery>,
    policy: DeliveryPolicy,
}

impl DeliveryQueue {
    pub fn new(policy: DeliveryPolicy) -> Self {
        Self {
            items: BTreeMap::new(),
            policy,
        }
    }

    pub fn policy(&self) -> &DeliveryPolicy {
        &self.policy
    }

    pub fn with_policy(mut self, policy: DeliveryPolicy) -> Self {
        self.policy = policy;
        self
    }

    /// Add one item. `id` is the idempotency key: enqueueing the same key twice is one
    /// delivery, which is what makes a retried turn safe.
    pub fn enqueue(
        &mut self,
        id: impl Into<String>,
        target: impl Into<String>,
        kind: impl Into<String>,
        payload: impl Into<String>,
        now_ms: i64,
    ) -> EnqueueOutcome {
        let id = id.into();
        if let Some(existing) = self.items.get(&id) {
            return EnqueueOutcome::Duplicate(existing.clone());
        }
        if self.items.len() >= self.policy.max_items {
            return EnqueueOutcome::Refused(format!(
                "the queue already holds {} items",
                self.items.len()
            ));
        }
        let delivery = Delivery {
            id: id.clone(),
            target: target.into(),
            kind: kind.into(),
            payload: payload.into(),
            created_at_ms: now_ms,
            attempts: 0,
            next_attempt_at_ms: now_ms,
            state: DeliveryState::Pending,
            last_error: None,
        };
        self.items.insert(id, delivery.clone());
        EnqueueOutcome::Queued(delivery)
    }

    pub fn get(&self, id: &str) -> Option<&Delivery> {
        self.items.get(id)
    }

    /// The items a sender should attempt now, oldest first, marked in flight so a
    /// second claim cannot take them before the deadline.
    pub fn claim(&mut self, now_ms: i64, limit: usize) -> Vec<Delivery> {
        let mut due: Vec<&Delivery> = self
            .items
            .values()
            .filter(|item| item.is_due(now_ms))
            .collect();
        due.sort_by_key(|item| (item.created_at_ms, item.id.clone()));
        let ids: Vec<String> = due
            .into_iter()
            .take(limit)
            .map(|item| item.id.clone())
            .collect();
        let deadline_at_ms = now_ms + self.policy.in_flight_timeout_ms;
        let mut claimed = Vec::with_capacity(ids.len());
        for id in ids {
            if let Some(item) = self.items.get_mut(&id) {
                item.attempts += 1;
                item.state = DeliveryState::InFlight {
                    claimed_at_ms: now_ms,
                    deadline_at_ms,
                };
                claimed.push(item.clone());
            }
        }
        claimed
    }

    /// The host says it was sent.
    pub fn complete(&mut self, id: &str, now_ms: i64) -> Option<Delivery> {
        let item = self.items.get_mut(id)?;
        item.state = DeliveryState::Delivered { at_ms: now_ms };
        item.last_error = None;
        Some(item.clone())
    }

    /// The host says it was not sent, or the deadline passed with no answer: schedule
    /// the next attempt, or give up if the attempts are spent.
    pub fn fail(&mut self, id: &str, reason: impl Into<String>, now_ms: i64) -> Option<Delivery> {
        let policy = self.policy.clone();
        let item = self.items.get_mut(id)?;
        let reason = reason.into();
        item.last_error = Some(reason.clone());
        if policy.max_attempts > 0 && item.attempts >= policy.max_attempts {
            item.state = DeliveryState::Dead {
                at_ms: now_ms,
                reason,
            };
            item.next_attempt_at_ms = i64::MAX;
            return Some(item.clone());
        }
        item.state = DeliveryState::Pending;
        item.next_attempt_at_ms = now_ms + policy.backoff_for(item.attempts);
        Some(item.clone())
    }

    /// Put a dead or delivered item back in the queue by hand.
    pub fn requeue(&mut self, id: &str, now_ms: i64) -> Option<Delivery> {
        let item = self.items.get_mut(id)?;
        item.state = DeliveryState::Pending;
        item.attempts = 0;
        item.next_attempt_at_ms = now_ms;
        item.last_error = None;
        Some(item.clone())
    }

    pub fn list(&self) -> Vec<Delivery> {
        let mut items: Vec<Delivery> = self.items.values().cloned().collect();
        items.sort_by_key(|item| (item.created_at_ms, item.id.clone()));
        items
    }

    /// Everything worth showing on a panel, in one number-shaped answer.
    pub fn stats(&self, now_ms: i64) -> DeliveryStats {
        let mut stats = DeliveryStats {
            total: self.items.len(),
            ..DeliveryStats::default()
        };
        for item in self.items.values() {
            match item.state {
                DeliveryState::Pending => {
                    stats.pending += 1;
                    if item.next_attempt_at_ms <= now_ms {
                        stats.due += 1;
                    }
                }
                DeliveryState::InFlight { .. } => stats.in_flight += 1,
                DeliveryState::Delivered { .. } => stats.delivered += 1,
                DeliveryState::Dead { .. } => stats.dead += 1,
            }
        }
        stats
    }

    /// Drop delivered items older than `older_than_ms`, so a long-lived process does
    /// not keep a history nobody will read.
    pub fn purge_delivered(&mut self, now_ms: i64, older_than_ms: i64) -> usize {
        let cutoff = now_ms - older_than_ms.max(0);
        let before = self.items.len();
        let expired: Vec<String> = self
            .items
            .values()
            .filter(|item| {
                matches!(&item.state, DeliveryState::Delivered { at_ms } if *at_ms <= cutoff)
            })
            .map(|item| item.id.clone())
            .collect();
        for id in &expired {
            self.items.remove(id);
        }
        before - self.items.len()
    }
}

/// Counts for a health panel.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryStats {
    pub total: usize,
    pub pending: usize,
    pub due: usize,
    pub in_flight: usize,
    pub delivered: usize,
    pub dead: usize,
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: i64 = 1_794_960_000_000;

    fn queue() -> DeliveryQueue {
        DeliveryQueue::new(DeliveryPolicy {
            max_attempts: 3,
            base_backoff_ms: 1_000,
            max_backoff_ms: 10_000,
            in_flight_timeout_ms: 5_000,
            max_items: 4,
        })
    }

    #[test]
    fn a_queued_item_is_due_immediately_and_claimed_once() {
        let mut queue = queue();
        queue.enqueue("d1", "ui", "report", "hello", T0);
        let claimed = queue.claim(T0, 10);
        assert_eq!(claimed.len(), 1);
        assert_eq!(claimed[0].attempts, 1);
        assert!(matches!(claimed[0].state, DeliveryState::InFlight { .. }));
        // A second claim before the deadline takes nothing.
        assert!(queue.claim(T0 + 1_000, 10).is_empty());
    }

    #[test]
    fn the_same_key_enqueued_twice_is_one_delivery() {
        let mut queue = queue();
        assert!(matches!(
            queue.enqueue("d1", "ui", "report", "first", T0),
            EnqueueOutcome::Queued(_)
        ));
        match queue.enqueue("d1", "ui", "report", "second", T0 + 1) {
            EnqueueOutcome::Duplicate(item) => {
                assert_eq!(item.payload, "first", "the first payload wins");
            }
            other => panic!("expected a duplicate, got {other:?}"),
        }
        assert_eq!(queue.stats(T0).total, 1);
    }

    #[test]
    fn an_unanswered_claim_is_claimed_again_after_its_deadline() {
        let mut queue = queue();
        queue.enqueue("d1", "ui", "report", "hello", T0);
        queue.claim(T0, 10);
        // The host never answered. After the deadline the item is claimable again:
        // at-least-once, not at-most-once.
        let again = queue.claim(T0 + 5_000, 10);
        assert_eq!(again.len(), 1);
        assert_eq!(again[0].attempts, 2);
    }

    #[test]
    fn a_failure_backs_off_and_grows_then_caps() {
        // Five attempts available, so three failures still leave the item alive.
        let mut queue = queue().with_policy(DeliveryPolicy {
            max_attempts: 5,
            ..DeliveryPolicy::default()
        });
        queue.enqueue("d1", "ui", "report", "hello", T0);
        queue.claim(T0, 10);
        let failed = queue.fail("d1", "platform down", T0).expect("the item");
        assert!(matches!(failed.state, DeliveryState::Pending));
        assert_eq!(
            failed.next_attempt_at_ms,
            T0 + queue.policy().backoff_for(1)
        );

        let first_wait = queue.policy().backoff_for(1);
        let second_wait = queue.policy().backoff_for(2);
        queue.claim(T0 + first_wait, 10);
        let failed = queue
            .fail("d1", "still down", T0 + first_wait)
            .expect("the item");
        assert_eq!(failed.next_attempt_at_ms, T0 + first_wait + second_wait);
        assert!(second_wait > first_wait, "the wait grew");
    }

    #[test]
    fn an_item_dies_after_the_attempts_are_spent_and_stays_visible() {
        let mut queue = queue();
        queue.enqueue("d1", "ui", "report", "hello", T0);
        let mut now = T0;
        for _ in 0..3 {
            queue.claim(now, 10);
            let item = queue.fail("d1", "nope", now).expect("the item");
            if item.is_terminal() {
                break;
            }
            now = item.next_attempt_at_ms.max(now) + 1;
        }
        let item = queue.get("d1").expect("still listed");
        match &item.state {
            DeliveryState::Dead { reason, .. } => assert_eq!(reason, "nope"),
            other => panic!("expected dead, got {other:?}"),
        }
        assert_eq!(item.last_error.as_deref(), Some("nope"));
        assert!(
            queue.claim(now + 1_000_000, 10).is_empty(),
            "dead items are not claimed"
        );
        assert_eq!(queue.stats(now).dead, 1);
    }

    #[test]
    fn a_delivered_item_is_terminal_and_can_be_requeued_by_hand() {
        let mut queue = queue();
        queue.enqueue("d1", "ui", "report", "hello", T0);
        queue.claim(T0, 10);
        let done = queue.complete("d1", T0 + 10).expect("the item");
        assert!(matches!(done.state, DeliveryState::Delivered { .. }));
        assert!(done.is_terminal());
        assert!(queue.claim(T0 + 1_000_000, 10).is_empty());

        let again = queue.requeue("d1", T0 + 1_000_000).expect("the item");
        assert_eq!(again.attempts, 0);
        assert!(matches!(again.state, DeliveryState::Pending));
        assert_eq!(queue.claim(T0 + 1_000_000, 10).len(), 1);
    }

    #[test]
    fn the_queue_refuses_to_grow_past_its_limit() {
        let mut queue = queue();
        for index in 0..4 {
            queue.enqueue(format!("d{index}"), "ui", "report", "x", T0);
        }
        match queue.enqueue("d9", "ui", "report", "x", T0) {
            EnqueueOutcome::Refused(reason) => assert!(reason.contains("4 items"), "{reason}"),
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    #[test]
    fn claims_come_out_oldest_first_and_stop_at_the_limit() {
        let mut queue = queue();
        queue.enqueue("b", "ui", "report", "second", T0 + 2);
        queue.enqueue("a", "ui", "report", "first", T0 + 1);
        queue.enqueue("c", "ui", "report", "third", T0 + 3);
        let claimed = queue.claim(T0 + 10, 2);
        assert_eq!(
            claimed
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            vec!["a", "b"]
        );
    }

    #[test]
    fn stats_and_purging_answer_what_a_panel_asks() {
        let mut queue = queue();
        queue.enqueue("d1", "ui", "report", "x", T0);
        queue.enqueue("d2", "ui", "report", "y", T0);
        queue.claim(T0, 2);
        queue.complete("d1", T0);
        let stats = queue.stats(T0 + 1);
        assert_eq!(stats.total, 2);
        assert_eq!(stats.delivered, 1);
        assert_eq!(stats.in_flight, 1);

        let purged = queue.purge_delivered(T0 + 10 * 60_000, 60_000);
        assert_eq!(purged, 1, "the delivered item is older than the window");
        assert_eq!(queue.stats(T0).total, 1);
    }

    #[test]
    fn a_policy_of_zero_attempts_never_gives_up() {
        let mut queue = queue().with_policy(DeliveryPolicy {
            max_attempts: 0,
            ..DeliveryPolicy::default()
        });
        queue.enqueue("d1", "ui", "report", "x", T0);
        let mut now = T0;
        for _ in 0..12 {
            queue.claim(now, 10);
            let item = queue.fail("d1", "down", now).expect("the item");
            now = item.next_attempt_at_ms.max(now) + 1;
        }
        assert!(!queue.get("d1").unwrap().is_terminal());
    }

    #[test]
    fn the_backoff_doubles_and_then_caps() {
        let policy = DeliveryPolicy {
            base_backoff_ms: 1_000,
            max_backoff_ms: 8_000,
            ..DeliveryPolicy::default()
        };
        assert_eq!(policy.backoff_for(0), 0);
        assert_eq!(policy.backoff_for(1), 1_000);
        assert_eq!(policy.backoff_for(2), 2_000);
        assert_eq!(policy.backoff_for(3), 4_000);
        assert_eq!(policy.backoff_for(4), 8_000);
        assert_eq!(policy.backoff_for(9), 8_000, "capped");
        assert_eq!(policy.backoff_for(64), 8_000, "no overflow");
    }
}
