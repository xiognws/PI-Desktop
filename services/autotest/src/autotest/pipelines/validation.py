"""Stage output rules for the autotest workflow.

The old ``pipelines/service.py`` bundled two different things: a stage state
machine and the rules that decide whether a stage output is usable. The state
machine is gone — the agent plans the order now — but the rules are worth
keeping, because they are the only place that knows what a usable set of
function points, cases, scripts, execution rows, verdicts, patches and report
looks like.

The workflow tools call these validators before writing anything to the
database, so a malformed model answer is rejected at the boundary instead of
becoming a row that later steps have to defend against.
"""

from __future__ import annotations

from typing import Any

TARGET_HEADER = "// @target"
VERDICTS = ("pass", "fail", "error", "cancelled")

MAX_FUNCTION_POINTS = 200
MAX_CASES = 200
MAX_SCRIPTS = 200


class PipelineRuleError(ValueError):
    """A stage output or transition broke a rule; the run must not advance."""


def _require_list(payload: dict[str, Any], key: str, limit: int) -> list[Any]:
    value = payload.get(key)
    if not isinstance(value, list) or not value:
        raise PipelineRuleError(f"{key} must be a non-empty array")
    if len(value) > limit:
        raise PipelineRuleError(f"{key} has {len(value)} entries, limit is {limit}")
    return value


def validate_analyze(payload: dict[str, Any]) -> dict[str, Any]:
    points = _require_list(payload, "function_points", MAX_FUNCTION_POINTS)
    normalized: list[dict[str, Any]] = []
    for index, point in enumerate(points):
        if not isinstance(point, dict):
            raise PipelineRuleError(f"function_points[{index}] must be an object")
        name = str(point.get("name", "")).strip()
        if not name:
            raise PipelineRuleError(f"function_points[{index}].name is required")
        normalized.append(
            {
                "name": name,
                "module": str(point.get("module", "")).strip(),
                "description": str(point.get("description", "")).strip(),
                "priority": str(point.get("priority", "中")).strip() or "中",
            }
        )
    return {"function_points": normalized}


def validate_design(payload: dict[str, Any]) -> dict[str, Any]:
    cases = _require_list(payload, "cases", MAX_CASES)
    normalized: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, case in enumerate(cases):
        if not isinstance(case, dict):
            raise PipelineRuleError(f"cases[{index}] must be an object")
        title = str(case.get("title", "")).strip()
        if not title:
            raise PipelineRuleError(f"cases[{index}].title is required")
        if title in seen:
            raise PipelineRuleError(f"duplicate case title: {title}")
        seen.add(title)
        steps = case.get("steps")
        if isinstance(steps, list):
            steps_text = "\n".join(str(step).strip() for step in steps if str(step).strip())
        else:
            steps_text = str(steps or "").strip()
        if not steps_text:
            raise PipelineRuleError(f"cases[{index}].steps is required")
        expected = str(case.get("expected", "")).strip()
        if not expected:
            raise PipelineRuleError(f"cases[{index}].expected is required")
        normalized.append(
            {
                "title": title,
                "function_point": str(case.get("function_point", "")).strip(),
                "steps": steps_text,
                "expected": expected,
                "priority": str(case.get("priority", "中")).strip() or "中",
                "scene": str(case.get("scene", "正向")).strip() or "正向",
                "case_type": str(case.get("case_type", "正向")).strip() or "正向",
            }
        )
    return {"cases": normalized}


def validate_author(payload: dict[str, Any]) -> dict[str, Any]:
    scripts = _require_list(payload, "scripts", MAX_SCRIPTS)
    normalized: list[dict[str, Any]] = []
    for index, script in enumerate(scripts):
        if not isinstance(script, dict):
            raise PipelineRuleError(f"scripts[{index}] must be an object")
        name = str(script.get("name", "")).strip()
        content = str(script.get("content", ""))
        if not name:
            raise PipelineRuleError(f"scripts[{index}].name is required")
        language = str(script.get("language", "e2e")).strip().lower()
        if language not in ("python", "e2e"):
            raise PipelineRuleError(f"scripts[{index}].language must be python or e2e")
        if not content.strip():
            raise PipelineRuleError(f"scripts[{index}].content is required")
        if language == "e2e" and TARGET_HEADER not in content.splitlines()[0]:
            raise PipelineRuleError(
                f"scripts[{index}] is e2e but its first line has no `{TARGET_HEADER} <url>`"
            )
        case_ref = script.get("case_title") or script.get("case_id") or script.get("case")
        normalized.append(
            {
                "name": name,
                "language": language,
                "content": content,
                "case_title": str(case_ref or "").strip(),
            }
        )
    return {"scripts": normalized}


def validate_gate(payload: dict[str, Any]) -> dict[str, Any]:
    failures = payload.get("failures") or []
    if not isinstance(failures, list):
        raise PipelineRuleError("gate.failures must be an array")
    ok = bool(payload.get("ok")) and not failures
    return {"ok": ok, "failures": [str(item) for item in failures]}


def validate_execute(payload: dict[str, Any]) -> dict[str, Any]:
    runs = _require_list(payload, "executions", MAX_SCRIPTS)
    normalized: list[dict[str, Any]] = []
    for index, run in enumerate(runs):
        if not isinstance(run, dict):
            raise PipelineRuleError(f"executions[{index}] must be an object")
        for field in ("scriptId", "executionId", "status"):
            if run.get(field) in (None, ""):
                raise PipelineRuleError(f"executions[{index}].{field} is required")
        if str(run["status"]) not in VERDICTS:
            raise PipelineRuleError(f"executions[{index}].status must be one of {VERDICTS}")
        counts = run.get("counts") or {}
        normalized.append(
            {
                "scriptId": str(run["scriptId"]),
                "scriptName": str(run.get("scriptName", "")),
                "caseId": str(run.get("caseId", "")),
                "executionId": int(run["executionId"]),
                "status": str(run["status"]),
                "durationMs": float(run.get("durationMs") or 0.0),
                "failure": str(run.get("failure") or ""),
                "artifacts": [
                    {"kind": str(item.get("kind", "log")), "path": str(item.get("path", ""))}
                    for item in (run.get("artifacts") or [])
                    if isinstance(item, dict) and item.get("path")
                ],
                "counts": {
                    "pass": int(counts.get("pass") or 0),
                    "fail": int(counts.get("fail") or 0),
                    "skip": int(counts.get("skip") or 0),
                },
            }
        )
    return {"executions": normalized}


def validate_judge(payload: dict[str, Any]) -> dict[str, Any]:
    results = _require_list(payload, "results", MAX_SCRIPTS)
    normalized: list[dict[str, Any]] = []
    for index, item in enumerate(results):
        if not isinstance(item, dict):
            raise PipelineRuleError(f"results[{index}] must be an object")
        verdict = str(item.get("verdict", "")).strip()
        if verdict not in VERDICTS:
            raise PipelineRuleError(f"results[{index}].verdict must be one of {VERDICTS}")
        normalized.append(
            {
                "scriptId": str(item.get("scriptId", "")),
                "scriptName": str(item.get("scriptName", "")),
                "caseId": str(item.get("caseId", "")),
                "caseTitle": str(item.get("caseTitle", "")),
                "verdict": verdict,
                "reason": str(item.get("reason", "")),
                "durationMs": float(item.get("durationMs") or 0.0),
            }
        )
    counts = {"pass": 0, "fail": 0, "error": 0, "cancelled": 0}
    for item in normalized:
        counts[item["verdict"]] += 1
    return {"results": normalized, "counts": counts}


def validate_repair(payload: dict[str, Any]) -> dict[str, Any]:
    patched = payload.get("patched") or []
    if not isinstance(patched, list):
        raise PipelineRuleError("patched must be an array")
    normalized: list[dict[str, Any]] = []
    for index, item in enumerate(patched):
        if not isinstance(item, dict):
            raise PipelineRuleError(f"patched[{index}] must be an object")
        script_id = str(item.get("scriptId", "")).strip()
        if not script_id:
            raise PipelineRuleError(f"patched[{index}].scriptId is required")
        content = str(item.get("content", ""))
        if not content.strip():
            raise PipelineRuleError(f"patched[{index}].content is required")
        note = str(item.get("note", "")).strip()
        if not note:
            raise PipelineRuleError(
                f"patched[{index}].note is required: a patch must name the failure it fixes"
            )
        normalized.append(
            {
                "scriptId": script_id,
                "scriptName": str(item.get("scriptName", "")),
                "note": note,
                "content": content,
            }
        )
    if not normalized:
        raise PipelineRuleError("repair produced no patched script; nothing to re-run")
    return {"patched": normalized}


def validate_report(payload: dict[str, Any]) -> dict[str, Any]:
    markdown = str(payload.get("markdown", "")).strip()
    if len(markdown) < 80:
        raise PipelineRuleError("report markdown is too short to be evidence")
    counts = payload.get("counts") or {}
    return {
        "name": str(payload.get("name", "测试报告")),
        "markdown": markdown,
        "counts": {
            "pass": int(counts.get("pass") or 0),
            "fail": int(counts.get("fail") or 0),
            "error": int(counts.get("error") or 0),
            "cancelled": int(counts.get("cancelled") or 0),
        },
    }


VALIDATORS = {
    "analyze": validate_analyze,
    "design": validate_design,
    "author": validate_author,
    "gate": validate_gate,
    "execute": validate_execute,
    "judge": validate_judge,
    "repair": validate_repair,
    "report": validate_report,
}
