"""In-process Python scripts: the legacy ``subprocess.run`` path, now streamed.

Behaviour is preserved from the pre-executor route: same interpreter (the
running venv), same cwd (the script's folder), same 30 s default timeout, same
Chinese timeout message. The only addition is the event stream.

pytest modules get one extra hop: a file that declares ``def test_…`` is driven
through ``pytest`` instead of being executed top-to-bottom, because running it as
a script never calls those functions. Without that hop every generated case —
which is a pytest skeleton — exits 0 and is recorded as a pass, so the report's
pass rate would be meaningless. Files without ``def test_`` keep the previous
behaviour exactly.
"""

from __future__ import annotations

import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Iterator

from autotest.executors import events
from autotest.executors.base import CHANNEL_API, Executor, RunRequest

STEP_ID = "run-script"
POLL_S = 0.1

# 模块级测试函数：pytest 的收集规则里 `test_` 前缀就是用例入口。
_PYTEST_CASE = re.compile(r"^def test_", re.MULTILINE)
# pytest 的 `-q` 结尾汇总行，例如 "1 failed, 2 passed, 1 skipped in 0.12s"。
_PYTEST_SUMMARY = re.compile(r"(\d+) (passed|failed|error|errors|skipped|xfailed|xpassed|deselected)")
# 失败现场块的表头，例如 "========== FAILURES =========="
_FAILURES_HEADER = re.compile(r"^=+ FAILURES =+$", re.MULTILINE)


def looks_like_pytest_module(script_path: Path) -> bool:
    """True when the file declares pytest-style test functions.

    Reading the file (instead of importing it) keeps the decision side-effect
    free: the script is untrusted test code and must not be imported into the
    service process.
    """
    try:
        text = script_path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return False
    return bool(_PYTEST_CASE.search(text))


def parse_pytest_counts(stdout: str) -> dict[str, int]:
    """Turn pytest's `-q` summary line into counts.

    Only the trailing summary block is scanned: a test's own output can print
    numbers followed by these words, and the last such line is the summary.
    """
    counts: dict[str, int] = {}
    for line in reversed(stdout.strip().splitlines()):
        found = _PYTEST_SUMMARY.findall(line)
        if not found:
            continue
        for number, label in found:
            counts[label] = counts.get(label, 0) + int(number)
        break
    return counts


def pytest_failure_excerpt(stdout: str, limit: int = 1500) -> str:
    """Pull the readable failure block out of pytest's stdout.

    pytest writes tracebacks to stdout, so without this the case's failure
    message is a bare count and neither the execution detail nor the log
    analysis has anything to quote.
    """
    match = _FAILURES_HEADER.search(stdout)
    block = stdout[match.end():] if match else stdout
    stop = block.find("===== short test summary")
    if stop != -1:
        block = block[:stop]
    block = block.strip()
    return block[-limit:] if len(block) > limit else block


def pytest_case_status(counts: dict[str, int], returncode: int) -> tuple[str, str | None]:
    """Map pytest counts to the case status the event stream expects.

    A run whose only tests were skipped is a skip, not a pass — the generated
    skeletons are exactly that shape, and calling them "passed" is what made the
    report disagree with reality.
    """
    failed = counts.get("failed", 0) + counts.get("error", 0) + counts.get("errors", 0)
    passed = counts.get("passed", 0) + counts.get("xpassed", 0)
    skipped = counts.get("skipped", 0) + counts.get("xfailed", 0)
    if failed:
        return "fail", f"{failed} 条用例失败"
    if passed:
        return "pass", None
    if skipped:
        return "skip", None
    # 没有收集到任何用例：pytest 退出码 5。这不是通过。
    if returncode == 5:
        return "fail", "pytest 没有收集到任何用例（文件里没有 test_ 开头的函数）"
    return ("pass", None) if returncode == 0 else ("fail", f"pytest 退出码 {returncode}")


class PythonNativeExecutor(Executor):
    name = "python-native"
    language = "python"
    channel = CHANNEL_API

    def run(self, request: RunRequest) -> Iterator[dict[str, Any]]:
        started = time.monotonic()
        pytest_mode = looks_like_pytest_module(request.script_path)
        yield events.case_start(request.run_id, request.case_id)
        yield events.step_start(
            request.run_id,
            request.case_id,
            STEP_ID,
            0,
            "driver",
            f"{'pytest' if pytest_mode else 'python'} {request.script_name}",
        )

        stdout = ""
        stderr = ""
        returncode = -1
        timed_out = False
        cancelled = False
        step_started = time.monotonic()

        try:
            command = (
                [
                    sys.executable,
                    "-m",
                    "pytest",
                    str(request.script_path),
                    "-q",
                    "--no-header",
                    "-p",
                    "no:cacheprovider",
                ]
                if pytest_mode
                else [sys.executable, str(request.script_path)]
            )
            process = subprocess.Popen(
                command,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                cwd=str(request.script_path.parent),
                env=request.env or None,
            )
            deadline = step_started + float(request.timeout_s)
            while process.poll() is None:
                if request.cancel is not None and request.cancel.cancelled:
                    process.kill()
                    cancelled = True
                    break
                if time.monotonic() > deadline:
                    process.kill()
                    timed_out = True
                    break
                time.sleep(POLL_S)
            out, err = process.communicate()
            stdout = out or ""
            stderr = err or ""
            returncode = process.returncode if process.returncode is not None else -1
            if timed_out:
                stderr = f"脚本执行超时（{int(request.timeout_s)}秒）"
                returncode = -1
            elif cancelled:
                reason = request.cancel.reason if request.cancel else "cancelled"
                stderr = f"已取消：{reason}"
                returncode = -1
        except OSError as error:
            stderr = str(error)
            returncode = -1

        duration_ms = (time.monotonic() - step_started) * 1000
        counts: dict[str, int] = {}
        if pytest_mode and not timed_out and not cancelled:
            counts = parse_pytest_counts(stdout)
            status, failure = pytest_case_status(counts, returncode)
            if status == "fail":
                # 把 pytest 的失败块留在 case_end 上：执行详情、报告和日志分析
                # 都从这里取原文，只写「N 条用例失败」等于什么都没留下。
                failure = pytest_failure_excerpt(stdout) or stderr.strip() or failure
        else:
            passed = returncode == 0 and not timed_out and not cancelled
            status = "pass" if passed else ("skip" if cancelled else "fail")
            failure = None if passed else (stderr.strip() or f"exit code {returncode}")

        yield events.step_end(
            request.run_id,
            request.case_id,
            STEP_ID,
            status,
            duration_ms,
            detail={
                "returncode": returncode,
                "stdout": stdout[-20_000:],
                "stderr": stderr[-20_000:],
                "timedOut": timed_out,
                "cancelled": cancelled,
                "driver": "pytest" if pytest_mode else "script",
                "counts": counts,
            },
        )
        yield events.case_end(
            request.run_id,
            request.case_id,
            status,
            (time.monotonic() - started) * 1000,
            failure=failure,
        )


def _as_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", "replace")
    return str(value)
