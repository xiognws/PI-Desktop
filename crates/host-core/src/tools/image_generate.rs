//! `GenerateImages`: draw one or more images from a prompt and put them in the
//! workspace.
//!
//! Three choices are deliberate:
//!
//! * **The image endpoint, not chat.** `POST {base}/images/generations` is what
//!   an image model publishes. A chat endpoint only reinterprets a one-image
//!   message as generation by gateway heuristic — the same heuristic that makes
//!   `VisionAnalyze` answer with `data[].url` instead of prose.
//!
//! * **Download immediately, hand back local paths.** The URLs an image provider
//!   returns are short-lived signed links (hours, not days). Returning one to the
//!   model would produce a link that is dead by the time the user clicks it, so
//!   the bytes are fetched inside the call and the workspace path is the result.
//!
//! * **A refusal, not a truncation, past the size ceiling.** Twenty megabytes is
//!   far past any generated image; a larger body is a wrong URL or an error page,
//!   and writing half of it would hand the model a file that looks usable.
//!
//! Temporary downloads live under `<data_dir>/tmp` (`crate::runtime_tmp`), never
//! the platform temp directory (AGENTS.md §8): a workspace may be on another
//! volume, and the move into `generated/` is the only step that crosses over.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use crate::tools::hashline::ToolError;
use crate::tools::provider_store::{host_providers, ProviderCredentials};

/// The name the kernel declares. `image_generate` is accepted too: it is the
/// upstream spelling, and a kernel that declares the snake_case name should not
/// have to wait for a host release.
pub const TOOL_NAME: &str = "GenerateImages";

/// What the host asks for when the caller names no model. The gateway this
/// product talks to serves exactly this one through `/images/generations`.
pub const DEFAULT_IMAGE_MODEL: &str = "hunyuan-image-alpha";

/// How many images one call may ask for. Four is the most any provider in the
/// catalog returns per request; past that the extra cost buys nothing.
pub const MAX_IMAGES: u64 = 4;

/// Ceiling for one downloaded image. A 1024-pixel PNG measures about 1.2 MB.
pub const MAX_DOWNLOAD_BYTES: usize = 20 * 1024 * 1024;

/// Drawing is slower than answering: a provider queues the job before it renders.
/// Anything past this is a hung provider, not a slow picture.
const GENERATE_TIMEOUT: Duration = Duration::from_secs(240);

/// A signed URL serves bytes from a CDN, so waiting on it is a transfer, not a
/// render. Two minutes covers twenty megabytes on a slow link.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(120);

/// How much of an error body is worth showing: enough to read the provider's own
/// complaint, little enough not to flood the transcript.
const MAX_ERROR_DETAIL: usize = 600;

/// Longest prompt-derived part of a file name. Long enough to tell two pictures
/// apart in a directory listing, short enough to stay far from path limits.
const MAX_SLUG_CHARS: usize = 40;

/// Where generated images land, relative to the workspace root.
const GENERATED_DIR: &str = "generated";

/// Distinguishes two calls that start in the same millisecond, so a batch never
/// overwrites the previous one's files.
static SAVE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// The boxed future a backend returns. A trait object cannot carry `async fn`, and
/// the tool is `dyn ImageBackend` so a test can substitute the network.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// What the caller asked for, already validated and bounded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GenerationRequest {
    pub prompt: String,
    /// Never `None`: the call always names a model, because an image endpoint
    /// without one is a provider-specific default nothing here can predict.
    pub model: String,
    pub count: u64,
}

/// One accepted generation request, as the provider answered it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GenerationOutcome {
    pub body: Value,
    /// The model the provider was actually asked for, echoed into the result so a
    /// caller can tell two configurations apart.
    pub model: String,
}

/// The bytes of one image, with the content type the provider declared.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FetchedImage {
    pub content_type: Option<String>,
    pub bytes: Vec<u8>,
}

/// The network half of the tool.
///
/// A trait for the same reason [`ProviderDirectory`] is one: the naming, the size
/// ceiling, the temp-file hygiene and the result shape are the parts that need
/// testing, and none of them should need a provider account to exercise.
pub trait ImageBackend: Send + Sync {
    fn generate<'a>(
        &'a self,
        request: &'a GenerationRequest,
    ) -> BoxFuture<'a, Result<GenerationOutcome, ToolError>>;
    fn download<'a>(&'a self, url: &'a str) -> BoxFuture<'a, Result<FetchedImage, ToolError>>;
}

/// The backend the dispatcher uses: the configured provider over HTTP.
pub fn host_backend() -> &'static dyn ImageBackend {
    &HostBackend
}

/// Does this tool name belong to the image-generation family?
pub fn recognizes(tool_name: &str) -> bool {
    tool_name == TOOL_NAME || tool_name == "image_generate"
}

fn require_str(args: &Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// `n`, from a number or a numeric string. `0` reads as "unspecified" rather than
/// "no images": a caller that meant zero would be asking for a call that cannot
/// succeed.
pub fn clamp_count(requested: Option<u64>) -> u64 {
    match requested {
        None | Some(0) => 1,
        Some(count) => count.clamp(1, MAX_IMAGES),
    }
}

fn requested_count(args: &Value) -> Option<u64> {
    let value = args.get("n")?;
    value
        .as_u64()
        .or_else(|| {
            value
                .as_f64()
                .filter(|count| *count >= 0.0)
                .map(|count| count as u64)
        })
        .or_else(|| value.as_str().and_then(|text| text.trim().parse().ok()))
}

/// Read the caller's intent. `prompt` is required; the model and the count have
/// defaults, so a caller who says what to draw gets a picture.
pub fn parse_request(args: &Value) -> Result<GenerationRequest, ToolError> {
    let prompt = require_str(args, "prompt").ok_or_else(|| {
        ToolError::new(
            "INVALID_ARGUMENT",
            "`prompt` is required (what the picture should show)",
        )
    })?;
    let model = require_str(args, "model").unwrap_or_else(|| DEFAULT_IMAGE_MODEL.to_string());
    Ok(GenerationRequest {
        prompt,
        model,
        count: clamp_count(requested_count(args)),
    })
}

/// The `images/generations` body. Serialised by the caller rather than through
/// reqwest's `json` helper, which this crate's feature set does not enable.
pub fn build_request_body(request: &GenerationRequest) -> Value {
    json!({
        "model": request.model,
        "prompt": request.prompt,
        "n": request.count,
    })
}

fn truncate(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_string();
    }
    let head: String = text.chars().take(limit).collect();
    format!("{head}…")
}

fn provider_error(message: impl Into<String>, body: &Value) -> ToolError {
    ToolError::new("PROVIDER_ERROR", message.into()).with_extra(json!({
        "detail": truncate(&body.to_string(), MAX_ERROR_DETAIL),
    }))
}

/// Pull every `data[].url` out of the response, in the provider's order.
///
/// Three shapes are refused rather than returned empty, because an empty list
/// would read downstream as "the provider drew nothing" when the real problem is
/// that this is not a generation response at all: no `data`, `data` that is not
/// an array, and an array whose rows carry no usable `url`.
pub fn image_urls(body: &Value) -> Result<Vec<String>, ToolError> {
    let rows = body
        .get("data")
        .ok_or_else(|| provider_error("the provider response carried no `data`", body))?;
    let rows = rows
        .as_array()
        .ok_or_else(|| provider_error("`data` in the provider response is not an array", body))?;
    if rows.is_empty() {
        return Err(provider_error(
            "the provider answered with an empty `data` array",
            body,
        ));
    }
    let urls: Vec<String> = rows
        .iter()
        .filter_map(|row| row.get("url").and_then(Value::as_str))
        .map(str::trim)
        .filter(|url| !url.is_empty())
        .map(str::to_string)
        .collect();
    if urls.is_empty() {
        return Err(ToolError::new(
            "PROVIDER_ERROR",
            format!(
                "none of the {} image(s) in the response carries a `url`",
                rows.len()
            ),
        )
        .with_extra(json!({ "images": rows.len() })));
    }
    Ok(urls)
}

/// A file-name-safe, lower-case fragment of the prompt.
///
/// The prompt is model-written text: it may hold a slash, a colon, a Chinese
/// character, a space or a `..`, and any of those in a path is either a separator
/// or a Windows-invalid character. Everything outside `[a-z0-9]` collapses into a
/// single `-`, and the tail is cut at [`MAX_SLUG_CHARS`].
pub fn prompt_slug(prompt: &str) -> String {
    let mut slug = String::new();
    let mut separator_pending = false;
    for character in prompt.chars() {
        if character.is_ascii_alphanumeric() {
            if separator_pending && !slug.is_empty() {
                slug.push('-');
            }
            separator_pending = false;
            slug.push(character.to_ascii_lowercase());
            if slug.chars().count() >= MAX_SLUG_CHARS {
                break;
            }
        } else {
            separator_pending = true;
        }
    }
    while slug.ends_with('-') {
        slug.pop();
    }
    if slug.is_empty() {
        "image".to_string()
    } else {
        slug
    }
}

fn extension_from_mime(raw: &str) -> Option<&'static str> {
    // `image/png; charset=binary` is a legal header; only the type matters.
    let mime = raw
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    match mime.as_str() {
        "image/png" => Some("png"),
        "image/jpeg" | "image/jpg" => Some("jpg"),
        "image/webp" => Some("webp"),
        "image/gif" => Some("gif"),
        "image/avif" => Some("avif"),
        _ => None,
    }
}

fn extension_from_url(url: &str) -> Option<&'static str> {
    // A signed URL carries its signature in the query string, so only the path
    // before `?` can name a format.
    let path = url
        .split(['?', '#'])
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    for (suffix, extension) in [
        ("png", "png"),
        ("jpg", "jpg"),
        ("jpeg", "jpg"),
        ("webp", "webp"),
        ("gif", "gif"),
        ("avif", "avif"),
    ] {
        if path.ends_with(&format!(".{suffix}")) {
            return Some(extension);
        }
    }
    None
}

/// The extension for one downloaded image: the declared content type first, then
/// the URL's own suffix. A provider that declares nothing and serves from an
/// opaque CDN path still gets a usable name — PNG, the common case.
pub fn extension_for(content_type: Option<&str>, url: &str) -> &'static str {
    content_type
        .and_then(extension_from_mime)
        .or_else(|| extension_from_url(url))
        .unwrap_or("png")
}

/// `generated/` under the workspace root: the caller's own files, next to the
/// project they belong to, not hidden inside the data directory.
pub fn generated_dir(workspace: &Path) -> PathBuf {
    workspace.join(GENERATED_DIR)
}

/// `{slug}-{stamp}-{sequence}-{index}.{ext}`.
///
/// The stamp and the process-wide sequence keep two calls apart; the index keeps
/// the images of one batch apart. The slug is only there for the human reading
/// the directory afterwards.
pub fn file_name(
    slug: &str,
    stamp_ms: u128,
    sequence: u64,
    index: usize,
    extension: &str,
) -> String {
    format!("{slug}-{stamp_ms}-{sequence}-{index}.{extension}")
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or(0)
}

/// The one measured-length ceiling, shared with `VisionAnalyze` so both tools
/// refuse an oversized body with the same shape of error.
pub fn ensure_within_limit(bytes: usize, description: &str) -> Result<(), ToolError> {
    crate::tools::provider_store::ensure_within_limit(
        bytes,
        MAX_DOWNLOAD_BYTES,
        "IMAGE_TOO_LARGE",
        description,
    )
}

/// Owns one temporary download and removes it however the call ends — a refused
/// size, a failed move, an early return. A leaked `image-download-*.part` in the
/// data directory is a file the user never asked for, and every retry adds one.
struct TempDownload {
    path: PathBuf,
}

impl TempDownload {
    /// A fresh path under `<data_dir>/tmp`, created on demand.
    fn new() -> Result<Self, ToolError> {
        let path =
            crate::runtime_tmp::scratch_path("image-download", ".part").map_err(|error| {
                ToolError::new(
                    "SCRATCH_UNAVAILABLE",
                    format!("an image download needs the host's runtime temp directory: {error}"),
                )
            })?;
        Ok(Self { path })
    }

    /// The same guard for a caller that already knows where the temporary file
    /// goes. Tests use it; nothing in production has a reason to.
    #[allow(dead_code)]
    fn at(path: PathBuf) -> Self {
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempDownload {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// Write the bytes to the temporary file, then move them into `dir`.
///
/// The move is a rename when both paths sit on one volume and a copy otherwise:
/// a workspace on another drive is normal, and a rename across volumes fails
/// outright. The copy is only attempted after the write succeeded, so a failed
/// download never leaves a half-written image in the workspace.
fn save_image(
    dir: &Path,
    name: &str,
    bytes: &[u8],
    temp: &TempDownload,
) -> Result<PathBuf, ToolError> {
    if let Some(parent) = temp.path().parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            ToolError::new(
                "TOOL_FAILED",
                format!("could not create {}: {error}", parent.display()),
            )
        })?;
    }
    std::fs::write(temp.path(), bytes).map_err(|error| {
        ToolError::new(
            "TOOL_FAILED",
            format!(
                "could not write the download to {}: {error}",
                temp.path().display()
            ),
        )
    })?;
    std::fs::create_dir_all(dir).map_err(|error| {
        ToolError::new(
            "TOOL_FAILED",
            format!("could not create {}: {error}", dir.display()),
        )
    })?;
    let target = dir.join(name);
    if std::fs::rename(temp.path(), &target).is_err() {
        std::fs::copy(temp.path(), &target).map_err(|error| {
            ToolError::new(
                "TOOL_FAILED",
                format!("could not move the image to {}: {error}", target.display()),
            )
        })?;
        let _ = std::fs::remove_file(temp.path());
    }
    Ok(target)
}

/// The real backend: one provider, resolved through the shared store, over HTTP.
struct HostBackend;

impl HostBackend {
    fn client(timeout: Duration) -> Result<reqwest::Client, ToolError> {
        reqwest::Client::builder()
            .timeout(timeout)
            .build()
            .map_err(|error| {
                ToolError::new(
                    "TOOL_FAILED",
                    format!("could not create an HTTP client: {error}"),
                )
            })
    }

    fn open(
        client: &reqwest::Client,
        request: &GenerationRequest,
        provider: &ProviderCredentials,
    ) -> BoxFuture<'static, Result<GenerationOutcome, ToolError>> {
        let body = build_request_body(request);
        let endpoint = provider.images_endpoint();
        let api_key = provider.api_key.clone();
        let model = provider.model.clone();
        let client = client.clone();
        Box::pin(async move {
            // The feature set this crate enables for reqwest has no `json`
            // helper, so the body is serialised here and the type set explicitly.
            let payload = serde_json::to_string(&body).map_err(|error| {
                ToolError::new(
                    "TOOL_FAILED",
                    format!("the request body could not be encoded: {error}"),
                )
            })?;
            let response = client
                .post(&endpoint)
                .header(reqwest::header::AUTHORIZATION, format!("Bearer {api_key}"))
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(payload)
                .send()
                .await
                .map_err(|error| {
                    // reqwest's error carries the URL and the transport fault,
                    // never the Authorization header.
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
            let body: Value = serde_json::from_str(&text).map_err(|_| {
                ToolError::new(
                    "PROVIDER_ERROR",
                    "the provider answered with something that is not JSON",
                )
                .with_extra(json!({ "detail": truncate(&text, MAX_ERROR_DETAIL) }))
            })?;
            Ok(GenerationOutcome { body, model })
        })
    }
}

impl ImageBackend for HostBackend {
    fn generate<'a>(
        &'a self,
        request: &'a GenerationRequest,
    ) -> BoxFuture<'a, Result<GenerationOutcome, ToolError>> {
        // Resolve before any network work: an unconfigured provider should cost
        // the caller nothing but an error. Opening the store per call is
        // deliberate (see `provider_store`).
        let provider = match host_providers().resolve(Some(&request.model)) {
            Ok(provider) => provider,
            Err(error) => return Box::pin(async move { Err(error) }),
        };
        match Self::client(GENERATE_TIMEOUT) {
            Ok(client) => Self::open(&client, request, &provider),
            Err(error) => Box::pin(async move { Err(error) }),
        }
    }

    fn download<'a>(&'a self, url: &'a str) -> BoxFuture<'a, Result<FetchedImage, ToolError>> {
        Box::pin(async move {
            let client = Self::client(DOWNLOAD_TIMEOUT)?;
            let response = client.get(url).send().await.map_err(|error| {
                ToolError::new(
                    "DOWNLOAD_FAILED",
                    format!("the image could not be downloaded: {error}"),
                )
            })?;
            let status = response.status();
            if !status.is_success() {
                return Err(ToolError::new(
                    "DOWNLOAD_FAILED",
                    format!("the download answered {status}"),
                ));
            }
            // A declared length that is already over the ceiling is refused
            // before the body is pulled into memory.
            if let Some(declared) = response.content_length() {
                ensure_within_limit(declared as usize, url)?;
            }
            let content_type = response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .map(str::to_string);
            let bytes = response.bytes().await.map_err(|error| {
                ToolError::new(
                    "DOWNLOAD_FAILED",
                    format!("the image body could not be read: {error}"),
                )
            })?;
            // The declared length and the delivered length can disagree; the
            // bytes that are actually written are what count.
            ensure_within_limit(bytes.len(), url)?;
            Ok(FetchedImage {
                content_type,
                bytes: bytes.to_vec(),
            })
        })
    }
}

/// Run one image-generation call.
///
/// `workspace` is where `generated/` is created: the pictures belong to the
/// project they were drawn for, and a call with no workspace open has nowhere to
/// put them.
pub async fn execute(
    args: &Value,
    workspace: &Path,
    backend: &dyn ImageBackend,
) -> Result<Value, ToolError> {
    let request = parse_request(args)?;
    let outcome = backend.generate(&request).await?;
    let urls = image_urls(&outcome.body)?;

    let dir = generated_dir(workspace);
    let stamp = now_millis();
    let sequence = SAVE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let slug = prompt_slug(&request.prompt);
    let mut paths: Vec<String> = Vec::new();
    let mut failures: Vec<String> = Vec::new();
    for (index, url) in urls.iter().enumerate() {
        match backend.download(url).await {
            Ok(image) => {
                if let Err(error) = ensure_within_limit(image.bytes.len(), url) {
                    failures.push(format!("#{index}: {}", error.message));
                    continue;
                }
                let temp = TempDownload::new()?;
                let name = file_name(
                    &slug,
                    stamp,
                    sequence,
                    index,
                    extension_for(image.content_type.as_deref(), url),
                );
                match save_image(&dir, &name, &image.bytes, &temp) {
                    Ok(path) => paths.push(path.display().to_string()),
                    Err(error) => failures.push(format!("#{index}: {}", error.message)),
                }
            }
            Err(error) => failures.push(format!("#{index}: {}", error.message)),
        }
    }
    if paths.is_empty() {
        // Nothing on disk means nothing to hand the model: a partial failure is
        // reported as data, a total one as an error.
        return Err(ToolError::new(
            "TOOL_FAILED",
            format!("no image could be saved: {}", failures.join("; ")),
        )
        .with_extra(json!({ "failures": failures, "model": outcome.model })));
    }

    let mut content = json!({
        "paths": paths,
        "model": outcome.model,
        "count": paths.len(),
    });
    if !failures.is_empty() {
        content["failures"] = json!(failures);
    }
    // The provider's own accounting, when it sends any: a caller watching cost
    // should not have to parse the raw body to see it.
    if let Some(usage) = outcome.body.get("usage") {
        content["usage"] = usage.clone();
    }
    Ok(content)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::provider_store::{not_configured, ProviderDirectory};

    /// Test files live under the build directory, never the platform temp
    /// directory (AGENTS.md §8).
    fn test_dir(label: &str) -> PathBuf {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("image-generate-tests")
            .join(format!("{label}-{}", std::process::id()));
        std::fs::create_dir_all(&root).expect("test workspace");
        root
    }

    #[test]
    fn the_tool_answers_to_both_spellings() {
        assert!(recognizes("GenerateImages"));
        assert!(recognizes("image_generate"));
        assert!(!recognizes("ImageGenerate"));
        assert!(!recognizes("VisionAnalyze"));
    }

    #[test]
    fn the_prompt_is_required_and_the_rest_has_defaults() {
        for args in [
            json!({}),
            json!({ "prompt": "" }),
            json!({ "prompt": "  " }),
        ] {
            let error = parse_request(&args).expect_err("a prompt is required");
            assert_eq!(error.code, "INVALID_ARGUMENT");
        }
        let request = parse_request(&json!({ "prompt": " a cat " })).expect("a request");
        assert_eq!(request.prompt, "a cat");
        assert_eq!(request.model, DEFAULT_IMAGE_MODEL);
        assert_eq!(request.count, 1);
        let named = parse_request(&json!({ "prompt": "x", "model": "other-image" }))
            .expect("a named model");
        assert_eq!(named.model, "other-image");
    }

    #[test]
    fn the_count_is_clamped_to_what_a_provider_returns() {
        assert_eq!(clamp_count(None), 1);
        assert_eq!(clamp_count(Some(0)), 1);
        assert_eq!(clamp_count(Some(1)), 1);
        assert_eq!(clamp_count(Some(3)), 3);
        assert_eq!(clamp_count(Some(MAX_IMAGES)), MAX_IMAGES);
        assert_eq!(clamp_count(Some(MAX_IMAGES + 1)), MAX_IMAGES);
        assert_eq!(clamp_count(Some(500)), MAX_IMAGES);
        // Read from either a number or a numeric string; junk falls back to one.
        assert_eq!(
            parse_request(&json!({ "prompt": "x", "n": 9 }))
                .expect("n")
                .count,
            4
        );
        assert_eq!(
            parse_request(&json!({ "prompt": "x", "n": "2" }))
                .expect("n")
                .count,
            2
        );
        assert_eq!(
            parse_request(&json!({ "prompt": "x", "n": "two" }))
                .expect("n")
                .count,
            1
        );
    }

    #[test]
    fn the_body_names_the_model_the_prompt_and_the_count() {
        let request = GenerationRequest {
            prompt: "a red door".into(),
            model: DEFAULT_IMAGE_MODEL.into(),
            count: 2,
        };
        let body = build_request_body(&request);
        assert_eq!(body["model"], json!(DEFAULT_IMAGE_MODEL));
        assert_eq!(body["prompt"], json!("a red door"));
        assert_eq!(body["n"], json!(2));
    }

    #[test]
    fn urls_come_back_in_the_providers_order() {
        let body = json!({
            "data": [
                { "url": "https://cdn.test/b.png", "index": 1 },
                { "url": "https://cdn.test/a.png", "index": 0 }
            ],
            "usage": { "credit": 1 }
        });
        assert_eq!(
            image_urls(&body).expect("two urls"),
            vec![
                "https://cdn.test/b.png".to_string(),
                "https://cdn.test/a.png".to_string()
            ]
        );
    }

    /// Every shape that is not a generation response is an error with its own
    /// wording: an empty list would read downstream as "the provider drew
    /// nothing".
    #[test]
    fn a_body_without_usable_urls_is_refused() {
        let missing_data = json!({ "choices": [] });
        assert_eq!(
            image_urls(&missing_data).expect_err("no data").code,
            "PROVIDER_ERROR"
        );

        let not_an_array = json!({ "data": { "url": "https://cdn.test/a.png" } });
        let error = image_urls(&not_an_array).expect_err("data is not an array");
        assert_eq!(error.code, "PROVIDER_ERROR");
        assert!(error.message.contains("not an array"), "{}", error.message);

        let empty = json!({ "data": [] });
        assert_eq!(
            image_urls(&empty).expect_err("empty").code,
            "PROVIDER_ERROR"
        );

        // Rows without a url are skipped; if none survives, that is an error.
        let no_urls = json!({ "data": [{ "index": 0 }, { "url": "   " }, { "url": null }] });
        let error = image_urls(&no_urls).expect_err("no usable url");
        assert_eq!(error.code, "PROVIDER_ERROR");
        assert!(error.message.contains('3'), "{}", error.message);
        assert_eq!(error.extra["images"], json!(3));

        // One good url among bad rows is enough.
        let mixed = json!({ "data": [{ "index": 0 }, { "url": "https://cdn.test/a.png" }] });
        assert_eq!(image_urls(&mixed).expect("one url").len(), 1);
    }

    /// The prompt is model-written text and may hold anything a path cannot.
    #[test]
    fn the_prompt_becomes_a_safe_file_name_fragment() {
        assert_eq!(prompt_slug("A red door / at night"), "a-red-door-at-night");
        assert_eq!(prompt_slug("C:\\temp\\x.png"), "c-temp-x-png");
        assert_eq!(prompt_slug("汉字 图片"), "image");
        assert_eq!(prompt_slug("../../etc/passwd"), "etc-passwd");
        assert_eq!(prompt_slug("  ...  "), "image");
        assert_eq!(prompt_slug(""), "image");
        // No separator survives, whatever the prompt holds.
        for prompt in ["a/b", "a\\b", "a:b", "a*b?c", "a\"b<c>d|e"] {
            let slug = prompt_slug(prompt);
            assert!(
                !slug.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|']),
                "{prompt} -> {slug}"
            );
        }
        // A long prompt is cut, and the cut never ends in a separator.
        let long = prompt_slug(&"a".repeat(200));
        assert_eq!(long.chars().count(), MAX_SLUG_CHARS);
        let cut = prompt_slug(&format!("{} b", "a".repeat(MAX_SLUG_CHARS)));
        assert!(!cut.ends_with('-'), "{cut}");
        assert!(cut.chars().count() <= MAX_SLUG_CHARS);
    }

    #[test]
    fn the_extension_follows_the_content_type_then_the_url() {
        assert_eq!(
            extension_for(Some("image/png"), "https://cdn.test/x"),
            "png"
        );
        assert_eq!(
            extension_for(Some("image/jpeg; charset=binary"), "https://cdn.test/x"),
            "jpg"
        );
        assert_eq!(
            extension_for(Some("IMAGE/WEBP"), "https://cdn.test/x"),
            "webp"
        );
        // An unknown type falls back to the URL's own suffix.
        assert_eq!(
            extension_for(
                Some("application/octet-stream"),
                "https://cdn.test/x.webp?sig=1"
            ),
            "webp"
        );
        assert_eq!(extension_for(None, "https://cdn.test/x.jpeg"), "jpg");
        // Neither names a format: PNG is the common case.
        assert_eq!(extension_for(None, "https://cdn.test/opaque"), "png");
        assert_eq!(
            extension_for(Some("text/html"), "https://cdn.test/error"),
            "png"
        );
    }

    #[test]
    fn file_names_carry_the_prompt_the_stamp_and_the_index() {
        let first = file_name("a-cat", 1_700_000_000_000, 3, 0, "png");
        assert_eq!(first, "a-cat-1700000000000-3-0.png");
        // Two images of one batch, and two batches, never collide.
        assert_ne!(first, file_name("a-cat", 1_700_000_000_000, 3, 1, "png"));
        assert_ne!(first, file_name("a-cat", 1_700_000_000_001, 3, 0, "png"));
        assert_ne!(first, file_name("a-cat", 1_700_000_000_000, 4, 0, "png"));
    }

    #[test]
    fn images_land_in_generated_under_the_workspace() {
        assert_eq!(
            generated_dir(Path::new("D:/work/project")),
            Path::new("D:/work/project/generated")
        );
    }

    /// Over the ceiling is a refusal that names the real size, never a truncation
    /// the model would treat as a whole picture.
    #[test]
    fn an_oversized_download_is_refused_with_its_byte_count() {
        let error = ensure_within_limit(MAX_DOWNLOAD_BYTES + 1, "https://cdn.test/x.png")
            .expect_err("over the limit");
        assert_eq!(error.code, "IMAGE_TOO_LARGE");
        assert!(error
            .message
            .contains(&(MAX_DOWNLOAD_BYTES + 1).to_string()));
        assert_eq!(error.extra["limit"], json!(MAX_DOWNLOAD_BYTES));
        ensure_within_limit(MAX_DOWNLOAD_BYTES, "https://cdn.test/x.png")
            .expect("exactly at the limit");
    }

    /// The temporary file is written, moved, and gone — on success and on failure.
    #[test]
    fn a_download_is_written_through_a_temporary_file() {
        let root = test_dir("save");
        let dir = root.join("generated");
        let temp_path = root.join("tmp").join("image-download-1.part");
        let temp = TempDownload::at(temp_path.clone());
        let target = save_image(&dir, "a-cat-1-1-0.png", b"PNGDATA", &temp).expect("saved");
        assert_eq!(target, dir.join("a-cat-1-1-0.png"));
        assert_eq!(std::fs::read(&target).expect("read back"), b"PNGDATA");
        assert!(!temp_path.exists(), "the temporary file is not left behind");

        // A directory that cannot be created fails without leaving the temp file.
        let blocked = root.join("blocked");
        std::fs::write(&blocked, b"not a directory").expect("a file where a dir should be");
        let temp_path = root.join("tmp").join("image-download-2.part");
        {
            let temp = TempDownload::at(temp_path.clone());
            let error = save_image(&blocked.join("generated"), "x.png", b"PNGDATA", &temp)
                .expect_err("the directory cannot be created");
            assert_eq!(error.code, "TOOL_FAILED");
            // The download really was written before the move failed, so this
            // asserts the cleanup and not a call that never started.
            assert!(temp_path.exists(), "the download was written first");
        }
        assert!(
            !temp_path.exists(),
            "the temporary file is removed on failure"
        );
    }

    /// A backend that answers with fixed URLs and fixed bytes: no provider, no
    /// network, and the whole call — including the move into `generated/` — runs.
    struct FakeBackend {
        body: Value,
        images: Vec<(Option<&'static str>, Vec<u8>)>,
        model: String,
        fail: Vec<usize>,
    }

    impl FakeBackend {
        fn new(body: Value, images: Vec<(Option<&'static str>, Vec<u8>)>) -> Self {
            Self {
                body,
                images,
                model: DEFAULT_IMAGE_MODEL.to_string(),
                fail: Vec::new(),
            }
        }
    }

    impl ImageBackend for FakeBackend {
        fn generate<'a>(
            &'a self,
            _request: &'a GenerationRequest,
        ) -> BoxFuture<'a, Result<GenerationOutcome, ToolError>> {
            Box::pin(async move {
                Ok(GenerationOutcome {
                    body: self.body.clone(),
                    model: self.model.clone(),
                })
            })
        }

        fn download<'a>(&'a self, url: &'a str) -> BoxFuture<'a, Result<FetchedImage, ToolError>> {
            Box::pin(async move {
                // The image and the failure list are keyed by the url's position
                // in `data`, so a test can fail one download and keep the other.
                let position = self
                    .body
                    .get("data")
                    .and_then(Value::as_array)
                    .map(|rows| {
                        rows.iter()
                            .position(|row| row.get("url").and_then(Value::as_str) == Some(url))
                    })
                    .flatten()
                    .unwrap_or(0);
                if self.fail.contains(&position) {
                    return Err(ToolError::new(
                        "DOWNLOAD_FAILED",
                        "the download answered 403 Forbidden",
                    ));
                }
                let (content_type, bytes) = self
                    .images
                    .get(position)
                    .cloned()
                    .ok_or_else(|| ToolError::new("DOWNLOAD_FAILED", "no such image"))?;
                Ok(FetchedImage {
                    content_type: content_type.map(str::to_string),
                    bytes,
                })
            })
        }
    }

    fn install_runtime_tmp(root: &Path) {
        // The host installs this once at startup; a test binary has to do it
        // itself, and the first call wins for the process.
        crate::runtime_tmp::install_root(root);
    }

    #[tokio::test]
    async fn a_call_saves_every_image_and_reports_the_paths() {
        let workspace = test_dir("execute-ok");
        install_runtime_tmp(&workspace.join("tmp"));
        let backend = FakeBackend::new(
            json!({ "data": [{ "url": "https://cdn.test/a" }, { "url": "https://cdn.test/b.png" }] }),
            vec![
                (Some("image/png"), b"PNGDATA".to_vec()),
                (None, b"PNGDATA2".to_vec()),
            ],
        );
        let result = execute(&json!({ "prompt": "a red door" }), &workspace, &backend)
            .await
            .expect("two images");
        assert_eq!(result["model"], json!(DEFAULT_IMAGE_MODEL));
        assert_eq!(result["count"], json!(2));
        let paths = result["paths"].as_array().expect("paths");
        assert_eq!(paths.len(), 2);
        for path in paths {
            let path = PathBuf::from(path.as_str().expect("a path"));
            assert!(
                path.starts_with(generated_dir(&workspace)),
                "{}",
                path.display()
            );
            assert!(path.exists(), "{}", path.display());
            assert!(path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .contains("a-red-door"));
        }
        // The first URL declares no suffix, the second one does: both still get
        // an extension, one from the content type and one from the URL.
        let names: Vec<String> = paths
            .iter()
            .filter_map(|path| path.as_str().map(str::to_string))
            .collect();
        assert!(names[0].ends_with(".png"), "{}", names[0]);
        assert!(names[1].ends_with(".png"), "{}", names[1]);
        assert!(result.get("failures").is_none(), "no failures were listed");
    }

    /// One URL that cannot be fetched is a partial success: the other path is
    /// returned and the failure is reported, not hidden.
    #[tokio::test]
    async fn a_failed_download_is_reported_next_to_the_images_that_worked() {
        let workspace = test_dir("execute-partial");
        install_runtime_tmp(&workspace.join("tmp"));
        let mut backend = FakeBackend::new(
            json!({ "data": [{ "url": "https://cdn.test/a.png" }, { "url": "https://cdn.test/b.png" }] }),
            vec![(Some("image/png"), b"PNGDATA".to_vec())],
        );
        backend.fail = vec![1];
        let result = execute(&json!({ "prompt": "x" }), &workspace, &backend)
            .await
            .expect("one image");
        assert_eq!(result["count"], json!(1));
        let failures = result["failures"].as_array().expect("failures");
        assert_eq!(failures.len(), 1);
        assert!(failures[0].as_str().unwrap_or_default().contains("#1"));
    }

    /// Nothing saved is an error, because there is no path to hand the model.
    #[tokio::test]
    async fn a_call_where_every_download_fails_is_an_error() {
        let workspace = test_dir("execute-failed");
        install_runtime_tmp(&workspace.join("tmp"));
        let mut backend = FakeBackend::new(
            json!({ "data": [{ "url": "https://cdn.test/a.png" }] }),
            vec![(Some("image/png"), b"PNGDATA".to_vec())],
        );
        backend.fail = vec![0];
        let error = execute(&json!({ "prompt": "x" }), &workspace, &backend)
            .await
            .expect_err("nothing saved");
        assert_eq!(error.code, "TOOL_FAILED");
        assert!(error.message.contains("403"), "{}", error.message);
        assert_eq!(error.extra["model"], json!(DEFAULT_IMAGE_MODEL));
    }

    /// An unconfigured provider costs the caller an error and no network call.
    #[tokio::test]
    async fn an_unconfigured_provider_fails_before_the_call() {
        struct Missing;
        impl ProviderDirectory for Missing {
            fn resolve(&self, _model: Option<&str>) -> Result<ProviderCredentials, ToolError> {
                Err(crate::tools::provider_store::not_configured(
                    "no enabled provider",
                ))
            }
        }
        let error = Missing.resolve(Some("m")).expect_err("no provider");
        assert_eq!(error.code, "PROVIDER_NOT_CONFIGURED");
    }
}
