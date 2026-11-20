//! Credential patterns, and the scrub that uses them.
//!
//! Counterpart of `packages/shared/src/redaction.ts`. Two directions, one
//! vocabulary: the log redactor governs what is written locally, this module is
//! the other direction — text on its way *out* of the process, to a provider or
//! into storage that is replayed into a prompt on every later turn. A key that
//! reaches memory is re-sent forever, so that path holds regardless of any log
//! setting and fails closed.

use std::sync::OnceLock;

use regex::Regex;

pub const REDACTED_MARKER: &str = "***REDACTED***";

fn url_credential() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)(https?://)[^/\s:@]+:[^@\s]+@").expect("url pattern"))
}

fn bearer() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)\b((?:bearer|basic))\s+[A-Za-z0-9+/_=.-]{8,}").expect("bearer pattern")
    })
}

fn assignment() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r#"(?i)\b((?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|password|api[_-]?key|apikey|authorization|proxy-authorization|cookie|set-cookie|credential|private[_-]?key|client[_-]?secret)\s*[:=]\s*)[^\s,;&}"']+"#,
        )
        .expect("assignment pattern")
    })
}

fn value() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"\b(?:sk|rk|pk)-[A-Za-z0-9_-]{10,}\b|\b(?:gh[pousr]_|github_pat_|glpat-|xox[baprs]-|AIza|ya29\.)[A-Za-z0-9._-]{8,}\b",
        )
        .expect("value pattern")
    })
}

fn token() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"[A-Za-z0-9_\-./+]{16,}").expect("token pattern"))
}

/// Mask credentials in one string.
///
/// Order matters: the URL form owns its own `@`, and an assignment
/// (`token=abc…`) has to be recognised before the bare value pattern, or the
/// label survives while the value is masked only sometimes.
pub fn scrub_secrets(text: &str) -> String {
    let step = url_credential().replace_all(text, "$1***:***@");
    let step = bearer().replace_all(&step, "$1 ***REDACTED***");
    let step = assignment().replace_all(&step, "${1}***REDACTED***");
    value().replace_all(&step, REDACTED_MARKER).into_owned()
}

/// Scrub a batch, and mask a token caught anywhere in it *everywhere* in it.
///
/// The model often states a credential once with its label and then repeats it
/// bare in prose or in the next field; masking only the labelled occurrence
/// leaves the value in the store, which is the whole thing this is for.
pub fn scrub_secrets_in_batch(texts: &[String]) -> Vec<String> {
    let masked: Vec<String> = texts.iter().map(|text| scrub_secrets(text)).collect();
    let mut learned: Vec<String> = Vec::new();
    for (index, text) in texts.iter().enumerate() {
        if masked[index] == *text {
            continue;
        }
        for found in token().find_iter(text) {
            let candidate = found.as_str();
            if !masked[index].contains(candidate) && !learned.iter().any(|seen| seen == candidate) {
                learned.push(candidate.to_string());
            }
        }
    }
    if learned.is_empty() {
        return masked;
    }
    // Longest first, so a token that contains another is masked whole.
    learned.sort_by_key(|token| std::cmp::Reverse(token.len()));
    let pattern = learned
        .iter()
        .map(|token| regex::escape(token))
        .collect::<Vec<_>>()
        .join("|");
    let combined = Regex::new(&pattern).expect("escaped token pattern");
    masked
        .into_iter()
        .map(|text| combined.replace_all(&text, REDACTED_MARKER).into_owned())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_credential_in_a_url_keeps_the_scheme_and_masks_both_halves() {
        let scrubbed = scrub_secrets("clone https://bob:hunter2@example.com/repo.git");
        assert_eq!(
            scrubbed, "clone https://***:***@example.com/repo.git",
            "the host stays readable, the credential does not"
        );
    }

    #[test]
    fn a_bearer_token_keeps_its_scheme_word() {
        // Assembled at runtime: this source file must not contain a
        // credential-shaped literal, and every tool that writes or prints one
        // masks it — which is the module under test.
        let token = format!("{}{}", "ghp_", "aaaaaaaaaaaaaaaaaaaa");
        let scrubbed = scrub_secrets(&format!("{}{token}", "Bearer "));
        assert!(!scrubbed.contains(&token), "the token itself is gone");
        assert!(scrubbed.ends_with(REDACTED_MARKER));
        assert!(scrubbed.starts_with("Bearer "), "the scheme word survives");
    }

    #[test]
    fn a_labelled_assignment_keeps_the_label() {
        assert_eq!(
            scrub_secrets("api_key: 0123456789abcdef"),
            "api_key: ***REDACTED***"
        );
        assert_eq!(
            scrub_secrets("PASSWORD = swordfish"),
            "PASSWORD = ***REDACTED***"
        );
    }

    #[test]
    fn a_known_key_shape_is_masked_without_a_label() {
        for text in [
            "key sk-abcdefghijklmnop used",
            "token ghp_1234567890abcdef",
            "gitlab glpat-abcdefghij123456",
            "slack xoxb-1234567890",
            "google AIza1234567890abcdef",
        ] {
            let scrubbed = scrub_secrets(text);
            assert!(
                scrubbed.contains(REDACTED_MARKER),
                "{text} should be masked, got {scrubbed}"
            );
        }
    }

    #[test]
    fn ordinary_prose_is_left_alone() {
        let text = "the build takes 40 seconds and the tests are green";
        assert_eq!(scrub_secrets(text), text);
    }

    #[test]
    fn a_token_stated_once_is_masked_wherever_it_repeats_in_the_batch() {
        let batch = vec![
            "the api key is api_key: sk-abcdefghijklmnop".to_string(),
            "use sk-abcdefghijklmnop with the proxy".to_string(),
        ];
        let scrubbed = scrub_secrets_in_batch(&batch);
        assert!(!scrubbed
            .iter()
            .any(|text| text.contains("sk-abcdefghijklmnop")));
        assert!(scrubbed[1].contains(REDACTED_MARKER));
    }

    #[test]
    fn a_batch_without_credentials_is_returned_unchanged() {
        let batch = vec!["alpha".to_string(), "beta".to_string()];
        assert_eq!(scrub_secrets_in_batch(&batch), batch);
    }
}
