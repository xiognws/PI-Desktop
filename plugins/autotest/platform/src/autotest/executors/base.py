"""Executor contract: one language/channel implementation per module.

The dispatcher owns the run envelope (``run.start`` / ``run.end``, the
``executions`` row, persistence). An executor only walks its own case and
yields the middle events, so a new channel (ECU, API, e2e) cannot drift on
counting or bookkeeping.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterator, Protocol, runtime_checkable

from autotest.executors.cancel import CancelToken

CHANNEL_UI = "ui"
CHANNEL_ECU = "ecu"
CHANNEL_API = "api"


@dataclass
class RunRequest:
    """Everything an executor is allowed to know about one case run."""

    run_id: str
    execution_id: int
    project_id: str
    case_id: str
    script_id: str
    script_name: str
    script_path: Path
    project_dir: Path | None = None
    timeout_s: float = 30.0
    env: dict[str, str] = field(default_factory=dict)
    meta: dict[str, Any] = field(default_factory=dict)
    cancel: CancelToken | None = None


@runtime_checkable
class Executor(Protocol):
    """``language`` is the ``scripts.language`` value this executor serves."""

    name: str
    language: str
    channel: str

    def run(self, request: RunRequest) -> Iterator[dict[str, Any]]:
        """Yield events between ``case.start`` and ``case.end``."""
        ...
