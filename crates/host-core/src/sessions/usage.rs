//! Durable physical-request accounting in the existing turn JSON column.
//! No transcript row, second database, or schema migration is needed.

use anyhow::{anyhow, Result};
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Map, Value};

use crate::db::Database;

const TOKENS: [&str; 6] = [
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "reasoningTokens",
    "totalTokens",
];
const COSTS: [&str; 5] = ["input", "output", "cacheRead", "cacheWrite", "total"];

fn operations(usage: &Value) -> Vec<Value> {
    if let Some(records) = usage
        .get("operations")
        .and_then(Value::as_array)
        .filter(|v| !v.is_empty())
    {
        return records.clone();
    }
    if usage.get("operationId").and_then(Value::as_str).is_some() {
        let mut record = usage.clone();
        if let Some(object) = record.as_object_mut() {
            object.remove("operations");
            object.remove("aggregation");
        }
        return vec![record];
    }
    vec![]
}

fn count(value: &Value, key: &str) -> i64 {
    value.get(key).and_then(Value::as_i64).unwrap_or(0).max(0)
}

fn known_cost(record: &Value) -> bool {
    record.get("costStatus").and_then(Value::as_str) != Some("unknown")
        && COSTS.iter().all(|key| {
            record
                .get("cost")
                .and_then(|c| c.get(key))
                .and_then(Value::as_f64)
                .is_some_and(|n| n.is_finite() && n >= 0.0)
        })
}
fn sum_counts(records: &[Value], key: &str) -> i64 {
    records.iter().fold(0_i64, |total, record| {
        total.saturating_add(count(record, key))
    })
}
fn validate(usage: &Value) -> Result<()> {
    let records = operations(usage);
    if records.is_empty() {
        return Err(anyhow!("usage requires a physical operation identity"));
    }
    for record in records {
        if record
            .get("operationId")
            .and_then(Value::as_str)
            .is_none_or(str::is_empty)
        {
            return Err(anyhow!("usage operationId required"));
        }
        for key in TOKENS {
            if record.get(key).is_none()
                && !["inputTokens", "outputTokens", "totalTokens"].contains(&key)
            {
                continue;
            }
            if record
                .get(key)
                .and_then(Value::as_i64)
                .is_none_or(|v| v < 0)
            {
                return Err(anyhow!("invalid usage token count"));
            }
        }
    }
    Ok(())
}

/// End-turn is a snapshot, not another charge. Union its ledger with requests
/// already persisted before the process stopped. Legacy token-only snapshots
/// retain their historical replacement semantics.
pub(super) fn merge_usage(existing: Option<&Value>, incoming: &Value) -> Value {
    let Some(existing) = existing else {
        return incoming.clone();
    };
    let left = operations(existing);
    let right = operations(incoming);
    if left.is_empty() && right.is_empty() {
        return incoming.clone();
    }
    let mut records: Vec<Value> = Vec::new();
    for record in left.iter().chain(&right) {
        let Some(id) = record.get("operationId").and_then(Value::as_str) else {
            continue;
        };
        if let Some(index) = records
            .iter()
            .position(|v| v.get("operationId").and_then(Value::as_str) == Some(id))
        {
            let previous = &records[index];
            let incoming_count = count(record, "totalTokens");
            let previous_count = count(previous, "totalTokens");
            if incoming_count > previous_count
                || (incoming_count == previous_count
                    && (!known_cost(previous)
                        || (known_cost(record)
                            && record.get("costStatus").and_then(Value::as_str)
                                == Some("reported"))))
            {
                records[index] = record.clone();
            }
        } else {
            records.push(record.clone());
        }
    }
    let mut merged = Map::new();
    let mut has_legacy = false;
    for key in TOKENS {
        let left_count: i64 = sum_counts(&left, key);
        let right_count: i64 = sum_counts(&right, key);
        let residual = count(existing, key)
            .saturating_sub(left_count)
            .max(count(incoming, key).saturating_sub(right_count))
            .max(0);
        has_legacy |= residual > 0;
        let total = sum_counts(&records, key).saturating_add(residual);
        if total > 0
            || ["inputTokens", "outputTokens", "totalTokens"].contains(&key)
            || existing.get(key).is_some()
            || incoming.get(key).is_some()
        {
            merged.insert(key.into(), json!(total));
        }
    }
    let known = !has_legacy
        && records.iter().all(known_cost)
        && COSTS.iter().all(|key| {
            records
                .iter()
                .filter_map(|v| v.get("cost")?.get(key)?.as_f64())
                .sum::<f64>()
                .is_finite()
        });
    if known {
        let mut cost = Map::new();
        for key in COSTS {
            let total: f64 = records
                .iter()
                .filter_map(|v| v.get("cost")?.get(key)?.as_f64())
                .sum();
            cost.insert(key.into(), json!(total));
        }
        merged.insert("cost".into(), Value::Object(cost));
        let reported = records
            .iter()
            .all(|v| v.get("costStatus").and_then(Value::as_str) == Some("reported"));
        merged.insert(
            "costStatus".into(),
            json!(if reported { "reported" } else { "estimated" }),
        );
    } else {
        merged.insert("costStatus".into(), json!("unknown"));
    }
    merged.insert("aggregation".into(), json!("aggregate"));
    merged.insert("operations".into(), Value::Array(records));
    Value::Object(merged)
}

/// The immutable session/turn pair is checked even when a durable outbox is
/// replayed after shutdown. Late writes may complete the old turn's bill, never
/// the newer turn's. Deleted sessions/turns are not recreated.
pub fn record_usage(db: &Database, session_id: &str, turn_id: &str, usage: &Value) -> Result<bool> {
    validate(usage)?;
    let existing: Option<Option<String>> = db
        .conn()
        .query_row(
            "SELECT usage_json FROM turns WHERE id = ?1 AND session_id = ?2",
            params![turn_id, session_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(existing) = existing else {
        return Ok(false);
    };
    let parsed = existing
        .as_deref()
        .map(serde_json::from_str::<Value>)
        .transpose()?;
    let merged = merge_usage(parsed.as_ref(), usage);
    db.conn().execute(
        "UPDATE turns SET usage_json = ?1, input_tokens = ?2, output_tokens = ?3 WHERE id = ?4 AND session_id = ?5",
        params![merged.to_string(), count(&merged, "inputTokens"), count(&merged, "outputTokens"), turn_id, session_id],
    )?;
    Ok(true)
}

/// Operation id prefix the kernel gives a settled delegation's spend.
pub const DELEGATION_OPERATION_PREFIX: &str = "delegation:";

/// What one session has spent, summed over every turn it has run.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTotals {
    pub turns: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    /// Already part of `outputTokens`; reported for the breakdown only.
    pub reasoning_tokens: i64,
    /// The delegated share of the five counts above, from `delegation:<id>`
    /// operations. Subtracting these leaves the orchestrating model's own spend, so
    /// the status bar can show both halves of a smart-mode turn without a second
    /// query or a second total.
    pub worker_input_tokens: i64,
    pub worker_output_tokens: i64,
    pub worker_cache_read_tokens: i64,
    pub worker_cache_write_tokens: i64,
    pub worker_reasoning_tokens: i64,
}

/// Token totals for one session, from its first turn.
///
/// The caller cannot derive this from a transcript: the renderer's window is
/// bounded and older turns drop out of it, while the status bar is supposed to
/// count the whole session. Turns the user deleted are gone with their rows,
/// which is exactly what the ledger itself says.
pub fn session_totals(db: &Database, session_id: &str) -> Result<SessionTotals> {
    let mut statement = db.conn().prepare(
        "SELECT input_tokens, output_tokens, usage_json FROM turns WHERE session_id = ?1",
    )?;
    let mut totals = SessionTotals::default();
    let mut rows = statement.query(params![session_id])?;
    while let Some(row) = rows.next()? {
        totals.turns = totals.turns.saturating_add(1);
        totals.input_tokens = totals
            .input_tokens
            .saturating_add(row.get::<_, Option<i64>>(0)?.unwrap_or(0).max(0));
        totals.output_tokens = totals
            .output_tokens
            .saturating_add(row.get::<_, Option<i64>>(1)?.unwrap_or(0).max(0));
        // Cache and reasoning live in the merged usage document only; the token
        // columns carry the prompt/completion pair the ledger bills on.
        let usage: Option<String> = row.get(2)?;
        let Some(parsed) = usage
            .as_deref()
            .and_then(|text| serde_json::from_str::<Value>(text).ok())
        else {
            continue;
        };
        let token = |key: &str| parsed.get(key).and_then(Value::as_i64).unwrap_or(0).max(0);
        // A delegated request is a physical request like any other: it is already in
        // the totals above. Counting it again here would inflate the session, so this
        // only sizes the worker's share of what was just added.
        if let Some(operations) = parsed.get("operations").and_then(Value::as_array) {
            for operation in operations {
                let id = operation.get("operationId").and_then(Value::as_str).unwrap_or("");
                if !id.starts_with(DELEGATION_OPERATION_PREFIX) {
                    continue;
                }
                let count = |key: &str| {
                    operation
                        .get(key)
                        .and_then(Value::as_i64)
                        .unwrap_or(0)
                        .max(0)
                };
                totals.worker_input_tokens = totals
                    .worker_input_tokens
                    .saturating_add(count("inputTokens"));
                totals.worker_output_tokens = totals
                    .worker_output_tokens
                    .saturating_add(count("outputTokens"));
                totals.worker_cache_read_tokens = totals
                    .worker_cache_read_tokens
                    .saturating_add(count("cacheReadTokens"));
                totals.worker_cache_write_tokens = totals
                    .worker_cache_write_tokens
                    .saturating_add(count("cacheWriteTokens"));
                totals.worker_reasoning_tokens = totals
                    .worker_reasoning_tokens
                    .saturating_add(count("reasoningTokens"));
            }
        }
        totals.cache_read_tokens = totals
            .cache_read_tokens
            .saturating_add(token("cacheReadTokens"));
        totals.cache_write_tokens = totals
            .cache_write_tokens
            .saturating_add(token("cacheWriteTokens"));
        totals.reasoning_tokens = totals
            .reasoning_tokens
            .saturating_add(token("reasoningTokens"));
    }
    Ok(totals)
}

#[derive(Default)]
struct CostBucket {
    total: f64,
    priced: i64,
    reported: i64,
    unpriced: i64,
}

/// Read-only cost rollup for one session, grouped by the physical provider that
/// served each request. Every turn status counts: aborted and failed requests
/// were still billed. A request without a usable price is counted, never
/// guessed, so callers can say the total is a lower bound.
pub fn session_usage_cost(db: &Database, session_id: &str) -> Result<Value> {
    let mut stmt = db.conn().prepare_cached(
        "SELECT usage_json, input_tokens, output_tokens FROM turns WHERE session_id = ?1",
    )?;
    let rows = stmt.query_map(params![session_id], |row| {
        Ok((
            row.get::<_, Option<String>>(0)?,
            row.get::<_, Option<i64>>(1)?.unwrap_or(0),
            row.get::<_, Option<i64>>(2)?.unwrap_or(0),
        ))
    })?;
    let mut buckets: std::collections::BTreeMap<Option<String>, CostBucket> = Default::default();
    let mut turn_count = 0_i64;
    let mut request_count = 0_i64;
    for row in rows {
        let (usage_json, input_tokens, output_tokens) = row?;
        let usage = usage_json
            .as_deref()
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok());
        let records = usage.as_ref().map(operations).unwrap_or_default();
        let recorded_tokens = usage
            .as_ref()
            .map(|u| count(u, "totalTokens"))
            .unwrap_or(0)
            .max(input_tokens.max(0).saturating_add(output_tokens.max(0)));
        if records.is_empty() && recorded_tokens == 0 {
            continue;
        }
        turn_count += 1;
        for record in &records {
            let provider = record
                .get("providerId")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .map(str::to_owned);
            let bucket = buckets.entry(provider).or_default();
            request_count += 1;
            if known_cost(record) {
                bucket.priced += 1;
                bucket.total += record
                    .get("cost")
                    .and_then(|c| c.get("total"))
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0);
                if record.get("costStatus").and_then(Value::as_str) == Some("reported") {
                    bucket.reported += 1;
                }
            } else {
                bucket.unpriced += 1;
            }
        }
        // Token-only legacy turns, or legacy totals beside a ledger, cannot be
        // attributed to a provider or priced after the fact.
        if recorded_tokens > sum_counts(&records, "totalTokens")
            && (records.is_empty()
                || usage
                    .as_ref()
                    .and_then(|u| u.get("aggregation"))
                    .and_then(Value::as_str)
                    == Some("aggregate"))
        {
            buckets.entry(None).or_default().unpriced += 1;
            request_count += 1;
        }
    }
    let providers: Vec<Value> = buckets
        .into_iter()
        .map(|(provider, bucket)| {
            let mut value = json!({
                "total": bucket.total,
                "pricedRequests": bucket.priced,
                "reportedRequests": bucket.reported,
                "unpricedRequests": bucket.unpriced,
            });
            if let Some(provider) = provider {
                value["providerId"] = json!(provider);
            }
            value
        })
        .collect();
    Ok(json!({
        "sessionId": session_id,
        "turnCount": turn_count,
        "requestCount": request_count,
        "providers": providers,
    }))
}

/// One provider's or one model's share of a spend window.
///
/// Token fields are per-record sums, so a row can be read on its own: a spend
/// review that showed only dollars would hide the case where most of the windows
/// spend came from cache reads, which is billed differently by every provider.
#[derive(Default)]
struct SpendBucket {
    requests: i64,
    input_tokens: i64,
    output_tokens: i64,
    cache_read_tokens: i64,
    cache_write_tokens: i64,
    reasoning_tokens: i64,
    total_tokens: i64,
    cost_total: f64,
    priced_requests: i64,
    reported_requests: i64,
    unpriced_requests: i64,
}

impl SpendBucket {
    /// Fold one ledger record in. `counted` is false for a token-only leftover
    /// that belongs to no request of its own: its tokens are money-relevant, its
    /// request count is not its to claim.
    fn add(&mut self, record: &Value, counted: bool) {
        let token = |key: &str| count(record, key);
        let input = token("inputTokens");
        let output = token("outputTokens");
        let cache_read = token("cacheReadTokens");
        let cache_write = token("cacheWriteTokens");
        self.input_tokens = self.input_tokens.saturating_add(input);
        self.output_tokens = self.output_tokens.saturating_add(output);
        self.cache_read_tokens = self.cache_read_tokens.saturating_add(cache_read);
        self.cache_write_tokens = self.cache_write_tokens.saturating_add(cache_write);
        self.reasoning_tokens = self
            .reasoning_tokens
            .saturating_add(token("reasoningTokens"));
        let reported = token("totalTokens");
        let derived = input
            .saturating_add(output)
            .saturating_add(cache_read)
            .saturating_add(cache_write);
        self.total_tokens = self.total_tokens.saturating_add(reported.max(derived));
        if counted {
            self.requests = self.requests.saturating_add(1);
        }
        if known_cost(record) {
            if counted {
                self.priced_requests = self.priced_requests.saturating_add(1);
                if record.get("costStatus").and_then(Value::as_str) == Some("reported") {
                    self.reported_requests = self.reported_requests.saturating_add(1);
                }
            }
            self.cost_total += record
                .get("cost")
                .and_then(|cost| cost.get("total"))
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
        } else if counted {
            self.unpriced_requests = self.unpriced_requests.saturating_add(1);
        }
    }

    fn to_json(&self) -> Value {
        json!({
            "requests": self.requests,
            "inputTokens": self.input_tokens,
            "outputTokens": self.output_tokens,
            "cacheReadTokens": self.cache_read_tokens,
            "cacheWriteTokens": self.cache_write_tokens,
            "reasoningTokens": self.reasoning_tokens,
            "totalTokens": self.total_tokens,
            "costTotal": self.cost_total,
            "pricedRequests": self.priced_requests,
            "reportedRequests": self.reported_requests,
            "unpricedRequests": self.unpriced_requests,
        })
    }
}

fn spend_rows(
    map: std::collections::BTreeMap<Option<String>, SpendBucket>,
    key: &str,
) -> Vec<Value> {
    let mut items: Vec<Value> = map
        .into_iter()
        .map(|(id, bucket)| {
            let mut value = bucket.to_json();
            if let Some(id) = id {
                value[key] = json!(id);
            }
            value
        })
        .collect();
    // The rows a user opens this page for are the expensive ones; a stable
    // tie-break on tokens keeps two equal-dollar providers from swapping places
    // between refreshes.
    items.sort_by(|a, b| {
        let cost = |value: &Value| value["costTotal"].as_f64().unwrap_or(0.0);
        let tokens = |value: &Value| value["totalTokens"].as_i64().unwrap_or(0);
        cost(b).total_cmp(&cost(a)).then(tokens(b).cmp(&tokens(a)))
    });
    items
}

/// What every session in a window has spent, split by provider and by model.
///
/// `session_usage_cost` answers "what did this session cost". A spend review
/// asks the same question across sessions and over a date range, which is the
/// one thing a per-session rollup cannot answer, and it asks it about money
/// rather than about one number: which provider took it, which model took it,
/// and how much of the total is a lower bound because a request had no price.
///
/// The window is on `started_at`, and every turn status counts — an aborted or
/// failed request was still billed, and a running turn has already paid for the
/// requests it completed. Sums always reconcile: the totals are accumulated from
/// the same records that feed the rows below them, a turn whose usage document
/// never arrived is read from its token columns and the provider/model on its
/// turn row, and a record nobody can attribute lands in an id-less row instead
/// of being dropped.
pub fn spend_summary(db: &Database, range_start: i64, range_end: i64) -> Result<Value> {
    let mut stmt = db.conn().prepare_cached(
        "SELECT provider_id, model_id, input_tokens, output_tokens, usage_json
         FROM turns
         WHERE started_at >= ?1 AND started_at <= ?2
         ORDER BY started_at ASC",
    )?;
    let rows = stmt.query_map(params![range_start, range_end], |row| {
        Ok((
            row.get::<_, Option<String>>(0)?,
            row.get::<_, Option<String>>(1)?,
            row.get::<_, Option<i64>>(2)?.unwrap_or(0).max(0),
            row.get::<_, Option<i64>>(3)?.unwrap_or(0).max(0),
            row.get::<_, Option<String>>(4)?,
        ))
    })?;
    let mut totals = SpendBucket::default();
    let mut by_provider: std::collections::BTreeMap<Option<String>, SpendBucket> =
        Default::default();
    let mut by_model: std::collections::BTreeMap<Option<String>, SpendBucket> = Default::default();
    let mut turn_count = 0_i64;
    for row in rows {
        let (turn_provider, turn_model, input_tokens, output_tokens, usage_json) = row?;
        let usage = usage_json
            .as_deref()
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok());
        let mut records = usage.as_ref().map(operations).unwrap_or_default();
        if records.is_empty() {
            // No ledger, only columns. Two zero columns mean this turn never
            // reached a provider, so it is not a request to report.
            if input_tokens == 0 && output_tokens == 0 {
                continue;
            }
            records.push(json!({
                "inputTokens": input_tokens,
                "outputTokens": output_tokens,
                "totalTokens": input_tokens + output_tokens,
                "costStatus": "unknown",
            }));
        }
        turn_count += 1;
        let recorded = sum_counts(&records, "totalTokens");
        let reported = usage
            .as_ref()
            .map(|value| count(value, "totalTokens"))
            .unwrap_or(0)
            .max(input_tokens.saturating_add(output_tokens));
        let residual = reported.saturating_sub(recorded);
        for record in &records {
            let provider = record
                .get("providerId")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .map(str::to_owned)
                .or_else(|| turn_provider.clone());
            let model = record
                .get("modelId")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .map(str::to_owned)
                .or_else(|| turn_model.clone());
            totals.add(record, true);
            by_provider.entry(provider).or_default().add(record, true);
            by_model.entry(model).or_default().add(record, true);
        }
        if residual > 0 {
            // Legacy totals recorded beside a ledger cannot be split across
            // requests; they still belong to this turn's provider and model.
            let leftover = json!({ "totalTokens": residual, "costStatus": "unknown" });
            totals.add(&leftover, false);
            by_provider
                .entry(turn_provider)
                .or_default()
                .add(&leftover, false);
            by_model
                .entry(turn_model)
                .or_default()
                .add(&leftover, false);
        }
    }
    let mut summary = totals.to_json();
    summary["rangeStart"] = json!(range_start);
    summary["rangeEnd"] = json!(range_end);
    summary["turnCount"] = json!(turn_count);
    summary["byProvider"] = json!(spend_rows(by_provider, "providerId"));
    summary["byModel"] = json!(spend_rows(by_model, "modelId"));
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn operation(id: &str, known: bool) -> Value {
        let mut value = json!({"operationId": id, "usageOrigin": "pi", "inputTokens": 12, "outputTokens": 3, "totalTokens": 15, "costStatus": "unknown"});
        if known {
            value["costStatus"] = json!("reported");
            value["cost"] = json!({"input": 0.12, "output": 0.03, "cacheRead": 0, "cacheWrite": 0, "total": 0.15});
        }
        value
    }

    #[test]
    fn usage_ledger_deduplicates_child_parent_and_replayed_snapshots() {
        let child = operation("child", true);
        let other = operation("classifier", false);
        let total = merge_usage(Some(&child), &other);
        assert_eq!(total["totalTokens"], 30);
        assert_eq!(total["costStatus"], "unknown");
        assert!(total.get("cost").is_none());
        assert_eq!(total["operations"][0]["cost"]["total"], 0.15);
        assert_eq!(merge_usage(Some(&total), &child), total);
        assert_eq!(merge_usage(Some(&total), &total), total);
    }

    #[test]
    fn equal_token_replay_preserves_known_cost() {
        let known = operation("request", true);
        let unknown = operation("request", false);
        for (left, right) in [(&known, &unknown), (&unknown, &known)] {
            let total = merge_usage(Some(left), right);
            assert_eq!(total["costStatus"], "reported");
            assert_eq!(total["cost"]["total"], 0.15);
        }
    }

    #[test]
    fn oversized_counts_cannot_overflow_the_ledger() {
        let left = json!({"operationId": "left", "inputTokens": i64::MAX, "outputTokens": 0, "totalTokens": i64::MAX});
        let right =
            json!({"operationId": "right", "inputTokens": 1, "outputTokens": 0, "totalTokens": 1});
        let total = merge_usage(Some(&left), &right);
        assert_eq!(total["totalTokens"], i64::MAX);
        assert_eq!(total["inputTokens"], i64::MAX);
    }

    fn priced(id: &str, provider: &str, status: &str, total: f64) -> Value {
        json!({"operationId": id, "usageOrigin": "pi", "providerId": provider,
            "inputTokens": 10, "outputTokens": 2, "totalTokens": 12, "costStatus": status,
            "cost": {"input": total, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": total}})
    }

    #[test]
    fn session_cost_groups_by_provider_and_counts_unpriced_requests() {
        let dir = std::env::temp_dir().join(format!("pi-usage-cost-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = Database::open(&dir.join("test.sqlite")).unwrap();
        let session = super::super::create_session(&db, None, None, None, None, None).unwrap();
        let other = super::super::create_session(&db, None, None, None, None, None).unwrap();
        let empty = session_usage_cost(&db, &session.id).unwrap();
        assert_eq!(empty["requestCount"], 0);
        assert_eq!(empty["providers"], json!([]));

        // Ledger turn: a billed request, an unpriced classifier, and a replay.
        let turn = super::super::begin_turn(&db, &session.id, None, None).unwrap();
        let billed = priced("a", "api", "reported", 0.25);
        record_usage(&db, &session.id, &turn, &billed).unwrap();
        record_usage(&db, &session.id, &turn, &billed).unwrap();
        let mut classifier = operation("b", false);
        classifier["providerId"] = json!("api");
        record_usage(&db, &session.id, &turn, &classifier).unwrap();
        super::super::end_turn(&db, &turn, "aborted", None, None, false).unwrap();
        // Token-only legacy snapshot: counted, never priced.
        let legacy = super::super::begin_turn(&db, &session.id, None, None).unwrap();
        let tokens = json!({"inputTokens": 5, "outputTokens": 1, "totalTokens": 6});
        super::super::end_turn(&db, &legacy, "completed", None, Some(&tokens), false).unwrap();
        // A still-running turn has already been billed for its first request.
        let running = super::super::begin_turn(&db, &session.id, None, None).unwrap();
        record_usage(
            &db,
            &session.id,
            &running,
            &priced("c", "sub", "estimated", 0.5),
        )
        .unwrap();
        // Another session's spend stays out of this rollup.
        let foreign = super::super::begin_turn(&db, &other.id, None, None).unwrap();
        record_usage(
            &db,
            &other.id,
            &foreign,
            &priced("d", "api", "reported", 9.0),
        )
        .unwrap();

        let summary = session_usage_cost(&db, &session.id).unwrap();
        assert_eq!(summary["sessionId"], json!(session.id));
        assert_eq!(summary["turnCount"], 3);
        assert_eq!(summary["requestCount"], 4);
        assert_eq!(
            summary["providers"],
            json!([
                {"total": 0.0, "pricedRequests": 0, "reportedRequests": 0, "unpricedRequests": 1},
                {"providerId": "api", "total": 0.25, "pricedRequests": 1, "reportedRequests": 1, "unpricedRequests": 1},
                {"providerId": "sub", "total": 0.5, "pricedRequests": 1, "reportedRequests": 0, "unpricedRequests": 0},
            ])
        );
        drop(db);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn usage_ledger_survives_restart_and_rejects_wrong_turn_owner() {
        let dir = std::env::temp_dir().join(format!("pi-usage-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("test.sqlite");
        let db = Database::open(&path).unwrap();
        let session = super::super::create_session(&db, None, None, None, None, None).unwrap();
        let turn = super::super::begin_turn(&db, &session.id, None, None).unwrap();
        let child = operation("child", true);
        assert!(!record_usage(&db, "other-session", &turn, &child).unwrap());
        assert!(record_usage(&db, &session.id, &turn, &child).unwrap());
        drop(db);
        let db = Database::open(&path).unwrap();
        assert!(record_usage(&db, &session.id, &turn, &child).unwrap());
        let parent = merge_usage(Some(&child), &operation("parent", true));
        super::super::end_turn(&db, &turn, "completed", None, Some(&parent), false).unwrap();
        super::super::end_turn(&db, &turn, "completed", None, Some(&parent), false).unwrap();
        assert!(record_usage(&db, &session.id, &turn, &child).unwrap());
        let stored: String = db
            .conn()
            .query_row(
                "SELECT usage_json FROM turns WHERE id = ?1",
                params![turn],
                |row| row.get(0),
            )
            .unwrap();
        let stored: Value = serde_json::from_str(&stored).unwrap();
        assert_eq!(stored["totalTokens"], 30);
        assert_eq!(stored["cost"]["total"], 0.3);
        assert_eq!(stored["operations"].as_array().unwrap().len(), 2);
        drop(db);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn session_totals_sum_every_turn_from_the_first() {
        let dir = std::env::temp_dir().join(format!("pi-usage-totals-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = Database::open(&dir.join("test.sqlite")).unwrap();
        let session = super::super::create_session(&db, None, None, None, None, None).unwrap();
        let other = super::super::create_session(&db, None, None, None, None, None).unwrap();

        // A session that has not run a turn yet is empty, not an error: the
        // status bar polls by session id from the moment the session opens.
        let fresh = session_totals(&db, &session.id).unwrap();
        assert_eq!(fresh.turns, 0);
        assert_eq!(fresh.input_tokens, 0);
        assert_eq!(session_totals(&db, "missing-session").unwrap().turns, 0);

        for (index, (input, output, cached, reasoning)) in
            [(10_i64, 2_i64, 40_i64, 1_i64), (30, 5, 60, 4)]
                .into_iter()
                .enumerate()
        {
            let turn = super::super::begin_turn(&db, &session.id, None, None).unwrap();
            let usage = json!({
                "operationId": format!("op-{index}"),
                "usageOrigin": "pi",
                "inputTokens": input,
                "outputTokens": output,
                "totalTokens": input + output,
                "cacheReadTokens": cached,
                "cacheWriteTokens": 7,
                "reasoningTokens": reasoning,
                "costStatus": "unknown",
            });
            assert!(record_usage(&db, &session.id, &turn, &usage).unwrap());
            super::super::end_turn(&db, &turn, "completed", None, Some(&usage), false).unwrap();
        }

        // Another session's turns must never leak into this total.
        let foreign = super::super::begin_turn(&db, &other.id, None, None).unwrap();
        assert!(record_usage(&db, &other.id, &foreign, &operation("other", false)).unwrap());

        let totals = session_totals(&db, &session.id).unwrap();
        assert_eq!(totals.turns, 2);
        assert_eq!(totals.input_tokens, 40);
        assert_eq!(totals.output_tokens, 7);
        assert_eq!(totals.cache_read_tokens, 100);
        assert_eq!(totals.cache_write_tokens, 14);
        assert_eq!(totals.reasoning_tokens, 5);

        // The turn whose usage document never arrived still counts its columns.
        let bare = super::super::begin_turn(&db, &session.id, None, None).unwrap();
        super::super::end_turn(&db, &bare, "aborted", None, None, false).unwrap();
        let totals = session_totals(&db, &session.id).unwrap();
        assert_eq!(totals.turns, 3);
        assert_eq!(totals.input_tokens, 40);

        drop(db);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn spend_summary_rolls_up_a_window_across_sessions() {
        let dir = std::env::temp_dir().join(format!("pi-usage-spend-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = Database::open(&dir.join("test.sqlite")).unwrap();
        let session = super::super::create_session(&db, None, None, None, None, None).unwrap();
        let other = super::super::create_session(&db, None, None, None, None, None).unwrap();

        // One session, one billed request and one classifier with no price.
        let turn = super::super::begin_turn(&db, &session.id, Some("api"), Some("m1")).unwrap();
        let mut billed = priced("a", "api", "reported", 0.25);
        billed["modelId"] = json!("m1");
        record_usage(&db, &session.id, &turn, &billed).unwrap();
        record_usage(
            &db,
            &session.id,
            &turn,
            &json!({
                "operationId": "classifier", "providerId": "api", "modelId": "m1",
                "inputTokens": 4, "outputTokens": 1, "totalTokens": 5,
                "costStatus": "unknown",
            }),
        )
        .unwrap();
        super::super::end_turn(&db, &turn, "completed", None, None, false).unwrap();

        // A second session's subscription-backed request is in the same window.
        let second = super::super::begin_turn(&db, &other.id, Some("sub"), Some("m2")).unwrap();
        record_usage(
            &db,
            &other.id,
            &second,
            &priced("b", "sub", "estimated", 0.5),
        )
        .unwrap();
        super::super::end_turn(&db, &second, "completed", None, None, false).unwrap();

        // Spend from before the window must not leak into it.
        let old = super::super::begin_turn(&db, &other.id, Some("api"), Some("m1")).unwrap();
        record_usage(&db, &other.id, &old, &priced("c", "api", "reported", 9.0)).unwrap();
        super::super::end_turn(&db, &old, "completed", None, None, false).unwrap();
        db.conn()
            .execute(
                "UPDATE turns SET started_at = 0 WHERE id = ?1",
                params![old],
            )
            .unwrap();

        let now = crate::db::now_ms();
        let summary = spend_summary(&db, now - 60_000, now + 60_000).unwrap();
        assert_eq!(summary["turnCount"], 2);
        assert_eq!(summary["requests"], 3);
        assert_eq!(summary["costTotal"], json!(0.75));
        assert_eq!(summary["pricedRequests"], 2);
        assert_eq!(summary["reportedRequests"], 1);
        assert_eq!(summary["unpricedRequests"], 1);
        // 12 + 5 + 12: two priced records at 10 in / 2 out, one 4 / 1 leftover.
        assert_eq!(summary["totalTokens"], 29);

        // Rows are ordered by money, so the expensive provider leads.
        let providers = summary["byProvider"].as_array().unwrap();
        assert_eq!(providers.len(), 2);
        assert_eq!(providers[0]["providerId"], json!("sub"));
        assert_eq!(providers[0]["costTotal"], json!(0.5));
        assert_eq!(providers[1]["providerId"], json!("api"));
        assert_eq!(providers[1]["costTotal"], json!(0.25));
        assert_eq!(providers[1]["unpricedRequests"], 1);
        let models = summary["byModel"].as_array().unwrap();
        assert_eq!(models.len(), 2);
        assert_eq!(models[0]["modelId"], json!("m2"));

        // The rows reconcile with the total: nothing is counted twice or dropped.
        let row_tokens: i64 = providers
            .iter()
            .map(|row| row["totalTokens"].as_i64().unwrap())
            .sum();
        assert_eq!(row_tokens, 29);

        let all = spend_summary(&db, 0, now + 60_000).unwrap();
        assert_eq!(all["turnCount"], 3);
        assert_eq!(all["costTotal"], json!(9.75));

        drop(db);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
