"""RunEvent v1 — the single event contract every executor channel speaks.

A run is a sequence of NDJSON objects; the schema lives next to this module in
``run_event.schema.json``. The Python side only needs the required-field checks
(no jsonschema dependency), and the same shapes are what the Node e2e runner
prints, so the panel and the report never branch on which channel produced a
row.
"""

from __future__ import annotations

import json
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

SCHEMA_VERSION = 1
SCHEMA_PATH = Path(__file__).with_name("run_event.schema.json")

CHANNELS = ("ui", "ecu", "api")
STEP_KINDS = ("act", "assert", "driver")
ARTIFACT_KINDS = ("screenshot", "video", "trace", "report", "log")

REQUIRED_FIELDS: dict[str, tuple[str, ...]] = {
    "run.start": ("projectId", "channel", "startedAt"),
    "case.start": ("caseId", "attempt", "startedAt"),
    "step.start": ("caseId", "stepId", "index", "kind", "label"),
    "step.end": ("caseId", "stepId", "status", "durationMs", "replayHit"),
    "artifact": ("caseId", "kind", "path"),
    "case.end": ("caseId", "status", "durationMs"),
    "run.end": ("status", "counts", "durationMs"),
}


def now_iso() -> str:
    """UTC timestamp in the ISO-8601 shape the schema expects."""
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def new_run_id() -> str:
    return f"run_{uuid.uuid4().hex[:12]}"


def _event(event_type: str, run_id: str, **fields: Any) -> dict[str, Any]:
    return {"schemaVersion": SCHEMA_VERSION, "type": event_type, "runId": run_id, **fields}


def run_start(run_id: str, project_id: str, case_ids: list[str], channel: str) -> dict[str, Any]:
    return _event(
        "run.start",
        run_id,
        projectId=project_id,
        caseIds=list(case_ids),
        channel=channel,
        startedAt=now_iso(),
    )


def case_start(run_id: str, case_id: str, attempt: int = 1) -> dict[str, Any]:
    return _event("case.start", run_id, caseId=case_id, attempt=attempt, startedAt=now_iso())


def step_start(
    run_id: str, case_id: str, step_id: str, index: int, kind: str, label: str
) -> dict[str, Any]:
    if kind not in STEP_KINDS:
        kind = "act"
    return _event(
        "step.start",
        run_id,
        caseId=case_id,
        stepId=step_id,
        index=index,
        kind=kind,
        label=label,
    )


def step_end(
    run_id: str,
    case_id: str,
    step_id: str,
    status: str,
    duration_ms: float,
    replay_hit: bool = False,
    detail: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if status not in ("pass", "fail", "skip"):
        status = "fail" if status == "error" else "pass"
    event = _event(
        "step.end",
        run_id,
        caseId=case_id,
        stepId=step_id,
        status=status,
        durationMs=round(float(duration_ms), 1),
        replayHit=bool(replay_hit),
    )
    if detail:
        event["detail"] = detail
    return event


def artifact(
    run_id: str, case_id: str, kind: str, path: str, size_bytes: int | None = None
) -> dict[str, Any]:
    if kind not in ARTIFACT_KINDS:
        kind = "log"
    event = _event("artifact", run_id, caseId=case_id, kind=kind, path=path)
    if size_bytes is not None:
        event["bytes"] = int(size_bytes)
    return event


def case_end(
    run_id: str,
    case_id: str,
    status: str,
    duration_ms: float,
    failure: str | None = None,
) -> dict[str, Any]:
    if status not in ("pass", "fail", "skip", "error"):
        status = "fail"
    return _event(
        "case.end",
        run_id,
        caseId=case_id,
        status=status,
        durationMs=round(float(duration_ms), 1),
        failure=failure,
    )


def run_end(
    run_id: str,
    status: str,
    counts: dict[str, int],
    duration_ms: float,
    replay_hits: int = 0,
    model_calls: int = 0,
) -> dict[str, Any]:
    return _event(
        "run.end",
        run_id,
        status=status,
        counts={
            "pass": int(counts.get("pass", 0)),
            "fail": int(counts.get("fail", 0)),
            "skip": int(counts.get("skip", 0)),
        },
        durationMs=round(float(duration_ms), 1),
        replayHits=int(replay_hits),
        modelCalls=int(model_calls),
    )


def validate(event: dict[str, Any]) -> list[str]:
    """Return the schema violations of one event; an empty list means valid."""
    problems: list[str] = []
    if event.get("schemaVersion") != SCHEMA_VERSION:
        problems.append(f"schemaVersion must be {SCHEMA_VERSION}")
    event_type = event.get("type")
    if event_type not in REQUIRED_FIELDS:
        return problems + [f"unknown event type: {event_type!r}"]
    for key in ("runId", "seq", "ts"):
        if key not in event:
            problems.append(f"missing {key}")
    if event.get("channel") is not None and event["channel"] not in CHANNELS:
        problems.append(f"channel must be one of {CHANNELS}")
    for key in REQUIRED_FIELDS[event_type]:
        if key not in event:
            problems.append(f"{event_type} requires {key}")
    return problems


class RunEventLog:
    """Appends events to ``execution_events`` and reads them back in order."""

    def __init__(self, db_path: Path, execution_id: int):
        self.db_path = Path(db_path)
        self.execution_id = int(execution_id)
        self._seq = 0

    @property
    def next_seq(self) -> int:
        """The ``seq`` the next appended event will carry."""
        return self._seq

    @contextmanager
    def _conn(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        try:
            yield conn
            conn.commit()
        finally:
            conn.close()

    def append(self, event: dict[str, Any]) -> dict[str, Any]:
        """Stamp the event with ``seq``/``ts``, persist it, return the stamped copy."""
        stamped = dict(event)
        stamped["seq"] = self._seq
        stamped["ts"] = stamped.get("ts") or now_iso()
        problems = validate(stamped)
        if problems:
            raise ValueError("invalid run event: " + "; ".join(problems))
        payload = json.dumps(stamped, ensure_ascii=False)
        with self._conn() as conn:
            conn.execute(
                "INSERT INTO execution_events (execution_id, seq, type, payload) VALUES (?, ?, ?, ?)",
                (self.execution_id, stamped["seq"], stamped["type"], payload),
            )
        self._seq += 1
        return stamped

    def replay(self) -> list[dict[str, Any]]:
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT payload FROM execution_events WHERE execution_id = ? ORDER BY seq",
                (self.execution_id,),
            ).fetchall()
        return [json.loads(row["payload"]) for row in rows]


def ensure_execution_tables(conn: sqlite3.Connection) -> None:
    """Create the event table and add the executor columns on an existing DB."""
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS execution_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            execution_id INTEGER NOT NULL,
            seq INTEGER NOT NULL,
            type TEXT NOT NULL,
            payload TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_execution_events_run "
        "ON execution_events (execution_id, seq)"
    )
    existing = {row[1] for row in conn.execute("PRAGMA table_info(executions)").fetchall()}
    for column, ddl in (
        ("executor", "ALTER TABLE executions ADD COLUMN executor TEXT"),
        ("channel", "ALTER TABLE executions ADD COLUMN channel TEXT DEFAULT 'ui'"),
        ("replay_hits", "ALTER TABLE executions ADD COLUMN replay_hits INTEGER DEFAULT 0"),
        ("model_calls", "ALTER TABLE executions ADD COLUMN model_calls INTEGER DEFAULT 0"),
    ):
        if column not in existing:
            conn.execute(ddl)
