//! Provider resolution shared by the tools that call a model directly.
//!
//! Two tools now reach the same provider store: `VisionAnalyze` asks one about
//! an image, `GenerateImages` asks one to draw one. Both need the same three
//! facts — a base URL, a credential, a model id — read from the same tables
//! through the same rules, so the reading lives here once. A second copy would
//! be a second answer to "which provider is configured", and the two would drift
//! the first time the store changed.
//!
//! The credential never leaves [`ProviderCredentials`] except as an
//! `Authorization` header built by the caller, and no error message repeats it:
//! only whether one exists.

use serde_json::json;

use crate::tools::hashline::ToolError;

/// One provider, resolved far enough to make a call. The API key never leaves
/// this struct except as an `Authorization` header.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderCredentials {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
}

impl ProviderCredentials {
    /// `POST {base}{path}`. A stored base URL may or may not already carry the
    /// path, so it is normalised rather than concatenated blindly: a provider
    /// configured as `…/v1/chat/completions` must not become
    /// `…/v1/chat/completions/chat/completions`.
    pub fn endpoint_for(&self, path: &str) -> String {
        let base = self.base_url.trim().trim_end_matches('/');
        let path = path.trim();
        let path = path.strip_prefix('/').unwrap_or(path);
        if base.ends_with(&format!("/{path}")) {
            base.to_string()
        } else {
            format!("{base}/{path}")
        }
    }

    /// `POST {base}/chat/completions` — the conversation endpoint.
    pub fn chat_endpoint(&self) -> String {
        self.endpoint_for("chat/completions")
    }

    /// `POST {base}/images/generations` — the image endpoint. A separate path
    /// rather than the chat one: a gateway only reinterprets a single-image chat
    /// message as generation by heuristic, and that heuristic is what makes a
    /// vision call answer with `data[].url` instead of prose.
    pub fn images_endpoint(&self) -> String {
        self.endpoint_for("images/generations")
    }
}

/// Where a tool call gets its provider from. A trait so request construction and
/// the error paths can be exercised without a provider store or a network.
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
/// purpose: these calls are rare, and a cached connection would be a second,
/// silently stale owner of the same SQLite file.
pub fn host_providers() -> &'static dyn ProviderDirectory {
    &StoredProviders
}

/// The error for "no usable provider", in wording a caller can act on.
pub fn not_configured(detail: &str) -> ToolError {
    // Never echo the credential itself — only whether one exists.
    ToolError::new("PROVIDER_NOT_CONFIGURED", detail.to_string())
}

fn resolve_from_store(model: Option<&str>) -> Result<ProviderCredentials, ToolError> {
    let data_dir = crate::pi_home::data_dir().ok_or_else(|| {
        not_configured("no provider is configured: this host has no data directory")
    })?;
    let db = crate::db::Database::open_in_dir(&data_dir).map_err(|error| {
        not_configured(&format!("the provider store could not be opened: {error}"))
    })?;
    let secrets = crate::secrets::SecretStore::open(&data_dir).map_err(|error| {
        not_configured(&format!("the provider store could not be opened: {error}"))
    })?;
    let providers = crate::providers::list_providers(&db, &secrets, false).map_err(|error| {
        not_configured(&format!("the provider list could not be read: {error}"))
    })?;

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
        .map_err(|error| {
            not_configured(&format!("the stored credential could not be read: {error}"))
        })?
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

/// The ceiling check used by both callers, applied to one measured length.
///
/// A refusal rather than a clamp: a truncated image would be answered about — or
/// handed to the model — as if it were whole, and nothing downstream can notice
/// the difference.
pub fn ensure_within_limit(
    bytes: usize,
    limit: usize,
    code: &str,
    description: &str,
) -> Result<(), ToolError> {
    if bytes > limit {
        return Err(ToolError::new(
            code,
            format!("{description} is {bytes} bytes, over the {limit} byte limit"),
        )
        .with_extra(json!({ "bytes": bytes, "limit": limit })));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn credentials(base: &str) -> ProviderCredentials {
        ProviderCredentials {
            base_url: base.into(),
            api_key: "k".into(),
            model: "m".into(),
        }
    }

    /// Endpoint normalisation: a stored base URL may or may not carry the path.
    #[test]
    fn each_endpoint_is_built_from_the_base_url_once() {
        assert_eq!(
            credentials("https://api.example.test/v1/").chat_endpoint(),
            "https://api.example.test/v1/chat/completions"
        );
        assert_eq!(
            credentials("https://api.example.test/v1/images/generations").images_endpoint(),
            "https://api.example.test/v1/images/generations"
        );
        assert_eq!(
            credentials("https://api.example.test/v1").images_endpoint(),
            "https://api.example.test/v1/images/generations"
        );
        assert_eq!(
            credentials("https://api.example.test/v1/chat/completions").chat_endpoint(),
            "https://api.example.test/v1/chat/completions"
        );
        // A base that carries the *other* path still gets this one appended.
        assert_eq!(
            credentials("https://api.example.test/v1/chat/completions").images_endpoint(),
            "https://api.example.test/v1/chat/completions/images/generations"
        );
    }

    #[test]
    fn a_size_ceiling_reports_the_real_length() {
        let error = ensure_within_limit(11, 10, "IMAGE_TOO_LARGE", "a.png").expect_err("over");
        assert_eq!(error.code, "IMAGE_TOO_LARGE");
        assert!(error.message.contains("11 bytes"));
        assert_eq!(error.extra["limit"], json!(10));
        ensure_within_limit(10, 10, "IMAGE_TOO_LARGE", "a.png").expect("exactly at the limit");
    }
}
