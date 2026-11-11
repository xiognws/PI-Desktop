"""The audit ledger: one row per model call that produced an artifact.

A test report has to show where each answer came from — which model, which
stage, which prompt hash, whether the answer was accepted, and how many tokens
it cost. That is what ``agent_calls`` stores.

The column is still named ``pipeline_id`` because old databases already have
rows under that name; new callers pass the workflow run id into it. Keeping the
column name is cheaper than a migration that rewrites historical rows.
"""

from __future__ import annotations

import hashlib
import sqlite3
from pathlib import Path

AGENT_CALL_SCHEMA = """
CREATE TABLE IF NOT EXISTS agent_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pipeline_id TEXT,
    stage TEXT,
    model_key TEXT,
    prompt_hash TEXT,
    output_hash TEXT,
    tokens_in INTEGER DEFAULT 0,
    tokens_out INTEGER DEFAULT 0,
    accepted INTEGER DEFAULT 0,
    reason TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
"""


def ensure_agent_call_table(conn: sqlite3.Connection) -> None:
    conn.executescript(AGENT_CALL_SCHEMA)


def hash_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", "replace")).hexdigest()[:32]


def record_agent_call(
    db_path: Path,
    call_id: str,
    stage: str,
    model_key: str,
    prompt: str,
    output: str,
    tokens_in: int,
    tokens_out: int,
    accepted: bool,
    reason: str = "",
) -> None:
    conn = sqlite3.connect(Path(db_path))
    try:
        conn.execute(
            "INSERT INTO agent_calls (pipeline_id, stage, model_key, prompt_hash, output_hash, "
            "tokens_in, tokens_out, accepted, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                call_id,
                stage,
                model_key,
                hash_text(prompt),
                hash_text(output),
                int(tokens_in),
                int(tokens_out),
                1 if accepted else 0,
                reason,
            ),
        )
        conn.commit()
    finally:
        conn.close()
