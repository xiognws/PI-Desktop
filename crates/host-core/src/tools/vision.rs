//! `VisionAnalyze`: hand one image to a multimodal model and answer a question
//! about it.
//!
//! The kernel only declares tools; the host is what actually runs them, so this
//! module owns the outward call: read the bytes (or keep the URL), wrap them in
//! an OpenAI-compatible `chat/completions` body, and return the answer text.
//!
//! Two choices are deliberate:
//!
//! * A local image travels inline as a `data:` URI. The provider never gets a
//!   second fetch to make, no temp file survives the call, and a path that only
//!   exists on this machine still reaches the model.
//! * The size ceiling is a refusal, not a clamp. A truncated image would be
//!   answered about as if it were whole, and the model has no way to notice the
//!   difference — so an oversized file fails with its real byte count.

use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::Engine as _;
use serde_json::{json, Value};

use crate::tools::hashline::ToolError;

/// The name the kernel declares. `vision_analyze` is accepted too: it is the
/// upstream spelling, and a kernel that declares the snake_case name should not
/// have to wait for a host release.
pub const TOOL_NAME: &str = "VisionAnalyze";

/// Ceiling for one image, before base64 expansion. Above this the call is
/// refused with the number that was actually found.
pub const MAX_IMAGE_BYTES: usize = 8 * 1024 * 1024;

/// A vision answer is one short turn, but a slow multimodal model on a large
/// image is not instant; anything past this is a hung provider, not an answer.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

/// Asked for when the caller names an image without a question. Describing beats
/// answering "nothing" to nothing.
const DEFAULT_QUESTION: &str = "Describe this image and point out anything that matters.";

/// How much of an error body is worth showing. Enough to read the provider's own
/// complaint, little enough not to flood the transcript.
const MAX_ERROR_DETAIL: usize = 800;

/// The system message every vision request carries. See
/// [`build_request_body`] for why it is not optional.
const SYSTEM_PROMPT: &str = "You are looking at an image the user attached. Answer strictly about \
     what is visible in it; if something cannot be determined from the image, say so.";

/// What the caller asked for, already validated.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VisionRequest {
    pub image_url: String,
    pub question: String,
    /// Caller-selected model. `None` means "the provider's default".
    pub model: Option<String>,
}

fn require_str(args: &Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// Read the caller's intent. `image_url` is required; `question` falls back to a
/// description request rather than failing a call the model meant to make.
pub fn parse_request(args: &Value) -> Result<VisionRequest, ToolError> {
    let image_url = require_str(args, "image_url").ok_or_else(|| {
        ToolError::new(
            "INVALID_ARGUMENT",
            "`image_url` is required (an http(s) URL or a local image path)",
        )
    })?;
    let question = require_str(args, "question").unwrap_or_else(|| DEFAULT_QUESTION.to_string());
    let model = require_str(args, "model");
    Ok(VisionRequest {
        image_url,
        question,
        model,
    })
}

/// Does this tool name belong to the vision family?
pub fn recognizes(tool_name: &str) -> bool {
    tool_name == TOOL_NAME || tool_name == "vision_analyze"
}

/// Where the image bytes come from, after the argument has been validated.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ImageSource {
    /// Bytes read here and encoded inline.
    Local { mime: &'static str, data: String },
    /// Left to the provider to fetch.
    Remote(String),
}

impl ImageSource {
    /// The value that goes into `image_url.url`.
    pub fn to_url(&self) -> String {
        match self {
            ImageSource::Local { mime, data } => format!("data:{mime};base64,{data}"),
            ImageSource::Remote(url) => url.clone(),
        }
    }
}

/// Mime type by extension. Screenshots (the common case) are PNG; an unknown
/// extension is treated as PNG rather than guessed into something the provider
/// would reject outright.
pub fn mime_for_image_path(path: &str) -> &'static str {
    let lower = path.to_ascii_lowercase();
    // Strip a query string so `photo.jpg?x=1` still reads as JPEG.
    let lower = lower.split(['?', '#']).next().unwrap_or(lower.as_str());
    if lower.ends_with(".png") {
        "image/png"
    } else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        "image/jpeg"
    } else if lower.ends_with(".webp") {
        "image/webp"
    } else if lower.ends_with(".gif") {
        "image/gif"
    } else {
        "image/png"
    }
}

/// The ceiling, applied to one measured length. Kept separate from the read so
/// the refusal can be tested without producing an 8 MB file.
pub fn ensure_within_limit(bytes: usize, description: &str) -> Result<(), ToolError> {
    if bytes > MAX_IMAGE_BYTES {
        return Err(ToolError::new(
            "IMAGE_TOO_LARGE",
            format!(
                "{description} is {bytes} bytes, over the {MAX_IMAGE_BYTES} byte limit for one image"
            ),
        )
        .with_extra(json!({ "bytes": bytes, "limit": MAX_IMAGE_BYTES })));
    }
    Ok(())
}

/// Resolve and read the image argument.
///
/// An http(s) URL is passed through untouched — the provider fetches it, so the
/// host never needs egress for it. Anything else is a file path: absolute paths
/// are used as given (a screenshot the user attached lives outside the
/// workspace), relative paths resolve against the workspace root.
pub fn load_image(image_url: &str, workspace: Option<&Path>) -> Result<ImageSource, ToolError> {
    let trimmed = image_url.trim();
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        return Ok(ImageSource::Remote(trimmed.to_string()));
    }
    let local = trimmed.strip_prefix("file://").unwrap_or(trimmed);
    let path = Path::new(local);
    let candidate: PathBuf = if path.is_absolute() {
        path.to_path_buf()
    } else {
        let root = workspace.ok_or_else(|| {
            ToolError::new(
                "WORKSPACE_REQUIRED",
                "a relative image path needs an open workspace",
            )
        })?;
        root.join(path)
    };
    let description = candidate.display().to_string();
    // Measure before reading: an 80 MB screenshot should not be pulled into
    // memory just to be rejected.
    let size = std::fs::metadata(&candidate).map(|meta| meta.len()).map_err(|error| {
        ToolError::new(
            if error.kind() == std::io::ErrorKind::NotFound {
                "FILE_NOT_FOUND"
            } else {
                "TOOL_FAILED"
            },
            format!("{description} could not be read: {error}"),
        )
    })?;
    ensure_within_limit(size as usize, &description)?;
    let bytes = std::fs::read(&candidate).map_err(|error| {
        ToolError::new(
            "TOOL_FAILED",
            format!("{description} could not be read: {error}"),
        )
    })?;
    // The metadata size and the read size can disagree on a file that grew
    // between the two calls; the bytes that are actually sent are what count.
    ensure_within_limit(bytes.len(), &description)?;
    Ok(ImageSource::Local {
        mime: mime_for_image_path(&description),
        data: base64::engine::general_purpose::STANDARD.encode(&bytes),
    })
}

/// Build the `chat/completions` body for one question about one image.
///
/// The system message is **not** decoration. The local gateway classifies a
/// request as *image generation* when its only message carries an image part
/// (`hasImagePart && messages.len() <= 1` in `server.mjs`); it then answers
/// `{ data: [{ url }] }` with no `choices` at all, which reads downstream as a
/// stream that ended early. A real conversation always has a system message, so
/// sending one is what keeps the same model answering *about* the picture
/// instead of drawing a new one.
pub fn build_request_body(model: &str, question: &str, image: &ImageSource) -> Value {
    json!({
        "model": model,
        "stream": false,
        "messages": [
            { "role": "system", "content": SYSTEM_PROMPT },
            {
                "role": "user",
                "content": [
                    { "type": "text", "text": question },
                    { "type": "image_url", "image_url": { "url": image.to_url() } },
                ],
            },
        ],
    })
}

/// One provider, resolved far enough to make the call. The API key never leaves
/// this struct except as an `Authorization` header.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderCredentials {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
}

impl ProviderCredentials {
    /// `POST {base}/chat/completions`. A stored base URL may or may not already
    /// carry the path, so it is normalised rather than concatenated blindly.
    pub fn endpoint(&self) -> String {
        let base = self.base_url.trim().trim_end_matches('/');
        if base.ends_with("/chat/completions") {
            base.to_string()
        } else {
            format!("{base}/chat/completions")
        }
    }
}

/// Where a vision call gets its provider from. A trait so the body constructor
/// and the error paths can be exercised without a provider store or a network.
pub trait ProviderDirectory: Send + Sync {
    fn resolve(&self, model: Option<&str>) -> Result<ProviderCredentials, ToolError>;
}

/// The real directory: host-core's provider store.
pub struct StoredProviders;

impl ProviderDirectory for StoredProviders {
    fn resolve(&self, model: Option<&str>) -> Result<ProviderCredentials, ToolError> {
        resolve_from_store(model)
    }
}

/// The directory the dispatcher uses. Resolving opens the store per call on
/// purpose: a vision call is rare, and a cached connection would be a second,
/// silently stale owner of the same SQLite file.
pub fn host_providers() -> &'static dyn ProviderDirectory {
    &StoredProviders
}

fn not_configured(detail: &str) -> ToolError {
    // Never echo the credential itself — only whether one exists.
    ToolError::new("PROVIDER_NOT_CONFIGURED", detail.to_string())
}

fn resolve_from_store(model: Option<&str>) -> Result<ProviderCredentials, ToolError> {
    let data_dir = crate::pi_home::data_dir().ok_or_else(|| {
        not_configured("no provider is configured: this host has no data directory")
    })?;
    let db = crate::db::Database::open_in_dir(&data_dir)
        .map_err(|error| not_configured(&format!("the provider store could not be opened: {error}")))?;
    let secrets = crate::secrets::SecretStore::open(&data_dir)
        .map_err(|error| not_configured(&format!("the provider store could not be opened: {error}")))?;
    let providers = crate::providers::list_providers(&db, &secrets, false)
        .map_err(|error| not_configured(&format!("the provider list could not be read: {error}")))?;

    // Only a provider that could actually answer is a candidate: an OpenAI
    // compatible base URL and a stored credential.
    let usable: Vec<_> = providers
        .iter()
        .filter(|provider| {
            provider.has_secret
                && provider
                    .base_url
                    .as_deref()
                    .map(|url| !url.trim().is_empty())
                    .unwrap_or(false)
        })
        .collect();
    if usable.is_empty() {
        return Err(not_configured(
            "no enabled provider has both a base URL and a stored credential",
        ));
    }
    // An explicit model wins, but it has to come from a provider that lists it —
    // otherwise the name would be sent to a vendor that never published it.
    let chosen = model
        .and_then(|wanted| {
            usable
                .iter()
                .find(|provider| provider.models.iter().any(|binding| binding.id == wanted))
        })
        .copied()
        .unwrap_or(usable[0]);
    let model_id = model
        .map(str::to_string)
        .or_else(|| chosen.default_model_id.clone())
        .or_else(|| chosen.models.first().map(|binding| binding.id.clone()))
        .ok_or_else(|| not_configured("the chosen provider declares no model"))?;
    let api_key = crate::providers::get_secret_for_provider(&db, &secrets, &chosen.id)
        .map_err(|error| not_configured(&format!("the stored credential could not be read: {error}")))?
        .filter(|key| !key.trim().is_empty())
        .ok_or_else(|| not_configured("the chosen provider has no stored API key"))?;
    let base_url = chosen
        .base_url
        .clone()
        .ok_or_else(|| not_configured("the chosen provider has no base URL"))?;
    Ok(ProviderCredentials {
        base_url,
        api_key,
        model: model_id,
    })
}

fn truncate(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_string();
    }
    let head: String = text.chars().take(limit).collect();
    format!("{head}…")
}

/// Pull the answer out of a `chat/completions` response. `content` is a string on
/// OpenAI's own wire and an array of typed parts on some compatible gateways, so
/// both shapes are read. A body with no `choices` is not an empty answer — it is
/// a different response shape entirely, and the caller must be told that.
fn answer_text(body: &Value) -> Option<String> {
    let content = body.get("choices")?.get(0)?.get("message")?.get("content")?;
    let text = match content {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(""),
        _ => return None,
    };
    let text = text.trim().to_string();
    (!text.is_empty()).then_some(text)
}

/// Why a body without `choices` reached us, in the model's own language. Written
/// as a hint rather than a guess: the picture was never looked at, and the model
/// must not pretend otherwise.
const NO_CHOICES_HINT: &str =
    "the provider returned no choices for this image. A gateway that treats a single image \
     message as an image-generation request answers with `data[].url` instead — that is a \
     gateway heuristic, not an answer about the picture. Report the failure instead of \
     guessing what the image contains.";

/// Run one vision call.
pub async fn execute(
    args: &Value,
    workspace: Option<&Path>,
    directory: &dyn ProviderDirectory,
) -> Result<Value, ToolError> {
    let request = parse_request(args)?;
    let image = load_image(&request.image_url, workspace)?;
    // Resolve before any network work: an unconfigured provider should cost the
    // caller nothing but an error.
    let provider = directory.resolve(request.model.as_deref())?;
    let body = build_request_body(&provider.model, &request.question, &image);

    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|error| {
            ToolError::new(
                "TOOL_FAILED",
                format!("could not create an HTTP client: {error}"),
            )
        })?;
    // The feature list this crate enables for reqwest has no `json` helper, so the
    // body is serialised here and the content type set explicitly.
    let payload = serde_json::to_string(&body).map_err(|error| {
        ToolError::new(
            "TOOL_FAILED",
            format!("the request body could not be encoded: {error}"),
        )
    })?;
    let response = client
        .post(provider.endpoint())
        .header(
            reqwest::header::AUTHORIZATION,
            format!("Bearer {}", provider.api_key),
        )
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(payload)
        .send()
        .await
        .map_err(|error| {
            // reqwest's error carries the URL and the transport fault, never the
            // Authorization header.
            ToolError::new(
                "PROVIDER_UNREACHABLE",
                format!("the provider call failed: {error}"),
            )
        })?;

    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(ToolError::new(
            "PROVIDER_ERROR",
            format!("the provider answered {status}"),
        )
        .with_extra(json!({
            "status": status.as_u16(),
            "detail": truncate(&text, MAX_ERROR_DETAIL),
        })));
    }
    let parsed: Value = serde_json::from_str(&text).map_err(|_| {
        ToolError::new(
            "PROVIDER_ERROR",
            "the provider answered with something that is not JSON",
        )
        .with_extra(json!({ "detail": truncate(&text, MAX_ERROR_DETAIL) }))
    })?;
    let answer = match answer_text(&parsed) {
        Some(answer) => answer,
        None => {
            // A gateway error object is more specific than the shape hint, so it
            // is preferred when the provider bothered to send one.
            if let Some(message) = parsed
                .get("error")
                .and_then(|error| error.get("message"))
                .and_then(Value::as_str)
            {
                return Err(ToolError::new(
                    "PROVIDER_ERROR",
                    format!("the provider refused the image: {message}"),
                ));
            }
            return Err(
                ToolError::new("PROVIDER_ERROR", NO_CHOICES_HINT)
                    .with_extra(json!({ "detail": truncate(&text, MAX_ERROR_DETAIL) })),
            );
        }
    };
    Ok(json!({ "answer": answer, "model": provider.model }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn local_image() -> ImageSource {
        ImageSource::Local {
            mime: "image/png",
            data: base64::engine::general_purpose::STANDARD.encode(b"PNG"),
        }
    }

    /// The shape the gateway depends on: a system message first, then a user turn
    /// whose content is a multimodal array carrying the question and the image.
    #[test]
    fn the_body_carries_a_system_message_and_a_multimodal_user_turn() {
        let body = build_request_body("vision-model", "What colour is the door?", &local_image());
        let messages = body["messages"].as_array().expect("messages");
        assert_eq!(messages.len(), 2, "a system message plus one user turn");
        assert_eq!(messages[0]["role"], json!("system"));
        assert!(
            !messages[0]["content"]
                .as_str()
                .unwrap_or_default()
                .trim()
                .is_empty(),
            "the system message is what keeps the gateway from treating this as image generation"
        );

        assert_eq!(messages[1]["role"], json!("user"));
        let blocks = messages[1]["content"].as_array().expect("multimodal array");
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0]["type"], json!("text"));
        assert_eq!(blocks[0]["text"], json!("What colour is the door?"));
        assert_eq!(blocks[1]["type"], json!("image_url"));
        assert_eq!(body["model"], json!("vision-model"));
    }

    /// The image travels as a data URI built from the bytes that were read, so
    /// the provider fetches nothing and the mime matches the file.
    #[test]
    fn a_local_image_becomes_a_data_uri() {
        let body = build_request_body("m", "q", &local_image());
        let url = body["messages"][1]["content"][1]["image_url"]["url"]
            .as_str()
            .expect("image url");
        assert_eq!(url, "data:image/png;base64,UE5H");
    }

    /// An http(s) argument is passed through: the provider does the fetch.
    #[test]
    fn a_remote_image_keeps_its_url() {
        let image = ImageSource::Remote("https://example.test/a.png".into());
        let body = build_request_body("m", "q", &image);
        assert_eq!(
            body["messages"][1]["content"][1]["image_url"]["url"],
            json!("https://example.test/a.png")
        );
    }

    #[test]
    fn mime_types_come_from_the_extension() {
        assert_eq!(mime_for_image_path("shot.PNG"), "image/png");
        assert_eq!(mime_for_image_path("photo.jpg"), "image/jpeg");
        assert_eq!(mime_for_image_path("photo.jpeg"), "image/jpeg");
        assert_eq!(mime_for_image_path("anim.webp"), "image/webp");
        assert_eq!(mime_for_image_path("anim.gif"), "image/gif");
        // Unknown or absent extension: PNG, the common case for a screenshot.
        assert_eq!(mime_for_image_path("clip.bmp"), "image/png");
        assert_eq!(mime_for_image_path("no-extension"), "image/png");
        // A query string must not hide the real extension.
        assert_eq!(mime_for_image_path("photo.jpg?token=1"), "image/jpeg");
    }

    /// Over the ceiling is a refusal that names the real size — never a truncation
    /// the model would answer about as if it were the whole picture.
    #[test]
    fn an_oversized_image_is_refused_with_its_byte_count() {
        let error = ensure_within_limit(MAX_IMAGE_BYTES + 1, "big.png").expect_err("over the limit");
        assert_eq!(error.code, "IMAGE_TOO_LARGE");
        assert!(error.message.contains(&(MAX_IMAGE_BYTES + 1).to_string()));
        assert_eq!(error.extra["limit"], json!(MAX_IMAGE_BYTES));
        // The limit itself is allowed.
        ensure_within_limit(MAX_IMAGE_BYTES, "edge.png").expect("exactly at the limit");
    }

    /// The size check runs before the bytes are read, so a huge file fails fast.
    #[test]
    fn load_image_refuses_a_file_over_the_limit() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("huge.png");
        let file = std::fs::File::create(&path).expect("create");
        // Sparse: the length is what the check reads, not the disk usage.
        file.set_len((MAX_IMAGE_BYTES + 1) as u64).expect("set len");
        drop(file);
        let error = load_image(path.to_str().expect("utf-8 path"), None).expect_err("too large");
        assert_eq!(error.code, "IMAGE_TOO_LARGE");
    }

    #[test]
    fn a_relative_path_resolves_against_the_workspace() {
        let dir = tempfile::tempdir().expect("temp dir");
        std::fs::write(dir.path().join("shot.png"), b"PNG").expect("write");
        let image = load_image("shot.png", Some(dir.path())).expect("a local image");
        assert_eq!(
            image,
            ImageSource::Local {
                mime: "image/png",
                data: base64::engine::general_purpose::STANDARD.encode(b"PNG"),
            }
        );
    }

    #[test]
    fn a_missing_image_is_a_file_not_found() {
        let dir = tempfile::tempdir().expect("temp dir");
        let missing = dir.path().join("definitely-not-here.png");
        let error = load_image(missing.to_str().expect("utf-8 path"), None)
            .expect_err("missing file");
        assert_eq!(error.code, "FILE_NOT_FOUND");
        // A relative path with no workspace open is a different failure: there is
        // nothing to resolve it against, and saying so beats a wrong FILE_NOT_FOUND.
        let error = load_image("shot.png", None).expect_err("no workspace");
        assert_eq!(error.code, "WORKSPACE_REQUIRED");
    }

    #[test]
    fn image_url_is_required_and_the_question_has_a_default() {
        let error = parse_request(&json!({ "question": "what is this" })).expect_err("no image");
        assert_eq!(error.code, "INVALID_ARGUMENT");
        let request = parse_request(&json!({ "image_url": " a.png " })).expect("a request");
        assert_eq!(request.image_url, "a.png");
        assert_eq!(request.question, DEFAULT_QUESTION);
        assert!(request.model.is_none());
    }

    /// Endpoint normalisation: a stored base URL may or may not carry the path.
    #[test]
    fn the_endpoint_is_built_from_the_base_url_once() {
        let base = |url: &str| ProviderCredentials {
            base_url: url.into(),
            api_key: "k".into(),
            model: "m".into(),
        };
        assert_eq!(
            base("https://api.example.test/v1/").endpoint(),
            "https://api.example.test/v1/chat/completions"
        );
        assert_eq!(
            base("https://api.example.test/v1").endpoint(),
            "https://api.example.test/v1/chat/completions"
        );
        assert_eq!(
            base("https://api.example.test/v1/chat/completions").endpoint(),
            "https://api.example.test/v1/chat/completions"
        );
    }

    /// An unconfigured provider fails before anything is sent, so this test needs
    /// no network.
    #[test]
    fn an_unconfigured_provider_fails_before_the_call() {
        struct Missing;
        impl ProviderDirectory for Missing {
            fn resolve(&self, _model: Option<&str>) -> Result<ProviderCredentials, ToolError> {
                Err(not_configured("no enabled provider"))
            }
        }
        let dir = tempfile::tempdir().expect("temp dir");
        std::fs::write(dir.path().join("shot.png"), b"PNG").expect("write");
        let args = json!({ "image_url": "shot.png", "question": "what is this" });
        let error = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(execute(&args, Some(dir.path()), &Missing))
            .expect_err("no provider");
        assert_eq!(error.code, "PROVIDER_NOT_CONFIGURED");
    }

    /// A `data[].url` body is the image-generation shape, not an answer: it must
    /// be an error, and the message has to say so instead of returning a URL.
    #[test]
    fn an_image_generation_reply_is_reported_as_a_failure() {
        assert_eq!(answer_text(&json!({ "data": [{ "url": "https://x/y.png" }] })), None);
        assert_eq!(
            answer_text(&json!({ "choices": [{ "message": { "content": "a red door" } }] })),
            Some("a red door".to_string())
        );
        // Array-of-parts content, as some compatible gateways send it.
        assert_eq!(
            answer_text(&json!({ "choices": [{ "message": { "content": [
                { "type": "text", "text": "a " },
                { "type": "text", "text": "red door" }
            ] } }] })),
            Some("a red door".to_string())
        );
        assert_eq!(
            answer_text(&json!({ "choices": [{ "message": { "content": "   " } }] })),
            None
        );
    }

    #[test]
    fn requires_exactly_the_vision_tool_names() {
        assert!(recognizes("VisionAnalyze"));
        assert!(recognizes("vision_analyze"));
        assert!(!recognizes("Vision"));
        assert!(!recognizes("Read"));
    }
}
