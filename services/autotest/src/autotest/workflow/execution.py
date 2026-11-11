"""批量投递与结果聚合（复用既有执行器，不新建进程模型）。

`execute_script` 自己会建 executions 行、写 RunEvent、回写用例状态；这一层只负责
"一次跑多条脚本、把结果收成固定形状"，以及把 stdout/stderr 压到可进会话的长度。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Mapping

from autotest.executors.service import execute_script

MAX_TAIL_CHARS = 2_000
MAX_RESULTS = 200


def _tail(text: str | None) -> str:
    text = (text or "").strip()
    return text if len(text) <= MAX_TAIL_CHARS else "…" + text[-MAX_TAIL_CHARS:]


def run_scripts(
    db_path: Path,
    project_id: str,
    scripts: list[Mapping[str, Any]],
    *,
    project_dir: Path | None = None,
    timeout_s: float = 60.0,
) -> dict:
    """顺序执行脚本并汇总。

    串行是刻意的：同一批用例共享测试环境，并行会让失败现场互相污染，
    Agent 拿到的日志也就失去归因价值。
    """
    results: list[dict] = []
    counts = {"pass": 0, "fail": 0, "error": 0, "cancelled": 0}
    started = 0.0

    for script in scripts[:MAX_RESULTS]:
        response = execute_script(
            Path(db_path),
            project_id,
            script,
            project_dir=project_dir,
            timeout_s=timeout_s,
        )
        status = str(response.get("status") or "error")
        counts[status if status in counts else "error"] += 1
        duration = float(response.get("duration_ms") or 0.0)
        started += duration
        results.append(
            {
                "script_id": str(script.get("id") or ""),
                "script_name": str(script.get("name") or ""),
                "case_id": str(script.get("case_id") or ""),
                "execution_id": response.get("execution_id"),
                "status": status,
                "success": bool(response.get("success")),
                "duration_ms": round(duration, 1),
                "failure": _tail(str(response.get("failure") or "")),
                "stdout_tail": _tail(str(response.get("stdout") or "")),
                "stderr_tail": _tail(str(response.get("stderr") or "")),
            }
        )

    return {
        "results": results,
        "stats": {
            "total": len(results),
            "pass": counts["pass"],
            "fail": counts["fail"],
            "error": counts["error"],
            "cancelled": counts["cancelled"],
            "duration_ms": round(started, 1),
        },
    }


def failed_results(payload: dict) -> list[dict]:
    return [item for item in (payload.get("results") or []) if item.get("status") != "pass"]
