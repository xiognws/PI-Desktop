"""Cancellation for a running case.

The HTTP layer lives in an asyncio loop while an execution runs in a worker
thread, so the flag has to be thread-safe: a ``threading.Event`` written by the
cancel route and polled by the executor's child-process loop.
"""

from __future__ import annotations

import threading


class CancelToken:
    def __init__(self) -> None:
        self._event = threading.Event()
        self._reason = ""

    def cancel(self, reason: str = "cancelled by user") -> None:
        self._reason = reason
        self._event.set()

    @property
    def cancelled(self) -> bool:
        return self._event.is_set()

    @property
    def reason(self) -> str:
        return self._reason

    def wait(self, timeout: float) -> bool:
        """Block until cancelled or the timeout elapses; True when cancelled."""
        return self._event.wait(timeout)
