//! The system-prompt journal: a durable record of what the model was told.
//!
//! The system prompt is composed fresh every turn — persona, tool guidance,
//! project instructions, the skill catalogue — and none of it appears in the
//! visible transcript. Without a record, a session that is restored later cannot
//! reproduce the prompt it ran with, and a support bundle cannot show what the
//! model was actually given. Host-core keeps one row per distinct prompt: the
//! renderer hides it, and the transcript's system rows are ordered around the
//! user message that followed them.
//!
//! Two decisions shape this module.
//!
//! A row is written once per distinct serialization. The composed prompt is
//! usually identical between turns of a session, and a copy per turn would grow
//! the store without adding information; the row is keyed by the prompt itself,
//! so a prompt that changes (a new instruction file, a skill removed) is recorded
//! as a new row.
//!
//! The row is written *before* dispatch. A prompt that was never recorded cannot
//! be reproduced afterwards, so a failed write fails the request instead of
//! leaving behind a turn the store does not know about — retrying the provider
//! cannot repair a durable write that never landed.

use std::collections::HashSet;

use serde_json::{json, Value};

use crate::prompt::ComposedPrompt;

/// Keeps the serializations this session has already journaled.
#[derive(Debug, Default)]
pub struct SystemJournal {
    seen: HashSet<String>,
}

impl SystemJournal {
    pub fn new() -> Self {
        Self::default()
    }

    /// The row to persist for this prompt, or `None` when it is already on file.
    ///
    /// `key` identifies the *prompt*, which is why it comes from
    /// [`system_message_key`] and not from the serialized message: the message
    /// carries the timestamp it was sent at, so it differs on every turn even
    /// when the model was told exactly the same thing.
    ///
    /// `before_message_id` names the user message the prompt preceded, so the
    /// transcript can place the row where it belongs even though the user's row
    /// may have been written first.
    pub fn row(
        &mut self,
        key: &str,
        message_json: &str,
        before_message_id: Option<&str>,
        created_at_ms: i64,
    ) -> Option<Value> {
        if !self.seen.insert(key.to_string()) {
            return None;
        }
        let mut model_system = json!({
            "version": 1,
            "messageJson": message_json,
        });
        if let Some(id) = before_message_id {
            model_system["beforeMessageId"] = json!(id);
        }
        Some(json!({
            "id": uuid::Uuid::new_v4().to_string(),
            "role": "system",
            // The prompt lives in `modelSystem`, never in `content`: the visible
            // row is empty, which is what keeps it out of the chat.
            "content": "",
            "createdAt": iso8601(created_at_ms),
            "modelSystem": model_system,
        }))
    }
}

/// What makes two prompts the same prompt: its text and the blocks it came from.
///
/// The timestamp is deliberately not part of it. Identity is what the model was
/// told, and a turn that told it the same thing has nothing new to record.
pub fn system_message_key(composed: &ComposedPrompt) -> String {
    let sections: Vec<(&str, &str)> = composed
        .sections
        .iter()
        .map(|section| (section.name, section.text.as_str()))
        .collect();
    json!({ "content": composed.system, "sections": sections }).to_string()
}

/// The system message as the model received it, serialized for the journal.
///
/// `content` is the text that was sent; `sections` keeps the blocks it was
/// assembled from, so a reader can tell a prompt that changed because the
/// persona changed from one that changed because an instruction file did.
pub fn system_message_json(composed: &ComposedPrompt, timestamp_ms: i64) -> String {
    let sections: serde_json::Map<String, Value> = composed
        .sections
        .iter()
        .map(|section| {
            let value = if section.text.trim().is_empty() {
                Value::Null
            } else {
                json!(section.text)
            };
            (section.name.to_string(), value)
        })
        .collect();
    json!({
        "role": "system",
        "content": composed.system,
        "timestamp": timestamp_ms,
        "sections": Value::Object(sections),
    })
    .to_string()
}

/// `yyyy-mm-ddThh:mm:ss.sssZ` from milliseconds since the Unix epoch.
///
/// No date crate is a dependency of this kernel, and the only format needed here
/// is the one the store already uses.
pub fn iso8601(epoch_ms: i64) -> String {
    let millis = epoch_ms.rem_euclid(1_000);
    let seconds = epoch_ms.div_euclid(1_000);
    let days = seconds.div_euclid(86_400);
    let second_of_day = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = second_of_day / 3_600;
    let minute = (second_of_day % 3_600) / 60;
    let second = second_of_day % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

/// Days since 1970-01-01 to a proleptic Gregorian date (H. Hinnant's algorithm).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::prompt::PromptSection;

    fn composed() -> ComposedPrompt {
        ComposedPrompt {
            system: "You are Pi.".to_string(),
            sections: vec![
                PromptSection {
                    name: "persona",
                    text: "You are Pi.".to_string(),
                },
                PromptSection {
                    name: "instructions",
                    text: String::new(),
                },
            ],
        }
    }

    /// Record `composed` as sent at `at_ms`, the way a turn does.
    fn record(
        journal: &mut SystemJournal,
        composed: &ComposedPrompt,
        before: Option<&str>,
        at_ms: i64,
    ) -> Option<Value> {
        journal.row(
            &system_message_key(composed),
            &system_message_json(composed, at_ms),
            before,
            at_ms,
        )
    }

    #[test]
    fn a_prompt_is_journaled_once_however_many_turns_send_it() {
        let mut journal = SystemJournal::new();
        assert!(record(&mut journal, &composed(), Some("u1"), 1_700_000_000_000).is_some());
        // The next turn sends the same prompt at a later moment. The model was
        // told nothing new, so nothing new is written — a per-turn row would grow
        // every session by one copy of the same text.
        assert!(
            record(&mut journal, &composed(), Some("u2"), 1_700_000_100_000).is_none(),
            "an unchanged prompt is not a second row"
        );

        // A prompt that actually changed *is* recorded: making that difference
        // visible is the whole job.
        let changed = ComposedPrompt {
            system: "You are Pi, in Plan mode.".to_string(),
            sections: composed().sections,
        };
        assert!(record(&mut journal, &changed, None, 1_700_000_200_000).is_some());
    }

    #[test]
    fn a_changed_section_is_a_changed_prompt() {
        let mut journal = SystemJournal::new();
        assert!(record(&mut journal, &composed(), None, 1).is_some());
        // Same text, new instruction block: the prompt the model receives
        // changed, so the record has to change with it.
        let mut with_instructions = composed();
        with_instructions.sections[1].text = "Always run the tests.".to_string();
        assert!(record(&mut journal, &with_instructions, None, 2).is_some());
    }

    #[test]
    fn the_row_hides_the_prompt_behind_model_system() {
        let mut journal = SystemJournal::new();
        let row = record(&mut journal, &composed(), Some("u1"), 1_700_000_000_000).unwrap();
        assert_eq!(row["role"], "system");
        assert_eq!(row["content"], "", "the visible row stays empty");
        assert_eq!(row["modelSystem"]["version"], 1);
        assert_eq!(row["modelSystem"]["beforeMessageId"], "u1");
        assert!(row["id"].as_str().is_some_and(|id| !id.is_empty()));
        let restored: Value =
            serde_json::from_str(row["modelSystem"]["messageJson"].as_str().unwrap()).unwrap();
        assert_eq!(restored["content"], "You are Pi.");
        assert_eq!(restored["sections"]["persona"], "You are Pi.");
        assert_eq!(
            restored["sections"]["instructions"],
            Value::Null,
            "an empty block is recorded as absent, not as empty text"
        );
    }

    #[test]
    fn a_row_without_a_following_message_still_validates() {
        let mut journal = SystemJournal::new();
        let row = record(&mut journal, &composed(), None, 0).unwrap();
        assert!(
            row["modelSystem"].get("beforeMessageId").is_none(),
            "the field is omitted rather than written as null"
        );
    }

    #[test]
    fn timestamps_render_in_the_store_format() {
        assert_eq!(iso8601(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso8601(1), "1970-01-01T00:00:00.001Z");
        assert_eq!(iso8601(1_700_000_000_123), "2023-11-14T22:13:20.123Z");
        // A leap day, because the day arithmetic is the part most likely wrong.
        assert_eq!(iso8601(1_709_164_800_000), "2024-02-29T00:00:00.000Z");
    }

    #[test]
    fn a_time_before_the_epoch_is_still_a_date() {
        // Rem-corrected rather than truncated, so the value stays readable
        // instead of turning into a negative day count.
        assert_eq!(iso8601(-1), "1969-12-31T23:59:59.999Z");
    }
}
