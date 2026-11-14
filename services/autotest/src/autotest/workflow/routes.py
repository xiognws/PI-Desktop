"""Agent 工具的 HTTP 入口。

每个路由返回统一信封 `{ok, summary, data, refs}`：工具的 execute 只做转发，
不需要再拼一套结果结构。真正的规则（阶段、去重、上限）留在 Python 里，
模型改不了。
"""

from __future__ import annotations

import json
import re
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from autotest.knowledge import extract
from autotest.prompts import PromptError
from autotest.prompts import catalog as prompt_catalog
from autotest.prompts import load as load_prompt
from autotest.workflow import analysis as analysis_service
from autotest.workflow import cases as case_service
from autotest.workflow import consistency
from autotest.workflow import script_state
from autotest.workflow import execution as execution_service
from autotest.workflow import grounding
from autotest.workflow import prd as prd_service
from autotest.workflow import report as report_service
from autotest.workflow import review as review_service
from autotest.workflow import scripts as script_service
from autotest.workflow import store

router = APIRouter(prefix="/api/projects/{project_id}/workflow", tags=["workflow"])

# pytest 的 "E   assert 1 <= 30" 与 "ValueError: xxx" 两种最可读的失败行。
_PYTEST_ERROR_LINE = re.compile(r"^E\s+(.+)$", re.MULTILINE)
_EXCEPTION_LINE = re.compile(r"^([A-Za-z_][\w.]*(?:Error|Exception))(?::\s*(.*))?$")


def _cases_steps_text(case: dict) -> str:
    """Flatten a designed case's steps into the single text column the table keeps."""
    steps = case.get("steps") or []
    expected = case.get("expected") or []
    lines: list[str] = []
    for index, step in enumerate(steps, start=1):
        line = f"{index}. {step}"
        if index - 1 < len(expected):
            line += f" → 预期：{expected[index - 1]}"
        lines.append(line)
    return "\n".join(lines)


def _persist_designed_cases(conn: sqlite3.Connection, module: str, cases: list[dict]) -> dict[str, str]:
    """把设计出来的用例写进项目 test_cases，返回「标题 → 用例 id」。

    幂等口径是 (module_id, title)：同一个标题重新设计时更新内容而不是再插一条，
    这样反复跑 case-design 不会让用例页翻倍。返回值给 script_author 用来把
    scripts.case_id 指向真实用例 id（早先存的是标题，关联只能靠字符串匹配）。

    复用调用方已持有的连接：这里再开一条连接到同一个项目库会直接撞上
    「database is locked」（路由在 _project_conn 里已经持有写事务）。
    """
    # 很早的库没有 evidence 列：按需补上，不重建表（保用户数据）。
    columns = {row[1] for row in conn.execute("PRAGMA table_info(test_cases)")}
    if "evidence" not in columns:
        conn.execute("ALTER TABLE test_cases ADD COLUMN evidence TEXT DEFAULT ''")

    ids: dict[str, str] = {}
    for case in cases:
        title = str(case.get("title") or "").strip()
        if not title:
            continue
        row = conn.execute(
            "SELECT id FROM test_cases WHERE title = ? AND COALESCE(module_id, '') = ?",
            (title, module),
        ).fetchone()
        steps_text = _cases_steps_text(case)
        expected_text = "\n".join(str(item) for item in (case.get("expected") or []))
        if row is not None:
            case_id = str(row["id"] if isinstance(row, sqlite3.Row) else row[0])
            conn.execute(
                "UPDATE test_cases SET precondition = ?, steps = ?, expected = ?,"
                " case_type = ?, priority = ?, module_id = ?, evidence = ?,"
                " updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                (
                    str(case.get("precondition") or ""),
                    steps_text,
                    expected_text,
                    str(case.get("case_type") or "正向"),
                    str(case.get("priority") or "中"),
                    module,
                    _case_evidence_text(case),
                    case_id,
                ),
            )
        else:
            case_id = f"case_{uuid.uuid4().hex[:8]}"
            function_point = str(case.get("function_point") or "").replace('"', "")
            conn.execute(
                "INSERT INTO test_cases (id, module_id, title, precondition, steps, expected,"
                " case_type, priority, status, tags, favorite, evidence)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, '未执行', ?, 0, ?)",
                (
                    case_id,
                    module,
                    title,
                    str(case.get("precondition") or ""),
                    steps_text,
                    expected_text,
                    str(case.get("case_type") or "正向"),
                    str(case.get("priority") or "中"),
                    json.dumps([function_point] if function_point else [], ensure_ascii=False),
                    _case_evidence_text(case),
                ),
            )
        ids[title] = case_id
    return ids


def _drop_stale_ungrounded(
    conn: sqlite3.Connection, module: str, keep_titles: set[str]
) -> int:
    """删掉「因为没依据被跳过」而留在库里的旧用例。

    只动 evidence 里 grounding=none 的行：有依据的用例、人工写的用例都不碰。
    """
    removed = 0
    rows = conn.execute(
        "SELECT id, title, evidence FROM test_cases WHERE COALESCE(module_id, '') = ?",
        (module,),
    ).fetchall()
    for row in rows:
        title = str(row["title"])
        if title in keep_titles:
            continue
        raw = row["evidence"]
        if not raw:
            continue
        try:
            parsed = json.loads(raw)
        except (TypeError, ValueError):
            continue
        if isinstance(parsed, dict) and parsed.get("grounding") == "none":
            conn.execute("DELETE FROM test_cases WHERE id = ?", (row["id"],))
            removed += 1
    return removed


def _case_evidence_text(case: dict) -> str:
    """用例的依据落库：JSON（doc/quote/numbers + grounding 等级）。

    存成文本而不是拆列：不同来源（资料条款、知识切片、人工补充）字段不一样，
    拆列会让后面的来源没法扩展。
    """
    payload = {
        "grounding": str(case.get("grounding") or "none"),
        "reason": str(case.get("basis_reason") or ""),
        "evidence": case.get("evidence"),
    }
    if not payload["evidence"]:
        return json.dumps(
            {"grounding": payload["grounding"], "reason": payload["reason"], "evidence": None},
            ensure_ascii=False,
        )
    return json.dumps(payload, ensure_ascii=False)


def _failure_reason(text: str, fallback: str) -> str:
    """Pick the line a human would quote from a failure block.

    pytest 的失败块第一行是 `____ test_name ____` 这层装饰，直接取第一行会让缺陷
    标题变成一串下划线。优先取断言行（`E   assert …`），其次异常行，最后才是
    第一行有内容的文本。
    """
    lines = [line.rstrip() for line in (text or "").splitlines()]
    for line in reversed(lines):
        matched = _PYTEST_ERROR_LINE.match(line)
        if matched and matched.group(1).strip():
            return matched.group(1).strip()[:200]
    for line in reversed(lines):
        if _EXCEPTION_LINE.match(line.strip()):
            return line.strip()[:200]
    for line in lines:
        stripped = line.strip()
        if not stripped or set(stripped) <= set("_= "):
            continue
        return stripped[:200]
    return fallback


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
            # .docx/.pdf/.xlsx 是二进制容器，必须先抽文本；直接 decode 只会拿到
            # ZIP 里的一段乱码（实测 649 KB 的 docx 解出 62 万字符、0 个标题、
            # 于是 prd-parse 恒定「解析出 0 个功能点」）。
            if extract.is_supported(candidate.name):
                try:
                    return extract.extract_text(candidate.name, data).text
                except extract.UnsupportedDocument as problem:
                    raise HTTPException(status_code=400, detail=str(problem)) from problem
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
    # 没有知识库依据的用例默认不生成（只进"待补资料"清单）；需要占位时显式传 false。
    skip_ungrounded: bool = True


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
    # 默认不覆盖"已补断言"的脚本：骨架是模板产物，补完断言的脚本是人的资产。
    # 需要整体重出时显式传 true。
    overwrite: bool = False


class ExecuteIn(BaseModel):
    script_ids: list[str] | None = None
    timeout_s: float = 60.0


class ReportIn(BaseModel):
    execution_payload: dict | None = None


class BugStatusIn(BaseModel):
    status: str


class BugBatchIn(BaseModel):
    ids: list[str]
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
        "prompt": _prompt_marker("prd-parse"),
    }
    return _envelope(f"解析出 {fp_count} 个功能点、{len(result['risks'])} 条风险", data, run_id)


@router.post("/case-design")
def case_design(project_id: str, body: CaseDesignIn) -> dict:
    server = _server()
    # 项目库由 init_project_db 建（含 test_cases）。库不存在就先建，否则下面把
    # 设计结果落进用例表时会撞上缺表；已存在的库不动。
    if not server.get_project_db(project_id).exists():
        server.init_project_db(project_id)
    with _project_conn(project_id) as conn:
        run = store.get_run(conn, body.run_id)
        if run is None:
            raise HTTPException(status_code=404, detail=f"运行不存在: {body.run_id}")
        prd_result = body.prd_result or store.last_payload(conn, body.run_id, "autotest_prd_parse")
        if not prd_result:
            raise HTTPException(status_code=409, detail="还没有 PRD 解析结果，先调用 prd-parse")
        # 先从知识库给每个功能点找依据：有条款原文就写具体的步骤与阈值，
        # 没有就退回模板并标 ungrounded（界面能看出哪些用例还没底）。
        function_points = prd_result.get("function_points") or []
        evidence = grounding.collect(conn, project_id, function_points)
        # 无依据也分几种：资料里没这一节、切片正文为空、条款没有可判定内容。
        # 不给原因的话，界面只能含糊地说"去入库吧"，用户根本不知道该补什么。
        reasons = grounding.diagnose(conn, project_id, function_points)
        result = case_service.design_cases(
            prd_result,
            body.types,
            body.template,
            evidence=evidence,
            reasons=reasons,
            skip_ungrounded=body.skip_ungrounded,
        )
        # 设计的用例要落进项目的 test_cases：用例页、执行状态回写、脚本关联都读那张
        # 表。只把它留在 workflow_steps 的 payload 里，界面上就永远是「0 条用例」。
        module = str(run.get("module") or "")
        # 固定提示词的硬性规则在这里落成"可判定的问题"：不合格不静默放过，
        # 结论跟着 payload 一起落库，评审与 Agent 都能看到。
        judgement = consistency.check_cases(result["cases"])
        result["consistency"] = judgement
        result["prompt"] = _prompt_marker("case-design")
        case_ids = _persist_designed_cases(conn, module, result["cases"])
        # 之前生成过、这次因为"没依据"被跳过的空壳要从用例库里清掉，
        # 否则它们会一直挂在列表里，看着像已经覆盖了那个功能点。
        removed = _drop_stale_ungrounded(conn, module, set(case_ids))
        result["stats"]["removed_stale"] = removed
        result["case_ids"] = case_ids
        store.append_step(
            conn,
            body.run_id,
            tool="autotest_case_design",
            stage="designed",
            status="ok" if judgement["ok"] else "warning",
            summary=(
                f"生成 {result['stats']['total']} 条用例"
                f"（有依据 {result['stats']['grounding']['strong']} 条"
                f"，仅条款 {result['stats']['grounding']['weak']} 条）"
                + (
                    f"，跳过 {result['stats']['skipped']} 条无依据用例待补资料"
                    if result["stats"].get("skipped")
                    else ""
                )
                + (
                    f"，不符合提示词规则 {len(judgement['issues'])} 处"
                    if not judgement["ok"]
                    else ""
                )
            ),
            payload=result,
        )
        store.touch_run(conn, body.run_id, stage="designed")
        run = store.get_run(conn, body.run_id) or {}

    data = {
        "run_id": body.run_id,
        "case_total": result["stats"]["total"],
        "by_type": result["stats"]["by_type"],
        "grounding": result["stats"]["grounding"],
        "reasons": result["stats"].get("reasons") or {},
        "uncovered": result["stats"].get("uncovered") or [],
        "consistency": result.get("consistency"),
        "prompt": result.get("prompt"),
        "skipped": result["stats"].get("skipped") or 0,
        "removed_stale": result["stats"].get("removed_stale") or 0,
        "preview": result["cases"][:5],
        "stats": result["stats"],
        "stage": run.get("stage"),
    }
    levels = result["stats"]["grounding"]
    return _envelope(
        f"生成 {result['stats']['total']} 条用例（{len(result['stats']['by_type'])} 种类型）"
        f"，其中有知识库依据 {levels['strong']} 条、仅条款无参数 {levels['weak']} 条、无依据 {levels['none']} 条",
        data,
        body.run_id,
    )


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
        review_judgement = consistency.check_review(result, cases)
        store.append_step(
            conn,
            body.run_id,
            tool="autotest_case_review",
            stage="reviewed",
            status="ok" if result["verdict"] == "ok" and review_judgement["ok"] else "warning",
            summary=(
                f"评审结论 {result['verdict']}，不可测 {len(result['untestable'])} 条"
                + (
                    f"，结论不符合提示词规则 {len(review_judgement['issues'])} 处"
                    if not review_judgement["ok"]
                    else ""
                )
            ),
            payload={
                **result,
                "prompt": _prompt_marker("case-review"),
                "consistency": review_judgement,
            },
        )
        store.touch_run(conn, body.run_id, stage="reviewed")

    return _envelope(
        f"评审结论 {result['verdict']}：不可测 {len(result['untestable'])} 条、重复 {len(result['duplicates'])} 条",
        {
            "run_id": body.run_id,
            **result,
            "prompt": _prompt_marker("case-review"),
            "consistency": review_judgement,
        },
        body.run_id,
    )


def _assertion_counts(stats: dict | None) -> dict | None:
    """执行统计里补上「真断言 / 骨架」两个口径。

    既有约定 `total = pass + fail + skip` 且 `passed` 含 skip，所以「通过 34/34」
    在全是骨架时也成立。界面与报告要能说出"其中 N 条真跑了断言"，就得单独给数。
    """
    if not stats:
        return stats
    total = int(stats.get("total") or 0)
    skipped = int(stats.get("skip") or 0)
    enriched = dict(stats)
    enriched["asserted_cases"] = max(total - skipped, 0)
    enriched["skeleton_cases"] = skipped
    return enriched


def _prompt_marker(stage: str) -> dict:
    """本次产出用的是哪一版固定提示词：`id@version` + 正文指纹。

    读不到就返回 error，而不是让整个阶段失败 —— 但产出里会明确写着"没有按固定
    提示词跑"，事后可追溯。
    """
    try:
        prompt = load_prompt(stage)
    except PromptError as problem:
        return {"stage": stage, "error": str(problem)}
    return {
        "stage": stage,
        "id": prompt.prompt_id,
        "version": prompt.version,
        "ref": prompt.ref,
        "digest": prompt.digest,
        "updated": prompt.updated,
    }


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
        "prompt": _prompt_marker("log-analyze"),
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

        # case-design 落库后回传「标题 → 用例 id」：脚本的 case_id 优先指向真实
        # 用例 id，老数据（case_id 存的是标题）继续按标题兼容。
        designed_payload = store.last_payload(conn, body.run_id, "autotest_case_design") or {}
        case_ids: dict[str, str] = designed_payload.get("case_ids") or {}

        scripts_dir = (server.WORKSPACE / project_id / "scripts").resolve()
        scripts_dir.mkdir(parents=True, exist_ok=True)
        authored = script_service.author_scripts(cases, body.sdk)
        # 脚本规则同样要可判定：骨架写成 assert True 或忘记 skip，执行器一跑就是绿的
        script_judgement = consistency.check_scripts(authored["scripts"])

        created: list[dict] = []
        preserved: list[str] = []
        for item in authored["scripts"]:
            filepath = scripts_dir / item["name"]
            # 已经补过断言的脚本不再被骨架覆盖：重新生成用例后顺手丢掉几天的补充工作
            # 是不可接受的（这类"重新生成"在流水线里点一下就会发生）。
            keep_file = False
            if not body.overwrite and filepath.is_file():
                current = script_state.classify(filepath.read_text(encoding="utf-8", errors="replace"))
                keep_file = current["state"] == "asserted"
            if keep_file:
                # 文件不动，但库里的关联要更新：用例重设计后 case_id 会变，
                # 不更新就会把一条好脚本变成孤儿。
                preserved.append(item["name"])
            else:
                filepath.write_text(item["content"], encoding="utf-8")
            case_ref = case_ids.get(str(item["case_ref"]["title"]), item["case_ref"]["title"])
            # 按文件名覆盖而不是再插一行：重新生成同一个用例的脚本时，旧的 INSERT
            # 会在 scripts 表里留下第二条同名记录（脚本数虚高、断言覆盖翻倍），
            # 而且执行历史里的 script_id 也跟着漂移。
            existing = conn.execute(
                "SELECT id FROM scripts WHERE name = ? LIMIT 1", (item["name"],)
            ).fetchone()
            if existing is not None:
                script_id = str(existing["id"])
                conn.execute(
                    "UPDATE scripts SET case_id = ?, language = ?, status = ?, filepath = ?,"
                    " updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                    (case_ref, item["language"], "就绪", str(filepath), script_id),
                )
            else:
                script_id = f"script_{uuid.uuid4().hex[:8]}"
                conn.execute(
                    "INSERT INTO scripts (id, case_id, name, language, status, filepath) VALUES (?, ?, ?, ?, ?, ?)",
                    (script_id, case_ref, item["name"], item["language"], "就绪", str(filepath)),
                )
            created.append(
                {
                    "script_id": script_id,
                    "name": item["name"],
                    "filepath": str(filepath),
                    "case_type": item["case_ref"]["case_type"],
                    "preserved": keep_file,
                }
            )

        store.append_step(
            conn,
            body.run_id,
            tool="autotest_script_author",
            stage="authored",
            status="ok" if script_judgement["ok"] else "warning",
            summary=(
                f"生成 {len(created)} 个 pytest 骨架"
                + (f"（保留 {len(preserved)} 个已补断言的脚本）" if preserved else "")
                + (
                    f"，不符合提示词规则 {len(script_judgement['issues'])} 处"
                    if not script_judgement["ok"]
                    else ""
                )
            ),
            payload={
                "scripts": created,
                "stats": authored["stats"],
                "preserved": preserved,
                "prompt": _prompt_marker("script-author"),
                "consistency": script_judgement,
            },
        )
        store.touch_run(conn, body.run_id, stage="authored")

    data = {
        "run_id": body.run_id,
        "script_total": len(created),
        "scripts": created[:10],
        "stats": authored["stats"],
        "preserved": preserved,
        "preserved_total": len(preserved),
        "prompt": _prompt_marker("script-author"),
        "consistency": script_judgement,
    }
    summary = f"生成 {len(created)} 个 pytest 骨架，已落 scripts 表"
    if preserved:
        summary += f"；保留 {len(preserved)} 个已补断言的脚本（要重出请传 overwrite=true）"
    return _envelope(summary, data, body.run_id)


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
        step_status = "ok" if stats["fail"] == 0 and stats["error"] == 0 else "warning"
        # 先把投递时那条 autotest_run（running）收尾，结果再单独记一条：
        # 不收尾的话步骤列表里会永远有一条在跑，界面和轮询的 Agent 都被它骗住。
        store.close_latest_step(
            conn,
            run_id,
            "autotest_run",
            status=step_status,
            summary=f"跑完 {stats['scripts']} 个脚本、{stats['total']} 条用例，通过 {stats['pass']}",
        )
        store.append_step(
            conn,
            run_id,
            tool="autotest_run_result",
            stage="executed",
            status=step_status,
            summary=(
                f"{stats['pass']}/{stats['total'] - stats.get('skip', 0)} 通过"
                f"（{stats.get('skip', 0)} 条骨架跳过），失败 {stats['fail']}，异常 {stats['error']}"
            ),
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


@router.post("/bugs/status")
def update_project_bugs_batch(project_id: str, body: BugBatchIn) -> dict:
    """批量流转缺陷状态（缺陷页多选后一次改多张）。

    逐条处理并分别回报：一张单不存在或状态非法，不该让整批回滚 —— 那会让人把
    「有几张已经改成功了」也重新点一遍。
    """
    ids = [str(item).strip() for item in body.ids if str(item).strip()]
    if not ids:
        raise HTTPException(status_code=400, detail="ids 不能为空")
    if len(ids) > 200:
        raise HTTPException(status_code=400, detail="一次最多改 200 张缺陷单")

    updated: list[str] = []
    failed: list[dict] = []
    with _project_conn(project_id) as conn:
        for bug_id in ids:
            if not store.bug_in_project(conn, bug_id, project_id):
                failed.append({"id": bug_id, "reason": "项目里没有这条缺陷单"})
                continue
            try:
                store.update_bug_status(conn, bug_id, body.status)
                updated.append(bug_id)
            except ValueError as exc:
                failed.append({"id": bug_id, "reason": str(exc)})
    summary = f"{len(updated)} 张缺陷单 → {body.status}"
    if failed:
        summary += f"，{len(failed)} 张失败"
    return {
        "ok": True,
        "summary": summary,
        "data": {"updated": updated, "failed": failed, "status": body.status},
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
        "execution": _assertion_counts(stats),
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
            failure_text = str(item.get("failure") or "")
            reason = _failure_reason(failure_text, f"状态 {item.get('status')}")
            store.create_bug(
                conn,
                run_id,
                title=f"{script_name or '未命名脚本'} 失败：{reason}",
                script_name=script_name,
                case_id=str(item.get("case_id") or ""),
                severity="blocker" if item.get("status") == "error" else "major",
                error_type=error_type or analysis_service.guess_error_type(failure_text),
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
        report_judgement = consistency.check_report(result["markdown"], counts, result["pass_rate"])
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
            status="ok" if report_judgement["ok"] else "warning",
            summary=(
                f"通过率 {result['pass_rate']}，报告 {result['name']}"
                + (
                    f"，报告不符合提示词规则 {len(report_judgement['issues'])} 处"
                    if not report_judgement["ok"]
                    else ""
                )
            ),
            payload={
                "report_id": report_id,
                "path": str(report_path),
                "counts": counts,
                "consistency": report_judgement,
            },
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
        "prompt": _prompt_marker("report"),
        "consistency": report_judgement,
    }
    return _envelope(f"报告已生成：通过率 {result['pass_rate']}", data, run_id)


@router.get("/prompts")
def list_prompts(project_id: str) -> dict:
    """固定提示词目录：每个阶段当前生效的版本号与正文指纹。

    Agent / 界面用它说明"这次按哪一版规则生成"，也方便确认改动是否已生效。
    """
    items = prompt_catalog()
    return _envelope(
        f"{len(items)} 份固定提示词", {"prompts": items, "total": len(items)}, ""
    )


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


@router.get("/pending")
def list_pending(project_id: str, limit: int = 50) -> dict:
    """项目级待办：所有 waiting 的人工卡点，按时间正序。

    审批页一次拿全项目，不用按 run 逐个拉；limit 夹在 1..200，防止前端要全表。
    """
    capped = max(1, min(int(limit), 200))
    with _project_conn(project_id) as conn:
        decisions = store.list_pending(conn, project_id, capped)
    # 项目级列表没有单条 run 可引用，refs 留空（_envelope 要求 run_id）。
    return {
        "ok": True,
        "summary": f"{len(decisions)} 条待审批",
        "data": {"decisions": decisions, "total": len(decisions)},
        "refs": [],
    }


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
