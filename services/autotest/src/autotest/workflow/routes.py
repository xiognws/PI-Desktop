"""Agent 工具的 HTTP 入口。

每个路由返回统一信封 `{ok, summary, data, refs}`：工具的 execute 只做转发，
不需要再拼一套结果结构。真正的规则（阶段、去重、上限）留在 Python 里，
模型改不了。
"""

from __future__ import annotations

import sqlite3
import threading
import uuid
from contextlib import contextmanager
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from autotest.workflow import analysis as analysis_service
from autotest.workflow import cases as case_service
from autotest.workflow import execution as execution_service
from autotest.workflow import prd as prd_service
from autotest.workflow import report as report_service
from autotest.workflow import review as review_service
from autotest.workflow import scripts as script_service
from autotest.workflow import store

router = APIRouter(prefix="/api/projects/{project_id}/workflow", tags=["workflow"])


def _server():
    # 延迟导入：server 在模块末尾 include_router，顶层导入会形成循环。
    from autotest.api import server

    return server


@contextmanager
def _project_conn(project_id: str):
    server = _server()
    server.require_project(project_id)
    db_path = server.get_project_db(project_id)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        store.ensure_workflow_tables(conn)
        yield conn
        conn.commit()
    finally:
        conn.close()


def _read_requirement_text(project_id: str, ref: str) -> str:
    """按 requirements 表找文件；表里没有时退到 specs/ 与 requirements/ 目录。"""
    server = _server()
    db_path = server.get_project_db(project_id)
    candidates: list[Path] = []
    if db_path.exists():
        conn = sqlite3.connect(db_path)
        try:
            row = conn.execute(
                "SELECT filepath FROM requirements WHERE filename = ? OR id = ?", (ref, ref)
            ).fetchone()
            if row and row[0]:
                candidates.append(Path(str(row[0])))
        finally:
            conn.close()
    project_dir = server.WORKSPACE / project_id
    for folder in ("specs", "requirements"):
        candidates.append(project_dir / folder / ref)
    for candidate in candidates:
        if candidate.is_file():
            data = candidate.read_bytes()
            for encoding in ("utf-8", "utf-8-sig", "gb18030"):
                try:
                    return data.decode(encoding)
                except UnicodeDecodeError:
                    continue
            return data.decode("utf-8", errors="replace")
    raise HTTPException(status_code=404, detail=f"需求文档不存在: {ref}")


class PrdParseIn(BaseModel):
    text: str | None = None
    requirement_ref: str | None = None
    module: str = ""
    session_id: str = ""
    run_id: str | None = None


class CaseDesignIn(BaseModel):
    run_id: str
    types: list[str] | None = None
    template: str = "standard"
    prd_result: dict | None = None


class CaseReviewIn(BaseModel):
    run_id: str
    cases: list[dict] | None = None
    module: str = ""


class LogAnalyzeIn(BaseModel):
    raw_log: str = ""
    execution_id: int | None = None
    trace_id: str = ""
    module: str = ""
    run_id: str | None = None


class ScriptAuthorIn(BaseModel):
    run_id: str
    cases: list[dict] | None = None
    sdk: str = "pytest"


class ExecuteIn(BaseModel):
    script_ids: list[str] | None = None
    timeout_s: float = 60.0


class ReportIn(BaseModel):
    execution_payload: dict | None = None


class BugStatusIn(BaseModel):
    status: str


class DecisionCreateIn(BaseModel):
    prompt: str
    options: list[str]
    step_id: int | None = None


class DecisionDecideIn(BaseModel):
    answer: str
    note: str = ""


def _envelope(summary: str, data: dict, run_id: str, kind: str = "run") -> dict:
    return {
        "ok": True,
        "summary": summary,
        "data": data,
        "refs": [{"kind": kind, "id": run_id}],
    }


@router.post("/prd-parse")
def prd_parse(project_id: str, body: PrdParseIn) -> dict:
    text = body.text or ""
    if not text and body.requirement_ref:
        text = _read_requirement_text(project_id, body.requirement_ref)
    if not text.strip():
        raise HTTPException(status_code=400, detail="text 与 requirement_ref 至少提供一个")

    result = prd_service.parse_prd(text, body.module)
    fp_count = len(result["function_points"])
    with _project_conn(project_id) as conn:
        run_id = body.run_id or store.create_run(
            conn, project_id, body.module, body.requirement_ref or "", body.session_id
        )
        store.append_step(
            conn,
            run_id,
            tool="autotest_prd_parse",
            stage="parsed",
            summary=f"解析出 {fp_count} 个功能点",
            payload=result,
        )
        store.touch_run(conn, run_id, stage="parsed")
        run = store.get_run(conn, run_id) or {}

    data = {
        "run_id": run_id,
        "function_points": result["function_points"][:10],
        "function_point_total": fp_count,
        "non_functional": result["non_functional"][:5],
        "dependencies": result["dependencies"][:5],
        "risks": result["risks"][:5],
        "stats": result["stats"],
        "stage": run.get("stage"),
    }
    return _envelope(f"解析出 {fp_count} 个功能点、{len(result['risks'])} 条风险", data, run_id)


@router.post("/case-design")
def case_design(project_id: str, body: CaseDesignIn) -> dict:
    with _project_conn(project_id) as conn:
        run = store.get_run(conn, body.run_id)
        if run is None:
            raise HTTPException(status_code=404, detail=f"运行不存在: {body.run_id}")
        prd_result = body.prd_result or store.last_payload(conn, body.run_id, "autotest_prd_parse")
        if not prd_result:
            raise HTTPException(status_code=409, detail="还没有 PRD 解析结果，先调用 prd-parse")
        result = case_service.design_cases(prd_result, body.types, body.template)
        store.append_step(
            conn,
            body.run_id,
            tool="autotest_case_design",
            stage="designed",
            summary=f"生成 {result['stats']['total']} 条用例",
            payload=result,
        )
        store.touch_run(conn, body.run_id, stage="designed")
        run = store.get_run(conn, body.run_id) or {}

    data = {
        "run_id": body.run_id,
        "case_total": result["stats"]["total"],
        "by_type": result["stats"]["by_type"],
        "preview": result["cases"][:5],
        "stats": result["stats"],
        "stage": run.get("stage"),
    }
    return _envelope(f"生成 {result['stats']['total']} 条用例（{len(result['stats']['by_type'])} 种类型）", data, body.run_id)


@router.post("/case-review")
def case_review(project_id: str, body: CaseReviewIn) -> dict:
    with _project_conn(project_id) as conn:
        run = store.get_run(conn, body.run_id)
        if run is None:
            raise HTTPException(status_code=404, detail=f"运行不存在: {body.run_id}")
        cases = body.cases
        if cases is None:
            designed = store.last_payload(conn, body.run_id, "autotest_case_design") or {}
            cases = designed.get("cases") or []
        result = review_service.review_cases(cases, body.module or str(run.get("module") or ""))
        store.append_step(
            conn,
            body.run_id,
            tool="autotest_case_review",
            stage="reviewed",
            status="ok" if result["verdict"] == "ok" else "warning",
            summary=f"评审结论 {result['verdict']}，不可测 {len(result['untestable'])} 条",
            payload=result,
        )
        store.touch_run(conn, body.run_id, stage="reviewed")

    return _envelope(
        f"评审结论 {result['verdict']}：不可测 {len(result['untestable'])} 条、重复 {len(result['duplicates'])} 条",
        {"run_id": body.run_id, **result},
        body.run_id,
    )


def _execution_events_text(project_id: str, execution_id: int) -> str:
    """把一次执行的 RunEvent 流拼成纯文本，作为没传 raw_log 时的分析输入。"""
    server = _server()
    events = server.read_events(server.get_project_db(project_id), execution_id)
    lines: list[str] = []
    for event in events:
        matched = False
        # 执行器把 stdout/stderr 放在 step_end 的 detail 里，失败现场在那。
        detail = event.get("detail") if isinstance(event, dict) else None
        if isinstance(detail, dict):
            for key in ("stderr", "stdout"):
                value = detail.get(key)
                if isinstance(value, str) and value.strip():
                    lines.append(value)
                    matched = True
                    break
        if matched:
            continue
        for key in ("line", "message", "text", "output"):
            value = event.get(key) if isinstance(event, dict) else None
            if isinstance(value, str) and value.strip():
                lines.append(value)
                matched = True
                break
        if not matched:
            lines.append(str(event))
    return "\n".join(lines)


@router.post("/log-analyze")
def log_analyze(project_id: str, body: LogAnalyzeIn) -> dict:
    raw = body.raw_log or ""
    if not raw.strip() and body.execution_id is not None:
        raw = _execution_events_text(project_id, body.execution_id)
    if not raw.strip():
        raise HTTPException(status_code=400, detail="raw_log 与 execution_id 至少提供一个")

    result = analysis_service.analyze_log(raw, body.trace_id, body.module)
    if body.run_id:
        with _project_conn(project_id) as conn:
            if store.get_run(conn, body.run_id) is not None:
                store.append_step(
                    conn,
                    body.run_id,
                    tool="autotest_log_analyze",
                    stage="executed",
                    status="warning" if result["error"] else "ok",
                    summary=result["summary"][:120],
                    payload=result,
                )
                store.touch_run(conn, body.run_id, stage="executed")

    data = {
        "run_id": body.run_id,
        "execution_id": body.execution_id,
        "summary": result["summary"],
        "error": result["error"],
        "suspects": result["suspects"],
        "suggestions": result["suggestions"],
        "stats": result["stats"],
    }
    return _envelope(result["summary"][:160], data, body.run_id or "")


@router.post("/script-author")
def script_author(project_id: str, body: ScriptAuthorIn) -> dict:
    """用例 → pytest 骨架，同时落 scripts 表与项目 scripts/ 目录。

    执行器读的是 scripts 表（filepath 指向真实文件），所以脚本必须先落库，
    后面的 run 才能直接投递。
    """
    server = _server()
    with _project_conn(project_id) as conn:
        run = store.get_run(conn, body.run_id)
        if run is None:
            raise HTTPException(status_code=404, detail=f"运行不存在: {body.run_id}")
        cases = body.cases
        if cases is None:
            designed = store.last_payload(conn, body.run_id, "autotest_case_design") or {}
            cases = designed.get("cases") or []
        if not cases:
            raise HTTPException(status_code=409, detail="还没有用例，先调用 case-design")

        scripts_dir = (server.WORKSPACE / project_id / "scripts").resolve()
        scripts_dir.mkdir(parents=True, exist_ok=True)
        authored = script_service.author_scripts(cases, body.sdk)

        created: list[dict] = []
        for item in authored["scripts"]:
            script_id = f"script_{uuid.uuid4().hex[:8]}"
            filepath = scripts_dir / item["name"]
            filepath.write_text(item["content"], encoding="utf-8")
            conn.execute(
                "INSERT INTO scripts (id, case_id, name, language, status, filepath) VALUES (?, ?, ?, ?, ?, ?)",
                (script_id, item["case_ref"]["title"], item["name"], item["language"], "就绪", str(filepath)),
            )
            created.append(
                {
                    "script_id": script_id,
                    "name": item["name"],
                    "filepath": str(filepath),
                    "case_type": item["case_ref"]["case_type"],
                }
            )

        store.append_step(
            conn,
            body.run_id,
            tool="autotest_script_author",
            stage="authored",
            summary=f"生成 {len(created)} 个 pytest 骨架",
            payload={"scripts": created, "stats": authored["stats"]},
        )
        store.touch_run(conn, body.run_id, stage="authored")

    data = {
        "run_id": body.run_id,
        "script_total": len(created),
        "scripts": created[:10],
        "stats": authored["stats"],
    }
    return _envelope(f"生成 {len(created)} 个 pytest 骨架，已落 scripts 表", data, body.run_id)


def _run_batch_thread(
    db_path: Path,
    project_id: str,
    run_id: str,
    rows: list[dict],
    project_dir: Path,
    timeout_s: float,
) -> None:
    """后台执行线程：必须自己开连接，不能借用请求线程的那条。"""
    payload = execution_service.run_scripts(
        db_path, project_id, rows, project_dir=project_dir, timeout_s=timeout_s
    )
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        store.ensure_workflow_tables(conn)
        stats = payload["stats"]
        store.append_step(
            conn,
            run_id,
            tool="autotest_run_result",
            stage="executed",
            status="ok" if stats["fail"] == 0 and stats["error"] == 0 else "warning",
            summary=f"{stats['pass']}/{stats['total']} 通过，失败 {stats['fail']}，异常 {stats['error']}",
            payload=payload,
        )
        store.touch_run(conn, run_id, stage="executed")
        conn.commit()
    finally:
        conn.close()


@router.post("/runs/{run_id}/execute")
def execute_run(project_id: str, run_id: str, body: ExecuteIn) -> dict:
    """投递执行：后台线程跑，调用方拿 runId 轮询，不阻塞等待全部跑完。"""
    server = _server()
    with _project_conn(project_id) as conn:
        run = store.get_run(conn, run_id)
        if run is None:
            raise HTTPException(status_code=404, detail=f"运行不存在: {run_id}")
        authored = store.last_payload(conn, run_id, "autotest_script_author") or {}
        if body.script_ids:
            # 显式给 id 时直接用：人工补的脚本、或只重跑失败的子集都走这条路径。
            script_ids = [str(item) for item in body.script_ids]
        else:
            script_ids = [str(item.get("script_id") or "") for item in (authored.get("scripts") or [])]
        script_ids = [item for item in script_ids if item]
        if not script_ids:
            raise HTTPException(status_code=409, detail="还没有可执行的脚本，先调用 script-author")

        placeholders = ",".join("?" for _ in script_ids)
        rows = [dict(row) for row in conn.execute(
            f"SELECT * FROM scripts WHERE id IN ({placeholders})", script_ids
        ).fetchall()]
        store.append_step(
            conn,
            run_id,
            tool="autotest_run",
            stage="authored",
            status="running",
            summary=f"投递 {len(rows)} 个脚本",
            payload={"script_ids": script_ids},
        )
        # 重跑一轮（例如修完脚本再执行）要把它从 done 拉回 running。
        store.touch_run(conn, run_id, status="running")

    db_path = server.get_project_db(project_id)
    project_dir = server.safe_project_dir(project_id)
    threading.Thread(
        target=_run_batch_thread,
        args=(db_path, project_id, run_id, rows, project_dir, body.timeout_s),
        daemon=True,
        name=f"wf-run-{run_id}",
    ).start()

    data = {"run_id": run_id, "status": "started", "script_total": len(rows), "script_ids": script_ids[:10]}
    return _envelope(f"已投递 {len(rows)} 个脚本，轮询 run 状态获取结果", data, run_id)


@router.get("/bugs")
def project_bugs(project_id: str, status: str | None = None, limit: int = 100) -> dict:
    """项目级缺陷清单（前端「缺陷」页用）：跨 run 归并后的单子，最近出现的在前。"""
    with _project_conn(project_id) as conn:
        try:
            bugs = store.list_project_bugs(conn, project_id, status, limit)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    summary = f"{len(bugs)} 条缺陷单" + (f"（{status}）" if status else "")
    return {"ok": True, "summary": summary, "data": {"bugs": bugs, "total": len(bugs)}}


@router.patch("/bugs/{bug_id}")
def update_project_bug(project_id: str, bug_id: str, body: BugStatusIn) -> dict:
    """项目级改缺陷状态（不要求指定 run：缺陷单是跨 run 归并的同一张单）。"""
    with _project_conn(project_id) as conn:
        if not store.bug_in_project(conn, bug_id, project_id):
            raise HTTPException(status_code=404, detail=f"项目里没有这条缺陷单: {bug_id}")
        try:
            store.update_bug_status(conn, bug_id, body.status)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {
        "ok": True,
        "summary": f"{bug_id} → {body.status}",
        "data": {"bug_id": bug_id, "status": body.status},
    }


@router.get("/runs/{run_id}/bugs")
def run_bugs(project_id: str, run_id: str) -> dict:
    """缺陷单列表（前端用）：报告出完后每个失败脚本一条，按创建顺序。"""
    with _project_conn(project_id) as conn:
        if store.get_run(conn, run_id) is None:
            raise HTTPException(status_code=404, detail=f"运行不存在: {run_id}")
        bugs = store.list_bugs(conn, run_id)
    return {"ok": True, "summary": f"{len(bugs)} 条缺陷单", "data": {"bugs": bugs, "total": len(bugs)}}


@router.get("/runs/{run_id}/report-content")
def report_content(project_id: str, run_id: str) -> dict:
    """报告正文（前端渲染用）：从最后一次 report 步骤记下的路径读取。"""
    server = _server()
    with _project_conn(project_id) as conn:
        if store.get_run(conn, run_id) is None:
            raise HTTPException(status_code=404, detail=f"运行不存在: {run_id}")
        payload = store.find_payload(conn, run_id, "autotest_report", "path") or {}
    raw_path = str(payload.get("path") or "")
    if not raw_path:
        raise HTTPException(status_code=409, detail="这次运行还没有生成报告")
    reports_dir = (server.safe_project_dir(project_id) / "reports").resolve()
    target = Path(raw_path).resolve()
    if reports_dir not in target.parents or not target.is_file():
        raise HTTPException(status_code=404, detail="报告文件不存在")
    markdown = target.read_text(encoding="utf-8")
    return {
        "ok": True,
        "summary": f"{target.name}（{len(markdown)} 字符）",
        "data": {"name": target.name, "markdown": markdown[:20_000], "chars": len(markdown)},
    }


@router.patch("/runs/{run_id}/bugs/{bug_id}")
def update_bug(project_id: str, run_id: str, bug_id: str, body: BugStatusIn) -> dict:
    """人工流转缺陷单状态（open / fixed / verified / wontfix）。"""
    with _project_conn(project_id) as conn:
        if store.get_run(conn, run_id) is None:
            raise HTTPException(status_code=404, detail=f"运行不存在: {run_id}")
        if not store.bug_visible_in_run(conn, bug_id, run_id):
            raise HTTPException(status_code=404, detail=f"这个运行里没有缺陷单: {bug_id}")
        try:
            store.update_bug_status(conn, bug_id, body.status)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {
        "ok": True,
        "summary": f"{bug_id} → {body.status}",
        "data": {"bug_id": bug_id, "status": body.status},
    }


@router.get("/runs/{run_id}/status")
def run_status(project_id: str, run_id: str) -> dict:
    """给 Agent 的摘要视图：步骤名、状态、待确认与执行统计，不含 payload 大对象。"""
    with _project_conn(project_id) as conn:
        run = store.get_run(conn, run_id)
        if run is None:
            raise HTTPException(status_code=404, detail=f"运行不存在: {run_id}")
        steps = [
            {
                "seq": step["seq"],
                "tool": step["tool"],
                "stage": step["stage"],
                "status": step["status"],
                "summary": step["summary"],
            }
            for step in run.get("steps") or []
        ]
        pending = run.get("pending") or []
        executed = store.last_payload(conn, run_id, "autotest_run_result") or {}
        bug_count = len(store.list_bugs(conn, run_id))

    stats = executed.get("stats") or {}
    failures = [
        {
            "script_name": item.get("script_name"),
            "status": item.get("status"),
            "failure": str(item.get("failure") or "")[:200],
        }
        for item in execution_service.failed_results(executed)[:5]
    ]
    data = {
        "run_id": run_id,
        "stage": run.get("stage"),
        "status": run.get("status"),
        "steps": steps,
        "pending": [
            {"decision_id": item.get("id"), "prompt": item.get("prompt"), "options": item.get("options")}
            for item in pending
        ],
        "execution": stats,
        "failures": failures,
        "bugs": bug_count,
    }
    summary = f"阶段 {run.get('stage')} / 状态 {run.get('status')} / 步骤 {len(steps)} 条"
    if stats:
        summary += f" / 通过 {stats.get('pass')}/{stats.get('total')}"
    return _envelope(summary, data, run_id)


@router.post("/runs/{run_id}/report")
def build_report(project_id: str, run_id: str, body: ReportIn) -> dict:
    server = _server()
    with _project_conn(project_id) as conn:
        run = store.get_run(conn, run_id)
        if run is None:
            raise HTTPException(status_code=404, detail=f"运行不存在: {run_id}")
        payload = body.execution_payload or store.last_payload(conn, run_id, "autotest_run_result")
        if not payload:
            raise HTTPException(status_code=409, detail="还没有执行结果，先调用 execute")
        designed = store.last_payload(conn, run_id, "autotest_case_design") or {}
        cases_total = int((designed.get("stats") or {}).get("total") or 0)

        # 失败 → bug 单：确定性映射（失败用例 + 最近一次日志分析的错误类型），不经过模型。
        failed_items = execution_service.failed_results(payload)
        analysis = store.last_payload(conn, run_id, "autotest_log_analyze") or {}
        error_type = str((analysis.get("error") or {}).get("type") or "")
        for item in failed_items:
            script_name = str(item.get("script_name") or item.get("script_id") or "")
            if script_name and store.bug_exists(conn, run_id, script_name):
                continue
            first_line = str(item.get("failure") or "").strip().splitlines()
            reason = (first_line[0][:100] if first_line else f"状态 {item.get('status')}")
            store.create_bug(
                conn,
                run_id,
                title=f"{script_name or '未命名脚本'} 失败：{reason}",
                script_name=script_name,
                case_id=str(item.get("case_id") or ""),
                severity="blocker" if item.get("status") == "error" else "major",
                error_type=error_type,
                summary=reason,
                repro=str(item.get("execution_id") or ""),
            )
        bugs = store.list_bugs(conn, run_id)

        # 通过的用例 → 自动改缺陷状态：同一签名若还挂着 open/fixed，说明修好了，置 verified。
        verified_bug_ids: list[str] = []
        for item in payload.get("results") or []:
            if item.get("status") != "pass":
                continue
            signature = store.bug_signature(
                str(item.get("script_name") or item.get("script_id") or ""),
                str(item.get("case_id") or ""),
            )
            bug_id = store.find_bug_by_signature(conn, signature)
            if bug_id:
                store.update_bug_status(conn, bug_id, "verified")
                store.record_occurrence(
                    conn,
                    bug_id,
                    run_id,
                    str(item.get("script_name") or item.get("script_id") or ""),
                    str(item.get("execution_id") or ""),
                )
                verified_bug_ids.append(bug_id)

        result = report_service.build_report(
            run_id,
            str(run.get("module") or ""),
            payload,
            cases_total=cases_total,
            requirement=str(run.get("requirement_ref") or ""),
            bugs=bugs,
        )
        reports_dir = (server.WORKSPACE / project_id / "reports").resolve()
        reports_dir.mkdir(parents=True, exist_ok=True)
        report_path = reports_dir / result["name"]
        report_path.write_text(result["markdown"], encoding="utf-8")

        counts = result["counts"]
        first_execution = next(
            (item.get("execution_id") for item in (payload.get("results") or [])), None
        )
        report_id = f"report_{uuid.uuid4().hex[:8]}"
        conn.execute(
            "INSERT INTO reports (id, name, total, passed, failed, pass_rate, execution_id)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                report_id,
                result["name"],
                counts["total"],
                counts["passed"],
                counts["failed"] + counts["errored"],
                result["pass_rate"],
                first_execution,
            ),
        )
        store.append_step(
            conn,
            run_id,
            tool="autotest_report",
            stage="reported",
            status="ok",
            summary=f"通过率 {result['pass_rate']}，报告 {result['name']}",
            payload={"report_id": report_id, "path": str(report_path), "counts": counts},
        )
        store.touch_run(conn, run_id, stage="reported", status="done")

        # 流水线的最后一步：报告归档进项目知识库（后续同类需求可直接检索到这一轮结论）
        from autotest.knowledge import store as knowledge_store

        knowledge_store.ensure_knowledge_tables(conn)
        # 重复出报告（例如改了结论再生成）不要产出第二条归档记录
        archived = conn.execute(
            "SELECT 1 FROM knowledge_records WHERE project_id = ? AND source_ref = ?"
            " AND record_type = 'run-report' LIMIT 1",
            (project_id, f"run:{run_id}"),
        ).fetchone()
        if archived is None:
            store.save_knowledge(
                conn,
                project_id,
                record_type="run-report",
                title=f"{run_id} 测试报告（通过率 {result['pass_rate']}）",
                content=result["markdown"][:20_000],
                module=str(run.get("module") or ""),
                tags=["report", "workflow-run"],
                source_ref=f"run:{run_id}",
            )
        store.append_step(
            conn,
            run_id,
            tool="autotest_report",
            stage="reported",
            status="ok",
            summary="报告已归档到知识库" if archived is None else "报告已归档过，跳过重复写入",
            payload={"knowledge_ref": f"run:{run_id}"},
        )

    data = {
        "run_id": run_id,
        "report_id": report_id,
        "path": str(report_path),
        "counts": counts,
        "pass_rate": result["pass_rate"],
        "bug_ids": [bug["id"] for bug in bugs],
        "verified_bug_ids": verified_bug_ids,
        "preview": result["markdown"][:400],
    }
    return _envelope(f"报告已生成：通过率 {result['pass_rate']}", data, run_id)


@router.post("/runs/{run_id}/pending")
def create_pending(project_id: str, run_id: str, body: DecisionCreateIn) -> dict:
    with _project_conn(project_id) as conn:
        if store.get_run(conn, run_id) is None:
            raise HTTPException(status_code=404, detail=f"运行不存在: {run_id}")
        decision_id = store.create_decision(conn, run_id, body.prompt, body.options, body.step_id)
    return _envelope(
        "已进入待人工确认",
        {"run_id": run_id, "decision_id": decision_id, "status": "waiting_human"},
        run_id,
        kind="decision",
    )


@router.post("/runs/{run_id}/pending/{decision_id}/decide")
def decide(project_id: str, run_id: str, decision_id: str, body: DecisionDecideIn) -> dict:
    with _project_conn(project_id) as conn:
        if store.get_run(conn, run_id) is None:
            raise HTTPException(status_code=404, detail=f"运行不存在: {run_id}")
        result = store.decide(conn, decision_id, body.answer, body.note)
        if result is None:
            raise HTTPException(status_code=404, detail=f"决策不存在: {decision_id}")
    return _envelope(f"已记录确认: {body.answer}", result, run_id)


@router.get("/runs")
def list_runs(project_id: str, limit: int = 20) -> dict:
    with _project_conn(project_id) as conn:
        return {"ok": True, "data": {"runs": store.list_runs(conn, project_id, limit)}}


@router.get("/runs/{run_id}")
def get_run(project_id: str, run_id: str) -> dict:
    with _project_conn(project_id) as conn:
        run = store.get_run(conn, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail=f"运行不存在: {run_id}")
    return {"ok": True, "data": run}


@router.get("/knowledge/search")
def knowledge_search(project_id: str, q: str = "", module: str = "", tags: str = "", limit: int = 20) -> dict:
    """前端检索入口：BM25 排序，命中短于 3 字符的词时退化为 LIKE。

    命中项由前端展示，用户手动选择后才把内容作为消息送进会话，
    Agent 侧不自动注入。
    """
    from autotest.knowledge import store as knowledge_store

    with _project_conn(project_id) as conn:
        knowledge_store.ensure_knowledge_tables(conn)
        records = knowledge_store.search_records(conn, project_id, q, module, tags, limit)
    return {"ok": True, "data": {"records": records, "total": len(records)}}
