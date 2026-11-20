//! Edit formats, validated before anything is written.
//!
//! Practice from the agents with the best edit reliability (Aider's
//! `SEARCH/REPLACE` blocks, and the "one exact span" rule this kernel's `Edit`
//! tool already documents): the model states the text it expects to find, so a
//! wrong assumption is caught *as a message to the model* instead of being
//! written to a file. Two failure modes matter and both are refusals rather than
//! silent damage:
//!
//! * the search text occurs **zero** times — the file is not what the model thinks;
//! * it occurs **more than once** — the edit would touch the wrong place.
//!
//! The kernel parses and validates; the host executes the write. That split is the
//! same one the rest of the tool surface uses.

use crate::error::{AgentError, Result};

/// Opening marker of a search block, as Aider writes it.
pub const SEARCH_MARKER: &str = "<<<<<<< SEARCH";
/// The line between the old and the new text.
pub const DIVIDER: &str = "=======";
/// Closing marker.
pub const REPLACE_MARKER: &str = ">>>>>>> REPLACE";

/// One block of a multi-file edit answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EditBlock {
    /// Replace one exact span in an existing file.
    SearchReplace {
        /// The file the block applies to; `None` when one answer edits one file
        /// named elsewhere.
        path: Option<String>,
        search: String,
        replace: String,
    },
    /// A whole new file.
    Create { path: String, content: String },
}

impl EditBlock {
    pub fn path(&self) -> Option<&str> {
        match self {
            Self::SearchReplace { path, .. } => path.as_deref(),
            Self::Create { path, .. } => Some(path),
        }
    }
}

/// Parse every block in an answer, ignoring prose and code fences around them.
///
/// A malformed block fails the whole answer: applying half an edit set is worse
/// than applying none, because the half that landed is invisible.
pub fn parse_edit_blocks(text: &str) -> Result<Vec<EditBlock>> {
    let lines: Vec<&str> = text.lines().collect();
    let mut blocks: Vec<EditBlock> = Vec::new();
    let mut index = 0usize;
    let mut pending_path: Option<String> = None;

    while index < lines.len() {
        let line = lines[index].trim();

        if line.starts_with(SEARCH_MARKER) {
            let path = pending_path.take();
            let (search, next) = collect_until(&lines, index + 1, DIVIDER)?;
            let (replace, next) = collect_until(&lines, next + 1, REPLACE_MARKER)?;
            index = next + 1;
            blocks.push(EditBlock::SearchReplace {
                path,
                search: join_block(&search),
                replace: join_block(&replace),
            });
            continue;
        }

        if line.starts_with(REPLACE_MARKER) {
            return Err(AgentError::Refused(
                "a `>>>>>>> REPLACE` line arrived without a matching `<<<<<<< SEARCH` above it."
                    .into(),
            ));
        }

        // A line that looks like a path and is followed by a search marker names
        // the file of the next block.
        if looks_like_path(line) && next_is_search(&lines, index + 1) {
            pending_path = Some(line.to_string());
        }
        index += 1;
    }

    if blocks.is_empty() {
        return Err(AgentError::Refused(format!(
            "no edit block was found: write `{SEARCH_MARKER}`, the exact current text, `{DIVIDER}`, the new text, `{REPLACE_MARKER}`."
        )));
    }
    Ok(blocks)
}

fn next_is_search(lines: &[&str], index: usize) -> bool {
    lines
        .get(index)
        .map(|line| line.trim().starts_with(SEARCH_MARKER))
        .unwrap_or(false)
}

/// A path line: no marker, no comment, and it looks like a file rather than a
/// sentence (`src/main.rs`, `a/b.py`, `Makefile`).
fn looks_like_path(line: &str) -> bool {
    if line.is_empty() || line.starts_with('#') || line.contains("<<<") || line.contains(">>>") {
        return false;
    }
    if line.contains(' ') && !line.contains('/') && !line.contains('\\') {
        return false;
    }
    line.contains('.') || line.contains('/') || line.contains('\\')
}

fn collect_until(lines: &[&str], start: usize, marker: &str) -> Result<(Vec<String>, usize)> {
    let mut collected = Vec::new();
    let mut index = start;
    while index < lines.len() {
        if lines[index].trim().starts_with(marker) {
            return Ok((collected, index));
        }
        collected.push(lines[index].to_string());
        index += 1;
    }
    Err(AgentError::Refused(format!(
        "an edit block is missing its `{marker}` line: close the block so the edit can be applied."
    )))
}

/// A block's lines without the trailing blank line most answers leave before the
/// marker, which is packaging rather than content.
fn join_block(lines: &[String]) -> String {
    let mut text = lines.join("\n");
    while text.ends_with('\n') {
        text.pop();
    }
    text
}

/// Why an edit could not be applied. Every variant is a sentence the model can act
/// on with one more attempt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApplyError {
    NotFound { search: String },
    Ambiguous { search: String, occurrences: usize },
    EmptySearch,
    MissingPath,
}

impl ApplyError {
    fn into_error(self) -> AgentError {
        match self {
            Self::NotFound { search } => AgentError::Refused(format!(
                "the search text was not found in the file ({} characters). Read the file again and copy the exact current text, whitespace included.",
                search.chars().count()
            )),
            Self::Ambiguous { search, occurrences } => AgentError::Refused(format!(
                "the search text occurs {occurrences} times. Add the surrounding lines that make it unique ({} characters given).",
                search.chars().count()
            )),
            Self::EmptySearch => AgentError::Refused(
                "the search text is empty: an edit replaces a span that exists, not the whole file — use `Write` for a new file.".into(),
            ),
            Self::MissingPath => AgentError::Refused(
                "this edit names no file: put the path on the line before `<<<<<<< SEARCH`.".into(),
            ),
        }
    }
}

/// Apply one block to a file's current text.
///
/// Exact match first; when that fails, a line-normalized match (trailing
/// whitespace and line endings ignored) because a model that copied text through
/// a terminal loses exactly that. A normalized match still has to be unique.
pub fn apply_edit(original: &str, block: &EditBlock) -> Result<String> {
    match block {
        EditBlock::Create { path, content } => {
            if path.trim().is_empty() {
                return Err(ApplyError::MissingPath.into_error());
            }
            Ok(content.clone())
        }
        EditBlock::SearchReplace {
            search, replace, ..
        } => {
            if search.is_empty() {
                return Err(ApplyError::EmptySearch.into_error());
            }
            if let Some(updated) = replace_exact(original, search, replace)? {
                return Ok(updated);
            }
            replace_normalized(original, search, replace)
        }
    }
}

fn replace_exact(original: &str, search: &str, replace: &str) -> Result<Option<String>> {
    let occurrences = original.matches(search).count();
    match occurrences {
        0 => Ok(None),
        1 => Ok(Some(original.replacen(search, replace, 1))),
        many => Err(ApplyError::Ambiguous {
            search: search.to_string(),
            occurrences: many,
        }
        .into_error()),
    }
}

/// Line-based fallback: compare with `\r` removed and trailing spaces trimmed,
/// then replace the whole matched line range with the replacement.
fn replace_normalized(original: &str, search: &str, replace: &str) -> Result<String> {
    let original_lines: Vec<&str> = original.lines().collect();
    let search_lines: Vec<String> = search.lines().map(normalize_line).collect();
    if search_lines.is_empty() {
        return Err(ApplyError::EmptySearch.into_error());
    }
    let normalized: Vec<String> = original_lines
        .iter()
        .map(|line| normalize_line(line))
        .collect();

    let mut hits: Vec<usize> = Vec::new();
    if normalized.len() >= search_lines.len() {
        for start in 0..=(normalized.len() - search_lines.len()) {
            if normalized[start..start + search_lines.len()] == search_lines[..] {
                hits.push(start);
            }
        }
    }
    match hits.len() {
        0 => Err(ApplyError::NotFound {
            search: search.to_string(),
        }
        .into_error()),
        1 => {
            let start = hits[0];
            let end = start + search_lines.len();
            let mut lines: Vec<String> = original_lines[..start]
                .iter()
                .map(|line| line.to_string())
                .collect();
            lines.extend(replace.lines().map(|line| line.to_string()));
            lines.extend(original_lines[end..].iter().map(|line| line.to_string()));
            let mut out = lines.join("\n");
            if original.ends_with('\n') {
                out.push('\n');
            }
            Ok(out)
        }
        many => Err(ApplyError::Ambiguous {
            search: search.to_string(),
            occurrences: many,
        }
        .into_error()),
    }
}

fn normalize_line(line: &str) -> String {
    line.trim_end_matches('\r').trim_end().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    const ANSWER: &str =
        "src/main.rs\n<<<<<<< SEARCH\nlet x = 1;\n=======\nlet x = 2;\n>>>>>>> REPLACE\n";

    #[test]
    fn a_block_names_its_file_and_applies_once() {
        let blocks = parse_edit_blocks(ANSWER).unwrap();
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].path(), Some("src/main.rs"));
        let updated = apply_edit("fn main() {\n    let x = 1;\n}\n", &blocks[0]).unwrap();
        assert_eq!(updated, "fn main() {\n    let x = 2;\n}\n");
    }

    #[test]
    fn prose_and_fences_around_the_blocks_are_ignored() {
        let answer = format!("Here you go:\n```\n{ANSWER}```\nThat should do it.\n");
        let blocks = parse_edit_blocks(&answer).unwrap();
        assert_eq!(blocks.len(), 1);
    }

    #[test]
    fn a_search_text_that_is_absent_is_a_refusal_not_a_write() {
        let blocks = parse_edit_blocks(ANSWER).unwrap();
        let error = apply_edit("fn main() {\n    let y = 1;\n}\n", &blocks[0]).unwrap_err();
        assert_eq!(error.code(), "TOOL_REFUSED");
        assert!(error.to_string().contains("not found"), "{error}");
        assert!(error.to_string().contains("whitespace"), "{error}");
    }

    #[test]
    fn an_ambiguous_search_text_is_refused_with_the_count() {
        let blocks = parse_edit_blocks(ANSWER).unwrap();
        let error = apply_edit("let x = 1;\nlet x = 1;\n", &blocks[0]).unwrap_err();
        assert!(error.to_string().contains("occurs 2 times"), "{error}");
    }

    #[test]
    fn a_line_normalized_match_still_applies() {
        // The file has CRLF and trailing spaces; the model copied clean text.
        let original = "fn main() {\r\n    let x = 1;   \r\n}\r\n";
        let blocks = parse_edit_blocks(ANSWER).unwrap();
        let updated = apply_edit(original, &blocks[0]).unwrap();
        assert!(updated.contains("let x = 2;"), "{updated}");
        assert!(!updated.contains("let x = 1;"));
    }

    #[test]
    fn several_blocks_in_one_answer_apply_in_order() {
        let answer = format!("{ANSWER}a.txt\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE\n");
        let blocks = parse_edit_blocks(&answer).unwrap();
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[1].path(), Some("a.txt"));
        let updated = apply_edit("old\n", &blocks[1]).unwrap();
        assert_eq!(updated, "new\n");
    }

    #[test]
    fn a_missing_marker_or_an_empty_answer_is_refused() {
        let no_close = "a.rs\n<<<<<<< SEARCH\nx\n=======\ny\n";
        assert!(parse_edit_blocks(no_close)
            .unwrap_err()
            .to_string()
            .contains("missing"));
        assert!(parse_edit_blocks("no edit here")
            .unwrap_err()
            .to_string()
            .contains("no edit block"));
        let stray = ">>>>>>> REPLACE\n";
        assert!(parse_edit_blocks(stray)
            .unwrap_err()
            .to_string()
            .contains("without a matching"));
    }

    #[test]
    fn an_empty_search_text_is_refused_with_the_right_advice() {
        let block = EditBlock::SearchReplace {
            path: Some("a.rs".into()),
            search: String::new(),
            replace: "new".into(),
        };
        let error = apply_edit("anything", &block).unwrap_err();
        assert!(error.to_string().contains("use `Write`"), "{error}");
    }

    #[test]
    fn a_create_block_carries_the_whole_file() {
        let block = EditBlock::Create {
            path: "new.rs".into(),
            content: "fn main() {}\n".into(),
        };
        assert_eq!(apply_edit("", &block).unwrap(), "fn main() {}\n");
        let pathless = EditBlock::Create {
            path: "  ".into(),
            content: String::new(),
        };
        assert!(apply_edit("", &pathless).is_err());
    }
}
