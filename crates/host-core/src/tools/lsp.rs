//! Read-only language intelligence for the agent (ADR 0401).
//!
//! This is not an editor: there is no completion, no formatting, no refactoring and
//! no workspace model the user can browse. What the agent needs from a language
//! server is narrower — "where is this defined", "who else calls this", "what does
//! the compiler already know is wrong here" — answered in one round trip.
//!
//! Stage 1 (this module) is the wire: framing and message shapes, tested without a
//! server. Process lifecycle, the initialize handshake and per-language server
//! discovery come next, and they are the parts that need the real binaries.

pub mod framing;
