//! Attachments on a prompt become what the provider can actually send.
//!
//! Electron main resolves the picker and hands the sidecar either a base64 payload
//! with a mime type, a bounded excerpt of a referenced conversation, or a bare
//! reference. Only the first can become an image block; the others must still reach
//! the model as text, because a prompt that silently loses an attachment is worse
//! than one that names it.

use agent_core::message::ContentPart;
use agent_core::sidecar::attachment_parts;
use serde_json::json;

#[test]
fn an_image_payload_becomes_an_image_part() {
    let params = json!({
        "attachments": [{
            "kind": "image",
            "name": "screenshot.png",
            "mimeType": "image/png",
            "data": "iVBORw0KGgo=",
        }]
    });
    let parts = attachment_parts(&params);
    assert_eq!(parts.len(), 1);
    match &parts[0] {
        ContentPart::Image { mime_type, data } => {
            assert_eq!(mime_type, "image/png");
            assert_eq!(data, "iVBORw0KGgo=");
        }
        other => panic!("expected an image part, got {other:?}"),
    }
}

#[test]
fn an_image_without_a_payload_is_still_named() {
    let params = json!({
        "attachments": [{ "kind": "image", "name": "big.png" }]
    });
    let parts = attachment_parts(&params);
    assert_eq!(parts.len(), 1);
    match &parts[0] {
        ContentPart::Text { text } => assert!(text.contains("big.png")),
        other => panic!("expected a text reference, got {other:?}"),
    }
}

#[test]
fn a_referenced_conversation_arrives_as_its_excerpt() {
    let params = json!({
        "attachments": [{
            "kind": "session",
            "name": "earlier chat",
            "text": "user: hi\nassistant: hello",
        }]
    });
    let parts = attachment_parts(&params);
    assert_eq!(parts.len(), 1);
    match &parts[0] {
        ContentPart::Text { text } => {
            assert!(text.contains("earlier chat"));
            assert!(text.contains("assistant: hello"));
        }
        other => panic!("expected a text excerpt, got {other:?}"),
    }
}

#[test]
fn a_file_reference_arrives_as_its_path() {
    let params = json!({
        "attachments": [{ "kind": "file", "name": "notes.md", "ref": "docs/notes.md" }]
    });
    let parts = attachment_parts(&params);
    assert_eq!(parts.len(), 1);
    match &parts[0] {
        ContentPart::Text { text } => assert!(text.contains("docs/notes.md")),
        other => panic!("expected a text reference, got {other:?}"),
    }
}

#[test]
fn a_prompt_without_attachments_adds_nothing() {
    assert!(attachment_parts(&json!({})).is_empty());
    assert!(attachment_parts(&json!({ "attachments": [] })).is_empty());
    // A malformed entry is skipped rather than failing the whole turn.
    assert!(attachment_parts(&json!({ "attachments": ["nonsense"] })).is_empty());
}
