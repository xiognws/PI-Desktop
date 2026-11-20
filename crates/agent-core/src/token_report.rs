//! Where a request's tokens actually go.
//!
//! Every optimisation in this kernel is a token decision, and a token decision
//! made without a measurement is a guess. This module answers the only question
//! that matters before changing anything: for one request, how much of the cost
//! is the system prompt (and which section), how much is the tool declarations
//! (and which tool), how much is history (and which message), and how much is the
//! recalled-memory block.
//!
//! It is a *report*, not a policy: nothing here trims, drops or reorders. The
//! numbers it produces are what make the next change defensible, and what makes a
//! regression visible when a description grows into a manual.
//!
//! Estimated the same way the budget gate estimates, so a report and a compaction
//! decision can never disagree about how large a request is.

use serde_json::{json, Value};

use crate::context::{estimate_message_tokens, ESTIMATED_TEXT_CHARS_PER_TOKEN};
use crate::message::Message;
use crate::prompt::ComposedPrompt;
use crate::tool::ToolSpec;

/// One line of the report.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CostLine {
    /// Section name, tool name, or message role with an index.
    pub name: String,
    pub chars: usize,
    pub tokens: u64,
}

impl CostLine {
    fn new(name: impl Into<String>, chars: usize) -> Self {
        Self {
            name: name.into(),
            chars,
            // Rounded up, and with the same divisor the budget gate uses: a
            // report that counted differently from the gate would justify the
            // wrong change.
            tokens: (chars as f64 / ESTIMATED_TEXT_CHARS_PER_TOKEN).ceil() as u64,
        }
    }

    fn to_json(&self) -> Value {
        json!({
            "name": self.name,
            "chars": self.chars,
            "tokens": self.tokens,
            "share": 0.0,
        })
    }
}

/// The whole request, itemised.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RequestCost {
    pub system: Vec<CostLine>,
    pub tools: Vec<CostLine>,
    pub history: Vec<CostLine>,
    pub memory: Option<CostLine>,
}

/// Longest preview kept for a message name, so a report stays readable.
const PREVIEW_CHARS: usize = 40;

fn preview(message: &Message) -> String {
    let text = message.text();
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        // A message with no text is either a tool call or a tool result; naming
        // it by the tool is more useful than an empty preview.
        let names: Vec<String> = message
            .tool_calls()
            .iter()
            .map(|call| call.name.clone())
            .chain(
                message
                    .tool_results()
                    .iter()
                    .map(|result| result.name.clone()),
            )
            .collect();
        return names.join(",");
    }
    if collapsed.chars().count() <= PREVIEW_CHARS {
        return collapsed;
    }
    collapsed.chars().take(PREVIEW_CHARS).collect::<String>() + "…"
}

/// Cost of the system prompt, per section.
///
/// Sections are what the composition actually built, so a report names the block
/// that grew (an instruction file, the skill catalogue, the tool guidance) rather
/// than "the system prompt got bigger".
pub fn system_cost(composed: &ComposedPrompt) -> Vec<CostLine> {
    let mut lines: Vec<CostLine> = composed
        .sections
        .iter()
        .map(|section| CostLine::new(section.name, section.text.chars().count()))
        .collect();
    let sectioned: usize = composed
        .sections
        .iter()
        .map(|section| section.text.chars().count())
        .sum();
    // A composed prompt can carry text outside its named sections (headers, the
    // separators between blocks); attributing it keeps the total honest.
    let total = composed.system.chars().count();
    if total > sectioned {
        lines.push(CostLine::new("(unattributed)", total - sectioned));
    }
    lines
}

/// Cost of the tool declarations, per tool.
///
/// This is the fixed part of every request: the same declarations are re-sent on
/// every turn, and prompt caching is the only thing that makes them cheap.
pub fn tools_cost(specs: &[ToolSpec]) -> Vec<CostLine> {
    specs
        .iter()
        .map(|spec| {
            let encoded = serde_json::to_string(&json!({
                "name": spec.name,
                "description": spec.description,
                "parameters": spec.parameters,
            }))
            .unwrap_or_default();
            CostLine::new(spec.name.clone(), encoded.chars().count())
        })
        .collect()
}

/// Cost of the conversation, per message.
pub fn history_cost(messages: &[Message]) -> Vec<CostLine> {
    messages
        .iter()
        .enumerate()
        .map(|(index, message)| {
            let tokens = estimate_message_tokens(message);
            let text = preview(message);
            let name = format!(
                "#{index} {}{}",
                message.role.as_str(),
                if text.is_empty() {
                    String::new()
                } else {
                    format!(" · {text}")
                }
            );
            CostLine {
                name,
                chars: message.text().chars().count(),
                tokens,
            }
        })
        .collect()
}

impl RequestCost {
    pub fn total_tokens(&self) -> u64 {
        self.system.iter().map(|line| line.tokens).sum::<u64>()
            + self.tools.iter().map(|line| line.tokens).sum::<u64>()
            + self.history.iter().map(|line| line.tokens).sum::<u64>()
            + self.memory.as_ref().map(|line| line.tokens).unwrap_or(0)
    }

    /// The four groups as one number each, which is what decides where to work.
    pub fn group_tokens(&self) -> (u64, u64, u64, u64) {
        (
            self.system.iter().map(|line| line.tokens).sum(),
            self.tools.iter().map(|line| line.tokens).sum(),
            self.history.iter().map(|line| line.tokens).sum(),
            self.memory.as_ref().map(|line| line.tokens).unwrap_or(0),
        )
    }

    pub fn to_json(&self) -> Value {
        let total = self.total_tokens().max(1);
        let with_share = |lines: &[CostLine]| -> Value {
            Value::Array(
                lines
                    .iter()
                    .map(|line| {
                        let mut value = line.to_json();
                        value["share"] =
                            json!((line.tokens as f64 / total as f64 * 1_000.0).round() / 1_000.0);
                        value
                    })
                    .collect(),
            )
        };
        let (system, tools, history, memory) = self.group_tokens();
        json!({
            "totalTokens": self.total_tokens(),
            "groups": {
                "system": system,
                "tools": tools,
                "history": history,
                "memory": memory,
            },
            "system": with_share(&self.system),
            "tools": with_share(&self.tools),
            "history": with_share(&self.history),
            "memory": self.memory.as_ref().map(|line| {
                let mut value = line.to_json();
                value["share"] = json!((line.tokens as f64 / total as f64 * 1_000.0).round() / 1_000.0);
                value
            }),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::prompt::PromptSection;

    fn composed() -> ComposedPrompt {
        ComposedPrompt {
            // A header the sections do not account for.
            system: "header\nYou are Pi.\nskills\n".to_string(),
            sections: vec![
                PromptSection {
                    name: "persona",
                    text: "You are Pi.".to_string(),
                },
                PromptSection {
                    name: "skills",
                    text: String::new(),
                },
            ],
        }
    }

    fn tool(name: &str, description: &str) -> ToolSpec {
        ToolSpec::new(
            name,
            description.to_string(),
            json!({"type": "object", "properties": {}}),
        )
    }

    #[test]
    fn the_system_prompt_is_itemised_and_every_character_is_attributed() {
        let lines = system_cost(&composed());
        let attributed: usize = lines.iter().map(|line| line.chars).sum();
        assert_eq!(
            attributed,
            composed().system.chars().count(),
            "text outside the named sections is still paid for: {lines:?}"
        );
        assert!(lines.iter().any(|line| line.name == "persona"));
        assert!(lines.iter().any(|line| line.name == "(unattributed)"));
    }

    #[test]
    fn every_tool_declaration_is_priced_where_it_is_declared() {
        let lines = tools_cost(&[
            tool("Read", "Read a file."),
            tool("Bash", "Run a command in the session's shell."),
        ]);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].name, "Read");
        assert!(
            lines[1].chars > lines[0].chars,
            "a longer description costs more: {lines:?}"
        );
    }

    #[test]
    fn history_is_priced_per_message_with_a_readable_name() {
        let messages = vec![
            Message::user_text("fix the build please"),
            Message::tool_result(crate::message::ToolResult {
                call_id: "c1".into(),
                name: "Bash".into(),
                content: "output".into(),
                is_error: false,
                truncated: false,
            }),
        ];
        let lines = history_cost(&messages);
        assert_eq!(lines.len(), 2);
        assert!(lines[0].name.starts_with("#0 user"));
        assert!(lines[0].name.contains("fix the build"));
        assert!(
            lines[1].name.contains("Bash"),
            "a tool row is named by its tool: {lines:?}"
        );
    }

    #[test]
    fn the_groups_add_up_to_the_total() {
        let cost = RequestCost {
            system: system_cost(&composed()),
            tools: tools_cost(&[tool("Read", "Read a file.")]),
            history: history_cost(&[Message::user_text("hello")]),
            memory: Some(CostLine::new("memory", 700)),
        };
        let (system, tools, history, memory) = cost.group_tokens();
        assert_eq!(cost.total_tokens(), system + tools + history + memory);
        let json = cost.to_json();
        assert_eq!(json["groups"]["memory"], 200);
        assert!(json["memory"]["share"].as_f64().unwrap() > 0.0);
    }

    #[test]
    fn a_long_message_is_named_by_a_prefix_not_its_whole_body() {
        let long = "word ".repeat(200);
        let lines = history_cost(&[Message::user_text(long)]);
        assert!(
            lines[0].name.chars().count() < 80,
            "the report is for reading: {}",
            lines[0].name
        );
    }
}
