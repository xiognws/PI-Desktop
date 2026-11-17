//! MCP tool selection: which MCP tools one prompt may use.
//!
//! Counterpart of `mcp-tool-selection.ts`. The servers themselves are not the
//! kernel's: host-core owns the records and Electron main owns the processes,
//! handshakes and `callTool`. What the kernel owns is the gate — a composer can
//! ask for specific MCP servers or specific tools, and the answer has to be the
//! exact set those names authorize.
//!
//! The rule that earns this module is the last one: **never authorize a tool by
//! a name-prefix match.** Tool names are `mcp_<serverId>_<tool>`, so a prefix
//! test would let one selected server light up every tool whose name happens to
//! start the same way — including a tool from a server the user did not select.

use serde_json::Value;

const MCP_TOOL_PREFIX: &str = "mcp_";

/// A declared tool, with the server it came from when it is an MCP tool.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpToolIdentity {
    pub name: String,
    pub mcp_server_id: Option<String>,
}

impl McpToolIdentity {
    pub fn new(name: impl Into<String>, mcp_server_id: Option<String>) -> Self {
        Self {
            name: name.into(),
            mcp_server_id,
        }
    }

    /// Read one tool declaration. The name is required; `mcpServerId` marks the
    /// declaration as coming from an MCP server.
    pub fn from_value(value: &Value) -> Option<Self> {
        let name = value
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())?;
        let server = value
            .get("mcpServerId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(str::to_string);
        Some(Self {
            name: name.to_string(),
            mcp_server_id: server,
        })
    }

    /// A tool name the model can only reach if its server was selected.
    pub fn is_mcp(&self) -> bool {
        self.mcp_server_id.is_some() || self.name.starts_with(MCP_TOOL_PREFIX)
    }
}

/// What the caller asked for, when the answer is "no".
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum McpSelectionError {
    /// The request itself was malformed (not an array of non-empty strings).
    InvalidArgument(&'static str),
    /// A selected server or a selected tool is not in this session's catalog.
    Unavailable(String),
    /// The tool exists but this mode may not use it.
    Denied(String),
}

impl McpSelectionError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidArgument(_) => "INVALID_ARGUMENT",
            Self::Unavailable(_) => "COMPOSER_MCP_UNAVAILABLE",
            Self::Denied(_) => "TOOL_DENIED",
        }
    }

    pub fn message(&self) -> String {
        match self {
            Self::InvalidArgument(message) => (*message).to_string(),
            Self::Unavailable(message) | Self::Denied(message) => message.clone(),
        }
    }
}

fn parse_names(
    value: Option<&Value>,
    label: &'static str,
) -> Result<Option<Vec<String>>, McpSelectionError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let Some(entries) = value.as_array() else {
        return Err(McpSelectionError::InvalidArgument(label));
    };
    let mut names: Vec<String> = Vec::new();
    for entry in entries {
        let Some(text) = entry
            .as_str()
            .map(str::trim)
            .filter(|text| !text.is_empty())
        else {
            return Err(McpSelectionError::InvalidArgument(label));
        };
        if !names.iter().any(|seen| seen == text) {
            names.push(text.to_string());
        }
    }
    Ok(Some(names))
}

/// Parse the composer's server selection. `None` means "not selected".
pub fn parse_mcp_server_ids(
    value: Option<&Value>,
) -> Result<Option<Vec<String>>, McpSelectionError> {
    parse_names(value, "Invalid MCP server selection")
}

/// Parse an explicit tool selection. Present but empty is invalid: an empty list
/// cannot mean "every tool of the selected servers" without becoming a way to
/// widen the selection by accident.
pub fn parse_mcp_tool_names(
    value: Option<&Value>,
) -> Result<Option<Vec<String>>, McpSelectionError> {
    let parsed = parse_names(value, "Invalid MCP tool selection")?;
    if let Some(names) = &parsed {
        if names.is_empty() {
            return Err(McpSelectionError::InvalidArgument(
                "Invalid MCP tool selection",
            ));
        }
    }
    Ok(parsed)
}

/// Resolve the exact tool names a selection authorizes.
///
/// `available` is the mode's own answer, so a tool that exists but the mode denies
/// is reported as denied rather than silently missing.
pub fn resolve_mcp_tool_selection(
    server_ids: Option<&Value>,
    tools: &[McpToolIdentity],
    available: &dyn Fn(&str) -> bool,
    tool_names: Option<&Value>,
) -> Result<Vec<String>, McpSelectionError> {
    let selected = parse_mcp_server_ids(server_ids)?.unwrap_or_default();
    let requested = parse_mcp_tool_names(tool_names)?;
    if let Some(requested) = &requested {
        // A requested tool has to belong to a *selected* server: otherwise the
        // selection is being widened by naming a tool from a server the user
        // never chose.
        for name in requested {
            let owned = tools.iter().any(|tool| {
                &tool.name == name
                    && tool
                        .mcp_server_id
                        .as_ref()
                        .is_some_and(|server| selected.iter().any(|id| id == server))
            });
            if !owned {
                return Err(McpSelectionError::Unavailable(format!(
                    "Selected MCP tool unavailable: {name}"
                )));
            }
        }
    }
    let mut resolved: Vec<String> = Vec::new();
    for id in &selected {
        let owned: Vec<&McpToolIdentity> = tools
            .iter()
            .filter(|tool| tool.mcp_server_id.as_ref() == Some(id))
            .filter(|tool| {
                requested
                    .as_ref()
                    .is_none_or(|names| names.contains(&tool.name))
            })
            .collect();
        if owned.is_empty() {
            return Err(McpSelectionError::Unavailable(format!(
                "Selected MCP server unavailable: {id}"
            )));
        }
        // An explicit tool list is the strict case: if any of the tools it names
        // is denied by the mode, the whole selection fails instead of silently
        // shrinking to the tools that were allowed.
        if requested.is_some() && owned.iter().any(|tool| !available(&tool.name)) {
            return Err(McpSelectionError::Denied(
                "Selected MCP tool is unavailable in this mode".to_string(),
            ));
        }
        let allowed: Vec<&&McpToolIdentity> =
            owned.iter().filter(|tool| available(&tool.name)).collect();
        if allowed.is_empty() {
            return Err(McpSelectionError::Denied(
                "Selected MCP tools are unavailable in this mode".to_string(),
            ));
        }
        for tool in allowed {
            if !resolved.iter().any(|seen| seen == &tool.name) {
                resolved.push(tool.name.clone());
            }
        }
    }
    Ok(resolved)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn catalog() -> Vec<McpToolIdentity> {
        vec![
            McpToolIdentity::new("mcp_files_read", Some("files".into())),
            McpToolIdentity::new("mcp_files_write", Some("files".into())),
            McpToolIdentity::new("mcp_git_status", Some("git".into())),
            // A plain host tool: not MCP, so a selection never touches it.
            McpToolIdentity::new("Read", None),
        ]
    }

    fn all_available(_name: &str) -> bool {
        true
    }

    #[test]
    fn a_server_selection_resolves_exactly_its_own_tools() {
        let names =
            resolve_mcp_tool_selection(Some(&json!(["files"])), &catalog(), &all_available, None)
                .expect("resolved");
        assert_eq!(names, vec!["mcp_files_read", "mcp_files_write"]);
    }

    #[test]
    fn a_tool_selection_narrows_within_the_selected_servers() {
        let names = resolve_mcp_tool_selection(
            Some(&json!(["files"])),
            &catalog(),
            &all_available,
            Some(&json!(["mcp_files_write"])),
        )
        .expect("resolved");
        assert_eq!(names, vec!["mcp_files_write"]);
    }

    #[test]
    fn a_tool_name_is_never_authorized_by_a_prefix_match() {
        // `mcp_files_read` is selected; `mcp_files_read_all` would pass a prefix
        // test against the same server id prefix and must not resolve.
        let catalog = vec![
            McpToolIdentity::new("mcp_files_read", Some("files".into())),
            McpToolIdentity::new("mcp_files_read_all", Some("files-sketchy".into())),
        ];
        let names =
            resolve_mcp_tool_selection(Some(&json!(["files"])), &catalog, &all_available, None)
                .expect("resolved");
        assert_eq!(
            names,
            vec!["mcp_files_read"],
            "only the selected server's own tool"
        );
    }

    #[test]
    fn a_tool_from_an_unselected_server_is_refused() {
        let error = resolve_mcp_tool_selection(
            Some(&json!(["files"])),
            &catalog(),
            &all_available,
            Some(&json!(["mcp_git_status"])),
        )
        .expect_err("refused");
        assert_eq!(error.code(), "COMPOSER_MCP_UNAVAILABLE");
        assert!(error.message().contains("mcp_git_status"));
    }

    #[test]
    fn an_unknown_server_is_refused_rather_than_silently_empty() {
        let error =
            resolve_mcp_tool_selection(Some(&json!(["nope"])), &catalog(), &all_available, None)
                .expect_err("refused");
        assert_eq!(error.code(), "COMPOSER_MCP_UNAVAILABLE");
        assert!(error.message().contains("nope"));
    }

    #[test]
    fn a_tool_the_mode_denies_is_reported_as_denied() {
        let only_reads = |name: &str| name != "mcp_files_write";
        let error = resolve_mcp_tool_selection(
            Some(&json!(["files"])),
            &catalog(),
            &only_reads,
            Some(&json!(["mcp_files_write"])),
        )
        .expect_err("refused");
        assert_eq!(error.code(), "TOOL_DENIED");

        // Without an explicit tool list the writable tool is simply left out.
        let names =
            resolve_mcp_tool_selection(Some(&json!(["files"])), &catalog(), &only_reads, None)
                .expect("resolved");
        assert_eq!(names, vec!["mcp_files_read"]);
    }

    #[test]
    fn no_selection_authorizes_nothing() {
        let names =
            resolve_mcp_tool_selection(None, &catalog(), &all_available, None).expect("resolved");
        assert!(names.is_empty(), "an absent selection is not 'everything'");
    }

    #[test]
    fn a_malformed_selection_is_invalid_argument() {
        assert_eq!(
            parse_mcp_server_ids(Some(&json!("files")))
                .unwrap_err()
                .code(),
            "INVALID_ARGUMENT"
        );
        assert_eq!(
            parse_mcp_server_ids(Some(&json!(["files", ""])))
                .unwrap_err()
                .code(),
            "INVALID_ARGUMENT"
        );
        assert_eq!(
            parse_mcp_tool_names(Some(&json!([]))).unwrap_err().code(),
            "INVALID_ARGUMENT",
            "an empty tool list cannot mean every tool"
        );
        assert!(parse_mcp_server_ids(None).expect("absent").is_none());
    }

    #[test]
    fn duplicate_ids_and_names_collapse() {
        let ids = parse_mcp_server_ids(Some(&json!(["files", "files"])))
            .expect("parsed")
            .expect("present");
        assert_eq!(ids, vec!["files"]);
        let names = parse_mcp_tool_names(Some(&json!(["a", "a"])))
            .expect("parsed")
            .expect("present");
        assert_eq!(names, vec!["a"]);
    }

    #[test]
    fn a_declaration_without_a_server_is_not_an_mcp_tool() {
        let tool = McpToolIdentity::from_value(&json!({"name": "Read"})).expect("a tool");
        assert!(!tool.is_mcp());
        let tool = McpToolIdentity::from_value(&json!({"name": "mcp_x_y"})).expect("a tool");
        assert!(tool.is_mcp(), "the name shape alone is enough");
        assert!(McpToolIdentity::from_value(&json!({})).is_none());
    }
}
