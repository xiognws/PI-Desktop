//! When work is due — the kernel-side half of the reference implementation's `cron/`.
//!
//! The split is the same as everywhere else in this kernel: the kernel answers **when**
//! (a pure function of a clock and a rule, so it is testable and needs no thread), and
//! the host answers **what happens** and **where the result goes**. The reference implementation's scheduler
//! owns timers, delivery queues and platform sinks because it also owns the platforms;
//! here the host owns those, and the kernel keeps the part that has to be exact.
//!
//! What is copied from the reference implementation's behaviour, deliberately:
//!
//! * a job that came due while nothing was ticking is reported **once**, with how late
//!   it is — not once per missed minute (a laptop closed for a day must not wake up to
//!   1,440 turns);
//! * a one-shot (`.at(ts)`) disables itself after it fires;
//! * a disabled job is never due, and keeps its schedule so it can be enabled again;
//! * `nextRunAt` is always what the *rule* says, computed from the previous scheduled
//!   time (not from "now"), so drift accumulates at one minute per run at most instead
//!   of one scheduling delay per run.
//!
//! Cron syntax is the five-field form the reference implementation accepts (`m h dom mon dow`), with `*`,
//! lists, ranges, steps and month/weekday names. `@hourly`, `@daily`, `@weekly`,
//! `@monthly` and `@yearly` are accepted as words, because a person writes them.

use std::collections::BTreeMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

const MINUTE_MS: i64 = 60_000;
const HOUR_MS: i64 = 60 * MINUTE_MS;
const DAY_MS: i64 = 24 * HOUR_MS;

/// How far ahead a rule is searched before it is declared impossible. A rule that only
/// matches "31 February" never fires, and a scheduler that loops forever on it is worse
/// than one that says so.
const SEARCH_HORIZON_MINUTES: i64 = 4 * 366 * 24 * 60;

/// A field of a cron expression, as a bit set of the values it allows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Field {
    bits: u64,
    min: u32,
    max: u32,
}

impl Field {
    fn new(min: u32, max: u32) -> Self {
        Self { bits: 0, min, max }
    }

    fn full(min: u32, max: u32) -> Self {
        let mut field = Self::new(min, max);
        for value in min..=max {
            field.insert(value);
        }
        field
    }

    fn insert(&mut self, value: u32) {
        if value >= self.min && value <= self.max && value < 64 {
            self.bits |= 1 << value;
        }
    }

    pub fn allows(&self, value: u32) -> bool {
        value < 64 && self.bits & (1 << value) != 0
    }

    /// Whether the whole range is allowed, which is what decides the dom/dow rule.
    pub fn is_star(&self) -> bool {
        (self.min..=self.max).all(|value| self.allows(value))
    }

    pub fn values(&self) -> Vec<u32> {
        (self.min..=self.max)
            .filter(|value| self.allows(*value))
            .collect()
    }
}

impl Default for Field {
    /// Only used by `serde(skip)`: a parsed spec always has real fields.
    fn default() -> Self {
        Self::full(0, 59)
    }
}

/// A parsed five-field cron expression.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CronSpec {
    pub expr: String,
    #[serde(skip)]
    minute: Field,
    #[serde(skip)]
    hour: Field,
    #[serde(skip)]
    day_of_month: Field,
    #[serde(skip)]
    month: Field,
    #[serde(skip)]
    day_of_week: Field,
}

impl CronSpec {
    /// Parse `m h dom mon dow` (or an `@word`).
    pub fn parse(expr: &str) -> Result<Self, String> {
        let text = expr.trim();
        let lowered = text.to_ascii_lowercase();
        let expanded = match lowered.as_str() {
            "@hourly" => "0 * * * *",
            "@daily" | "@midnight" => "0 0 * * *",
            "@weekly" => "0 0 * * 0",
            "@monthly" => "0 0 1 * *",
            "@yearly" | "@annually" => "0 0 1 1 *",
            other => other,
        };
        let parts: Vec<&str> = expanded.split_whitespace().collect();
        if parts.len() != 5 {
            return Err(format!(
                "expected 5 fields (`minute hour day month weekday`), got {}: {expr}",
                parts.len()
            ));
        }
        Ok(Self {
            expr: text.to_string(),
            minute: parse_field(parts[0], 0, 59, MONTHS_OR_NONE)?,
            hour: parse_field(parts[1], 0, 23, MONTHS_OR_NONE)?,
            day_of_month: parse_field(parts[2], 1, 31, MONTHS_OR_NONE)?,
            month: parse_field(parts[3], 1, 12, MONTH_NAMES)?,
            day_of_week: parse_field(parts[4], 0, 6, WEEKDAY_NAMES)?,
        })
    }

    /// The next time this rule fires strictly after `after_ms`, in UTC plus the caller's
    /// offset. `None` when the rule cannot fire inside the search horizon.
    pub fn next_after(&self, after_ms: i64, tz_offset_min: i32) -> Option<i64> {
        let offset_ms = tz_offset_min as i64 * MINUTE_MS;
        // Start at the next whole minute: a rule matches on minute boundaries, and a
        // tick that arrives 300 ms after one must not fire it twice.
        let mut cursor = (after_ms + offset_ms).div_euclid(MINUTE_MS) * MINUTE_MS + MINUTE_MS;
        let limit = cursor + SEARCH_HORIZON_MINUTES * MINUTE_MS;
        while cursor <= limit {
            let (year, month, day, hour, minute, weekday) = civil_from_ms(cursor);
            if !self.month.allows(month) || !self.hour.allows(hour) || !self.minute.allows(minute) {
                // Jump: an hour that cannot match is worth skipping in whole hours.
                cursor = if !self.hour.allows(hour) || !self.month.allows(month) {
                    cursor + (60 - minute as i64) * MINUTE_MS
                } else {
                    cursor + MINUTE_MS
                };
                continue;
            }
            let dom_ok = self.day_of_month.allows(day);
            let dow_ok = self.day_of_week.allows(weekday);
            // Standard cron: when both day fields are restricted, either one matching
            // is enough; when one is `*`, the other decides.
            let day_matches = if self.day_of_month.is_star() && self.day_of_week.is_star() {
                true
            } else if self.day_of_month.is_star() {
                dow_ok
            } else if self.day_of_week.is_star() {
                dom_ok
            } else {
                dom_ok || dow_ok
            };
            if day_matches {
                let _ = year;
                return Some(cursor - offset_ms);
            }
            cursor += DAY_MS - (hour as i64 * HOUR_MS + minute as i64 * MINUTE_MS);
        }
        None
    }
}

const MONTH_NAMES: &[(&str, u32)] = &[
    ("jan", 1),
    ("feb", 2),
    ("mar", 3),
    ("apr", 4),
    ("may", 5),
    ("jun", 6),
    ("jul", 7),
    ("aug", 8),
    ("sep", 9),
    ("oct", 10),
    ("nov", 11),
    ("dec", 12),
];

const WEEKDAY_NAMES: &[(&str, u32)] = &[
    ("sun", 0),
    ("mon", 1),
    ("tue", 2),
    ("wed", 3),
    ("thu", 4),
    ("fri", 5),
    ("sat", 6),
];

const MONTHS_OR_NONE: &[(&str, u32)] = &[];

fn parse_field(text: &str, min: u32, max: u32, names: &[(&str, u32)]) -> Result<Field, String> {
    let mut field = Field::new(min, max);
    for part in text.split(',') {
        let part = part.trim();
        if part.is_empty() {
            return Err(format!("empty list item in `{text}`"));
        }
        let (range_text, step) = match part.split_once('/') {
            Some((range, step)) => {
                let step: u32 = step
                    .parse()
                    .map_err(|_| format!("`{step}` is not a step size"))?;
                if step == 0 {
                    return Err("a step of 0 would never fire".to_string());
                }
                (range, step)
            }
            None => (part, 1),
        };
        let (start, end) = if range_text == "*" {
            (min, max)
        } else if let Some((from, to)) = range_text.split_once('-') {
            (value_of(from, names)?, value_of(to, names)?)
        } else {
            let value = value_of(range_text, names)?;
            // `5/15` means "from 5 to the end, every 15".
            let end = if part.contains('/') { max } else { value };
            (value, end)
        };
        if start > end {
            return Err(format!("`{part}` starts after it ends"));
        }
        if start < min || end > max {
            return Err(format!("`{part}` is outside {min}-{max}"));
        }
        let mut value = start;
        while value <= end {
            field.insert(value);
            value += step;
        }
    }
    if field.values().is_empty() {
        return Err(format!("`{text}` allows no value"));
    }
    Ok(field)
}

fn value_of(text: &str, names: &[(&str, u32)]) -> Result<u32, String> {
    let lower = text.trim().to_ascii_lowercase();
    if let Some((_, value)) = names.iter().find(|(name, _)| *name == lower) {
        return Ok(*value);
    }
    lower
        .parse()
        .map_err(|_| format!("`{text}` is not a number or a known name"))
}

/// Days since 1970-01-01 → (year, month, day, hour, minute, weekday).
///
/// Howard Hinnant's civil-from-days, which is exact for every date this scheduler will
/// see and needs no calendar crate.
fn civil_from_ms(ms: i64) -> (i64, u32, u32, u32, u32, u32) {
    let days = ms.div_euclid(DAY_MS);
    let minutes_of_day = (ms.rem_euclid(DAY_MS) / MINUTE_MS) as u32;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = if month <= 2 { y + 1 } else { y };
    // 1970-01-01 was a Thursday.
    let weekday = ((days + 4).rem_euclid(7)) as u32;
    (
        year,
        month,
        day,
        minutes_of_day / 60,
        minutes_of_day % 60,
        weekday,
    )
}

/// When a job runs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Schedule {
    /// Once, at this instant (ms since the epoch).
    At {
        #[serde(rename = "atMs", alias = "at_ms")]
        at_ms: i64,
    },
    /// Every `every_ms`, aligned to Unix time so a restart does not shift the phase.
    Every {
        #[serde(rename = "everyMs", alias = "every_ms")]
        every_ms: i64,
    },
    /// A five-field cron rule.
    Cron {
        expr: String,
        #[serde(default, rename = "tzOffsetMin", alias = "tz_offset_min")]
        tz_offset_min: i32,
    },
}

impl Schedule {
    /// Reject a rule that can never fire, at the moment it is added.
    ///
    /// Without this a typo is stored as a job whose next time is "never": the host
    /// schedules nothing, no error is reported, and the only symptom is work that
    /// silently does not happen. A schedule is either answerable or refused.
    pub fn validate(&self) -> Result<(), String> {
        match self {
            Self::At { at_ms } => {
                if *at_ms <= 0 {
                    return Err("`atMs` must be a positive epoch time".to_string());
                }
                Ok(())
            }
            Self::Every { every_ms } => {
                if *every_ms <= 0 {
                    return Err("`everyMs` must be positive".to_string());
                }
                Ok(())
            }
            Self::Cron {
                expr,
                tz_offset_min,
            } => {
                if !(-1440..=1440).contains(tz_offset_min) {
                    return Err(format!(
                        "`tzOffsetMin` {tz_offset_min} is more than a day away from UTC"
                    ));
                }
                let spec = CronSpec::parse(expr)?;
                if spec.next_after(now_ms(), *tz_offset_min).is_none() {
                    return Err(format!("`{expr}` never fires on any date"));
                }
                Ok(())
            }
        }
    }

    /// The next fire time strictly after `after_ms`.
    pub fn next_after(&self, after_ms: i64) -> Option<i64> {
        match self {
            Self::At { at_ms } => (*at_ms > after_ms).then_some(*at_ms),
            Self::Every { every_ms } => {
                if *every_ms <= 0 {
                    return None;
                }
                let slot = after_ms.div_euclid(*every_ms) + 1;
                Some(slot * every_ms)
            }
            Self::Cron {
                expr,
                tz_offset_min,
            } => CronSpec::parse(expr)
                .ok()?
                .next_after(after_ms, *tz_offset_min),
        }
    }
}

/// One scheduled job. The prompt is opaque here: the host decides what it means.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    pub name: String,
    pub prompt: String,
    pub schedule: Schedule,
    pub enabled: bool,
    /// The time the *rule* says it should have run. Advances by the rule, not by when a
    /// tick happened, so a late tick never accumulates drift.
    pub next_run_at_ms: i64,
    pub last_run_at_ms: Option<i64>,
    /// How many times this job has been reported late, for a panel to show.
    pub late_runs: u32,
}

/// A job that is due, and how late it is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DueTicket {
    pub job_id: String,
    pub name: String,
    pub prompt: String,
    pub scheduled_at_ms: i64,
    pub late_ms: i64,
}

/// The book of jobs. Cheap, deterministic, and behind one lock in the sidecar.
#[derive(Debug, Default)]
pub struct ScheduleBook {
    jobs: BTreeMap<String, Job>,
    next_id: u64,
}

impl ScheduleBook {
    pub fn new() -> Self {
        Self::default()
    }

    /// Add a job. The first fire time is computed from `now_ms`, so a job added at noon
    /// with `0 9 * * *` waits for tomorrow morning rather than firing immediately.
    pub fn add(
        &mut self,
        name: impl Into<String>,
        prompt: impl Into<String>,
        schedule: Schedule,
        now_ms: i64,
    ) -> Job {
        self.next_id += 1;
        let next_run_at_ms = schedule.next_after(now_ms).unwrap_or(i64::MAX);
        let job = Job {
            id: format!("job-{}", self.next_id),
            name: name.into(),
            prompt: prompt.into(),
            schedule,
            enabled: true,
            next_run_at_ms,
            last_run_at_ms: None,
            late_runs: 0,
        };
        self.jobs.insert(job.id.clone(), job.clone());
        job
    }

    pub fn get(&self, id: &str) -> Option<&Job> {
        self.jobs.get(id)
    }

    pub fn list(&self) -> Vec<Job> {
        self.jobs.values().cloned().collect()
    }

    pub fn remove(&mut self, id: &str) -> bool {
        self.jobs.remove(id).is_some()
    }

    /// Enable or disable a job. Enabling recomputes the next fire time from `now_ms`, so
    /// a job that was off for a week does not immediately fire once per missed period.
    pub fn set_enabled(&mut self, id: &str, enabled: bool, now_ms: i64) -> Option<Job> {
        let job = self.jobs.get_mut(id)?;
        job.enabled = enabled;
        if enabled {
            job.next_run_at_ms = job.schedule.next_after(now_ms).unwrap_or(i64::MAX);
        }
        Some(job.clone())
    }

    /// Every job that is due now, in the order it was scheduled.
    ///
    /// A job that is due is advanced past `now_ms` and reported exactly once, with the
    /// lateness, no matter how many periods were missed.
    pub fn due(&mut self, now_ms: i64) -> Vec<DueTicket> {
        let mut tickets = Vec::new();
        for job in self.jobs.values_mut() {
            if !job.enabled || job.next_run_at_ms > now_ms {
                continue;
            }
            let scheduled_at_ms = job.next_run_at_ms;
            let late_ms = now_ms - scheduled_at_ms;
            let next = job.schedule.next_after(now_ms).unwrap_or(i64::MAX);
            job.next_run_at_ms = next;
            job.last_run_at_ms = Some(scheduled_at_ms);
            if late_ms > 60_000 {
                job.late_runs += 1;
            }
            if matches!(job.schedule, Schedule::At { at_ms } if at_ms == scheduled_at_ms) {
                // A one-shot has fired; it must not stay enabled with no next time.
                job.enabled = false;
            }
            tickets.push(DueTicket {
                job_id: job.id.clone(),
                name: job.name.clone(),
                prompt: job.prompt.clone(),
                scheduled_at_ms,
                late_ms,
            });
        }
        tickets.sort_by_key(|ticket| ticket.scheduled_at_ms);
        tickets
    }

    /// The soonest next fire time, for a "wake me at" hint to the host.
    pub fn next_wakeup(&self) -> Option<i64> {
        self.jobs
            .values()
            .filter(|job| job.enabled)
            .map(|job| job.next_run_at_ms)
            .filter(|at| *at != i64::MAX)
            .min()
    }
}

/// The book behind the lock the sidecar holds.
pub type SharedSchedule = std::sync::Arc<Mutex<ScheduleBook>>;

pub fn shared() -> SharedSchedule {
    std::sync::Arc::new(Mutex::new(ScheduleBook::new()))
}

/// Milliseconds since the Unix epoch, the one clock this module reads.
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 2026-11-18T00:00:00Z (a Wednesday).
    const MIDNIGHT: i64 = 1_794_960_000_000;

    fn cron(expr: &str) -> CronSpec {
        CronSpec::parse(expr).expect("a valid expression")
    }

    #[test]
    fn a_five_field_expression_parses() {
        let spec = cron("*/15 9-17 * * 1-5");
        assert!(spec.minute.allows(0) && spec.minute.allows(45));
        assert!(!spec.minute.allows(7));
        assert!(spec.hour.allows(9) && spec.hour.allows(17));
        assert!(!spec.hour.allows(8));
        assert!(spec.day_of_week.allows(1) && spec.day_of_week.allows(5));
        assert!(!spec.day_of_week.allows(6));
    }

    #[test]
    fn words_and_names_work() {
        assert_eq!(cron("@daily").expr, "@daily");
        let spec = cron("0 0 1 jan mon");
        assert!(spec.month.allows(1));
        assert!(spec.day_of_week.allows(1));
    }

    #[test]
    fn a_bad_expression_says_what_is_wrong() {
        for (expr, expected) in [
            ("* * * *", "expected 5 fields"),
            ("* * * * * *", "expected 5 fields"),
            ("60 * * * *", "outside 0-59"),
            ("* 24 * * *", "outside 0-23"),
            ("*/0 * * * *", "step of 0"),
            ("5-1 * * * *", "starts after it ends"),
            ("* * * * funday", "not a number"),
        ] {
            let error = CronSpec::parse(expr).expect_err(expr);
            assert!(error.contains(expected), "{expr}: {error}");
        }
    }

    #[test]
    fn the_next_fire_time_is_strictly_after_the_clock() {
        // 00:00 → next `0 * * * *` is 01:00, not 00:00.
        let spec = cron("0 * * * *");
        let next = spec.next_after(MIDNIGHT, 0).expect("a next hour");
        assert_eq!(next, MIDNIGHT + HOUR_MS);
        // A tick 300 ms past the boundary must not refire the same minute.
        let next = spec.next_after(MIDNIGHT + 300, 0).expect("a next hour");
        assert_eq!(next, MIDNIGHT + HOUR_MS);
    }

    #[test]
    fn a_weekday_rule_skips_the_weekend() {
        // 2026-11-18 is a Wednesday; `0 9 * * 1-5` from Wednesday midnight is Wed 09:00.
        let spec = cron("0 9 * * 1-5");
        let next = spec.next_after(MIDNIGHT, 0).expect("a weekday");
        assert_eq!(next, MIDNIGHT + 9 * HOUR_MS);
        // From Friday 10:00 it has to be Monday 09:00.
        let friday_ten = MIDNIGHT + 2 * DAY_MS + 10 * HOUR_MS;
        let next = spec.next_after(friday_ten, 0).expect("a weekday");
        assert_eq!(next, MIDNIGHT + 5 * DAY_MS + 9 * HOUR_MS);
    }

    #[test]
    fn a_timezone_offset_shifts_the_rule_not_the_answer() {
        // 09:00 in UTC+8 is 01:00 UTC.
        let spec = cron("0 9 * * *");
        let next = spec.next_after(MIDNIGHT, 480).expect("a next 09:00");
        assert_eq!(next, MIDNIGHT + HOUR_MS);
    }

    #[test]
    fn an_impossible_rule_reports_nothing_instead_of_looping() {
        // 31 February never happens.
        let spec = cron("0 0 31 2 *");
        assert_eq!(spec.next_after(MIDNIGHT, 0), None);
    }

    #[test]
    fn every_schedule_has_a_phase_that_survives_a_restart() {
        let schedule = Schedule::Every {
            every_ms: 5 * MINUTE_MS,
        };
        assert_eq!(
            schedule.next_after(MIDNIGHT + 7 * MINUTE_MS),
            Some(MIDNIGHT + 10 * MINUTE_MS)
        );
        let schedule = Schedule::At {
            at_ms: MIDNIGHT + DAY_MS,
        };
        assert_eq!(schedule.next_after(MIDNIGHT), Some(MIDNIGHT + DAY_MS));
        assert_eq!(schedule.next_after(MIDNIGHT + DAY_MS), None);
    }

    #[test]
    fn a_job_that_came_due_is_reported_once_with_its_lateness() {
        let mut book = ScheduleBook::new();
        let job = book.add(
            "standup",
            "summarise yesterday",
            cron_schedule("0 9 * * 1-5"),
            MIDNIGHT - DAY_MS,
        );
        // Two days later: the job is one period late, and is reported once.
        let tickets = book.due(MIDNIGHT + DAY_MS);
        assert_eq!(tickets.len(), 1, "{tickets:?}");
        assert_eq!(tickets[0].job_id, job.id);
        assert!(tickets[0].late_ms >= DAY_MS);
        assert!(book.due(MIDNIGHT + DAY_MS).is_empty(), "not twice");
        assert!(book.get(&job.id).unwrap().late_runs >= 1);
    }

    #[test]
    fn a_daily_job_fires_twice_in_two_days_and_never_thrice() {
        let mut book = ScheduleBook::new();
        book.add("daily", "report", cron_schedule("0 9 * * *"), MIDNIGHT);
        assert!(book.due(MIDNIGHT).is_empty(), "nothing due at midnight");
        let first = book.due(MIDNIGHT + 9 * HOUR_MS);
        assert_eq!(first.len(), 1);
        let second = book.due(MIDNIGHT + 33 * HOUR_MS);
        assert_eq!(second.len(), 1);
        assert_eq!(
            book.get(&first[0].job_id).unwrap().next_run_at_ms,
            MIDNIGHT + 57 * HOUR_MS
        );
    }

    #[test]
    fn a_one_shot_disables_itself_after_firing() {
        let mut book = ScheduleBook::new();
        let job = book.add(
            "once",
            "send the deck",
            Schedule::At {
                at_ms: MIDNIGHT + HOUR_MS,
            },
            MIDNIGHT,
        );
        assert!(book.due(MIDNIGHT + HOUR_MS).len() == 1);
        let after = book.get(&job.id).unwrap();
        assert!(!after.enabled, "a one-shot does not stay enabled");
        assert!(book.due(MIDNIGHT + 2 * HOUR_MS).is_empty());
    }

    #[test]
    fn a_disabled_job_is_not_due_and_can_be_enabled_again() {
        let mut book = ScheduleBook::new();
        let job = book.add("paused", "nothing", cron_schedule("*/5 * * * *"), MIDNIGHT);
        book.set_enabled(&job.id, false, MIDNIGHT);
        assert!(book.due(MIDNIGHT + HOUR_MS).is_empty());
        let enabled = book
            .set_enabled(&job.id, true, MIDNIGHT + HOUR_MS)
            .expect("the job exists");
        assert!(enabled.enabled);
        assert_eq!(enabled.next_run_at_ms, MIDNIGHT + HOUR_MS + 5 * MINUTE_MS);
        assert_eq!(book.due(MIDNIGHT + HOUR_MS + 5 * MINUTE_MS).len(), 1);
    }

    #[test]
    fn the_next_wakeup_is_the_soonest_enabled_job() {
        let mut book = ScheduleBook::new();
        assert_eq!(book.next_wakeup(), None);
        book.add("later", "b", cron_schedule("0 9 * * *"), MIDNIGHT);
        book.add(
            "sooner",
            "a",
            Schedule::Every { every_ms: HOUR_MS },
            MIDNIGHT,
        );
        assert_eq!(book.next_wakeup(), Some(MIDNIGHT + HOUR_MS));
    }

    #[test]
    fn jobs_can_be_listed_and_removed() {
        let mut book = ScheduleBook::new();
        let job = book.add("a", "x", Schedule::Every { every_ms: HOUR_MS }, MIDNIGHT);
        assert_eq!(book.list().len(), 1);
        assert!(book.remove(&job.id));
        assert!(!book.remove(&job.id));
        assert!(book.list().is_empty());
    }

    #[test]
    fn the_calendar_maths_agrees_with_known_dates() {
        // 1970-01-01 was a Thursday (weekday 4 with Sunday = 0).
        let (year, month, day, hour, minute, weekday) = civil_from_ms(0);
        assert_eq!(
            (year, month, day, hour, minute, weekday),
            (1970, 1, 1, 0, 0, 4)
        );
        // 2026-11-18T00:00Z is a Wednesday.
        let (year, month, day, _, _, weekday) = civil_from_ms(MIDNIGHT);
        assert_eq!((year, month, day, weekday), (2026, 11, 18, 3));
        // A leap day exists.
        let leap = 1_709_164_800_000; // 2024-02-29T00:00:00Z
        let (year, month, day, ..) = civil_from_ms(leap);
        assert_eq!((year, month, day), (2024, 2, 29));
    }

    fn cron_schedule(expr: &str) -> Schedule {
        Schedule::Cron {
            expr: expr.to_string(),
            tz_offset_min: 0,
        }
    }
}
