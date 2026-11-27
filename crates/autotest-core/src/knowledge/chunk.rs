//! Split long text into retrievable chunks.
//!
//! Ported from `autotest/knowledge/chunk.py`. Two levels:
//!
//! 1. **Structure**: a Markdown heading (`#`–`######`) opens a section, so one
//!    section is one semantic unit. In vehicle docs "故障现象" and "排查步骤" are
//!    separate headings; splitting on them is what makes a search hit return a
//!    whole procedure instead of half a sentence.
//! 2. **Length**: a section longer than `chunk_chars` is broken at blank lines
//!    and greedily packed up to the limit, keeping `overlap` characters between
//!    neighbours so a sentence crossing a boundary is still readable.
//!
//! Everything here counts code points, not bytes, because the stored `chars`
//! column and the chunk boundaries were produced by Python slicing.

use std::sync::OnceLock;

use regex::Regex;

use super::text::{char_len, slice_chars, tail_chars};

const MIN_CHUNK_CHARS: usize = 200;
const MAX_CHUNK_CHARS: usize = 8000;
const DEFAULT_OVERLAP: usize = 120;
const MAX_CHUNKS: usize = 5000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chunk {
    pub title: String,
    pub content: String,
}

fn heading_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^(#{1,6})\s+(.*\S)\s*$").expect("heading regex"))
}

fn blank_line_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\n\s*\n").expect("blank line regex"))
}

/// `_sections`: `(title, body)` per heading; text before the first heading
/// becomes the empty-title section.
fn sections(text: &str) -> Vec<(String, String)> {
    let mut sections: Vec<(String, Vec<&str>)> = vec![(String::new(), Vec::new())];
    for line in text.split('\n') {
        match heading_re().captures(line) {
            Some(captures) => {
                let title = captures
                    .get(2)
                    .map(|group| group.as_str().trim().to_string())
                    .unwrap_or_default();
                sections.push((title, Vec::new()));
            }
            None => {
                if let Some(last) = sections.last_mut() {
                    last.1.push(line);
                }
            }
        }
    }
    sections
        .into_iter()
        .map(|(title, body)| (title, body.join("\n").trim().to_string()))
        .collect()
}

/// `_pack`: greedy packing on blank-line paragraphs, hard split when a single
/// paragraph alone exceeds the limit.
fn pack(text: &str, limit: usize, overlap: usize) -> Vec<String> {
    let paragraphs: Vec<String> = blank_line_re()
        .split(text)
        .map(|paragraph| paragraph.trim().to_string())
        .filter(|paragraph| !paragraph.is_empty())
        .collect();
    if paragraphs.is_empty() {
        return Vec::new();
    }

    let mut pieces: Vec<String> = Vec::new();
    let mut buffer = String::new();
    for paragraph in paragraphs {
        if char_len(&paragraph) > limit {
            if !buffer.is_empty() {
                pieces.push(std::mem::take(&mut buffer));
            }
            let step = std::cmp::max(1, limit.saturating_sub(overlap));
            let length = char_len(&paragraph);
            let mut start = 0usize;
            while start < length {
                let end = std::cmp::min(start + limit, length);
                pieces.push(slice_chars(&paragraph, start, end));
                if start + limit >= length {
                    break;
                }
                start += step;
            }
            continue;
        }
        let candidate = if buffer.is_empty() {
            paragraph.clone()
        } else {
            format!("{buffer}\n\n{paragraph}")
        };
        if char_len(&candidate) <= limit {
            buffer = candidate;
        } else {
            let previous = std::mem::take(&mut buffer);
            let tail = if overlap > 0 && !previous.is_empty() {
                tail_chars(&previous, overlap)
            } else {
                String::new()
            };
            pieces.push(previous);
            buffer = if tail.is_empty() {
                paragraph
            } else {
                format!("{tail}\n{paragraph}")
            };
        }
    }
    if !buffer.is_empty() {
        pieces.push(buffer);
    }
    pieces
        .into_iter()
        .map(|piece| piece.trim().to_string())
        .filter(|piece| !piece.is_empty())
        .collect()
}

/// `chunk_text`. The error is the exact `ValueError` text the Python service
/// turned into a 400.
pub fn chunk_text(text: &str, chunk_chars: i64) -> Result<Vec<Chunk>, String> {
    if chunk_chars <= 0 || chunk_chars > MAX_CHUNK_CHARS as i64 {
        return Err(format!("chunk_chars 必须在 1~{MAX_CHUNK_CHARS} 之间"));
    }
    let mut limit = chunk_chars as usize;
    if limit < MIN_CHUNK_CHARS {
        limit = MIN_CHUNK_CHARS;
    }
    let overlap = DEFAULT_OVERLAP.min(limit / 3);

    let mut chunks: Vec<Chunk> = Vec::new();
    for (title, body) in sections(text) {
        if body.is_empty() {
            if !title.is_empty() {
                chunks.push(Chunk {
                    title: title.clone(),
                    content: title,
                });
            }
            continue;
        }
        if char_len(&body) <= limit {
            chunks.push(Chunk {
                title: title.clone(),
                content: body,
            });
            continue;
        }
        let pieces = pack(&body, limit, overlap);
        let total = pieces.len();
        for (index, piece) in pieces.into_iter().enumerate() {
            let label = if title.is_empty() {
                "正文".to_string()
            } else {
                title.clone()
            };
            chunks.push(Chunk {
                title: format!("{label} ({}/{total})", index + 1),
                content: piece,
            });
        }
    }

    if chunks.len() > MAX_CHUNKS {
        return Err(format!(
            "切分后条目 {} 条，超过上限 {}；请先拆分文档或调大 chunk_chars",
            chunks.len(),
            MAX_CHUNKS
        ));
    }
    Ok(chunks)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PRD: &str = "# 电池管理系统需求

## 1. 功能需求
- 采集单体电压，范围 0~5000 mV，采样周期 100 ms。
- 当单体电压超过 4200 mV 时，应在 200 ms 内上报过压故障。
- 支持 CAN 报文 0x351 上报总电压与总电流。
- 上电自检应在 500 ms 内完成，失败时点亮故障灯。

## 2. 非功能需求
- 通信超时 1000 ms 后进入安全状态。

## 3. 依赖
- 依赖整车 12V 供电。
";

    #[test]
    fn heading_sections_match_the_python_service() {
        let chunks = chunk_text(PRD, 1200).expect("chunks");
        let titles: Vec<&str> = chunks.iter().map(|chunk| chunk.title.as_str()).collect();
        assert_eq!(
            titles,
            vec![
                "电池管理系统需求",
                "1. 功能需求",
                "2. 非功能需求",
                "3. 依赖"
            ]
        );
        assert_eq!(
            chunks
                .iter()
                .map(|chunk| char_len(&chunk.content))
                .collect::<Vec<_>>(),
            vec![8, 132, 23, 14]
        );
    }

    #[test]
    fn long_section_is_packed_with_overlap_and_labelled() {
        let paragraph = "甲".repeat(900);
        let text = format!("# 章节\n\n{paragraph}\n\n{paragraph}");
        let chunks = chunk_text(&text, 400).expect("chunks");
        assert!(chunks.len() > 1);
        assert_eq!(
            chunks[0].title,
            "章节 (1/".to_string() + &format!("{})", chunks.len())
        );
        let limit = 400;
        assert!(chunks.iter().all(|chunk| char_len(&chunk.content) <= limit));
    }

    #[test]
    fn chunk_chars_bounds_are_reported_as_errors() {
        assert_eq!(
            chunk_text("正文", 0).unwrap_err(),
            "chunk_chars 必须在 1~8000 之间"
        );
        assert_eq!(
            chunk_text("正文", 8001).unwrap_err(),
            "chunk_chars 必须在 1~8000 之间"
        );
    }

    #[test]
    fn small_chunk_chars_is_raised_to_the_floor() {
        // 1 becomes 200, so a 132-char body stays one chunk.
        let chunks = chunk_text("## 标题\n\n短正文。", 1).expect("chunks");
        assert_eq!(chunks.len(), 1);
    }
}
