//! The prompt inputs the host resolves must reach the model.
//!
//! Electron main reads the workspace's `AGENTS.md` chain and the user's
//! `SYSTEM.md` / `APPEND_SYSTEM.md`, applies the byte caps, and hands the result to
//! the sidecar. The kernel used to ignore both fields, so a session answered with
//! the product prompt alone and never saw the project's rules. These cases pin the
//! two fields the kernel now reads, and the degradation when it cannot.

use agent_core::sidecar::host_prompt_inputs;
use serde_json::json;

#[test]
fn the_instruction_chain_and_custom_prompt_are_read() {
    let params = json!({
        "customSystemPrompt": { "append": "be terse", "replace": null },
        "projectInstructions": {
            "entries": [
                { "source": "AGENTS.md", "content": "use pnpm, not npm" },
                { "source": "crates/agent-core/AGENTS.md", "content": "tests are part of the change" }
            ]
        }
    });
    let (custom, project) = host_prompt_inputs(&params);
    let custom = custom.expect("the custom prompt is read");
    assert_eq!(custom.append.as_deref(), Some("be terse"));
    assert_eq!(custom.replace, None);

    let project = project.expect("the instruction chain is read");
    assert_eq!(project.entries.len(), 2);
    assert_eq!(project.entries[0].source, "AGENTS.md");
    assert!(project.entries[1]
        .content
        .contains("tests are part of the change"));
}

#[test]
fn a_payload_the_kernel_cannot_read_degrades_to_no_extra_rules() {
    // A malformed field must not fail the turn: the answer without extra rules beats
    // no answer at all.
    let params = json!({
        "customSystemPrompt": "not an object",
        "projectInstructions": { "entries": [{ "source": "AGENTS.md" }] }
    });
    let (custom, project) = host_prompt_inputs(&params);
    assert!(custom.is_none());
    assert!(project.is_none());
}

#[test]
fn a_prompt_without_either_field_reads_neither() {
    let (custom, project) = host_prompt_inputs(&json!({ "content": "hi" }));
    assert!(custom.is_none());
    assert!(project.is_none());
}

#[test]
fn an_empty_instruction_chain_is_still_a_chain() {
    // The host sending `{entries: []}` means "this workspace has no instructions",
    // which is different from the field being absent; both compose to the same
    // prompt, but the parser must not turn the first into an unreadable payload.
    let params = json!({ "projectInstructions": { "entries": [] } });
    let (_, project) = host_prompt_inputs(&params);
    assert_eq!(project.expect("parsed").entries.len(), 0);
}
