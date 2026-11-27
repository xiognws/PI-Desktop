//! "Did this script actually verify anything?"
//!
//! A generated skeleton exits green — pytest counts a skip as a pass — so
//! "34/34 passed" reads like coverage while no assertion ever ran. The state of
//! a script is therefore derived from its own bytes, not from what someone
//! remembers editing.

use std::sync::OnceLock;

use regex::Regex;
use serde::Serialize;

/// Explicit skeleton marker: the template's placeholder skip.
const SKELETON_MARKERS: [&str; 1] = ["pytest.skip("];

#[derive(Debug, Clone, Serialize)]
pub struct ScriptState {
    pub state: &'static str,
    pub asserts: usize,
    pub has_skip: bool,
}

fn assert_line() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?m)^\s*assert\s+").expect("static pattern"))
}

fn tautology() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"assert\s+(True|1\s*==\s*1)\b").expect("static pattern"))
}

/// `pytest.raises(...)` is a real assertion: the component must raise.
fn raises_line() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?m)^\s*(?:with\s+)?pytest\.raises\(|^\s*with\s+pytest\.raises\(")
            .expect("static pattern")
    })
}

/// `asserted` — real assertions and no placeholder skip; `skeleton` — a skip or
/// no assertion at all; `missing` — nothing to read.
pub fn classify(content: &str) -> ScriptState {
    if content.trim().is_empty() {
        return ScriptState {
            state: "missing",
            asserts: 0,
            has_skip: false,
        };
    }

    let has_skip = SKELETON_MARKERS
        .iter()
        .any(|marker| content.contains(marker));
    let mut asserts = 0usize;
    for found in assert_line().find_iter(content) {
        let line_end = content[found.start()..]
            .find('\n')
            .map(|offset| found.start() + offset)
            .unwrap_or(content.len());
        let line = &content[found.start()..line_end];
        if tautology().is_match(line) {
            continue;
        }
        asserts += 1;
    }
    asserts += raises_line().find_iter(content).count();

    ScriptState {
        state: if asserts > 0 && !has_skip {
            "asserted"
        } else {
            "skeleton"
        },
        asserts,
        has_skip,
    }
}

/// Several scripts per case: report the best state any of them reached.
pub fn merge<'a>(states: impl IntoIterator<Item = &'a str>) -> &'static str {
    let collected: Vec<&str> = states.into_iter().collect();
    for preferred in ["asserted", "skeleton", "missing"] {
        if collected.contains(&preferred) {
            return match preferred {
                "asserted" => "asserted",
                "skeleton" => "skeleton",
                _ => "missing",
            };
        }
    }
    "none"
}

/// Read a script for state classification; an unreadable file is "missing",
/// never an error the list route has to handle.
pub fn read_script_text(filepath: &str) -> String {
    if filepath.is_empty() {
        return String::new();
    }
    std::fs::read(filepath)
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn real_assertion_is_asserted() {
        assert_eq!(
            classify("def test_x():\n    assert 2 == 2\n").state,
            "asserted"
        );
    }

    #[test]
    fn skeleton_marker_wins_over_assertions() {
        assert_eq!(
            classify("pytest.skip('骨架未实现')\nassert 1 == 1\n").state,
            "skeleton"
        );
    }

    #[test]
    fn tautology_and_empty_body_are_skeleton() {
        assert_eq!(
            classify("def test_x():\n    assert True\n").state,
            "skeleton"
        );
        assert_eq!(classify("").state, "missing");
        assert_eq!(classify("print('hi')\n").state, "skeleton");
    }

    #[test]
    fn pytest_raises_counts_as_verification() {
        let text = "def test_x():\n    with pytest.raises(ValueError):\n        boom()\n";
        let state = classify(text);
        assert_eq!(state.state, "asserted");
        assert_eq!(state.asserts, 1);
    }

    #[test]
    fn merge_prefers_the_strongest_state() {
        assert_eq!(merge(["skeleton", "asserted"]), "asserted");
        assert_eq!(merge(["missing", "skeleton"]), "skeleton");
        assert_eq!(merge(std::iter::empty()), "none");
    }
}
