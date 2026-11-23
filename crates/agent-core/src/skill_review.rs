//! The background skill review: one forked run that reads the library and
//! updates it after a turn that taught something.
//!
//! Ported from `skill-review-run.ts`, which in turn ports the reference implementation's
//! `agent/background_review.py`. The shape is the point: the review is not a
//! model asked for a JSON plan of edits, it is a *fork with tools* — it reads the
//! library through `Skill`, writes through the same validated `skill_manage` path
//! the foreground uses, and may record a preference through `memory`. Every write
//! is a tool call, so a malformed answer is impossible in the way a JSON plan can
//! be malformed.
//!
//! The gate is two numbers: tool calls accrued since the last review, and a floor
//! between reviews. Counting happens *before* comparing, because a machine that
//! only ever runs one qualifying turn at a time would otherwise measure each turn
//! against zero and never open the gate.

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::message::Message;

/// Tools the review fork may call. Dispatch stays behind this list.
pub const REVIEW_TOOL_ALLOWLIST: &[&str] =
    &["Skill", "skill_manage", "memory", "Read", "Grep", "Glob"];

/// Iteration ceiling for one review fork (the reference implementation uses the same number).
pub const REVIEW_MAX_ITERATIONS: u32 = 16;

/// A turn that used fewer tools than this taught nothing worth a completion.
///
/// One, not three: the turns that carried the lessons worth keeping were the
/// short ones — a preference, a pitfall, one procedure — and every one of them
/// was skipped when the bar was three. The cooldown, not the tool count, is what
/// keeps the review from running on every turn.
pub const REVIEW_DEFAULT_MIN_TOOL_CALLS: usize = 1;

/// Floor between two reviews of the same session.
pub const REVIEW_DEFAULT_MIN_INTERVAL_SEC: u64 = 120;

/// What the review is told when it answered without calling a single tool.
///
/// Repeated once, then the pass is recorded as `no-tool-calls`. Short on purpose:
/// it is a correction, not a second set of instructions.
pub const SKILL_REVIEW_NO_LOOK_RETRY: &str = "You answered without calling any tool, so you have not seen what the library already covers. Call `Skill` for the most relevant candidate (or `Grep` the skills directory) now, read what comes back, then decide. If the library genuinely needs nothing, say 'Nothing to save.' after that.";

/// The review's own user turn. Verbatim from the reference implementation, with this app's tool names.
pub const SKILL_REVIEW_PROMPT: &str = "Before anything else: look at the library. Call `Skill` with no arguments to list what exists, or `Grep` the skills directory for the topic of this session. Judging whether a lesson is already covered without reading it is the one failure this pass cannot detect from inside — so read first, then decide.\n\nReview the conversation above and update the skill library. Be ACTIVE — most sessions produce at least one skill update, even if small. A pass that does nothing is a missed learning opportunity, not a neutral outcome.\n\nTarget shape of the library: CLASS-LEVEL skills, each with a SKILL.md of always-on rules and a small `references/` set of topical depth. Not a flat list of narrow one-session skills, and not an umbrella hoarding a references/ file per session. This shapes HOW you update, not WHETHER you update.\n\nWhat a skill IS: the instructions for doing a class of task the most efficient and correct way, to THIS user's specifications — the procedure, the tools and commands that work, the order, the user's preferences for how the result should look, and the pitfalls that cost time. A future session should be able to follow it and produce what the user wants on the first try. Everything below is about writing that well:\n  • Procedure first: the steps in the order they are done, with the concrete commands, tool calls, and decision points. Lessons and pitfalls attach to the step they affect.\n  • A pitfall is a generalizable rule + one clause of WHY (the mechanism), imperative. 'Grep the test tree for the SYMBOL before widening a helper signature — hand-rolled mocks reimplement the old shape and fail on a shard you did not run.' Not a narrative of what happened this session.\n  • No PR/issue numbers, dates, ticket IDs, or quoted user text as content — the rule must stand without the incident behind it. Keep a short quote ONLY when the quote itself is the clearest statement of the rule.\n  • The same lesson learned twice is ONE rule. Before adding, search the skill (and its references/) for the rule already stated; strengthen or clarify it rather than appending a second copy.\n  • Not a duplicate of what the environment already teaches: repo AGENTS.md files, tool schema descriptions, and other always-loaded context. A skill carries the WORKFLOW and the pitfalls; it does not restate the codebase map or a tool's parameter list.\n  • Always-on rules (standing user preferences, gates that apply to every instance of the task) live in SKILL.md itself, whole. references/ is for depth that is only needed sometimes: a decision table, a recipe, a domain note — each file topical and reusable, never '<date>-<incident>.md'. Prefer extending an existing references/ file over creating one; a skill with dozens of one-off references is the failure shape, not the goal.\n  • Fix the skill in place when it is wrong: edit the sentence that misled, do not append 'UPDATE: actually...' underneath it.\n\nDo not capture these — they become persistent self-imposed constraints that bite later when the environment changes:\n  • Environment-dependent failures: missing binaries, fresh-install errors, post-migration path mismatches, 'command not found', unconfigured credentials, uninstalled packages. The user can fix these — they are not durable rules.\n  • Negative claims about tools or features ('browser tools do not work', 'X tool is broken', 'cannot use Y from execute_code'). These harden into refusals the agent cites against itself for months after the actual problem was fixed.\n  • Session-specific transient errors that resolved before the conversation ended. If retrying worked, the lesson is the retry pattern, not the original failure.\n  • One-off task narratives. A user asking 'summarize today's market' or 'analyze this PR' is not a class of work that warrants a skill.\n  • Unresolved failures: if the session ended WITHOUT actually finding a working method — you tried several things, none worked, and told the user to check manually — do NOT write those attempts up as a 'reliable workflow' or 'recommended approach'. That presents an untested sequence of failures as validated guidance a future session will trust and repeat. Either say 'Nothing to save', or, only if you are independently confident of a real working alternative (not something you are merely guessing might work), capture ONLY that alternative — never the dead ends, and never dressed up as best practice.\n\nIf a tool failed because of setup state, capture the FIX (install command, config step, env var to set) under an existing setup or troubleshooting skill — never 'this tool does not work' as a standalone constraint.\n\nSignals to look for (any one of these warrants action):\n  • User corrected your style, tone, format, legibility, or verbosity. Frustration signals like 'stop doing X', 'this is too verbose', 'don't format like this', 'why are you explaining', 'just give me the answer', 'you always do Y and I hate it', or an explicit 'remember this' are FIRST-CLASS skill signals, not just memory signals. Update the relevant skill(s) to embed the preference so the next session starts already knowing.\n  • User corrected your workflow, approach, or sequence of steps. Encode the correction as a pitfall or explicit step in the skill that governs that class of task.\n  • Non-trivial technique, fix, workaround, debugging path, or tool-usage pattern emerged that a future session would benefit from. Capture it.\n  • A skill that got loaded or consulted this session turned out to be wrong, missing a step, or outdated. Patch it NOW.\n\nPreference order — prefer the earliest action that fits, but do pick one when a signal above fired:\n  1. UPDATE A CURRENTLY-LOADED SKILL. Look back through the conversation for skills the user loaded or you read with `Skill`. If any of them covers the territory of the new learning, PATCH that one first — re-load it with `Skill` during this review first. It is the skill that was in play, so it is the right one to extend: hand-written, installed, bundled and pinned skills are all yours to improve.\n  2. UPDATE AN EXISTING UMBRELLA (list the library, then `Skill` the candidate). If no loaded skill fits but an existing class-level skill does, patch it. Add a subsection, a pitfall, or broaden a trigger.\n\nFinish by saying what you changed, in one line per action. If the library genuinely needs nothing, say 'Nothing to save.'";

/// The review policy a session launches with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SkillReviewPolicy {
    pub enabled: bool,
    pub after_tool_calls: usize,
    pub min_interval: Duration,
    pub show_quiet_passes: bool,
}

impl Default for SkillReviewPolicy {
    fn default() -> Self {
        Self {
            enabled: true,
            after_tool_calls: REVIEW_DEFAULT_MIN_TOOL_CALLS,
            min_interval: Duration::from_secs(REVIEW_DEFAULT_MIN_INTERVAL_SEC),
            show_quiet_passes: false,
        }
    }
}

impl SkillReviewPolicy {
    /// Read the policy from a prompt's `skillReview` object.
    ///
    /// Absent fields keep the defaults the review has always used. A pass that
    /// wrote nothing is reported only when the reader asked for it: reference only
    /// ever announces a review that changed something, and reporting every quiet
    /// pass turns a useful notice into noise.
    pub fn from_params(value: Option<&Value>) -> Self {
        let Some(object) = value.and_then(Value::as_object) else {
            return Self::default();
        };
        let positive = |key: &str, fallback: usize| {
            object
                .get(key)
                .and_then(Value::as_u64)
                .filter(|value| *value > 0)
                .map(|value| value as usize)
                .unwrap_or(fallback)
        };
        Self {
            enabled: object
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(true),
            after_tool_calls: positive("afterToolCalls", REVIEW_DEFAULT_MIN_TOOL_CALLS),
            min_interval: Duration::from_secs(positive(
                "minIntervalSec",
                REVIEW_DEFAULT_MIN_INTERVAL_SEC as usize,
            ) as u64),
            show_quiet_passes: object
                .get("showQuietPasses")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        }
    }
}

/// The gate that decides whether a finished turn earns a review.
#[derive(Debug, Default)]
pub struct ReviewGate {
    since_last: usize,
    last_review_at: Option<Instant>,
}

/// Why a turn did not earn a review.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReviewSkip {
    Disabled,
    /// Plan and Goal negotiate a contract first; there is nothing to learn from.
    Mode,
    AlreadyRunning,
    TooFewTools,
    Cooldown,
}

impl ReviewSkip {
    pub fn reason(self) -> &'static str {
        match self {
            Self::Disabled => "disabled",
            Self::Mode => "mode",
            Self::AlreadyRunning => "already-running",
            Self::TooFewTools => "too-few-tools",
            Self::Cooldown => "cooldown",
        }
    }
}

impl ReviewGate {
    pub fn new() -> Self {
        Self::default()
    }

    /// Count this turn, then decide.
    ///
    /// The order is the whole function. Comparing first and counting after would
    /// measure the first qualifying turn against zero and throw it away, so a
    /// machine that only ever runs one qualifying turn at a time would never open
    /// the gate and the log would blame `too-few-tools` forever.
    ///
    /// The turn is spent whatever the answer: an aborted or skipped turn was paid
    /// for in tool calls, and carrying them into a later turn would let one long
    /// turn qualify an unrelated short one.
    pub fn qualify(
        &mut self,
        policy: SkillReviewPolicy,
        this_turn_tool_calls: usize,
        now: Instant,
    ) -> Result<(), ReviewSkip> {
        self.since_last += this_turn_tool_calls;
        if !policy.enabled {
            return Err(ReviewSkip::Disabled);
        }
        if self.since_last < policy.after_tool_calls {
            return Err(ReviewSkip::TooFewTools);
        }
        if let Some(last) = self.last_review_at {
            if now.duration_since(last) < policy.min_interval {
                return Err(ReviewSkip::Cooldown);
            }
        }
        Ok(())
    }

    /// Record that a review ran, which resets both numbers.
    pub fn record_review(&mut self, now: Instant) {
        self.since_last = 0;
        self.last_review_at = Some(now);
    }
}

/// One write a review fork completed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewAction {
    pub kind: ReviewActionKind,
    pub subject: String,
    pub file: Option<String>,
    pub preview: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReviewActionKind {
    Created,
    Patched,
    Wrote,
    Removed,
    Memory,
}

impl ReviewActionKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Created => "created",
            Self::Patched => "patched",
            Self::Wrote => "wrote",
            Self::Removed => "removed",
            Self::Memory => "memory",
        }
    }
}

/// Characters of the written text kept for the report line.
const PREVIEW_CHARS: usize = 120;

fn clip_preview(text: &str) -> String {
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= PREVIEW_CHARS {
        return collapsed;
    }
    let head: String = collapsed.chars().take(PREVIEW_CHARS).collect();
    format!("{head}…")
}

/// What a tool call wrote, if it wrote anything.
///
/// A read of the store is not an action, and neither is a `skill_manage` call
/// that failed validation: only a write with something in it counts.
pub fn review_action_from_call(tool_name: &str, arguments: &Value) -> Option<ReviewAction> {
    let text = |key: &str| {
        arguments
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    };
    if tool_name == "memory" {
        let subject = text("target").unwrap_or_else(|| "memory".to_string());
        let body = text("content")
            .or_else(|| text("old_text"))
            .or_else(|| text("text"))?;
        return Some(ReviewAction {
            kind: ReviewActionKind::Memory,
            subject,
            file: None,
            preview: Some(clip_preview(&body)),
        });
    }
    if tool_name != "skill_manage" {
        return None;
    }
    let action = text("action")?;
    let subject = text("name")
        .or_else(|| text("skill"))
        .or_else(|| text("id"))?;
    let file = text("file_path");
    let kind = match action.as_str() {
        "create" => ReviewActionKind::Created,
        "patch" | "edit" => ReviewActionKind::Patched,
        "write_file" => ReviewActionKind::Wrote,
        "remove_file" => ReviewActionKind::Removed,
        _ => return None,
    };
    let preview = match kind {
        ReviewActionKind::Patched => text("new_string")
            .or_else(|| text("body"))
            .or_else(|| text("content"))
            .map(|written| clip_preview(&written)),
        _ => None,
    };
    Some(ReviewAction {
        kind,
        subject,
        file,
        preview,
    })
}

/// One human-facing line per action, the way the reference implementation reports a review pass.
pub fn describe_review_action(action: &ReviewAction) -> String {
    let where_ = match &action.file {
        Some(file) => format!("{}/{}", action.subject, file),
        None => action.subject.clone(),
    };
    if action.kind == ReviewActionKind::Memory {
        let target = if action.subject == "user" {
            "user memory"
        } else {
            "memory"
        };
        return match &action.preview {
            Some(preview) => format!("{target}: {preview}"),
            None => format!("{target} updated"),
        };
    }
    match &action.preview {
        Some(preview) => format!("{} '{where_}' — {preview}", action.kind.as_str()),
        None => format!("{} '{where_}'", action.kind.as_str()),
    }
}

/// Collects the fork's completed tool calls from its event stream.
///
/// The run reports counts, not calls, so the summary has to be built while the
/// fork runs. A call is only reported once its result came back without an error,
/// and a result whose start was never seen is ignored rather than guessed at.
#[derive(Debug, Default)]
pub struct ReviewActionCollector {
    pending: HashMap<String, (String, Value)>,
    calls: Vec<(String, Value, bool)>,
}

impl ReviewActionCollector {
    pub fn new() -> Self {
        Self::default()
    }

    /// Completed tool calls. Zero means the fork answered without looking.
    pub fn tool_call_count(&self) -> usize {
        self.calls.len()
    }

    pub fn start(&mut self, tool_call_id: &str, tool_name: &str, arguments: &Value) {
        self.pending.insert(
            tool_call_id.to_string(),
            (tool_name.to_string(), arguments.clone()),
        );
    }

    pub fn end(&mut self, tool_call_id: &str, is_error: bool) {
        let Some((tool_name, arguments)) = self.pending.remove(tool_call_id) else {
            return;
        };
        self.calls.push((tool_name, arguments, is_error));
    }

    /// The writes the fork completed, as report lines.
    pub fn action_lines(&self) -> Vec<String> {
        let mut seen = HashSet::new();
        let mut lines = Vec::new();
        for (tool_name, arguments, is_error) in &self.calls {
            if *is_error {
                continue;
            }
            let Some(action) = review_action_from_call(tool_name, arguments) else {
                continue;
            };
            let line = describe_review_action(&action);
            if seen.insert(line.clone()) {
                lines.push(line);
            }
        }
        lines
    }

    /// The same writes as `action_lines`, structured.
    ///
    /// `{kind, subject, file}` is everything a client needs to render the write
    /// in its own words; the rendered line above is English and cannot be
    /// translated after the fact.
    pub fn action_details(&self) -> Vec<Value> {
        let mut seen = HashSet::new();
        let mut details = Vec::new();
        for (tool_name, arguments, is_error) in &self.calls {
            if *is_error {
                continue;
            }
            let Some(action) = review_action_from_call(tool_name, arguments) else {
                continue;
            };
            let value = json!({
                "kind": action.kind.as_str(),
                "subject": action.subject,
                "file": action.file,
            });
            if seen.insert(value.to_string()) {
                details.push(value);
            }
        }
        details
    }
}

/// The outcome a review pass reports.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewNotice {
    pub outcome: ReviewOutcome,
    pub reason: Option<String>,
    /// One rendered line per write, for logs and for clients that only print.
    pub actions: Vec<String>,
    /// The same writes, structured, so a renderer can say "skill 'x' wrote
    /// references/y.md" in the user's own language instead of echoing English.
    pub details: Vec<Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReviewOutcome {
    Applied,
    Skipped,
    Failed,
}

impl ReviewOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Applied => "applied",
            Self::Skipped => "skipped",
            Self::Failed => "failed",
        }
    }
}

impl ReviewNotice {
    pub fn skipped(reason: impl Into<String>) -> Self {
        Self {
            outcome: ReviewOutcome::Skipped,
            reason: Some(reason.into()),
            actions: Vec::new(),
            details: Vec::new(),
        }
    }

    pub fn failed(reason: impl Into<String>) -> Self {
        Self {
            outcome: ReviewOutcome::Failed,
            reason: Some(reason.into()),
            actions: Vec::new(),
            details: Vec::new(),
        }
    }

    /// Build the notice from what the fork did.
    ///
    /// A pass that read the library and changed nothing is `skipped` with
    /// `nothing-to-save`; a pass that answered without looking is
    /// `no-tool-calls`, which is a failed pass rather than a quiet one.
    pub fn from_collector(collector: &ReviewActionCollector) -> Self {
        let actions = collector.action_lines();
        if !actions.is_empty() {
            return Self {
                outcome: ReviewOutcome::Applied,
                reason: None,
                actions,
                details: collector.action_details(),
            };
        }
        if collector.tool_call_count() == 0 {
            return Self {
                outcome: ReviewOutcome::Failed,
                reason: Some("no-tool-calls".to_string()),
                actions: Vec::new(),
                details: Vec::new(),
            };
        }
        Self::skipped("nothing-to-save")
    }

    /// Whether this notice is worth telling the user about.
    ///
    /// A quiet pass is the normal answer, and reporting it on every qualifying
    /// turn is noise; a write and a failure always report.
    pub fn is_visible(&self, policy: SkillReviewPolicy) -> bool {
        if self.outcome != ReviewOutcome::Skipped {
            return true;
        }
        policy.show_quiet_passes || self.reason.as_deref() != Some("nothing-to-save")
    }
}

/// The transcript the fork starts from: the session's own turns, then its prompt.
///
/// The review reads the conversation; giving it the history is what lets it judge
/// whether a lesson was already visible in the work. The system prompt is left to
/// the fork's own composition.
pub fn review_transcript(history: &[Message]) -> Vec<Message> {
    let mut messages: Vec<Message> = history
        .iter()
        .filter(|message| message.role != crate::message::Role::System)
        .cloned()
        .collect();
    messages.push(Message::user_text(SKILL_REVIEW_PROMPT));
    messages
}

/// The event a finished review emits.
pub fn review_event(notice: &ReviewNotice) -> Value {
    let mut event = json!({
        "type": "skill_review",
        "outcome": notice.outcome.as_str(),
    });
    if let Some(reason) = &notice.reason {
        event["reason"] = json!(reason);
    }
    if !notice.actions.is_empty() {
        event["actions"] = json!(notice.actions);
    }
    if !notice.details.is_empty() {
        event["actionDetails"] = json!(notice.details);
    }
    event
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy() -> SkillReviewPolicy {
        SkillReviewPolicy::default()
    }

    #[test]
    fn the_first_qualifying_turn_opens_the_gate() {
        // Regression: comparing before counting threw this turn away, and a
        // machine running one qualifying turn at a time never reviewed at all.
        let mut gate = ReviewGate::new();
        assert_eq!(gate.qualify(policy(), 1, Instant::now()), Ok(()));
    }

    #[test]
    fn a_turn_with_no_tools_does_not_open_it() {
        let mut gate = ReviewGate::new();
        assert_eq!(
            gate.qualify(policy(), 0, Instant::now()),
            Err(ReviewSkip::TooFewTools)
        );
    }

    #[test]
    fn the_cooldown_holds_a_second_review_back() {
        let now = Instant::now();
        let mut gate = ReviewGate::new();
        assert_eq!(gate.qualify(policy(), 1, now), Ok(()));
        gate.record_review(now);
        assert_eq!(
            gate.qualify(policy(), 1, now + Duration::from_secs(5)),
            Err(ReviewSkip::Cooldown)
        );
        assert_eq!(
            gate.qualify(policy(), 1, now + Duration::from_secs(121)),
            Ok(()),
            "the floor has passed"
        );
    }

    #[test]
    fn a_disabled_or_wrong_mode_session_never_reviews() {
        let mut gate = ReviewGate::new();
        let disabled = SkillReviewPolicy {
            enabled: false,
            ..policy()
        };
        assert_eq!(
            gate.qualify(disabled, 5, Instant::now()),
            Err(ReviewSkip::Disabled)
        );
    }

    #[test]
    fn spent_tool_calls_are_not_carried_into_a_later_turn() {
        // The review resets the count; a skipped turn still spends what it used.
        let now = Instant::now();
        let mut gate = ReviewGate::new();
        assert_eq!(gate.qualify(policy(), 0, now), Err(ReviewSkip::TooFewTools));
        gate.record_review(now);
        assert_eq!(
            gate.qualify(policy(), 0, now + Duration::from_secs(200)),
            Err(ReviewSkip::TooFewTools),
            "the earlier turn's spend is not a credit"
        );
    }

    #[test]
    fn a_skill_write_is_reported_as_a_line_a_person_can_read() {
        let action = review_action_from_call(
            "skill_manage",
            &json!({
                "action": "patch",
                "name": "rust-agent-kernel-port",
                "new_string": "Grep the test tree for the symbol first."
            }),
        )
        .expect("a patch is an action");
        assert_eq!(action.kind, ReviewActionKind::Patched);
        assert_eq!(
            describe_review_action(&action),
            "patched 'rust-agent-kernel-port' — Grep the test tree for the symbol first."
        );
    }

    #[test]
    fn the_event_carries_the_parts_a_client_translates() {
        // `actions` is English prose; a renderer that has to say the same thing in
        // another language needs the parts, not the sentence.
        let mut collector = ReviewActionCollector::new();
        let arguments = json!({"action": "write_file", "name": "pi-desktop-dev", "file_path": "references/x.md"});
        collector.start("c1", "skill_manage", &arguments);
        collector.end("c1", false);
        let notice = ReviewNotice::from_collector(&collector);
        let event = review_event(&notice);
        assert_eq!(event["outcome"], "applied");
        assert_eq!(event["actionDetails"][0]["kind"], "wrote");
        assert_eq!(event["actionDetails"][0]["subject"], "pi-desktop-dev");
        assert_eq!(event["actionDetails"][0]["file"], "references/x.md");
    }

    #[test]
    fn a_reference_file_write_names_the_file() {
        let action = review_action_from_call(
            "skill_manage",
            &json!({"action": "write_file", "name": "pi-desktop-dev", "file_path": "references/build.md"}),
        )
        .expect("a file write is an action");
        assert_eq!(
            describe_review_action(&action),
            "wrote 'pi-desktop-dev/references/build.md'"
        );
    }

    #[test]
    fn reads_and_failed_writes_are_not_actions() {
        assert!(review_action_from_call("Skill", &json!({"id": "x"})).is_none());
        assert!(review_action_from_call("skill_manage", &json!({"action": "patch"})).is_none());
        assert!(review_action_from_call("memory", &json!({"query": "rust"})).is_none());
        let mut collector = ReviewActionCollector::new();
        collector.start(
            "c1",
            "skill_manage",
            &json!({"action": "create", "name": "x"}),
        );
        collector.end("c1", true);
        assert!(
            collector.action_lines().is_empty(),
            "a failed write changed nothing"
        );
    }

    #[test]
    fn a_memory_write_reads_as_a_preference() {
        let action = review_action_from_call(
            "memory",
            &json!({"target": "user", "content": "Prefers terse reports."}),
        )
        .expect("a memory write is an action");
        assert_eq!(
            describe_review_action(&action),
            "user memory: Prefers terse reports."
        );
    }

    #[test]
    fn a_pass_that_looked_and_wrote_nothing_is_quiet() {
        let mut collector = ReviewActionCollector::new();
        collector.start("c1", "Skill", &json!({"id": "pi-desktop-dev"}));
        collector.end("c1", false);
        let notice = ReviewNotice::from_collector(&collector);
        assert_eq!(notice.outcome, ReviewOutcome::Skipped);
        assert_eq!(notice.reason.as_deref(), Some("nothing-to-save"));
        assert!(
            !notice.is_visible(policy()),
            "quiet passes stay out of the chat"
        );
        assert!(notice.is_visible(SkillReviewPolicy {
            show_quiet_passes: true,
            ..policy()
        }));
    }

    #[test]
    fn a_pass_that_never_looked_is_a_failure_not_a_quiet_pass() {
        let notice = ReviewNotice::from_collector(&ReviewActionCollector::new());
        assert_eq!(notice.outcome, ReviewOutcome::Failed);
        assert_eq!(notice.reason.as_deref(), Some("no-tool-calls"));
        assert!(notice.is_visible(policy()));
    }

    #[test]
    fn the_event_carries_what_changed() {
        let mut collector = ReviewActionCollector::new();
        collector.start(
            "c1",
            "skill_manage",
            &json!({"action": "create", "name": "new-skill"}),
        );
        collector.end("c1", false);
        let event = review_event(&ReviewNotice::from_collector(&collector));
        assert_eq!(event["type"], "skill_review");
        assert_eq!(event["outcome"], "applied");
        assert_eq!(event["actions"][0], "created 'new-skill'");
        assert!(event.get("reason").is_none(), "a write needs no excuse");
    }

    #[test]
    fn the_fork_sees_the_conversation_and_then_its_own_prompt() {
        let history = vec![
            Message::system_text("be brief"),
            Message::user_text("fix the build"),
        ];
        let transcript = review_transcript(&history);
        assert!(transcript
            .iter()
            .all(|message| message.role != crate::message::Role::System));
        assert_eq!(transcript.len(), 2, "the user turn plus the review prompt");
        assert_eq!(transcript[1].text(), SKILL_REVIEW_PROMPT);
    }
}
