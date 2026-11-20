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
    /// `agent.stop`: end the turn at the next completed assistant boundary.
    ///
    /// It lives on the same token as `cancelled` because it travels the same
    /// path — one token per turn, addressed by session and turn, handed to the
    /// loop and to every tool — and because "was this turn asked to wrap up?"
    /// has to have one answer at every boundary. It is a separate bit because
    /// the effect is not the same: `cancel` cuts the running tool off, whereas
    /// this one lets it finish and stops the loop from asking for another step.
    stop_requested: AtomicBool,
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

    /// Ask the turn to end at its next completed assistant boundary.
    ///
    /// Deliberately not `cancel`: the tool the model already asked for runs to
    /// completion and its result reaches the transcript, and only then does the
    /// loop stop instead of issuing another provider request. Nothing waits on
    /// this bit, so it needs no notification — the loop reads it between steps.
    pub fn request_stop(&self) {
        self.inner.stop_requested.store(true, Ordering::SeqCst);
    }

    /// Whether [`request_stop`](Self::request_stop) has been called.
    ///
    /// A cancellation implies a stop, and a hard abort is never answered with a
    /// graceful exit: the loop checks `is_cancelled` first.
    pub fn stop_requested(&self) -> bool {
        self.inner.stop_requested.load(Ordering::SeqCst)
    }

    /// A token that is cancelled when either this token or itself is.
    ///
    /// A subagent gets one so `TaskStop` can end it alone, while the user's Stop
    /// still reaches it: the child watches the parent.
    pub fn child(&self) -> CancelToken {
        let child = CancelToken::new();
        if self.is_cancelled() {
            child.cancel();
            return child;
        }
        let parent = self.clone();
        let watched = child.clone();
        tokio::spawn(async move {
            tokio::select! {
                _ = parent.cancelled() => watched.cancel(),
                // The delegate settled on its own; stop watching.
                _ = watched.cancelled() => {}
            }
        });
        child
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

    #[tokio::test]
    async fn a_stop_request_is_not_a_cancellation() {
        let token = CancelToken::new();
        token.request_stop();
        assert!(token.stop_requested());
        // The tool that is running keeps its token: a graceful stop must not read
        // as "cut this off", or every tool that watches the token would abandon
        // the work the user asked to finish.
        assert!(!token.is_cancelled());
    }

    #[tokio::test]
    async fn a_cancelled_token_keeps_its_own_stop_answer() {
        let token = CancelToken::new();
        assert!(!token.stop_requested());
        token.cancel();
        assert!(token.is_cancelled());
        // Cancellation is not recorded as a stop request: the loop consults
        // `is_cancelled` first, and a failed turn must not be reported as one the
        // user asked to wrap up.
        assert!(!token.stop_requested());
    }
}
