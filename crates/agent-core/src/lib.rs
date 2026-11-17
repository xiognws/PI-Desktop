//! Rust agent core for Pi-Workspace.
//!
//! This crate is the Rust home of the agent kernel that used to live in the
//! Node sidecar (`packages/agent-runtime`, backed by `@earendil-works/pi-*`).
//! It is a component-by-component migration of the Hermes kernel onto the
//! process model already frozen in `docs/spec/03-runtime/07-process-model.md`:
//!
//! ```text
//! Electron main  --NDJSON JSON-RPC/stdio-->  pi-desktop-agent-core
//!                                                   |
//!                                    host-core tool bridge (RPC back to main)
//! ```
//!
//! Layout by responsibility, mirroring the Hermes kernel:
//!
//! | Module | Hermes counterpart |
//! | --- | --- |
//! | [`message`] | `agent/agent_messages.py`, transcript rows |
//! | [`event`] | `agent/display.py` turn/stream events |
//! | [`provider`] | `agent/auxiliary_client.py`, `agent/transports/*`, `agent/*_adapter.py` |
//! | [`tool`] | `agent/tool_executor.py`, `tools/registry.py`, `tools/approval.py` |
//! | [`turn`] | `agent/conversation_loop.py`, `agent/turn_context.py` |
//! | [`session`] | `hermes_state_sessions.py`, `agent/turn_recovery.py` |
//!
//! Phase 1 (this module set) implements the loop, the provider streaming
//! contract, the tool registry and the transcript repair rules with no
//! network, RPC or database dependency, so the kernel is testable on its own.
//! Later phases add the sidecar RPC surface, the host-core tool bridge, the
//! provider transports, compaction, memory, skills, MCP, cron and delegation.

pub mod ask;
pub mod cancel;
pub mod compaction;
pub mod context;
pub mod delegate;
pub mod error;
pub mod event;
pub mod host_bridge;
pub mod mcp;
pub mod memory;
pub mod memory_context;
pub mod message;
pub mod prompt;
pub mod provider;
pub mod redaction;
pub mod retry;
pub mod rpc;
pub mod session;
pub mod sidecar;
pub mod skill_manage;
pub mod skill_overlap;
pub mod skills;
pub mod tool;
pub mod turn;

pub use ask::{AskBroker, AskRequest, AskTool, ASK_TOOL_NAME};
pub use cancel::CancelToken;
pub use error::{AgentError, ProviderErrorKind, Result};
pub use event::{
    AgentEvent, AgentEventEnvelope, CompactionFailure, CompactionFallback, CompactionReason,
    EventSink, RecordingSink,
};
pub use host_bridge::{HostBridge, HostError, HostTool};
pub use message::{ContentPart, Message, Role, StopReason, ToolCall, ToolResult, Usage};
pub use provider::{ChatRequest, Provider, ProviderStream, StreamEvent, ThinkingLevel};
pub use sidecar::{LineSink, Sidecar};
pub use skills::{SkillCatalog, SkillDef, SkillTool, SKILL_TOOL_NAME};
pub use tool::{
    AllowAll, DenyList, Permission, PermissionGate, Tool, ToolContext, ToolRegistry, ToolSpec,
};
pub use turn::{SteeringSource, TurnConfig, TurnEngine, TurnOutcome};

/// Crate version, surfaced by the sidecar handshake.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
