//! `WebSearch` and `WebExtract`: the two tools that reach the open web.
//!
//! Ported from the reference agent's `tools/web_tools.py` plus
//! `plugins/web/<vendor>/provider.py` (see `references/web-tools-parity.md` in
//! the `rust-agent-kernel-port` skill). The parts that note calls a contract are
//! kept verbatim:
//!
//! * A backend is `name` / `is_available` / `is_keyless_available` / `search`.
//! * The ladder is `web.search_backend` (single-capability pin, **strict**) →
//!   `web.backend` (shared pin) → credential autodetect (paid tiers first, free
//!   keys after) → the keyless layer → the default backend. A pin never falls
//!   back: silently answering from B while the user configured A is how a
//!   debugging session ends up in the wrong place.
//! * `web_search` answers `{"success": true, "data": {"web": [{title, url,
//!   description, position}]}}`, `web_extract` answers
//!   `{"results": [{url, content} | {url, error}]}` and reports a bad URL *per
//!   URL* — one dead link does not fail the batch.
//! * Four gates: SSRF refusal before the request, ≤ 5 URLs per batch, a
//!   per-page character budget, and HTML→text cleaning.
//!
//! Cost defaults are the measured ones: 3 results (352 characters ≈ 97 tokens
//! against 613 ≈ 178 for 5) and 6 000 characters per page (a 15 000 default is
//! one Chinese article's worth of context). Enlarging either is an explicit
//! argument, never a default.
//!
//! The SSRF gate is textual: schemes, IP literals, loopback names and the cloud
//! metadata addresses. A public name that resolves to a private address is out
//! of scope here — a resolver-level guard belongs in the transport, and this
//! module's contract is "no obviously internal URL is ever handed to it".

use std::collections::BTreeMap;
use std::future::Future;
use std::net::{Ipv4Addr, Ipv6Addr};
use std::pin::Pin;
use std::sync::OnceLock;
use std::time::Duration;

use serde_json::{json, Value};

use crate::tools::browser_exec::html_to_text;
use crate::tools::hashline::ToolError;

/// The names the kernel declares. The snake_case spellings are accepted too:
/// they are the reference agent's own names (`web_search` / `web_extract`), and a
/// kernel that declares one spelling should not need a host release to change
/// its mind.
pub const SEARCH_TOOL_NAME: &str = "WebSearch";
pub const EXTRACT_TOOL_NAME: &str = "WebExtract";

/// Does this tool name belong to the search half of the pair?
pub fn recognizes_search(tool_name: &str) -> bool {
    tool_name == SEARCH_TOOL_NAME || tool_name == "web_search"
}

/// Does this tool name belong to the fetch half of the pair?
pub fn recognizes_extract(tool_name: &str) -> bool {
    tool_name == EXTRACT_TOOL_NAME || tool_name == "web_extract"
}

/// Three results by default: the measured cost of five is 613 characters
/// ≈ 178 tokens, against 352 ≈ 97 for three.
pub const DEFAULT_SEARCH_LIMIT: usize = 3;

/// A ceiling on `limit`, so one call cannot pull a hundred snippets into the
/// transcript.
pub const MAX_SEARCH_LIMIT: usize = 20;

/// The reference's per-batch ceiling. Refused above it rather than truncated: a
/// silently dropped URL reads as "this page does not exist".
pub const MAX_EXTRACT_URLS: usize = 5;

/// Characters per page by default. Chinese text is roughly one token per
/// character, so a vendored 15 000-character page is half a context window.
pub const DEFAULT_EXTRACT_CHARS: usize = 6_000;

/// The most a caller may ask for per page.
pub const MAX_EXTRACT_CHARS: usize = 40_000;

/// A search is one small request; a hung third party is not worth more than this.
const SEARCH_TIMEOUT: Duration = Duration::from_secs(25);

/// A page may be large and slow; this is still a fetch, not a browser.
const EXTRACT_TIMEOUT: Duration = Duration::from_secs(40);

/// How many redirect hops a fetch may follow. Each hop is re-checked against the
/// SSRF gate by [`ReqwestTransport`], so a public URL cannot land on loopback.
const MAX_REDIRECTS: usize = 5;

/// Enough of a response body to name the reason it failed.
const MAX_ERROR_DETAIL: usize = 300;

/// The credential-bearing backends, in the reference's order: paid tiers first,
/// free keys after (`tavily → … → searxng → brave-free`).
pub const KEYED_BACKENDS: [&str; 3] = ["tavily", "searxng", "brave-free"];

/// Backends that need no credential. `bing` leads because the reference note's
/// measurement is unambiguous on an allowlisting network: `cn.bing.com` resolves
/// and answers, `html.duckduckgo.com` does not, so a keyless tier that starts
/// with `ddgs` looks exactly like "the web tools are not wired up".
pub const KEYLESS_BACKENDS: [&str; 2] = ["bing", "ddgs"];

/// The last resort, matching the reference's own default.
pub const DEFAULT_BACKEND: &str = "ddgs";

/// Every backend this host knows by name, for a pin that names nothing real.
pub const KNOWN_BACKENDS: [&str; 5] = ["tavily", "searxng", "brave-free", "bing", "ddgs"];

/// Environment variables per backend. `searxng` stores its base URL here: a
/// self-hosted instance is "configured", not "credentialed".
pub const CREDENTIAL_ENV: [(&str, &[&str]); 3] = [
    ("tavily", &["TAVILY_API_KEY"]),
    ("searxng", &["SEARXNG_URL"]),
    ("brave-free", &["BRAVE_API_KEY", "BRAVE_SEARCH_API_KEY"]),
];

/// The same credentials as settings keys, in both spellings the settings store
/// already uses (`showThinking` next to `defaultPermissionMode`). A settings
/// document may also keep them flat as `web.tavily_api_key`.
pub const CREDENTIAL_SETTINGS: [(&str, &[&str]); 3] = [
    ("tavily", &["tavily_api_key", "tavilyApiKey"]),
    ("searxng", &["searxng_url", "searxngUrl"]),
    ("brave-free", &["brave_api_key", "braveApiKey"]),
];

/// What the host sends as a user agent unless a backend overrides it. Naming the
/// product rather than mimicking a browser is the honest default; a backend that
/// serves a script-only shell to unknown agents overrides it for itself.
const USER_AGENT: &str = concat!("Pi-Desktop/", env!("CARGO_PKG_VERSION"), " web-tools");

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/// A boxed, `Send` future: the tool code is async, the trait is object-safe.
pub type WebFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// One outgoing request, already fully described. `body.is_some()` means `POST`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpRequest {
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
}

impl HttpRequest {
    pub fn get(url: impl Into<String>) -> Self {
        Self {
            url: url.into(),
            headers: Vec::new(),
            body: None,
        }
    }

    pub fn post_json(url: impl Into<String>, body: Value) -> Self {
        Self {
            url: url.into(),
            headers: vec![("content-type".into(), "application/json".into())],
            body: Some(body.to_string()),
        }
    }

    pub fn header(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.headers.push((name.into(), value.into()));
        self
    }

    pub fn method(&self) -> &'static str {
        if self.body.is_some() {
            "POST"
        } else {
            "GET"
        }
    }
}

/// One answer: status, declared type, body. The body is text — every backend here
/// speaks JSON or HTML.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpResponse {
    pub status: u16,
    pub content_type: Option<String>,
    pub body: String,
}

impl HttpResponse {
    pub fn new(status: u16, content_type: Option<&str>, body: impl Into<String>) -> Self {
        Self {
            status,
            content_type: content_type.map(str::to_string),
            body: body.into(),
        }
    }

    fn is_success(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

/// The one seam between this module and the network.
///
/// A trait rather than a bare `reqwest` call so every gate, ladder and parser
/// above it is exercised by tests with fixed responses — a unit test that needs
/// the internet is a unit test that fails on a build machine.
pub trait HttpTransport: Send + Sync {
    fn send<'a>(&'a self, request: &'a HttpRequest) -> WebFuture<'a, Result<HttpResponse, String>>;
}

/// The real transport.
pub struct ReqwestTransport {
    client: reqwest::Client,
}

impl ReqwestTransport {
    pub fn new() -> Result<Self, String> {
        let client = reqwest::Client::builder()
            .timeout(EXTRACT_TIMEOUT.max(SEARCH_TIMEOUT))
            .user_agent(USER_AGENT)
            // A redirect is a second request to a URL nobody validated, so each
            // hop goes through the same gate as the first one.
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                if attempt.previous().len() >= MAX_REDIRECTS {
                    return attempt.stop();
                }
                match validate_public_url(attempt.url().as_str()) {
                    Ok(_) => attempt.follow(),
                    Err(_) => attempt.stop(),
                }
            }))
            .build()
            .map_err(|error| format!("could not create an HTTP client: {error}"))?;
        Ok(Self { client })
    }
}

impl HttpTransport for ReqwestTransport {
    fn send<'a>(&'a self, request: &'a HttpRequest) -> WebFuture<'a, Result<HttpResponse, String>> {
        Box::pin(async move {
            let mut builder = if request.method() == "POST" {
                self.client.post(&request.url)
            } else {
                self.client.get(&request.url)
            };
            for (name, value) in &request.headers {
                builder = builder.header(name.as_str(), value.as_str());
            }
            if let Some(body) = &request.body {
                builder = builder.body(body.clone());
            }
            let response = builder.send().await.map_err(|error| error.to_string())?;
            let status = response.status().as_u16();
            let content_type = response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .map(str::to_string);
            let body = response.text().await.map_err(|error| error.to_string())?;
            Ok(HttpResponse::new(status, content_type.as_deref(), body))
        })
    }
}

/// The process-wide transport the dispatcher hands both tools.
///
/// Built once: a `reqwest::Client` owns a connection pool, and building one per
/// call would open a fresh TLS session to the same host every time.
pub fn host_transport() -> Result<&'static dyn HttpTransport, ToolError> {
    static TRANSPORT: OnceLock<Result<ReqwestTransport, String>> = OnceLock::new();
    match TRANSPORT.get_or_init(ReqwestTransport::new) {
        Ok(transport) => Ok(transport),
        Err(error) => Err(ToolError::new("WEB_UNAVAILABLE", error.clone())),
    }
}

// ---------------------------------------------------------------------------
// The SSRF gate
// ---------------------------------------------------------------------------

/// A URL that survived the gate, in the form the transport should request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WebUrl {
    pub url: String,
    pub host: String,
    pub https: bool,
}

fn refused(url: &str, reason: &str) -> ToolError {
    ToolError::new(
        "URL_NOT_ALLOWED",
        format!("refused to fetch `{url}`: {reason}"),
    )
    .with_extra(json!({ "url": url }))
}

/// Refuse anything that is not a public http(s) resource, **before** a request is
/// made. Wording is for the model: it says which rule the URL broke.
pub fn validate_public_url(raw: &str) -> Result<WebUrl, ToolError> {
    let url = raw.trim();
    if url.is_empty() {
        return Err(ToolError::new(
            "INVALID_ARGUMENT",
            "`urls` must not contain an empty entry",
        ));
    }
    if url
        .chars()
        .any(|character| character.is_whitespace() || character.is_control())
    {
        return Err(refused(url, "it contains whitespace or control characters"));
    }
    // `to_ascii_lowercase` keeps byte offsets, so slicing the original by these
    // indices is safe and the host keeps its real case on the wire.
    let lower = url.to_ascii_lowercase();
    let (https, after_scheme) = if lower.starts_with("https://") {
        (true, &url["https://".len()..])
    } else if lower.starts_with("http://") {
        (false, &url["http://".len()..])
    } else {
        let scheme = lower
            .split([':', '/'])
            .next()
            .unwrap_or_default()
            .to_string();
        return Err(ToolError::new(
            "UNSUPPORTED_SCHEME",
            format!(
                "`{url}` is not fetchable: only http and https are{}",
                if scheme.is_empty() {
                    String::new()
                } else {
                    format!(" (not `{scheme}`)")
                }
            ),
        )
        .with_extra(json!({ "url": url })));
    };

    let authority = after_scheme
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default();
    if authority.is_empty() {
        return Err(refused(url, "it names no host"));
    }
    if authority.contains('@') {
        return Err(refused(url, "URLs carrying credentials are not fetched"));
    }
    let host = if let Some(rest) = authority.strip_prefix('[') {
        match rest.find(']') {
            Some(end) => rest[..end].to_string(),
            None => return Err(refused(url, "its IPv6 host is not bracketed properly")),
        }
    } else {
        let host = authority.split(':').next().unwrap_or_default();
        if host.contains(':') {
            return Err(refused(url, "its host is malformed"));
        }
        host.to_string()
    };
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    if host.is_empty() {
        return Err(refused(url, "it names no host"));
    }
    if host.contains('/') || host.contains('\\') {
        return Err(refused(url, "its host is malformed"));
    }

    match host.parse::<std::net::IpAddr>() {
        Ok(ip) if !is_public_ip(ip) => Err(refused(
            url,
            &format!("`{host}` is a loopback, private, link-local or metadata address"),
        )),
        Ok(_) => Ok(WebUrl {
            url: url.to_string(),
            host,
            https,
        }),
        Err(_) => {
            if is_internal_name(&host) {
                return Err(refused(
                    url,
                    &format!("`{host}` is an internal name, not a public host"),
                ));
            }
            if !host.contains('.') {
                // A single-label name only resolves on a LAN search domain.
                return Err(refused(
                    url,
                    &format!("`{host}` is not a public DNS name (no dot)"),
                ));
            }
            if !host
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || character == '-' || character == '.')
            {
                return Err(refused(url, "its host contains characters no DNS name has"));
            }
            Ok(WebUrl {
                url: url.to_string(),
                host,
                https,
            })
        }
    }
}

/// Loopback and metadata names, which no public page needs.
fn is_internal_name(host: &str) -> bool {
    const NAMES: [&str; 6] = [
        "localhost",
        "localhost.localdomain",
        "metadata",
        "metadata.google.internal",
        "instance-data",
        "kubernetes.default",
    ];
    NAMES.contains(&host)
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".internal")
        || host.ends_with(".localdomain")
        || host.ends_with(".home.arpa")
}

fn is_public_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => is_public_ipv4(v4),
        std::net::IpAddr::V6(v6) => is_public_ipv6(v6),
    }
}

/// Named ranges rather than `is_private()`: the standard predicate leaves
/// CGNAT, the metadata blocks and the reserved space public, and those are
/// exactly the addresses an SSRF attempt aims at.
fn is_public_ipv4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !(a == 0                              // 0.0.0.0/8 "this network"
        || a == 10                        // 10/8
        || a == 127                       // 127/8 loopback
        || a >= 224                       // 224/4 multicast + 240/4 reserved
        || (a == 100 && (64..=127).contains(&b))   // 100.64/10 CGNAT, incl. 100.100.100.200
        || (a == 169 && b == 254)         // 169.254/16 link-local, incl. 169.254.169.254
        || (a == 172 && (16..=31).contains(&b)) // 172.16/12
        || (a == 192 && b == 0 && c == 0) // 192.0.0/24 IETF protocol assignments
        || (a == 192 && b == 168)         // 192.168/16
        || (a == 198 && (b == 18 || b == 19)) // 198.18/15 benchmarking
        || (a == 255 && b == 255 && c == 255)) // limited broadcast
}

fn is_public_ipv6(ip: Ipv6Addr) -> bool {
    if let Some(v4) = ip.to_ipv4_mapped() {
        return is_public_ipv4(v4);
    }
    let segments = ip.segments();
    let unique_local = (segments[0] & 0xfe00) == 0xfc00;
    let link_local = segments[0] == 0xfe80;
    let loopback_or_unspecified = ip.is_loopback() || ip.is_unspecified();
    !(unique_local || link_local || loopback_or_unspecified || ip.is_multicast())
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/// Everything the ladder needs, read once per call: the two pins and the
/// credentials this host can see.
///
/// There is no second configuration system here. The app settings store is the
/// one this host already reads (`Database::get_setting("app")`, through
/// [`crate::pi_home::data_dir`] the way `provider_store` does), and the
/// environment is the override a deployment or a harness can set.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WebConfig {
    /// `web.search_backend` — a single-capability pin, honoured strictly.
    pub search_backend: Option<String>,
    /// `web.backend` — the shared pin.
    pub backend: Option<String>,
    /// Credential or endpoint per backend name, see [`CREDENTIAL_ENV`].
    pub credentials: BTreeMap<String, String>,
}

impl WebConfig {
    /// The pins and credentials visible in the environment. No settings store.
    pub fn from_env() -> Self {
        let mut config = Self {
            search_backend: env_value("PI_WEB_SEARCH_BACKEND"),
            backend: env_value("PI_WEB_BACKEND"),
            credentials: BTreeMap::new(),
        };
        for (backend, names) in CREDENTIAL_ENV {
            if let Some(value) = names.iter().find_map(|name| env_value(name)) {
                config.credentials.insert(backend.to_string(), value);
            }
        }
        config
    }

    /// The `web:` block of the app settings, plus the dotted spellings
    /// (`web.search_backend`, `web.backend`) for a settings document that keeps
    /// its keys flat.
    pub fn from_settings(settings: Option<&Value>) -> Self {
        let block = settings.and_then(|value| value.get("web"));
        let read = |camel: &str, snake: &str, dotted: &str| {
            block
                .and_then(|value| {
                    value
                        .get(snake)
                        .or_else(|| value.get(camel))
                        .and_then(Value::as_str)
                })
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .or_else(|| {
                    settings
                        .and_then(|value| value.get(dotted))
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(str::to_string)
                })
        };
        let mut config = Self {
            search_backend: read("searchBackend", "search_backend", "web.search_backend"),
            backend: read("backend", "backend", "web.backend"),
            credentials: BTreeMap::new(),
        };
        for (backend, keys) in CREDENTIAL_SETTINGS {
            let found = block
                .and_then(|value| {
                    keys.iter()
                        .find_map(|key| value.get(*key).and_then(Value::as_str))
                })
                .or_else(|| {
                    keys.iter().find_map(|key| {
                        settings
                            .and_then(|value| value.get(format!("web.{key}")))
                            .and_then(Value::as_str)
                    })
                })
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty());
            if let Some(value) = found {
                config.credentials.insert(backend.to_string(), value);
            }
        }
        config
    }

    /// Settings first, environment second — the environment wins, which is what
    /// makes a harness or a one-off run able to pin a backend without touching
    /// the user's stored settings.
    pub fn merged(settings: Option<&Value>, env: Self) -> Self {
        let mut config = Self::from_settings(settings);
        if env.search_backend.is_some() {
            config.search_backend = env.search_backend;
        }
        if env.backend.is_some() {
            config.backend = env.backend;
        }
        for (backend, value) in env.credentials {
            config.credentials.insert(backend, value);
        }
        config
    }

    /// What a tool call uses: the stored settings plus the environment. A store
    /// that cannot be opened is not an error — it is simply "no pins and no keys",
    /// and the keyless layer still answers.
    pub fn load() -> Self {
        let settings = crate::pi_home::data_dir()
            .and_then(|dir| crate::db::Database::open_in_dir(&dir).ok())
            .and_then(|db| db.get_setting("app").ok().flatten());
        Self::merged(settings.as_ref(), Self::from_env())
    }

    /// The pin that governs search: the single-capability key wins over the
    /// shared one.
    pub fn search_pin(&self) -> Option<&str> {
        self.search_backend
            .as_deref()
            .or(self.backend.as_deref())
            .map(str::trim)
            .filter(|value| !value.is_empty())
    }

    pub fn credential(&self, backend: &str) -> Option<&str> {
        self.credentials.get(backend).map(String::as_str)
    }
}

fn env_value(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

// ---------------------------------------------------------------------------
// Backends
// ---------------------------------------------------------------------------

/// The caller's search, already validated.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchRequest {
    pub query: String,
    pub limit: usize,
}

/// One search backend, in the reference's shape.
///
/// `search` answers rows or a readable reason; the ladder is what decides whether
/// a failure is fatal (a pin) or moves on (autodetect).
pub trait SearchProvider: Send + Sync {
    fn name(&self) -> &'static str;
    /// Configured: a credential or an endpoint is present.
    fn is_available(&self) -> bool;
    /// Answers without any credential at all.
    fn is_keyless_available(&self) -> bool;
    fn search<'a>(
        &'a self,
        request: &'a SearchRequest,
        http: &'a dyn HttpTransport,
    ) -> WebFuture<'a, Result<Vec<Value>, String>>;
}

/// Every backend this host knows, configured or not. `is_available` is what the
/// ladder reads, so an unconfigured paid backend still exists — a pin naming it
/// must produce *its* error, not "unknown backend".
pub fn catalog(config: &WebConfig) -> Vec<Box<dyn SearchProvider>> {
    vec![
        Box::new(Tavily::new(config.credential("tavily"))),
        Box::new(Searxng::new(config.credential("searxng"))),
        Box::new(BraveFree::new(config.credential("brave-free"))),
        Box::new(Bing::new()),
        Box::new(DuckDuckGo::new()),
    ]
}

/// The backends this call may try, best first.
///
/// A pin yields exactly one entry: strict means strict, so a pinned backend that
/// fails reports its own failure instead of being quietly replaced. Autodetect
/// yields the credentialed tier, then the keyless tier, then the default.
pub fn search_ladder<'a>(
    config: &WebConfig,
    providers: &'a [Box<dyn SearchProvider>],
) -> Result<Vec<&'a dyn SearchProvider>, ToolError> {
    if let Some(pin) = config.search_pin() {
        let pin = pin.to_ascii_lowercase();
        let found = providers.iter().find(|provider| provider.name() == pin);
        return match found {
            Some(provider) => Ok(vec![provider.as_ref()]),
            None => Err(ToolError::new(
                "WEB_BACKEND_UNKNOWN",
                format!(
                    "`web.search_backend` names `{pin}`, which is not a backend this host has. Known backends: {}",
                    KNOWN_BACKENDS.join(", ")
                ),
            )
            .with_extra(json!({ "known": KNOWN_BACKENDS }))),
        };
    }

    let mut ladder: Vec<&dyn SearchProvider> = Vec::new();
    for name in KEYED_BACKENDS {
        if let Some(provider) = providers
            .iter()
            .find(|provider| provider.name() == name && provider.is_available())
        {
            ladder.push(provider.as_ref());
        }
    }
    for name in KEYLESS_BACKENDS {
        if let Some(provider) = providers
            .iter()
            .find(|provider| provider.name() == name && provider.is_keyless_available())
        {
            ladder.push(provider.as_ref());
        }
    }
    if let Some(provider) = providers
        .iter()
        .find(|provider| provider.name() == DEFAULT_BACKEND)
    {
        if !ladder.iter().any(|chosen| chosen.name() == provider.name()) {
            ladder.push(provider.as_ref());
        }
    }
    if ladder.is_empty() {
        return Err(ToolError::new(
            "WEB_BACKEND_MISSING",
            format!(
                "no web search backend is available. Set one of {} (or {}), or configure a search backend in `web.search_backend`. Known backends: {}",
                CREDENTIAL_ENV
                    .iter()
                    .map(|(backend, names)| format!("{backend} via {}", names.join("/")))
                    .collect::<Vec<_>>()
                    .join(", "),
                "a self-hosted SearXNG URL",
                KNOWN_BACKENDS.join(", ")
            ),
        ));
    }
    Ok(ladder)
}

/// A body cut to something a transcript can carry.
fn short(body: &str) -> String {
    let trimmed = body.trim();
    let mut out: String = trimmed.chars().take(MAX_ERROR_DETAIL).collect();
    if trimmed.chars().count() > MAX_ERROR_DETAIL {
        out.push('…');
    }
    out
}

fn ensure_success(backend: &str, response: &HttpResponse) -> Result<(), String> {
    if response.is_success() {
        return Ok(());
    }
    Err(format!(
        "{backend} answered HTTP {}: {}",
        response.status,
        short(&response.body)
    ))
}

fn parse_json(backend: &str, body: &str) -> Result<Value, String> {
    serde_json::from_str(body).map_err(|_| {
        format!("{backend} answered with something that is not JSON")
    })
}

fn text_field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_string()
}

/// One `{title, url, description, position}` row.
///
/// `position` is the rank the model can cite ("the third result"), and it is the
/// only field the vendors do not send.
fn result_row(item: &Value, description_key: &str, position: usize) -> Option<Value> {
    let url = text_field(item, "url");
    if url.is_empty() {
        return None;
    }
    let description = if description_key == "url" {
        String::new()
    } else {
        text_field(item, description_key)
    };
    Some(json!({
        "title": text_field(item, "title"),
        "url": url,
        "description": description,
        "position": position,
    }))
}

fn rows_from_items(items: &[Value], description_key: &str, limit: usize) -> Vec<Value> {
    items
        .iter()
        .enumerate()
        .filter_map(|(index, item)| result_row(item, description_key, index + 1))
        .take(limit)
        .collect()
}

/// `tavily`: `POST /search` with the key in the body, `results[].content` as the
/// description.
struct Tavily {
    api_key: Option<String>,
}

const TAVILY_ENDPOINT: &str = "https://api.tavily.com/search";

impl Tavily {
    fn new(api_key: Option<&str>) -> Self {
        Self {
            api_key: api_key
                .map(str::trim)
                .filter(|key| !key.is_empty())
                .map(str::to_string),
        }
    }
}

impl SearchProvider for Tavily {
    fn name(&self) -> &'static str {
        "tavily"
    }

    fn is_available(&self) -> bool {
        self.api_key.is_some()
    }

    fn is_keyless_available(&self) -> bool {
        false
    }

    fn search<'a>(
        &'a self,
        request: &'a SearchRequest,
        http: &'a dyn HttpTransport,
    ) -> WebFuture<'a, Result<Vec<Value>, String>> {
        Box::pin(async move {
            let key = self
                .api_key
                .as_deref()
                .ok_or_else(|| "TAVILY_API_KEY is not set".to_string())?;
            let body = json!({
                "api_key": key,
                "query": request.query,
                "max_results": request.limit,
                "search_depth": "basic",
                "include_answer": false,
                "include_raw_content": false,
            });
            let response = http
                .send(&HttpRequest::post_json(TAVILY_ENDPOINT, body))
                .await?;
            ensure_success("tavily", &response)?;
            let parsed = parse_json("tavily", &response.body)?;
            let items = parsed
                .get("results")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or_default();
            Ok(rows_from_items(items, "content", request.limit))
        })
    }
}

/// `searxng`: a self-hosted instance, `GET /search?format=json`.
struct Searxng {
    base: Option<String>,
}

impl Searxng {
    fn new(base: Option<&str>) -> Self {
        Self {
            base: base
                .map(str::trim)
                .filter(|url| !url.is_empty())
                .map(|url| url.trim_end_matches('/').to_string()),
        }
    }
}

impl SearchProvider for Searxng {
    fn name(&self) -> &'static str {
        "searxng"
    }

    fn is_available(&self) -> bool {
        self.base.is_some()
    }

    fn is_keyless_available(&self) -> bool {
        false
    }

    fn search<'a>(
        &'a self,
        request: &'a SearchRequest,
        http: &'a dyn HttpTransport,
    ) -> WebFuture<'a, Result<Vec<Value>, String>> {
        Box::pin(async move {
            let base = self
                .base
                .as_deref()
                .ok_or_else(|| "SEARXNG_URL is not set".to_string())?;
            let url = format!(
                "{base}/search?q={}&format=json&safesearch=0",
                encode_query(&request.query)
            );
            let response = http.send(&HttpRequest::get(url)).await?;
            ensure_success("searxng", &response)?;
            let parsed = parse_json("searxng", &response.body)?;
            let items = parsed
                .get("results")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or_default();
            Ok(rows_from_items(items, "content", request.limit))
        })
    }
}

/// `brave-free`: Brave's free web-search tier, key in a header.
struct BraveFree {
    api_key: Option<String>,
}

const BRAVE_ENDPOINT: &str = "https://api.search.brave.com/res/v1/web/search";

impl BraveFree {
    fn new(api_key: Option<&str>) -> Self {
        Self {
            api_key: api_key
                .map(str::trim)
                .filter(|key| !key.is_empty())
                .map(str::to_string),
        }
    }
}

impl SearchProvider for BraveFree {
    fn name(&self) -> &'static str {
        "brave-free"
    }

    fn is_available(&self) -> bool {
        self.api_key.is_some()
    }

    fn is_keyless_available(&self) -> bool {
        false
    }

    fn search<'a>(
        &'a self,
        request: &'a SearchRequest,
        http: &'a dyn HttpTransport,
    ) -> WebFuture<'a, Result<Vec<Value>, String>> {
        Box::pin(async move {
            let key = self
                .api_key
                .as_deref()
                .ok_or_else(|| "BRAVE_API_KEY is not set".to_string())?;
            let url = format!(
                "{BRAVE_ENDPOINT}?q={}&count={}",
                encode_query(&request.query),
                request.limit
            );
            let response = http
                .send(
                    &HttpRequest::get(url)
                        .header("accept", "application/json")
                        .header("x-subscription-token", key),
                )
                .await?;
            ensure_success("brave-free", &response)?;
            let parsed = parse_json("brave-free", &response.body)?;
            let items = parsed
                .get("web")
                .and_then(|web| web.get("results"))
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or_default();
            Ok(rows_from_items(items, "description", request.limit))
        })
    }
}

/// `bing`: keyless, `https://cn.bing.com/search`, results in `li.b_algo`.
///
/// Keyless because this is the backend the reference note measured as reachable
/// where `html.duckduckgo.com` is not; it leads the keyless tier for that reason.
struct Bing {
    endpoint: String,
}

const BING_ENDPOINT: &str = "https://cn.bing.com/search";

/// Bing answers a script-only shell to a client it does not recognise, so this
/// one request identifies as a browser. It is the price of a keyless backend, and
/// it is scoped to this provider rather than to every request.
const BROWSER_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
     (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

impl Bing {
    fn new() -> Self {
        Self {
            endpoint: BING_ENDPOINT.to_string(),
        }
    }
}

impl SearchProvider for Bing {
    fn name(&self) -> &'static str {
        "bing"
    }

    fn is_available(&self) -> bool {
        false
    }

    fn is_keyless_available(&self) -> bool {
        true
    }

    fn search<'a>(
        &'a self,
        request: &'a SearchRequest,
        http: &'a dyn HttpTransport,
    ) -> WebFuture<'a, Result<Vec<Value>, String>> {
        Box::pin(async move {
            let url = format!("{}?q={}", self.endpoint, encode_query(&request.query));
            let response = http
                .send(
                    &HttpRequest::get(url)
                        .header("accept", "text/html")
                        .header("accept-language", "zh-CN,zh;q=0.9,en;q=0.8")
                        .header("user-agent", BROWSER_USER_AGENT),
                )
                .await?;
            ensure_success("bing", &response)?;
            let rows = parse_bing(&response.body, request.limit);
            if rows.is_empty() {
                return Err(
                    "bing answered without any parsed result (its markup may have changed); \
                     set a search backend key such as TAVILY_API_KEY to use a supported backend"
                        .to_string(),
                );
            }
            Ok(rows)
        })
    }
}

/// `ddgs`: DuckDuckGo's HTML endpoint, keyless. Kept because it is the reference's
/// default, and because a network that allows it should not have to configure
/// anything.
struct DuckDuckGo;

const DDGS_ENDPOINT: &str = "https://html.duckduckgo.com/html/";

impl DuckDuckGo {
    fn new() -> Self {
        Self
    }
}

impl SearchProvider for DuckDuckGo {
    fn name(&self) -> &'static str {
        "ddgs"
    }

    fn is_available(&self) -> bool {
        false
    }

    fn is_keyless_available(&self) -> bool {
        true
    }

    fn search<'a>(
        &'a self,
        request: &'a SearchRequest,
        http: &'a dyn HttpTransport,
    ) -> WebFuture<'a, Result<Vec<Value>, String>> {
        Box::pin(async move {
            let url = format!("{DDGS_ENDPOINT}?q={}", encode_query(&request.query));
            let response = http
                .send(&HttpRequest::get(url).header("user-agent", BROWSER_USER_AGENT))
                .await?;
            ensure_success("ddgs", &response)?;
            let rows = parse_ddgs(&response.body, request.limit);
            if rows.is_empty() {
                return Err("ddgs answered without any parsed result".to_string());
            }
            Ok(rows)
        })
    }
}

// ---------------------------------------------------------------------------
// HTML parsing helpers (no DOM crate in this host: the markers are the contract)
// ---------------------------------------------------------------------------

/// Percent-encode everything but the unreserved set, so a query keeps its meaning
/// on the wire without a `url` dependency.
fn encode_query(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).unwrap_or_default();
            if let Ok(byte) = u8::from_str_radix(hex, 16) {
                out.push(byte);
                index += 3;
                continue;
            }
        }
        if bytes[index] == b'+' {
            out.push(b' ');
        } else {
            out.push(bytes[index]);
        }
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The value of `name="…"` inside one tag, case-insensitively.
fn attribute(tag: &str, name: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let needle = format!("{name}=");
    let mut from = 0;
    while let Some(found) = lower[from..].find(&needle) {
        let start = from + found;
        // `data-href=` must not answer for `href=`: the character before the name
        // has to be whitespace or the tag's own `<`.
        let preceded = start == 0
            || matches!(
                lower.as_bytes()[start - 1],
                b' ' | b'\t' | b'\n' | b'\r' | b'<'
            );
        if preceded {
            let value_at = start + needle.len();
            let rest = &tag[value_at..];
            let (quote, body) = match rest.chars().next() {
                Some('"') => ('"', &rest[1..]),
                Some('\'') => ('\'', &rest[1..]),
                _ => return Some(rest.split([' ', '>']).next().unwrap_or_default().to_string()),
            };
            let end = body.find(quote)?;
            return Some(decode_entities(&body[..end]));
        }
        from = start + needle.len();
    }
    None
}

/// Entity decoding for an attribute value, which has no tags to strip: reuse the
/// text cleaner on a one-token string.
fn decode_entities(text: &str) -> String {
    html_to_text(text)
}

/// The first `<a href>` in a fragment, with its link text.
fn first_anchor(html: &str) -> Option<(String, String)> {
    let lower = html.to_ascii_lowercase();
    let mut from = 0;
    while let Some(found) = lower[from..].find("<a") {
        let start = from + found;
        let after = lower[start + 2..].chars().next();
        let is_tag = matches!(after, Some(' ') | Some('\t') | Some('\n') | Some('\r') | Some('>'));
        if !is_tag {
            from = start + 2;
            continue;
        }
        let open_end = start + lower[start..].find('>')?;
        let tag = &html[start..=open_end];
        let Some(href) = attribute(tag, "href") else {
            from = open_end + 1;
            continue;
        };
        let text_start = open_end + 1;
        let text_end = lower[text_start..]
            .find("</a")
            .map(|offset| text_start + offset)
            .unwrap_or(text_start);
        let title = html_to_text(&html[text_start..text_end]);
        return Some((href, title));
    }
    None
}

/// The first `<p>…</p>` after `from`, as text.
fn first_paragraph(html: &str, from: usize) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let mut cursor = from;
    while let Some(found) = lower[cursor..].find("<p") {
        let start = cursor + found;
        let open_end = start + lower[start..].find('>')?;
        let close = lower[open_end..].find("</p").map(|offset| open_end + offset)?;
        let text = html_to_text(&html[open_end + 1..close]);
        if !text.is_empty() {
            return Some(text);
        }
        cursor = close + 3;
    }
    None
}

/// Whether a result URL is the search engine itself. A site-internal link is
/// navigation, not a result, and the reference drops them for the same reason.
fn is_search_engine_link(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.contains("://cn.bing.com/")
        || lower.contains("://www.bing.com/")
        || lower.contains("://bing.com/")
        || lower.contains("://duckduckgo.com/")
        || lower.contains("://html.duckduckgo.com/")
}

/// Bing wraps result links in a click tracker (`/ck/a?…&u=a1<base64url>`). The
/// real target is in `u`, and an undecoded wrapper is a URL the model cannot cite.
fn bing_target(href: &str) -> String {
    let Some(index) = href.find("u=a1") else {
        return href.to_string();
    };
    let payload = href[index + 4..]
        .split('&')
        .next()
        .unwrap_or_default()
        .split('"')
        .next()
        .unwrap_or_default();
    match decode_base64url(payload) {
        Some(decoded) if decoded.starts_with("http") => decoded,
        _ => href.to_string(),
    }
}

fn decode_base64url(text: &str) -> Option<String> {
    use base64::Engine as _;
    let trimmed = text.trim_end_matches('=');
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(trimmed)
        .or_else(|_| base64::engine::general_purpose::STANDARD_NO_PAD.decode(trimmed))
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
}

/// `li.b_algo` blocks, each with an `h2 > a` title link and a first paragraph.
fn parse_bing(html: &str, limit: usize) -> Vec<Value> {
    let mut rows = Vec::new();
    // Splitting on the marker means each piece ends where the next result starts,
    // so a paragraph from the next result cannot be mistaken for this one's.
    for piece in html.split("b_algo").skip(1) {
        if rows.len() >= limit {
            break;
        }
        let lower = piece.to_ascii_lowercase();
        // The title lives in the `h2`; a `b_algo` block without one is decoration.
        let Some(heading) = lower.find("<h2") else {
            continue;
        };
        let Some((href, title)) = first_anchor(&piece[heading..]) else {
            continue;
        };
        if title.is_empty() {
            continue;
        }
        let target = bing_target(&href);
        if is_search_engine_link(&target) {
            continue;
        }
        let description = first_paragraph(piece, 0).unwrap_or_default();
        rows.push(json!({
            "title": title,
            "url": target,
            "description": description,
            "position": rows.len() + 1,
        }));
    }
    rows
}

/// `a.result__a` links plus `a.result__snippet` text.
///
/// Unlike Bing's blocks, DuckDuckGo's markup gives no result boundary to split
/// on, so each hit is walked from its own marker: back to the `<a` that carries
/// it, forward through its text, then to the snippet that follows.
fn parse_ddgs(html: &str, limit: usize) -> Vec<Value> {
    let lower = html.to_ascii_lowercase();
    let mut rows: Vec<Value> = Vec::new();
    let mut cursor = 0usize;
    while rows.len() < limit {
        let Some(found) = lower[cursor..].find("result__a") else {
            break;
        };
        let marker = cursor + found;
        let next = marker + "result__a".len();
        // The class attribute sits inside the anchor, so the tag opened earlier.
        let Some(open) = lower[cursor..marker].rfind("<a") else {
            cursor = next;
            continue;
        };
        let open = cursor + open;
        let Some(close) = lower[open..].find('>') else {
            break;
        };
        let tag = &html[open..open + close + 1];
        let Some(href) = attribute(tag, "href") else {
            cursor = next;
            continue;
        };
        let text_start = open + close + 1;
        let text_end = lower[text_start..]
            .find("</a")
            .map(|offset| text_start + offset)
            .unwrap_or(text_start);
        let title = html_to_text(&html[text_start..text_end]);
        let target = match href.split("uddg=").nth(1) {
            // The real target is percent-encoded inside the redirect wrapper.
            Some(encoded) => percent_decode(encoded.split('&').next().unwrap_or_default()),
            None => href.clone(),
        };
        let description = lower[text_end..]
            .find("result__snippet")
            .and_then(|offset| anchor_text(html, &lower, text_end + offset))
            .unwrap_or_default();
        cursor = text_end.max(next);
        if title.is_empty() || !target.starts_with("http") || is_search_engine_link(&target) {
            continue;
        }
        rows.push(json!({
            "title": title,
            "url": target,
            "description": description,
            "position": rows.len() + 1,
        }));
    }
    rows
}

/// The text of the anchor that carries `marker` (used for DuckDuckGo's snippet,
/// which is an `<a>` rather than a paragraph).
fn anchor_text(html: &str, lower: &str, marker: usize) -> Option<String> {
    let open_end = marker + lower[marker..].find('>')?;
    let close = lower[open_end..].find("</a").map(|offset| open_end + offset)?;
    let text = html_to_text(&html[open_end + 1..close]);
    (!text.is_empty()).then_some(text)
}

// ---------------------------------------------------------------------------
// `WebSearch`
// ---------------------------------------------------------------------------

fn require_str(args: &Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// A count argument from either spelling, tolerating a numeric string for the
/// same reason the other tools do: a model that read the schema loosely sends
/// `"5"`, and nothing is gained by failing it.
fn number_argument(args: &Value, keys: &[&str]) -> Result<Option<i64>, ToolError> {
    for key in keys {
        let Some(value) = args.get(*key) else {
            continue;
        };
        match value {
            Value::Number(number) => {
                return Ok(number.as_i64());
            }
            Value::String(text) => {
                return text.trim().parse::<i64>().map(Some).map_err(|_| {
                    ToolError::new(
                        "INVALID_ARGUMENT",
                        format!("`{key}` must be a number, not `{text}`"),
                    )
                });
            }
            Value::Null => continue,
            other => {
                return Err(ToolError::new(
                    "INVALID_ARGUMENT",
                    format!("`{key}` must be a number, not `{other}`"),
                ));
            }
        }
    }
    Ok(None)
}

/// Read the caller's search. `query` is required; `limit` defaults to
/// [`DEFAULT_SEARCH_LIMIT`] and is clamped rather than refused, because a model
/// asking for 50 results wants "as many as you can" and a refusal teaches it
/// nothing.
pub fn parse_search_request(args: &Value) -> Result<SearchRequest, ToolError> {
    let query = require_str(args, "query").ok_or_else(|| {
        ToolError::new("INVALID_ARGUMENT", "`query` is required and must not be empty")
    })?;
    let limit = match number_argument(args, &["limit", "max_results", "maxResults"])? {
        None | Some(0) => DEFAULT_SEARCH_LIMIT,
        Some(requested) if requested < 0 => {
            return Err(ToolError::new(
                "INVALID_ARGUMENT",
                format!("`limit` must be positive, not {requested}"),
            ));
        }
        Some(requested) => (requested as usize).min(MAX_SEARCH_LIMIT),
    };
    Ok(SearchRequest { query, limit })
}

/// Run one search down the ladder.
///
/// A strict pin yields a one-entry ladder, so "no fallback" needs no second
/// branch here: the loop simply has nowhere else to go. A failure that exhausted
/// the ladder names every backend it tried and the reason each gave — never
/// "network error", which would hide that a key is missing or a parser broke.
pub async fn search(
    args: &Value,
    config: &WebConfig,
    transport: &dyn HttpTransport,
) -> Result<Value, ToolError> {
    let request = parse_search_request(args)?;
    let providers = catalog(config);
    let ladder = search_ladder(config, &providers)?;

    let mut failures: Vec<String> = Vec::new();
    for provider in &ladder {
        tracing::info!("[web] search backend = {}", provider.name());
        match provider.search(&request, transport).await {
            Ok(rows) => {
                return Ok(json!({ "success": true, "data": { "web": rows } }));
            }
            Err(error) => {
                tracing::warn!("[web] search backend {} failed: {error}", provider.name());
                failures.push(format!("{}: {error}", provider.name()));
            }
        }
    }

    let message = match (failures.len(), config.search_pin()) {
        // A pin fails as a pin: the key that named it is part of the diagnosis,
        // because the fix is to change that key, not to retry.
        (1, Some(pin)) => {
            let key = if config.search_backend.as_deref().map(str::trim) == Some(pin) {
                "web.search_backend"
            } else {
                "web.backend"
            };
            let detail = failures[0]
                .split_once(": ")
                .map(|(_, rest)| rest)
                .unwrap_or(failures[0].as_str());
            format!(
                "web search failed via {pin}: {detail} (`{key}` pins {pin}, so no other backend was tried)"
            )
        }
        _ => format!(
            "web search failed via every available backend: {}",
            failures.join("; ")
        ),
    };
    Err(ToolError::new("WEB_SEARCH_FAILED", message)
        .with_extra(json!({ "tried": failures })))
}

// ---------------------------------------------------------------------------
// `WebExtract`
// ---------------------------------------------------------------------------

/// The caller's fetch, already validated.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtractRequest {
    pub urls: Vec<String>,
    pub max_chars: usize,
}

/// Read the caller's fetch. `urls` is required and capped:
/// [`MAX_EXTRACT_URLS`] is a refusal, not a silent slice.
pub fn parse_extract_request(args: &Value) -> Result<ExtractRequest, ToolError> {
    let urls: Vec<String> = match args.get("urls").or_else(|| args.get("url")) {
        Some(Value::String(url)) => vec![url.trim().to_string()],
        Some(Value::Array(entries)) => {
            let mut urls = Vec::with_capacity(entries.len());
            for (index, entry) in entries.iter().enumerate() {
                let Some(url) = entry.as_str().map(str::trim).filter(|url| !url.is_empty()) else {
                    return Err(ToolError::new(
                        "INVALID_ARGUMENT",
                        format!("`urls[{index}]` must be a non-empty string"),
                    ));
                };
                urls.push(url.to_string());
            }
            urls
        }
        Some(other) => {
            return Err(ToolError::new(
                "INVALID_ARGUMENT",
                format!("`urls` must be an array of strings, not `{other}`"),
            ));
        }
        None => {
            return Err(ToolError::new(
                "INVALID_ARGUMENT",
                "`urls` is required (an array of http(s) URLs)",
            ));
        }
    };
    if urls.is_empty() {
        return Err(ToolError::new(
            "INVALID_ARGUMENT",
            "`urls` needs at least one URL",
        ));
    }
    if urls.len() > MAX_EXTRACT_URLS {
        return Err(ToolError::new(
            "TOO_MANY_URLS",
            format!(
                "at most {MAX_EXTRACT_URLS} URLs per call, got {}; split the batch",
                urls.len()
            ),
        ));
    }
    let max_chars = match number_argument(args, &["max_chars", "maxChars", "max_length"])? {
        None | Some(0) => DEFAULT_EXTRACT_CHARS,
        Some(requested) if requested < 0 => {
            return Err(ToolError::new(
                "INVALID_ARGUMENT",
                format!("`max_chars` must be positive, not {requested}"),
            ));
        }
        Some(requested) => (requested as usize).clamp(500, MAX_EXTRACT_CHARS),
    };
    Ok(ExtractRequest { urls, max_chars })
}

/// One fetched page, cut to the budget.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Page {
    content: String,
    truncated: bool,
}

fn budget(text: &str, max_chars: usize) -> Page {
    let total = text.chars().count();
    if total <= max_chars {
        return Page {
            content: text.to_string(),
            truncated: false,
        };
    }
    let head: String = text.chars().take(max_chars).collect();
    Page {
        content: format!("{head}\n…[truncated: {total} characters, budget {max_chars}]"),
        truncated: true,
    }
}

/// Fetch and clean one URL.
///
/// The gate runs first, so a private address costs one refusal and no request.
async fn fetch_page(
    url: &str,
    max_chars: usize,
    transport: &dyn HttpTransport,
) -> Result<Page, ToolError> {
    let target = validate_public_url(url)?;
    let request = HttpRequest::get(target.url.clone())
        .header("accept", "text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.8")
        .header("accept-language", "zh-CN,zh;q=0.9,en;q=0.8");
    let response = transport.send(&request).await.map_err(|error| {
        ToolError::new(
            "WEB_FETCH_FAILED",
            format!("the request to `{url}` failed: {error}"),
        )
    })?;
    if !response.is_success() {
        return Err(ToolError::new(
            "WEB_HTTP_STATUS",
            format!("`{url}` answered HTTP {}", response.status),
        )
        .with_extra(json!({ "status": response.status })));
    }
    let content_type = response
        .content_type
        .as_deref()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let text = if content_type.is_empty() || content_type.contains("html") {
        html_to_text(&response.body)
    } else if content_type.starts_with("text/")
        || content_type.contains("json")
        || content_type.contains("xml")
    {
        response.body.trim().to_string()
    } else {
        return Err(ToolError::new(
            "WEB_UNSUPPORTED_CONTENT",
            format!("`{url}` served `{content_type}`, which is not text; use BrowserExec for a rendered page"),
        ));
    };
    if text.is_empty() {
        return Err(ToolError::new(
            "WEB_EMPTY",
            format!("`{url}` had no readable text"),
        ));
    }
    Ok(budget(&text, max_chars))
}

/// Fetch each URL, reporting failures per URL.
///
/// A batch is all-or-nothing only for the *arguments*: once it is running, one
/// unreachable host, one 404 and one PDF become three error entries beside the
/// pages that did arrive.
pub async fn extract(args: &Value, transport: &dyn HttpTransport) -> Result<Value, ToolError> {
    let request = parse_extract_request(args)?;
    let mut results = Vec::with_capacity(request.urls.len());
    for url in &request.urls {
        match fetch_page(url, request.max_chars, transport).await {
            Ok(page) => results.push(json!({
                "url": url,
                "content": page.content,
                "truncated": page.truncated,
            })),
            Err(error) => results.push(json!({
                "url": url,
                "error": error.message,
                "code": error.code,
            })),
        }
    }
    Ok(json!({ "results": results }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::Mutex;

    /// A transport that answers from a script and records what it was asked.
    struct FakeTransport {
        replies: Mutex<VecDeque<Result<HttpResponse, String>>>,
        requests: Mutex<Vec<HttpRequest>>,
    }

    impl FakeTransport {
        fn new(replies: Vec<Result<HttpResponse, String>>) -> Self {
            Self {
                replies: Mutex::new(replies.into()),
                requests: Mutex::new(Vec::new()),
            }
        }

        fn html(body: &str) -> Result<HttpResponse, String> {
            Ok(HttpResponse::new(
                200,
                Some("text/html; charset=utf-8"),
                body.to_string(),
            ))
        }

        fn json(body: Value) -> Result<HttpResponse, String> {
            Ok(HttpResponse::new(
                200,
                Some("application/json"),
                body.to_string(),
            ))
        }

        fn status(status: u16) -> Result<HttpResponse, String> {
            Ok(HttpResponse::new(status, Some("text/html"), "no"))
        }

        fn requests(&self) -> Vec<HttpRequest> {
            self.requests.lock().expect("requests").clone()
        }
    }

    impl HttpTransport for FakeTransport {
        fn send<'a>(
            &'a self,
            request: &'a HttpRequest,
        ) -> WebFuture<'a, Result<HttpResponse, String>> {
            Box::pin(async move {
                self.requests
                    .lock()
                    .expect("requests")
                    .push(request.clone());
                self.replies
                    .lock()
                    .expect("replies")
                    .pop_front()
                    .unwrap_or_else(|| Err("no reply scripted for this request".to_string()))
            })
        }
    }

    const BING_HTML: &str = r#"<html><body>
        <li class="b_algo"><h2><a href="https://example.org/one">One - Example</a></h2>
            <p>The first result.</p></li>
        <li class="b_algo"><h2><a href="/ck/a?u=a1aHR0cHM6Ly9leGFtcGxlLm9yZy90d28">Two - Example</a></h2>
            <p>The second result.</p></li>
        <li class="b_algo"><h2><a href="https://cn.bing.com/images">Bing images</a></h2>
            <p>Site navigation.</p></li>
    </body></html>"#;

    fn keyless_config() -> WebConfig {
        WebConfig::default()
    }

    fn names(ladder: &[&dyn SearchProvider]) -> Vec<&'static str> {
        ladder.iter().map(|provider| provider.name()).collect()
    }

    /// The reference's cost default, and the shape the model cites from.
    #[tokio::test]
    async fn a_keyless_search_answers_three_rows_in_the_documented_shape() {
        let transport = FakeTransport::new(vec![FakeTransport::html(BING_HTML)]);
        let value = search(&json!({ "query": "example" }), &keyless_config(), &transport)
            .await
            .expect("a search");
        let rows = value["data"]["web"].as_array().expect("web rows").clone();
        // Three requested by default; the site-internal link is dropped, so two
        // real results are left.
        assert_eq!(rows.len(), 2, "{value}");
        assert_eq!(value["success"], true);
        assert_eq!(rows[1]["url"], "https://example.org/two");
        assert_eq!(rows[0]["position"], 1);
        assert_eq!(rows[0]["title"], "One - Example");
        assert_eq!(rows[0]["description"], "The first result.");
        // No credential, so the keyless tier answered — and it was asked first.
        let requests = transport.requests();
        assert_eq!(requests.len(), 1);
        assert!(requests[0].url.starts_with("https://cn.bing.com/search?q=example"));
    }

    /// A pin is strict: one backend, its own failure, no fallback.
    #[tokio::test]
    async fn a_pin_tries_only_the_backend_it_names() {
        let config = WebConfig {
            search_backend: Some("bing".into()),
            ..WebConfig::default()
        };
        // One reply scripted: a second attempt would fail with "no reply", which
        // the assertion on the message would surface.
        let transport = FakeTransport::new(vec![FakeTransport::status(503)]);
        let error = search(&json!({ "query": "x" }), &config, &transport)
            .await
            .expect_err("a failure");
        assert_eq!(error.code, "WEB_SEARCH_FAILED");
        assert!(error.message.contains("via bing"), "{}", error.message);
        assert!(
            error.message.contains("no other backend was tried"),
            "{}",
            error.message
        );
        assert_eq!(transport.requests().len(), 1);
    }

    /// A pin naming nothing real lists the backends that do exist — the model can
    /// act on that, unlike "search failed".
    #[tokio::test]
    async fn an_unknown_pin_lists_the_known_backends() {
        let config = WebConfig {
            search_backend: Some("google".into()),
            ..WebConfig::default()
        };
        let transport = FakeTransport::new(vec![]);
        let error = search(&json!({ "query": "x" }), &config, &transport)
            .await
            .expect_err("a failure");
        assert_eq!(error.code, "WEB_BACKEND_UNKNOWN");
        assert!(error.message.contains("`google`"), "{}", error.message);
        for known in KNOWN_BACKENDS {
            assert!(error.message.contains(known), "{known}: {}", error.message);
        }
        assert!(transport.requests().is_empty());
    }

    /// Every backend that was tried is named with its own reason; the failure is
    /// never flattened into "network error".
    #[tokio::test]
    async fn an_exhausted_ladder_reports_every_backend_it_tried() {
        let mut config = WebConfig::default();
        config.credentials.insert("tavily".into(), "k".into());
        let transport = FakeTransport::new(vec![
            FakeTransport::status(401),
            Err("could not resolve host".to_string()),
        ]);
        let error = search(&json!({ "query": "x" }), &config, &transport)
            .await
            .expect_err("a failure");
        assert_eq!(error.code, "WEB_SEARCH_FAILED");
        assert!(error.message.contains("tavily:"), "{}", error.message);
        assert!(error.message.contains("bing:"), "{}", error.message);
        // The keyed tier is tried before the keyless one.
        let requests = transport.requests();
        assert_eq!(requests[0].url, TAVILY_ENDPOINT);
        assert!(requests[1].url.starts_with(BING_ENDPOINT));
    }

    #[test]
    fn the_ladder_follows_the_reference_order() {
        let empty = catalog(&WebConfig::default());
        let keyless = search_ladder(&WebConfig::default(), &empty).expect("a ladder");
        assert_eq!(names(&keyless), vec!["bing", "ddgs"]);

        let mut config = WebConfig::default();
        for backend in ["brave-free", "tavily", "searxng"] {
            config.credentials.insert(backend.into(), "value".into());
        }
        let configured = catalog(&config);
        let ladder = search_ladder(&config, &configured).expect("a ladder");
        assert_eq!(
            names(&ladder),
            vec!["tavily", "searxng", "brave-free", "bing", "ddgs"]
        );
    }

    /// The shared pin is honoured, and the single-capability pin beats it.
    #[test]
    fn the_search_pin_beats_the_shared_pin() {
        let catalog_all = catalog(&WebConfig::default());
        let shared = WebConfig {
            search_backend: None,
            backend: Some("ddgs".into()),
            credentials: BTreeMap::new(),
        };
        assert_eq!(
            names(&search_ladder(&shared, &catalog_all).expect("a ladder")),
            vec!["ddgs"]
        );
        let both = WebConfig {
            search_backend: Some("bing".into()),
            backend: Some("ddgs".into()),
            credentials: BTreeMap::new(),
        };
        assert_eq!(
            names(&search_ladder(&both, &catalog_all).expect("a ladder")),
            vec!["bing"]
        );
    }

    /// Both spellings of the settings keys are read: a flat document keeps
    /// `web.search_backend`, a nested one keeps `web: { searchBackend }`.
    #[test]
    fn settings_read_the_nested_block_and_the_dotted_keys() {
        let nested = json!({
            "web": {
                "searchBackend": "tavily",
                "backend": "bing",
                "tavily_api_key": "t-key",
                "searxng_url": "https://searx.example.test"
            }
        });
        let config = WebConfig::from_settings(Some(&nested));
        assert_eq!(config.search_backend.as_deref(), Some("tavily"));
        assert_eq!(config.backend.as_deref(), Some("bing"));
        assert_eq!(config.credential("tavily"), Some("t-key"));
        assert_eq!(config.credential("searxng"), Some("https://searx.example.test"));

        let flat = json!({
            "web.search_backend": "brave-free",
            "web.backend": "ddgs",
            "web.brave_api_key": "b-key"
        });
        let config = WebConfig::from_settings(Some(&flat));
        assert_eq!(config.search_backend.as_deref(), Some("brave-free"));
        assert_eq!(config.backend.as_deref(), Some("ddgs"));
        assert_eq!(config.credential("brave-free"), Some("b-key"));

        assert_eq!(WebConfig::from_settings(None), WebConfig::default());
    }

    /// The environment wins over stored settings: a harness can pin a backend
    /// without editing the user's configuration.
    #[test]
    fn the_environment_overrides_the_stored_settings() {
        let settings = json!({ "web": { "searchBackend": "tavily" } });
        let env = WebConfig {
            search_backend: Some("bing".into()),
            backend: None,
            credentials: BTreeMap::new(),
        };
        let merged = WebConfig::merged(Some(&settings), env);
        assert_eq!(merged.search_backend.as_deref(), Some("bing"));
    }

    /// The gate is the point: no request is made for anything internal.
    #[test]
    fn the_ssrf_gate_refuses_internal_targets_before_any_request() {
        let refused = [
            "http://127.0.0.1/",
            "http://127.1.2.3:8080/x",
            "http://localhost:3000/",
            "http://app.localhost/",
            "http://10.0.0.5/",
            "http://172.20.1.1/",
            "http://192.168.1.1/",
            "http://169.254.169.254/latest/meta-data/",
            "http://100.100.100.200/latest/meta-data/",
            "http://0.0.0.0/",
            "http://[::1]/",
            "http://[fd00::1]/",
            "http://metadata.google.internal/computeMetadata/v1/",
            "http://intranet/",
            "ftp://example.com/file",
            "file:///C:/Windows/win.ini",
            "data:text/html,<b>x</b>",
            "https://user:pass@example.com/",
            "https://exa mple.com/",
        ];
        for url in refused {
            assert!(
                validate_public_url(url).is_err(),
                "{url} should have been refused"
            );
        }
        for url in [
            "https://cn.bing.com/search?q=x",
            "http://example.org/a?b=c#d",
            "https://8.8.8.8/",
            "https://[2606:4700::1111]/",
        ] {
            assert!(validate_public_url(url).is_ok(), "{url} should be allowed");
        }
    }

    /// One bad URL does not fail the batch, and it is refused before the request.
    #[tokio::test]
    async fn extract_reports_a_bad_url_beside_the_page_that_arrived() {
        let transport = FakeTransport::new(vec![FakeTransport::html(
            "<html><body><h1>Title</h1><p>Body text.</p></body></html>",
        )]);
        let value = extract(
            &json!({ "urls": ["http://127.0.0.1/admin", "https://example.org/page"] }),
            &transport,
        )
        .await
        .expect("a result");
        let results = value["results"].as_array().expect("results");
        assert_eq!(results.len(), 2);
        assert_eq!(results[0]["code"], "URL_NOT_ALLOWED");
        assert!(results[0]["error"].as_str().unwrap().contains("127.0.0.1"));
        assert!(results[1]["content"].as_str().unwrap().contains("Body text."));
        assert!(results[1].get("error").is_none());
        // Only the allowed URL was requested.
        assert_eq!(transport.requests().len(), 1);
        assert_eq!(transport.requests()[0].url, "https://example.org/page");
    }

    #[test]
    fn a_batch_is_capped_at_five_urls_and_refused_above_it() {
        let five: Vec<String> = (0..5).map(|index| format!("https://e{index}.example")).collect();
        assert!(parse_extract_request(&json!({ "urls": five })).is_ok());
        let six: Vec<String> = (0..6).map(|index| format!("https://e{index}.example")).collect();
        let error = parse_extract_request(&json!({ "urls": six })).expect_err("too many");
        assert_eq!(error.code, "TOO_MANY_URLS");
        assert_eq!(
            parse_extract_request(&json!({ "urls": [] }))
                .expect_err("empty")
                .code,
            "INVALID_ARGUMENT"
        );
        assert_eq!(
            parse_extract_request(&json!({}))
                .expect_err("missing")
                .code,
            "INVALID_ARGUMENT"
        );
    }

    /// The budget is a truncation with a visible marker, not a silent cut.
    #[tokio::test]
    async fn extract_truncates_to_its_budget_and_says_so() {
        let long = format!("<p>{}</p>", "字".repeat(2_000));
        let transport = FakeTransport::new(vec![FakeTransport::html(&long)]);
        let value = extract(
            &json!({ "urls": ["https://example.org/long"], "max_chars": 500 }),
            &transport,
        )
        .await
        .expect("a result");
        let page = &value["results"][0];
        assert_eq!(page["truncated"], true);
        let content = page["content"].as_str().unwrap();
        assert!(content.contains("[truncated: 2000 characters, budget 500]"), "{content}");
        assert_eq!(content.chars().filter(|ch| *ch == '字').count(), 500);
    }

    #[tokio::test]
    async fn extract_reports_a_status_and_an_unsupported_type_per_url() {
        let transport = FakeTransport::new(vec![
            FakeTransport::status(404),
            Ok(HttpResponse::new(200, Some("application/pdf"), "%PDF-1.7")),
        ]);
        let value = extract(
            &json!({ "urls": ["https://example.org/missing", "https://example.org/paper.pdf"] }),
            &transport,
        )
        .await
        .expect("a result");
        let results = value["results"].as_array().unwrap();
        assert_eq!(results[0]["code"], "WEB_HTTP_STATUS");
        assert!(results[0]["error"].as_str().unwrap().contains("404"));
        assert_eq!(results[1]["code"], "WEB_UNSUPPORTED_CONTENT");
    }

    #[test]
    fn a_search_limit_is_clamped_and_a_zero_means_the_default() {
        assert_eq!(
            parse_search_request(&json!({ "query": "q" })).unwrap().limit,
            DEFAULT_SEARCH_LIMIT
        );
        assert_eq!(
            parse_search_request(&json!({ "query": "q", "limit": 0 }))
                .unwrap()
                .limit,
            DEFAULT_SEARCH_LIMIT
        );
        assert_eq!(
            parse_search_request(&json!({ "query": "q", "limit": 9 }))
                .unwrap()
                .limit,
            9
        );
        assert_eq!(
            parse_search_request(&json!({ "query": "q", "limit": "500" }))
                .unwrap()
                .limit,
            MAX_SEARCH_LIMIT
        );
        assert_eq!(
            parse_search_request(&json!({ "query": "q", "limit": -1 }))
                .expect_err("negative")
                .code,
            "INVALID_ARGUMENT"
        );
        assert_eq!(
            parse_search_request(&json!({ "query": "  " }))
                .expect_err("empty")
                .code,
            "INVALID_ARGUMENT"
        );
    }

    /// A keyed backend is asked before the keyless tier, and it receives the key.
    #[tokio::test]
    async fn a_key_selects_its_backend_and_is_sent_with_the_request() {
        let mut config = WebConfig::default();
        config.credentials.insert("tavily".into(), "t-key".into());
        let transport = FakeTransport::new(vec![FakeTransport::json(json!({
            "results": [
                { "title": "A", "url": "https://a.example", "content": "alpha" },
                { "title": "B", "url": "https://b.example", "content": "beta" }
            ]
        }))]);
        let value = search(&json!({ "query": "q" }), &config, &transport)
            .await
            .expect("a search");
        assert_eq!(value["data"]["web"].as_array().unwrap().len(), 2);
        let request = &transport.requests()[0];
        assert_eq!(request.url, TAVILY_ENDPOINT);
        assert_eq!(request.method(), "POST");
        let body: Value = serde_json::from_str(request.body.as_deref().unwrap()).unwrap();
        assert_eq!(body["api_key"], "t-key");
        assert_eq!(body["max_results"], 3);
    }

    /// A pinned backend that exists but is not configured reports *its* missing
    /// credential rather than switching to a backend that would have answered.
    #[tokio::test]
    async fn a_pin_to_an_unconfigured_backend_reports_the_missing_credential() {
        let config = WebConfig {
            search_backend: Some("tavily".into()),
            ..WebConfig::default()
        };
        let transport = FakeTransport::new(vec![]);
        let error = search(&json!({ "query": "q" }), &config, &transport)
            .await
            .expect_err("a failure");
        assert!(error.message.contains("TAVILY_API_KEY"), "{}", error.message);
        assert!(transport.requests().is_empty());
    }

    /// The parsers are the fragile half, so each one is pinned to a fixture.
    #[test]
    fn the_bing_parser_decodes_the_click_tracker_and_drops_site_links() {
        let rows = parse_bing(BING_HTML, 10);
        assert_eq!(rows.len(), 2, "{rows:?}");
        assert_eq!(rows[0]["url"], "https://example.org/one");
        assert_eq!(rows[1]["url"], "https://example.org/two");
        assert_eq!(rows[1]["description"], "The second result.");
    }

    #[test]
    fn the_ddgs_parser_unwraps_the_redirect_and_reads_the_snippet() {
        let html = r##"<div class="result results_links">
            <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fone&amp;rut=1">One</a>
            <a class="result__snippet" href="#">The snippet text.</a>
        </div>"##;
        let rows = parse_ddgs(html, 3);
        assert_eq!(rows.len(), 1, "{rows:?}");
        assert_eq!(rows[0]["url"], "https://example.org/one");
        assert_eq!(rows[0]["title"], "One");
    }

    #[test]
    fn the_recognizers_accept_both_spellings() {
        assert!(recognizes_search("WebSearch"));
        assert!(recognizes_search("web_search"));
        assert!(recognizes_extract("WebExtract"));
        assert!(recognizes_extract("web_extract"));
        assert!(!recognizes_search("WebExtract"));
        assert!(!recognizes_extract("WebSearch"));
    }

    /// A query keeps its meaning on the wire, and a redirect wrapper decodes.
    #[test]
    fn queries_are_encoded_and_wrappers_decoded() {
        assert_eq!(encode_query("a b&c=d?"), "a+b%26c%3Dd%3F");
        assert_eq!(percent_decode("https%3A%2F%2Fa.example%2F"), "https://a.example/");
        use base64::Engine as _;
        let encoded =
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode("https://example.org/two");
        assert_eq!(
            decode_base64url(&encoded).as_deref(),
            Some("https://example.org/two")
        );
    }

    // -----------------------------------------------------------------------
    // Live runs. Not part of `cargo test`: they need the internet, and a build
    // machine that cannot reach the network must stay green. They exist because
    // every other test in this module feeds the parser a fixed document — that
    // proves the parser, not that the request it makes is still the one Bing
    // answers.
    //
    //   cargo test -p host-core live_ -- --ignored --nocapture
    //
    // `cn.bing.com` is the only search host reachable from this build host;
    // duckduckgo and the Google endpoints are both blackholed here, which is why
    // the keyless tier asks Bing first.
    // -----------------------------------------------------------------------

    /// A real keyless search returns real rows, shaped the way the model reads them.
    #[tokio::test]
    #[ignore = "network: run with --ignored"]
    async fn live_search_answers_from_the_real_web() {
        let transport = ReqwestTransport::new().expect("a client");
        let value = search(
            &json!({ "query": "rust programming language", "limit": 3 }),
            &WebConfig::default(),
            &transport,
        )
        .await
        .expect("a real search");
        let rows = value["data"]["web"].as_array().expect("web rows");
        assert!(!rows.is_empty(), "no rows: {value}");
        assert_eq!(value["success"], true);
        for row in rows {
            let url = row["url"].as_str().expect("a url");
            assert!(
                url.starts_with("http://") || url.starts_with("https://"),
                "not a web url: {url}"
            );
            assert!(!row["title"].as_str().unwrap_or("").trim().is_empty(), "{row}");
        }
        println!("live search rows = {}", rows.len());
        println!("first = {}", rows[0]["url"]);
    }

    /// A real extract returns readable text for a page the gate lets through.
    #[tokio::test]
    #[ignore = "network: run with --ignored"]
    async fn live_extract_returns_text_for_a_public_page() {
        let transport = ReqwestTransport::new().expect("a client");
        let value = extract(
            &json!({ "urls": ["https://cn.bing.com/"], "maxChars": 2000 }),
            &transport,
        )
        .await
        .expect("a real extract");
        let results = value["results"]
            .as_array()
            .or_else(|| value["data"].as_array())
            .expect("results");
        assert!(!results.is_empty(), "no results: {value}");
        let text = results[0]["content"]
            .as_str()
            .or_else(|| results[0]["text"].as_str())
            .unwrap_or("");
        assert!(!text.trim().is_empty(), "empty text: {value}");
        println!("live extract chars = {}", text.chars().count());
    }

}
