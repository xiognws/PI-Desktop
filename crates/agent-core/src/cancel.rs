//! Cancellation. One token per turn, cloned into every awaited operation, so
//! a renderer `agent.abort` reaches the provider stream, the tool call and any
//! future subagent run without passing a handle through each of them.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::Notify;

#[derive(Debug, Clone, Default)]
pub struct CancelToken {
    inner: Arc<Inner>,
}

#[derive(Debug, Default)]
struct Inner {
    cancelled: AtomicBool,
    notify: Notify,
}

impl CancelToken {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        if !self.inner.cancelled.swap(true, Ordering::SeqCst) {
            // Registered waiters wake once; later waiters observe the flag.
            self.inner.notify.notify_waiters();
        }
    }

    pub fn is_cancelled(&self) -> bool {
        self.inner.cancelled.load(Ordering::SeqCst)
    }

    /// Resolve when the token is cancelled. Safe to call in a `select!`: a
    /// token cancelled before the call resolves immediately.
    pub async fn cancelled(&self) {
        if self.is_cancelled() {
            return;
        }
        loop {
            let waiter = self.inner.notify.notified();
            tokio::pin!(waiter);
            waiter.as_mut().await;
            if self.is_cancelled() {
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cancel_wakes_waiters_and_stays_idempotent() {
        let token = CancelToken::new();
        let waiter = token.clone();
        let handle = tokio::spawn(async move {
            waiter.cancelled().await;
            true
        });
        token.cancel();
        token.cancel();
        assert!(handle.await.unwrap());
        assert!(token.is_cancelled());
    }

    #[tokio::test]
    async fn already_cancelled_token_resolves_immediately() {
        let token = CancelToken::new();
        token.cancel();
        tokio::time::timeout(std::time::Duration::from_millis(10), token.cancelled())
            .await
            .expect("already-cancelled token must not block");
    }

    #[tokio::test]
    async fn child_tokens_are_independent() {
        let parent = CancelToken::new();
        let other = CancelToken::new();
        parent.cancel();
        assert!(!other.is_cancelled());
    }
}
