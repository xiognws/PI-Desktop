//! Read-only language intelligence for the agent (ADR 0401).
//!
//! This is not an editor: there is no completion, no formatting, no refactoring and
//! no workspace model the user can browse. What the agent needs from a language
//! server is narrower — "where is this defined", "who else calls this", "what does
//! the compiler already know is wrong here" — answered in one round trip.
//!
//! Stages follow ADR 0401 and each is useful on its own:
//!
//! 1. `framing` — the wire format, tested without a server (done).
//! 2. `session` — one server process per language, responses correlated by id,
//!    bounded timeouts, deterministic shutdown (done).
//! 3. the three tools that call it (next).
//!
//! Until stage 3 lands nothing outside this module's tests constructs a session, so
//! the module reads as dead code to the compiler. The allow below is deliberate and
//! local rather than a repo-wide relaxation: delete it when the tools arrive.
#![allow(dead_code)]

pub mod framing;
pub mod session;
