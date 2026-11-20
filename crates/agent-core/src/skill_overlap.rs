//! Keeping one lesson in one place, mechanically.
//!
//! Counterpart of `memory-skill-overlap.ts`. Measured on the desktop: the rule
//! "a procedure belongs in the skill and nowhere else" was in the prompt, and the
//! same four-step procedure still ended up as a skill *and* as two memory
//! entries — the main turn wrote memory, the review fork created the skill, and
//! neither knew about the other. A prompt rule cannot see what the other writer
//! just did; a check at write time can.
//!
//! The check is deliberately narrow. It only refuses a memory entry that looks
//! like a procedure — steps, not a sentence — and it uses vocabulary similarity
//! only to *name* the skill to patch. A fact that happens to share a word with a
//! skill ("this machine blocks TCP 22" next to a "publish a branch" skill) is
//! exactly what memory is for, and stays accepted.

use std::sync::OnceLock;

use regex::Regex;

/// A skill the library already holds, as the catalogue knows it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SkillSummary {
    pub id: String,
    pub name: Option<String>,
    pub description: Option<String>,
    /// The document itself, when the caller could read it.
    ///
    /// Measured, this is what makes the check work: catalogues describe skills in
    /// one line of English while the procedure a person dictates is Chinese and
    /// full of paths. Comparing against that one line shared exactly one token and
    /// let a real duplicate through; the same entry against the body — which names
    /// the files and the steps — shares most of its vocabulary.
    pub body: Option<String>,
}

fn latin_token() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"[a-z][a-z0-9_-]{2,}").expect("latin token pattern"))
}

fn cjk_run() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"[\u{4e00}-\u{9fff}]{2,}").expect("cjk run pattern"))
}

/// Whether `text` carries an enumerated marker for `digit` — `1.`, `1)`, `1、`.
///
/// The separator must not be followed by another digit: " 1.2" is a version
/// number, not a step. The reference implementation expressed that as a
/// look-ahead, which Rust's regex engine does not have, so the check is made on
/// the match end instead.
fn enumerated(digit: char, text: &str) -> bool {
    static ONE: OnceLock<Regex> = OnceLock::new();
    static TWO: OnceLock<Regex> = OnceLock::new();
    let pattern = match digit {
        '1' => ONE.get_or_init(|| Regex::new(r"(?:^|[^0-9])1[.)、]").expect("step pattern")),
        _ => TWO.get_or_init(|| Regex::new(r"(?:^|[^0-9])2[.)、]").expect("step pattern two")),
    };
    pattern.find_iter(text).any(|found| {
        !text[found.end()..]
            .chars()
            .next()
            .is_some_and(|next| next.is_ascii_digit())
    })
}

fn arrows() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"→|->|=>").expect("arrow pattern"))
}

fn ordered_cn() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(先|首先)[^。；]{2,60}(再|然后|接着)").expect("cn order pattern")
    })
}

fn ordered_en() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)\b(first|then|next|finally)\b").expect("en order pattern"))
}

/// Latin words of three letters or more, plus CJK two-character runs: the shape a
/// one-line catalogue entry and a dictated procedure can actually share.
pub fn topic_tokens(text: &str) -> Vec<String> {
    let lower = text.to_lowercase();
    let mut tokens: Vec<String> = Vec::new();
    let mut push = |token: String| {
        if !tokens.iter().any(|seen| seen == &token) {
            tokens.push(token);
        }
    };
    for found in latin_token().find_iter(&lower) {
        push(found.as_str().to_string());
    }
    for run in cjk_run().find_iter(&lower) {
        let chars: Vec<char> = run.as_str().chars().collect();
        for index in 0..chars.len().saturating_sub(1) {
            push(chars[index..index + 2].iter().collect());
        }
    }
    tokens
}

/// Whether an entry reads like a procedure rather than a fact.
///
/// Signals: a numbered pair, two or more arrows (a flow, not a sentence about
/// one), or an explicit ordering phrase. One weak signal alone is too easy to
/// hit — "first, the disk was full" is a fact about a failure.
pub fn looks_like_procedure(text: &str) -> bool {
    let numbered = enumerated('1', text) && enumerated('2', text);
    let flow = arrows().find_iter(text).count() >= 2;
    let ordered = ordered_cn().is_match(text) || ordered_en().find_iter(text).count() >= 2;
    numbered || flow || ordered
}

#[derive(Debug, Clone, PartialEq)]
pub struct CoverageHit {
    pub skill_id: String,
    pub score: f64,
}

/// The skill that already covers this entry, if one plainly does.
///
/// Used for the *message*, not for the gate: the gate is the shape of the
/// sentence (see [`procedure_needing_a_skill`]). Naming the likely skill turns a
/// refusal into one action — patch that skill — and when nothing matches
/// lexically the refusal still stands and points at `skill_manage create`.
pub fn covered_by_skill(
    text: &str,
    skills: &[SkillSummary],
    min_score: f64,
) -> Option<CoverageHit> {
    let tokens = topic_tokens(text);
    if tokens.is_empty() {
        return None;
    }
    let mut best: Option<CoverageHit> = None;
    for skill in skills {
        let haystack = format!(
            "{} {} {} {}",
            skill.name.as_deref().unwrap_or(""),
            skill.description.as_deref().unwrap_or(""),
            skill.id,
            skill.body.as_deref().unwrap_or("")
        );
        let skill_tokens = topic_tokens(&haystack);
        let shared = tokens
            .iter()
            .filter(|token| skill_tokens.iter().any(|candidate| candidate == *token))
            .count();
        // A hint only: two shared technical terms are enough to name the likely
        // skill, because the refusal already stands on its own.
        if shared < 2 {
            continue;
        }
        let score = shared as f64 / tokens.len().max(1) as f64;
        if score >= min_score && best.as_ref().is_none_or(|current| score > current.score) {
            best = Some(CoverageHit {
                skill_id: skill.id.clone(),
                score,
            });
        }
    }
    best
}

/// The first added entry that is a procedure rather than a fact.
///
/// `existing_entries` is honoured: an entry stored before this rule existed is
/// never re-judged, so a session can always fix a note by rewriting it.
pub fn procedure_needing_a_skill(
    added_entries: &[String],
    existing_entries: &[String],
    skills: &[SkillSummary],
) -> Option<(String, Option<String>)> {
    for entry in added_entries {
        let trimmed = entry.trim();
        if existing_entries.iter().any(|seen| seen.trim() == trimmed) {
            continue;
        }
        if !looks_like_procedure(entry) {
            continue;
        }
        let skill_id = covered_by_skill(entry, skills, 0.12).map(|hit| hit.skill_id);
        return Some((entry.clone(), skill_id));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn skill(id: &str, description: &str) -> SkillSummary {
        SkillSummary {
            id: id.to_string(),
            name: Some(id.to_string()),
            description: Some(description.to_string()),
            body: None,
        }
    }

    #[test]
    fn numbered_steps_read_as_a_procedure() {
        assert!(looks_like_procedure("1. run the build 2. push the tag"));
        assert!(looks_like_procedure("1、构建 2、发布"));
    }

    #[test]
    fn an_arrow_flow_reads_as_a_procedure() {
        assert!(looks_like_procedure("source -> build -> publish"));
    }

    #[test]
    fn an_ordering_phrase_reads_as_a_procedure() {
        assert!(looks_like_procedure("先构建产物，然后再发布"));
        assert!(looks_like_procedure("first build, then publish"));
    }

    #[test]
    fn a_fact_about_a_failure_is_not_a_procedure() {
        // One ordering word alone is a sentence about one thing happening.
        assert!(!looks_like_procedure("first, the disk was full"));
        assert!(!looks_like_procedure("this machine blocks TCP 22"));
        assert!(!looks_like_procedure(
            "the release notes live in CHANGELOG.md"
        ));
    }

    #[test]
    fn a_version_number_is_not_a_step_marker() {
        // Measured defect in the reference implementation: its boundary was
        // "not a digit *before*", so " 1.2" and " 2.3" in one sentence read as
        // steps and a plain fact was refused. The separator now also has to be
        // followed by something other than a digit.
        assert!(!looks_like_procedure("bumped 1.2 and kept 2.3 for later"));
        assert!(looks_like_procedure(
            "1. run the build
2. push the tag"
        ));
    }

    #[test]
    fn the_gate_refuses_the_first_procedure_and_names_the_skill() {
        let skills = vec![skill("pi/release", "cut a release tag and publish")];
        let entry = "1. cut the release tag 2. publish the release notes".to_string();
        let hit = procedure_needing_a_skill(std::slice::from_ref(&entry), &[], &skills)
            .expect("a procedure is refused");
        assert_eq!(hit.0, entry);
        assert_eq!(hit.1.as_deref(), Some("pi/release"), "the skill to patch");
    }

    #[test]
    fn a_procedure_with_no_matching_skill_is_still_refused() {
        let entry = "1. bake the cake 2. let it cool".to_string();
        let hit = procedure_needing_a_skill(&[entry], &[], &[]).expect("refused regardless");
        assert_eq!(hit.1, None, "nothing to name, the rule still applies");
    }

    #[test]
    fn an_entry_that_already_existed_is_never_re_judged() {
        let entry = "1. old step 2. older step".to_string();
        let existing = vec![entry.clone()];
        assert!(procedure_needing_a_skill(std::slice::from_ref(&entry), &existing, &[]).is_none());
    }

    #[test]
    fn a_fact_sharing_one_word_with_a_skill_is_accepted() {
        let skills = vec![skill("pi/release", "publish a branch and its tag")];
        let entry = "the release machine blocks TCP 22".to_string();
        assert!(procedure_needing_a_skill(&[entry], &[], &skills).is_none());
    }

    #[test]
    fn coverage_needs_two_shared_terms() {
        let skills = vec![skill("pi/release", "publish the tag")];
        // One shared technical term is a coincidence, not coverage ("the" is a
        // token too, which is why the fixture uses two distinct nouns).
        assert!(covered_by_skill("publish carefully", &skills, 0.12).is_none());
        assert!(covered_by_skill("publish the tag carefully", &skills, 0.12).is_some());
    }

    #[test]
    fn chinese_text_yields_bigram_tokens() {
        let tokens = topic_tokens("上下文压缩");
        assert!(tokens.contains(&"上下".to_string()));
        assert!(tokens.contains(&"压缩".to_string()));
    }
}
