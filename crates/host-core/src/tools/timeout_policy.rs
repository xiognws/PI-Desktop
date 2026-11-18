//! One place for every tool-call budget.
//!
//! A budget used to be a constant invented at the call site, so the same class
//! of call could carry different bounds depending on which path reached it. This
//! module owns the table: each class names its floor, its default and its
//! ceiling once, and callers read the row instead of restating a number.
//!
//! Behaviour is deliberately unchanged: the Bash contract still rejects an
//! out-of-range request as an argument error (`validate_bash_timeout_ms`), and
//! the classes without a default keep returning `None` so a caller that never
//! set a deadline does not silently gain one.

/// Largest value any timeout field may carry: `u32::MAX - 1` milliseconds.
pub const MAX_TIMEOUT_MS: u64 = 2_147_483_647;
/// Shortest accepted Bash budget.
pub const MIN_BASH_TIMEOUT_MS: u64 = 1_000;
/// Longest accepted Bash budget (six hours).
pub const MAX_BASH_TIMEOUT_MS: u64 = 21_600_000;
/// Budget a Bash call runs on when the caller sends no `timeoutMs`.
pub const DEFAULT_BASH_TIMEOUT_MS: u64 = 60_000;

/// How long host-core waits for Electron main to answer an approved
/// desktop-dispatched tool. It must outlast every budget Electron enforces
/// inside it — the plugin tool budget (110s), and the widest MCP leg: a lazy
/// handshake (10s) plus the whole `tools/list` traversal (30s) plus the call
/// (100s) — so the innermost layer reports its own timeout instead of being cut
/// off here (`07-plugins/12-plugin-ipc-and-host-services.md`, ADR 0038).
/// Mirrored by `DESKTOP_TOOL_DISPATCH_TIMEOUT_MS` in
/// `packages/shared/src/rpc-timeouts.ts`, which sizes the transport deadline
/// around it. The admission queue wait happens before this budget starts, so
/// that transport deadline carries it instead of this constant.
pub const DESKTOP_TOOL_DISPATCH_TIMEOUT_MS: u64 = 150_000;

/// Fallback wait for a remote tool call whose transport carries no deadline of
/// its own. Two minutes covers a lazy handshake plus one `tools/list` traversal.
pub const REMOTE_TOOL_WAIT_FALLBACK_MS: u64 = 120_000;

/// Which kind of call a budget applies to. This is the table's row key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolTimeoutClass {
    BashForeground,
    BashBackground,
    Search,
    Read,
    Mcp,
    Plugin,
    Other,
}

/// One row of the table: the bounds a class accepts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TimeoutPolicy {
    /// Smallest budget the class accepts.
    pub min_ms: u64,
    /// Budget used when the caller sends none; `None` keeps the call unbudgeted.
    pub default_ms: Option<u64>,
    /// Largest budget the class accepts.
    pub max_ms: u64,
}

/// The table: one row per class, and no bounds defined anywhere else.
pub const fn policy(class: ToolTimeoutClass) -> TimeoutPolicy {
    match class {
        // The floor is part of the Bash argument contract (`validate_bash_timeout_ms`).
        ToolTimeoutClass::BashForeground | ToolTimeoutClass::BashBackground => TimeoutPolicy {
            min_ms: MIN_BASH_TIMEOUT_MS,
            default_ms: Some(DEFAULT_BASH_TIMEOUT_MS),
            max_ms: MAX_BASH_TIMEOUT_MS,
        },
        // File tools are bounded work: no default budget, the global ceiling.
        ToolTimeoutClass::Search | ToolTimeoutClass::Read => TimeoutPolicy {
            min_ms: 1,
            default_ms: None,
            max_ms: MAX_TIMEOUT_MS,
        },
        // Desktop dispatch: the default is the Electron-facing budget, the
        // ceiling is the global one so a caller that asked for less is honoured.
        ToolTimeoutClass::Mcp | ToolTimeoutClass::Plugin => TimeoutPolicy {
            min_ms: 1,
            default_ms: Some(DESKTOP_TOOL_DISPATCH_TIMEOUT_MS),
            max_ms: MAX_TIMEOUT_MS,
        },
        ToolTimeoutClass::Other => TimeoutPolicy {
            min_ms: 1,
            default_ms: None,
            max_ms: MAX_TIMEOUT_MS,
        },
    }
}

/// Maps a tool call onto its class. The only name table in the crate.
pub fn class_for_call(tool_name: &str, run_in_background: bool) -> ToolTimeoutClass {
    if tool_name == "Bash" {
        return if run_in_background {
            ToolTimeoutClass::BashBackground
        } else {
            ToolTimeoutClass::BashForeground
        };
    }
    if tool_name.starts_with("mcp_") {
        return ToolTimeoutClass::Mcp;
    }
    if tool_name.starts_with("plugin_") {
        return ToolTimeoutClass::Plugin;
    }
    match tool_name {
        "Glob" | "Grep" => ToolTimeoutClass::Search,
        "Read" => ToolTimeoutClass::Read,
        _ => ToolTimeoutClass::Other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bash_row_matches_the_argument_contract() {
        let row = policy(ToolTimeoutClass::BashForeground);
        assert_eq!(row.min_ms, MIN_BASH_TIMEOUT_MS);
        assert_eq!(row.default_ms, Some(DEFAULT_BASH_TIMEOUT_MS));
        assert_eq!(row.max_ms, MAX_BASH_TIMEOUT_MS);
    }

    #[test]
    fn desktop_classes_default_to_the_dispatch_budget() {
        for class in [ToolTimeoutClass::Mcp, ToolTimeoutClass::Plugin] {
            assert_eq!(
                policy(class).default_ms,
                Some(DESKTOP_TOOL_DISPATCH_TIMEOUT_MS)
            );
        }
    }

    #[test]
    fn classes_without_a_budget_stay_unbudgeted() {
        for class in [
            ToolTimeoutClass::Search,
            ToolTimeoutClass::Read,
            ToolTimeoutClass::Other,
        ] {
            assert_eq!(policy(class).default_ms, None);
        }
    }

    #[test]
    fn every_class_maps_to_a_row_whose_bounds_are_ordered() {
        for tool_name in [
            "Bash",
            "mcp_fetch",
            "plugin_run",
            "Glob",
            "Grep",
            "Read",
            "Write",
        ] {
            let class = class_for_call(tool_name, false);
            let row = policy(class);
            assert!(row.min_ms <= row.max_ms, "{tool_name} has inverted bounds");
        }
    }

    #[test]
    fn background_bash_is_its_own_row() {
        assert_eq!(
            class_for_call("Bash", true),
            ToolTimeoutClass::BashBackground
        );
        assert_eq!(
            class_for_call("Bash", false),
            ToolTimeoutClass::BashForeground
        );
    }

    #[test]
    fn every_row_is_ordered() {
        for class in [
            ToolTimeoutClass::BashForeground,
            ToolTimeoutClass::BashBackground,
            ToolTimeoutClass::Search,
            ToolTimeoutClass::Read,
            ToolTimeoutClass::Mcp,
            ToolTimeoutClass::Plugin,
            ToolTimeoutClass::Other,
        ] {
            let row = policy(class);
            assert!(row.min_ms <= row.max_ms, "{class:?} has inverted bounds");
        }
    }
}
