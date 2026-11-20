//! Attachments on a prompt become what the provider can actually send.
//!
//! Electron main forwards a path, not a payload: the renderer only records what the
//! user picked, and reading it is the kernel's job. An image the model can see is
//! inlined as base64; everything else stays a text reference, because a prompt that
//! silently loses an attachment is worse than one that names it.

use agent_core::message::ContentPart;
use agent_core::sidecar::attachment_parts;
use serde_json::json;

fn scratch_file(name: &str, bytes: &[u8]) -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!("agent-core-attachment-{name}"));
    std::fs::write(&path, bytes).expect("write the fixture");
    path
}

#[tokio::test]
async fn an_image_the_model_can_see_is_inlined_as_base64() {
    let path = scratch_file("inline.png", b"abc");
    let params = json!({
        "supportsVision": true,
        "attachments": [{
            "kind": "image",
            "name": "inline.png",
            "mimeType": "image/png",
            "path": path.to_string_lossy(),
        }]
    });
    let parts = attachment_parts(&params).await;
    assert_eq!(parts.len(), 1);
    match &parts[0] {
        ContentPart::Image { mime_type, data } => {
            assert_eq!(mime_type, "image/png");
            // "abc" is "YWJj" in base64 — the payload the wire will carry.
            assert_eq!(data, "YWJj");
        }
        other => panic!("expected an image part, got {other:?}"),
    }
    let _ = std::fs::remove_file(path);
}

#[tokio::test]
async fn a_model_without_vision_gets_the_image_named_instead() {
    let path = scratch_file("no-vision.png", b"abc");
    let params = json!({
        "attachments": [{
            "kind": "image",
            "name": "no-vision.png",
            "path": path.to_string_lossy(),
        }]
    });
    let parts = attachment_parts(&params).await;
    assert_eq!(parts.len(), 1);
    match &parts[0] {
        ContentPart::Text { text } => {
            // The reference keeps the path so a text-only model can still ask a tool
            // for the file rather than never learning it existed.
            assert!(text.contains("no-vision.png"));
            assert!(text.contains(&path.to_string_lossy().to_string()));
        }
        other => panic!("expected a text reference, got {other:?}"),
    }
    let _ = std::fs::remove_file(path);
}

#[tokio::test]
async fn a_missing_image_does_not_fail_the_turn() {
    let missing = std::env::temp_dir().join("agent-core-does-not-exist.png");
    let params = json!({
        "supportsVision": true,
        "attachments": [{
            "kind": "image",
            "name": "gone.png",
            "path": missing.to_string_lossy(),
        }]
    });
    let parts = attachment_parts(&params).await;
    assert_eq!(parts.len(), 1);
    assert!(matches!(&parts[0], ContentPart::Text { .. }));
}

#[tokio::test]
async fn the_mime_type_falls_back_to_the_extension() {
    let path = scratch_file("photo.jpg", b"abc");
    let params = json!({
        "supportsVision": true,
        "attachments": [{ "kind": "image", "name": "photo.jpg", "path": path.to_string_lossy() }]
    });
    let parts = attachment_parts(&params).await;
    match &parts[0] {
        ContentPart::Image { mime_type, .. } => assert_eq!(mime_type, "image/jpeg"),
        other => panic!("expected an image part, got {other:?}"),
    }
    let _ = std::fs::remove_file(path);
}

#[tokio::test]
async fn a_file_attachment_arrives_as_its_path() {
    let params = json!({
        "attachments": [{ "kind": "file", "name": "notes.md", "path": "docs/notes.md" }]
    });
    let parts = attachment_parts(&params).await;
    assert_eq!(parts.len(), 1);
    match &parts[0] {
        ContentPart::Text { text } => assert!(text.contains("docs/notes.md")),
        other => panic!("expected a text reference, got {other:?}"),
    }
}

#[tokio::test]
async fn a_referenced_conversation_arrives_as_its_excerpt() {
    let params = json!({
        "attachments": [{
            "kind": "session",
            "name": "earlier chat",
            "text": "user: hi\nassistant: hello",
        }]
    });
    let parts = attachment_parts(&params).await;
    match &parts[0] {
        ContentPart::Text { text } => {
            assert!(text.contains("earlier chat"));
            assert!(text.contains("assistant: hello"));
        }
        other => panic!("expected a text excerpt, got {other:?}"),
    }
}

#[tokio::test]
async fn a_prompt_without_attachments_adds_nothing() {
    assert!(attachment_parts(&json!({})).await.is_empty());
    assert!(attachment_parts(&json!({ "attachments": [] })).await.is_empty());
    // A malformed entry is skipped rather than failing the whole turn.
    assert!(attachment_parts(&json!({ "attachments": ["nonsense"] }))
        .await
        .is_empty());
}
