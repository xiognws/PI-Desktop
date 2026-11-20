//! Where a user's mid-turn message lands.
//!
//! A steer is a message typed while the turn is working. It is not a Stop: the
//! turn keeps going, and the message becomes the next user row the model sees.
//! What a steer *does* change is what is worth waiting for — a five-minute build
//! that the user has just redirected should not be waited out, so a running tool is
//! told to stop (the same `tools.abort` the Stop button sends) and the turn
//! continues from the aborted result.
//!
//! This module owns only the trait two layers already needed to agree on: the turn
//! drains it between steps, and a running tool watches [`SteeringSource::pending`]
//! so it can notice a steer that arrives while it works.

use crate::message::Message;

pub trait SteeringSource: Send + Sync {
    /// Take everything queued for this turn.
    fn drain(&self) -> Vec<Message>;

    /// Is there something queued that has not been drained yet?
    ///
    /// A running tool asks this while it waits: a steer already waiting when the
    /// tool starts means the work is already out of date.
    fn pending(&self) -> bool;
}
