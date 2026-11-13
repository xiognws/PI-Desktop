"""FastAPI 后端：serve 前端 dist + REST API + WebSocket"""
from pathlib import Path
import mimetypes

# Windows 的 mimetypes 把 .js 猜成 text/plain（微软坑），而前端 dist 的 ES module
# 脚本要求 application/javascript，否则浏览器 "MIME type text/plain" 拒绝加载 →
# 页面空白。在 app 装配前注册，确保 StaticFiles 对 .js 返回正确 MIME。
mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("application/javascript", ".mjs")
mimetypes.add_type("text/css", ".css")

from fastapi import FastAPI, UploadFile, File, HTTPException, WebSocket, WebSocketDisconnect, Body
from starlette.exceptions import HTTPException as StarletteHTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, FileResponse
from pydantic import BaseModel
import asyncio
import json
import os
import socket
import threading
import uuid
import shutil
import sqlite3
import subprocess
import sys
from datetime import datetime
from typing import Any

from autotest.executors import execute_script, read_events
from autotest.executors.service import cancel_execution
from autotest.storage.migrations import ensure_project_schema
from autotest.storage.sqlite import init_db, get_conn
from autotest.workflow.routes import router as workflow_router
from autotest.api.knowledge_routes import router as knowledge_router

# 宿主关掉后自己退出：否则残留后端会占住端口，下一次启动像是"插件坏了"
from autotest.runtime.watchdog import start_parent_watchdog

start_parent_watchdog()

app = FastAPI(title="AutoTestDemo", version="0.2.0")

# 版本指纹：/api/health 返回；前端据此感知后端版本变更（防"新后端+旧前端"错位）
APP_VERSION = "0.2.0"

# CORS —— 桌面版嵌入时 SandboxedFrame 以 origin 'null' 跨源加载前端静态资源，
# 必须放行任意 origin，否则 CSS/JS 被 CORS 拦截导致 iframe 空白。
# 仅 bind 127.0.0.1，风险有限；如后续对外暴露再收紧。
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 前端 dist（生产模式下 serve ui/dist）；Vue 版还没构建时退回零构建的 ui-shell。
# 用服务根目录而不是 cwd 推导：服务由 Electron 以任意工作目录拉起。
SERVICE_ROOT = Path(__file__).resolve().parents[3]
DIST = SERVICE_ROOT / "ui" / "dist"
SHELL = SERVICE_ROOT / "ui-shell"
# 项目数据目录：插件跑起来时由宿主指向 userData，避免写进插件包内部
WORKSPACE = Path(os.getenv("AUTOTEST_WORKSPACE", "workspace/projects"))

# 平台自己的配置文件：workspace 只用环境变量传的话，用户在设置页改了就无处安放。
# 放在 DATA_DIR（默认 cwd）而不是 WORKSPACE 里 —— 后者正是这个文件要指向的
# 东西，把它放进自己管辖的目录里会在切换 workspace 时被一起搬走。
SETTINGS_FILE = Path(os.getenv("AUTOTEST_SETTINGS_FILE", "platform-settings.json"))
# 已保存但尚未生效的 workspace：下次启动读它，而不是立刻改运行中的 WORKSPACE
PENDING_WORKSPACE: str = ""
# _current_port 需要知道实际监听端口；uvicorn 由插件以 --port 拉起
PORT = int(os.getenv("AUTOTEST_PORT", os.getenv("PORT", "4000")))
# 平台自己不做推理：这几段由桌面端 Agent 的 workflow 工具驱动，
# /api/platform 只是把它们列出来给界面展示。
_PLATFORM_STAGES = [
    {"id": "analyze", "name": "需求分析"},
    {"id": "design", "name": "用例设计"},
    {"id": "author", "name": "脚本工程"},
]
# 硬件适配 MCP（CAN / HMI / 日志）：平台只登记它们的存在与地址，
# 启用与授权在桌面端的 MCP 设置里。这里不探活 —— 设置页不该因为
# 一台没接的台架而显示整页报错。
MCP_HARDWARE_SERVERS = [
    ("mcp_can", "CAN 总线适配", "http://127.0.0.1:9100/mcp"),
    ("mcp_hmi", "座舱 HMI 适配", "http://127.0.0.1:9101/mcp"),
    ("mcp_logger", "日志采集适配", "http://127.0.0.1:9102/mcp"),
]


def _current_port() -> int:
    """服务真实监听的端口。

    宿主用 `--port <n>` 拉起 uvicorn，而 `PORT` 只从环境变量取默认值。两者
    不一致时（宿主传了 `--port` 却没传 `AUTOTEST_PORT`），"再起一份"之类的
    动作会开到错的端口上，所以命令行优先。
    """
    argv = sys.argv
    for index, item in enumerate(argv):
        if item == "--port" and index + 1 < len(argv):
            try:
                return int(argv[index + 1])
            except ValueError:
                break
        if item.startswith("--port="):
            try:
                return int(item.split("=", 1)[1])
            except ValueError:
                break
    return PORT


def load_platform_settings() -> None:
    """启动时读平台配置。环境变量优先于文件：插件宿主显式传的 AUTOTEST_WORKSPACE
    是权威，文件只是用户在设置页留下的选择。"""
    global PENDING_WORKSPACE, WORKSPACE
    if not SETTINGS_FILE.is_file():
        return
    try:
        data = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return
    saved = str(data.get("workspace", "")).strip()
    if saved and not os.getenv("AUTOTEST_WORKSPACE"):
        WORKSPACE = Path(saved)
    PENDING_WORKSPACE = saved


def _write_platform_settings() -> None:
    SETTINGS_FILE.write_text(
        json.dumps({"workspace": PENDING_WORKSPACE}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


# 每个项目的数据库表结构
PROJECT_DB_SCHEMA = """
-- 模块表（项目结构）
CREATE TABLE IF NOT EXISTS modules (
    id TEXT PRIMARY KEY,
    parent_id TEXT,
    name TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0
);

-- 测试用例表
CREATE TABLE IF NOT EXISTS test_cases (
    id TEXT PRIMARY KEY,
    module_id TEXT,
    title TEXT NOT NULL,
    precondition TEXT,
    steps TEXT,
    expected TEXT,
    case_type TEXT DEFAULT '正向',
    priority TEXT DEFAULT '中',
    status TEXT DEFAULT '未执行',
    tags TEXT DEFAULT '[]',
    favorite BOOLEAN DEFAULT 0,
    review_status TEXT DEFAULT '待评审',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 用例版本历史
CREATE TABLE IF NOT EXISTS case_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    author TEXT DEFAULT 'AI',
    changes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 脚本表
CREATE TABLE IF NOT EXISTS scripts (
    id TEXT PRIMARY KEY,
    case_id TEXT,
    name TEXT NOT NULL,
    language TEXT DEFAULT 'python',
    content TEXT,
    filepath TEXT,
    status TEXT DEFAULT '就绪',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 测试计划表
CREATE TABLE IF NOT EXISTS test_plans (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    cron TEXT,
    case_count INTEGER DEFAULT 0,
    last_run TIMESTAMP,
    last_result TEXT,
    status TEXT DEFAULT 'enabled',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 执行记录表
CREATE TABLE IF NOT EXISTS executions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id TEXT,
    name TEXT NOT NULL,
    total INTEGER DEFAULT 0,
    passed INTEGER DEFAULT 0,
    failed INTEGER DEFAULT 0,
    running INTEGER DEFAULT 0,
    status TEXT DEFAULT '执行中',
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    finished_at TIMESTAMP
);

-- 执行用例明细
CREATE TABLE IF NOT EXISTS execution_cases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    execution_id INTEGER NOT NULL,
    case_id TEXT NOT NULL,
    result TEXT DEFAULT '未执行',
    duration_ms INTEGER,
    error_message TEXT
);

-- 测试报告表
CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    total INTEGER DEFAULT 0,
    passed INTEGER DEFAULT 0,
    failed INTEGER DEFAULT 0,
    pass_rate TEXT,
    execution_id INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 需求文档表
CREATE TABLE IF NOT EXISTS requirements (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    filepath TEXT NOT NULL,
    size INTEGER,
    status TEXT DEFAULT '已上传',
    analyzed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 执行事件流（RunEvent v1，NDJSON payload 逐条落库）
CREATE TABLE IF NOT EXISTS execution_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    execution_id INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_execution_events_run ON execution_events (execution_id, seq);
"""


def get_project_db(project_id: str) -> Path:
    """获取项目的数据库文件路径；数据库已存在时顺带补齐最新表结构。

    老项目库是在旧 schema 下建的（例如 scripts 缺 filepath 列），每次取库就
    走一次幂等迁移，避免每个路由各自记得迁移而漏掉其中一条。
    """
    db_path = WORKSPACE / project_id / "data.db"
    if db_path.exists():
        migrate_project_db(db_path, project_id)
    return db_path


def migrate_project_db(db_path: Path, project_id: str) -> None:
    """幂等迁移一个项目数据库到当前表结构。"""
    conn = sqlite3.connect(db_path)
    try:
        ensure_project_schema(conn, WORKSPACE / project_id / "scripts")
        conn.commit()
    finally:
        conn.close()


def safe_project_dir(project_id: str) -> Path:
    """校验 project_id 形状合法（非空、无路径分隔符/反斜杠/占位符冒号），
    返回 WORKSPACE 下的项目目录。不要求实体存在 —— 创建流程在 project.json
    落盘前就需要用它建 data.db。"""
    if (
        not project_id
        or project_id in (".", "..")
        or "/" in project_id
        or "\\" in project_id
        or ":" in project_id
        or ".." in project_id
    ):
        raise HTTPException(status_code=404, detail=f"项目不存在: {project_id}")
    return WORKSPACE / project_id


def require_project(project_id: str) -> Path:
    """校验 project_id 指向一个真实存在的项目，返回其目录。

    只接受 WORKSPACE 下、含 project.json 注册文件的目录。这样 URL 里出现
    非法/字面占位符（如 :projectId）时返回 404，而不是被 get_project_db /
    init_project_db 拿去裸 mkdir 撞出 WinError 500，也不会在 workspace 留下
    ':projectId' 之类垃圾目录。
    """
    project_dir = safe_project_dir(project_id)
    if not project_dir.is_dir():
        raise HTTPException(status_code=404, detail=f"项目不存在: {project_id}")
    if not (project_dir / "project.json").is_file():
        raise HTTPException(status_code=404, detail=f"项目不存在: {project_id}")
    return project_dir


def init_project_db(project_id: str):
    """初始化项目数据库。

    用 safe_project_dir 做形状校验（创建项目时 project.json 尚未落盘，
    不能走 require_project 的实体存在校验）；读路径的调用方在 db 已存在时
    根本不会进这里。
    """
    project_dir = safe_project_dir(project_id)
    db_path = project_dir / "data.db"
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.executescript(PROJECT_DB_SCHEMA)
    ensure_project_schema(conn, project_dir / "scripts")
    conn.commit()
    conn.close()


@app.on_event("startup")
async def startup():
    load_platform_settings()
    init_db()
    WORKSPACE.mkdir(parents=True, exist_ok=True)


# ====== 项目管理 ======
class ProjectCreate(BaseModel):
    name: str
    description: str = ""
    type: str = "ECU"  # ECU / 座舱


@app.get("/api/projects")
async def list_projects():
    """获取项目列表"""
    projects = []
    for p in WORKSPACE.iterdir():
        if p.is_dir():
            config_file = p / "project.json"
            if config_file.exists():
                with open(config_file, "r", encoding="utf-8") as f:
                    cfg = json.load(f)
                    cfg["id"] = p.name
                    projects.append(cfg)
    return {"projects": projects}


@app.post("/api/projects")
async def create_project(p: ProjectCreate):
    """创建新项目"""
    project_id = f"proj_{uuid.uuid4().hex[:8]}"
    project_dir = WORKSPACE / project_id
    project_dir.mkdir(parents=True, exist_ok=True)

    # 创建子目录
    for sub in ["specs", "cases", "scripts", "executions", "reports"]:
        (project_dir / sub).mkdir(exist_ok=True)

    # 初始化项目数据库
    init_project_db(project_id)

    # 写配置文件
    config = {
        "name": p.name,
        "description": p.description,
        "type": p.type,
        "created_at": datetime.now().isoformat(),
        "case_count": 0,
        "execution_count": 0,
        "last_active": datetime.now().strftime("%Y-%m-%d"),
    }
    with open(project_dir / "project.json", "w", encoding="utf-8") as f:
        json.dump(config, f, ensure_ascii=False, indent=2)

    return {"id": project_id, **config}


class ProjectPatch(BaseModel):
    # None = 不改这个字段；空字符串 = 清空描述。
    name: str | None = None
    description: str | None = None


@app.patch("/api/projects/{project_id}")
async def update_project(project_id: str, body: ProjectPatch):
    """改项目名 / 描述。

    只改 `project.json`：项目 id 就是目录名，改它等于搬家 —— 产物路径、数据库位置和
    已生成脚本里的绝对路径都会跟着失效，所以这里不给改。
    """
    project_dir = require_project(project_id)
    config_file = project_dir / "project.json"
    with open(config_file, "r", encoding="utf-8") as f:
        config = json.load(f)

    if body.name is not None:
        name = body.name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="项目名不能为空")
        config["name"] = name
    if body.description is not None:
        config["description"] = body.description.strip()
    config["last_active"] = datetime.now().strftime("%Y-%m-%d")

    with open(config_file, "w", encoding="utf-8") as f:
        json.dump(config, f, ensure_ascii=False, indent=2)
    return {"id": project_id, **config}


@app.delete("/api/projects/{project_id}")
async def delete_project(project_id: str, confirm: str = ""):
    """删除项目：**移进回收目录**，不真删。

    项目目录里是用户的需求、用例、脚本、执行产物和报告，误删重建不回来，所以
    1) 必须带 `confirm=<project_id>`（前端做二次确认）；
    2) 整个目录移到 `<workspace>/.trash/<project_id>-<时间戳>`，从列表消失但能捡回来；
    3) 有执行在跑时拒绝删除，避免删掉正在写入的数据库。
    """
    project_dir = require_project(project_id)
    if confirm.strip() != project_id:
        raise HTTPException(status_code=400, detail="删除需要二次确认：confirm 必须等于项目 id")

    from autotest.executors.service import RUNNING

    if any(str(key).startswith(f"{project_id}:") for key in RUNNING):
        raise HTTPException(status_code=409, detail="这个项目还有执行在跑，先取消或等它结束")

    trash_dir = WORKSPACE.parent / ".trash"
    trash_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    target = trash_dir / f"{project_id}-{stamp}"
    try:
        project_dir.rename(target)
    except OSError as error:  # Windows: 目录里有文件被占用
        raise HTTPException(status_code=409, detail=f"项目目录被占用，暂时无法移走：{error}") from error
    return {
        "id": project_id,
        "trashed_to": str(target),
        "message": f"项目已移入回收目录，可从 {target} 恢复",
    }


# ====== 用例管理 ======
@app.get("/api/projects/{project_id}/cases")
async def list_cases(project_id: str):
    """获取项目下的测试用例"""
    require_project(project_id)
    db_path = get_project_db(project_id)
    if not db_path.exists():
        init_project_db(project_id)

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    rows = conn.execute("SELECT * FROM test_cases ORDER BY created_at DESC").fetchall()
    conn.close()

    cases = []
    for row in rows:
        c = dict(row)
        c["tags"] = json.loads(c.get("tags", "[]"))
        c["name"] = c.get("title", "")
        c["module"] = c.get("module_id", "")
        c["type"] = c.get("case_type", "正向")
        cases.append(c)

    return {"cases": cases, "total": len(cases)}


@app.get("/api/projects/{project_id}/case-stats")
async def case_stats(project_id: str):
    """用例/执行计数。

    项目列表以前读 project.json 里的 case_count / execution_count，但这两个
    字段只在创建项目时写成 0，之后没有任何代码回写，所以首页永远显示
    「0 用例 / 0 次执行」。计数改成按需从项目库现算，不引入第二个真相源。
    """
    require_project(project_id)
    db_path = get_project_db(project_id)
    if not db_path.exists():
        return {"case_count": 0, "execution_count": 0}
    conn = sqlite3.connect(db_path)
    try:
        case_count = conn.execute("SELECT COUNT(*) FROM test_cases").fetchone()[0]
    except sqlite3.OperationalError:
        case_count = 0
    try:
        execution_count = conn.execute("SELECT COUNT(*) FROM executions").fetchone()[0]
    except sqlite3.OperationalError:
        execution_count = 0
    conn.close()
    return {"case_count": case_count, "execution_count": execution_count}


@app.post("/api/projects/{project_id}/cases")
async def create_case(project_id: str, case: dict):
    """创建新用例"""
    db_path = get_project_db(project_id)
    if not db_path.exists():
        init_project_db(project_id)

    case_id = f"case_{uuid.uuid4().hex[:8]}"
    tags_json = json.dumps(case.get("tags", []), ensure_ascii=False)

    conn = sqlite3.connect(db_path)
    conn.execute("""
        INSERT INTO test_cases (id, module_id, title, precondition, steps, expected, case_type, priority, status, tags, favorite, review_status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        case_id,
        case.get("module", ""),
        case.get("name", ""),
        case.get("precondition", ""),
        case.get("steps", ""),
        case.get("expected", ""),
        case.get("type", "正向"),
        case.get("priority", "中"),
        case.get("status", "未执行"),
        tags_json,
        case.get("favorite", False),
        case.get("reviewStatus", "待评审"),
    ))
    conn.commit()
    conn.close()

    return {"id": case_id, **case, "message": "创建成功"}


@app.get("/api/projects/{project_id}/cases/{case_id}")
async def get_case(project_id: str, case_id: str):
    """获取单个用例详情"""
    db_path = get_project_db(project_id)
    if not db_path.exists():
        raise HTTPException(status_code=404, detail="项目数据库不存在")

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    row = conn.execute("SELECT * FROM test_cases WHERE id = ?", (case_id,)).fetchone()
    conn.close()

    if not row:
        raise HTTPException(status_code=404, detail="用例不存在")

    c = dict(row)
    c["tags"] = json.loads(c.get("tags", "[]"))
    c["name"] = c.get("title", "")
    c["module"] = c.get("module_id", "")
    c["type"] = c.get("case_type", "正向")

    return c


@app.put("/api/projects/{project_id}/cases/{case_id}")
async def update_case(project_id: str, case_id: str, case: dict):
    """更新用例"""
    db_path = get_project_db(project_id)
    if not db_path.exists():
        raise HTTPException(status_code=404, detail="项目数据库不存在")

    tags_json = json.dumps(case.get("tags", []), ensure_ascii=False)

    conn = sqlite3.connect(db_path)
    conn.execute("""
        UPDATE test_cases
        SET title = ?, module_id = ?, case_type = ?, priority = ?, status = ?, tags = ?, favorite = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    """, (
        case.get("name", ""),
        case.get("module", ""),
        case.get("type", "正向"),
        case.get("priority", "中"),
        case.get("status", "未执行"),
        tags_json,
        case.get("favorite", False),
        case_id,
    ))
    conn.commit()
    conn.close()

    return {"id": case_id, **case, "message": "更新成功"}


@app.delete("/api/projects/{project_id}/cases/{case_id}")
async def delete_case(project_id: str, case_id: str):
    """删除用例"""
    db_path = get_project_db(project_id)
    if not db_path.exists():
        raise HTTPException(status_code=404, detail="项目数据库不存在")

    conn = sqlite3.connect(db_path)
    conn.execute("DELETE FROM test_cases WHERE id = ?", (case_id,))
    # 用例删了，指向它的脚本会变成孤儿：脚本页仍能列出，但 case_id 指向一个
    # 不存在的用例，用例页的「执行」永远找不到它。解除关联而不是删脚本，
    # 脚本文件属于用户资产。
    conn.execute("UPDATE scripts SET case_id = '' WHERE case_id = ?", (case_id,))
    conn.commit()
    conn.close()

    return {"id": case_id, "message": "删除成功"}


# ====== 脚本管理 ======
@app.get("/api/projects/{project_id}/scripts")
async def list_scripts(project_id: str):
    require_project(project_id)
    """获取脚本列表"""
    db_path = get_project_db(project_id)
    if not db_path.exists():
        init_project_db(project_id)

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    rows = conn.execute("SELECT id, case_id, name, language, status, filepath, created_at, updated_at FROM scripts ORDER BY updated_at DESC").fetchall()
    # 用例被删掉之后脚本还留在库里（脚本是可执行产物，可能已经被人补过断言，
    # 不能连带删除）。这里把"关联用例已不存在"标出来，否则界面上看不出来，
    # 执行结果也没法对回任何一条需求。
    case_ids = {row[0] for row in conn.execute("SELECT id FROM test_cases").fetchall()}
    conn.close()

    scripts = [dict(row) for row in rows]
    for s in scripts:
        script_case = str(s.get("case_id") or "")
        s["case_missing"] = bool(script_case) and script_case not in case_ids
    # 浏览器端 monaco-vscode-api 不允许访问真实磁盘 file:// 路径，
    # 使用统一虚拟根 file:///workspace/scripts，文件内容由编辑器 didOpen 提供给 LSP
    virtual_workspace_uri = "file:///workspace/scripts"
    for s in scripts:
        s["file_uri"] = f"{virtual_workspace_uri}/{s['name']}"
        s["workspace_uri"] = virtual_workspace_uri

    return {
        "scripts": scripts,
        "total": len(scripts),
        "orphan_total": sum(1 for s in scripts if s["case_missing"]),
        "workspace_uri": virtual_workspace_uri,
    }


@app.post("/api/projects/{project_id}/scripts")
async def create_script(project_id: str, script: dict):
    """创建新脚本"""
    db_path = get_project_db(project_id)
    if not db_path.exists():
        init_project_db(project_id)

    script_id = f"script_{uuid.uuid4().hex[:8]}"
    script_name = script.get("name", "untitled.py")
    scripts_dir = (WORKSPACE / project_id / "scripts").resolve()
    scripts_dir.mkdir(parents=True, exist_ok=True)
    script_filepath = scripts_dir / script_name

    # 写入脚本文件
    with open(script_filepath, "w", encoding="utf-8") as f:
        f.write(script.get("content", ""))

    conn = sqlite3.connect(db_path)
    conn.execute("""
        INSERT INTO scripts (id, case_id, name, language, status, filepath)
        VALUES (?, ?, ?, ?, ?, ?)
    """, (
        script_id,
        script.get("case_id", ""),
        script_name,
        script.get("language", "python"),
        script.get("status", "就绪"),
        str(script_filepath),
    ))
    conn.commit()
    conn.close()

    return {"id": script_id, **script, "message": "创建成功"}


@app.get("/api/projects/{project_id}/scripts/{script_id}/content")
async def get_script_content(project_id: str, script_id: str):
    """获取脚本内容"""
    db_path = get_project_db(project_id)
    if not db_path.exists():
        raise HTTPException(status_code=404, detail="项目数据库不存在")

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    row = conn.execute("SELECT filepath FROM scripts WHERE id = ?", (script_id,)).fetchone()
    conn.close()

    if not row:
        raise HTTPException(status_code=404, detail="脚本不存在")

    filepath = Path(row["filepath"]).resolve()
    if not filepath.exists():
        raise HTTPException(status_code=404, detail="脚本文件不存在")

    with open(filepath, "r", encoding="utf-8") as f:
        content = f.read()

    return {"content": content}


@app.put("/api/projects/{project_id}/scripts/{script_id}/content")
async def save_script_content(project_id: str, script_id: str, body: dict = Body(...)):
    """保存脚本内容到文件"""
    db_path = get_project_db(project_id)
    if not db_path.exists():
        raise HTTPException(status_code=404, detail="项目数据库不存在")

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    row = conn.execute("SELECT filepath FROM scripts WHERE id = ?", (script_id,)).fetchone()
    conn.close()

    if not row:
        raise HTTPException(status_code=404, detail="脚本不存在")

    filepath = Path(row["filepath"]).resolve()
    filepath.parent.mkdir(parents=True, exist_ok=True)

    content = body.get("content", "")
    with open(filepath, "w", encoding="utf-8") as f:
        f.write(content)

    return {"ok": True, "path": str(filepath)}


@app.post("/api/projects/{project_id}/scripts/{script_id}/check")
async def check_script(project_id: str, script_id: str):
    """运行 basedpyright 检查脚本"""
    db_path = get_project_db(project_id)
    if not db_path.exists():
        raise HTTPException(status_code=404, detail="项目数据库不存在")

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    row = conn.execute("SELECT filepath FROM scripts WHERE id = ?", (script_id,)).fetchone()
    conn.close()

    if not row:
        raise HTTPException(status_code=404, detail="脚本不存在")

    filepath = Path(row["filepath"])
    if not filepath.exists():
        raise HTTPException(status_code=404, detail="脚本文件不存在")

    # 运行 basedpyright：找不到可执行文件时明确报"不可用"，而不是把
    # WinError 2 混进 error 字段当成"检查结果"
    import subprocess
    import json
    import shutil

    exe = None
    for candidate in (
        Path.cwd() / ".venv" / "Scripts" / "basedpyright.exe",
        Path.cwd() / ".venv" / "bin" / "basedpyright",
    ):
        if candidate.is_file():
            exe = candidate
            break
    if exe is None:
        found = shutil.which("basedpyright")
        exe = Path(found) if found else None
    if exe is None:
        return {
            "errors": [],
            "errorCount": 0,
            "unavailable": "basedpyright 未安装（先 pnpm/pip 安装后可用）",
        }

    try:
        result = subprocess.run(
            [str(exe), str(filepath), "--outputjson"],
            capture_output=True,
            text=True,
            cwd=str(Path.cwd()),
        )
        output = json.loads(result.stdout)

        errors = []
        for diag in output.get("generalDiagnostics", []):
            errors.append({
                "line": diag["range"]["start"]["line"] + 1,
                "column": diag["range"]["start"]["character"] + 1,
                "message": diag["message"],
                "severity": diag["severity"],
            })

        return {"errors": errors, "errorCount": len(errors)}
    except Exception as e:
        return {"errors": [], "errorCount": 0, "unavailable": str(e)}


@app.post("/api/projects/{project_id}/scripts/{script_id}/run")
async def run_script(project_id: str, script_id: str, background: bool = False):
    """运行脚本：按 scripts.language 分派到执行器，返回输出 + RunEvent 事件流

    ``background=true`` 立即返回（Agent 用），执行行随后轮询 /executions 获取。
    """
    db_path = get_project_db(project_id)
    if not db_path.exists():
        raise HTTPException(status_code=404, detail="项目数据库不存在")

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    row = conn.execute("SELECT * FROM scripts WHERE id = ?", (script_id,)).fetchone()
    conn.close()

    if not row:
        raise HTTPException(status_code=404, detail="脚本不存在")

    filepath = Path(row["filepath"]).resolve()
    if not filepath.exists():
        raise HTTPException(status_code=404, detail="脚本文件不存在")

    if background:
        threading.Thread(
            target=execute_script,
            args=(db_path, project_id, row),
            kwargs={"project_dir": safe_project_dir(project_id), "timeout_s": 300.0},
            daemon=True,
            name=f"run-{script_id}",
        ).start()
        return {"status": "started", "script_id": script_id, "project_id": project_id}

    # 交互运行的超时按「一个人愿意等」来定，而不是按脚本该多快。实测同一份
    # 50 行骨架在这台机器上 pytest 启动耗时可从 2 秒跳到 60 秒（磁盘/杀软抖动），
    # 30 秒的上限会把正常脚本报成「脚本执行超时」。后台执行仍是 300 秒。
    return await asyncio.to_thread(
        execute_script,
        db_path,
        project_id,
        row,
        project_dir=safe_project_dir(project_id),
        timeout_s=180.0,
    )


@app.get("/api/projects/{project_id}/executions/{execution_id}")
async def get_execution(project_id: str, execution_id: int):
    """一次执行的明细 + RunEvent 流（执行详情页用）"""
    db_path = get_project_db(project_id)
    if not db_path.exists():
        raise HTTPException(status_code=404, detail="项目数据库不存在")
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    row = conn.execute("SELECT * FROM executions WHERE id = ?", (execution_id,)).fetchone()
    conn.close()
    if not row:
        raise HTTPException(status_code=404, detail="执行记录不存在")
    return {"execution": dict(row), "events": read_events(db_path, execution_id)}


@app.get("/api/projects/{project_id}/executions/{execution_id}/events")
async def list_execution_events(project_id: str, execution_id: int):
    """按 seq 顺序回放一次执行的 RunEvent 流（面板轮询/SSE 共用）"""
    db_path = get_project_db(project_id)
    if not db_path.exists():
        raise HTTPException(status_code=404, detail="项目数据库不存在")
    return {"execution_id": execution_id, "events": read_events(db_path, execution_id)}


@app.post("/api/projects/{project_id}/executions/{execution_id}/cancel")
async def cancel_execution_route(project_id: str, execution_id: int):
    """请求停止一次正在跑的用例；执行器在 0.1s 轮询粒度内退出并落 run.end: cancelled"""
    require_project(project_id)
    if not cancel_execution(project_id, execution_id):
        raise HTTPException(status_code=409, detail="该执行已结束或未在运行")
    return {"execution_id": execution_id, "status": "cancelling"}


# ====== 测试计划 ======
@app.get("/api/projects/{project_id}/plans")
async def list_plans(project_id: str):
    require_project(project_id)
    """获取测试计划列表"""
    db_path = get_project_db(project_id)
    if not db_path.exists():
        init_project_db(project_id)

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    rows = conn.execute("SELECT * FROM test_plans ORDER BY created_at DESC").fetchall()
    conn.close()

    plans = [dict(row) for row in rows]
    return {"plans": plans}


@app.post("/api/projects/{project_id}/plans")
async def create_plan(project_id: str, plan: dict):
    """创建测试计划"""
    db_path = get_project_db(project_id)
    if not db_path.exists():
        init_project_db(project_id)

    plan_id = f"plan_{uuid.uuid4().hex[:8]}"
    conn = sqlite3.connect(db_path)
    conn.execute("""
        INSERT INTO test_plans (id, name, description, cron, case_count, status)
        VALUES (?, ?, ?, ?, ?, ?)
    """, (
        plan_id,
        plan.get("name", ""),
        plan.get("description", ""),
        plan.get("cron", ""),
        plan.get("case_count", 0),
        plan.get("status", "enabled"),
    ))
    conn.commit()
    conn.close()

    return {"id": plan_id, **plan, "message": "创建成功"}


# ====== 执行记录 ======
@app.get("/api/projects/{project_id}/executions")
async def list_executions(project_id: str):
    require_project(project_id)
    """获取执行记录列表"""
    db_path = get_project_db(project_id)
    if not db_path.exists():
        init_project_db(project_id)

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    rows = conn.execute("SELECT * FROM executions ORDER BY started_at DESC").fetchall()
    conn.close()

    executions = [dict(row) for row in rows]
    return {"executions": executions}


@app.get("/api/projects/{project_id}/cases/{case_id}/executions")
async def list_case_executions(project_id: str, case_id: str, limit: int = 20):
    """一条用例的历次执行结果（用例详情抽屉用）。

    `execution_cases` 只记「脚本带 case_id 的执行」，所以这里为空不代表用例没跑过
    —— 早期骨架脚本的 case_id 是脚本自己的 id，那些执行不会出现在这张表里。
    """
    require_project(project_id)
    db_path = get_project_db(project_id)
    if not db_path.exists():
        init_project_db(project_id)

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT ec.execution_id, ec.result, ec.duration_ms, ec.error_message, "
        "       e.name, e.status, e.started_at, e.finished_at "
        "FROM execution_cases ec JOIN executions e ON e.id = ec.execution_id "
        "WHERE ec.case_id = ? ORDER BY e.started_at DESC, ec.execution_id DESC LIMIT ?",
        (case_id, max(1, min(limit, 100))),
    ).fetchall()
    passed = conn.execute(
        "SELECT COUNT(*) FROM execution_cases WHERE case_id = ? AND result = '通过'",
        (case_id,),
    ).fetchone()[0]
    total = conn.execute(
        "SELECT COUNT(*) FROM execution_cases WHERE case_id = ?", (case_id,)
    ).fetchone()[0]
    conn.close()

    return {
        "case_id": case_id,
        "total": total,
        "passed": passed,
        "history": [dict(row) for row in rows],
    }


# ====== 测试报告 ======
@app.get("/api/projects/{project_id}/reports")
async def list_reports(project_id: str):
    require_project(project_id)
    """获取测试报告列表"""
    db_path = get_project_db(project_id)
    if not db_path.exists():
        init_project_db(project_id)

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    rows = conn.execute("SELECT * FROM reports ORDER BY created_at DESC").fetchall()
    conn.close()

    reports = []
    for row in rows:
        item = dict(row)
        # 流水线报告（id = pipe_…）与历史执行报告同表；前端据 kind 决定能否查看正文
        item["kind"] = "pipeline" if str(item["id"]).startswith("pipe_") else "execution"
        reports.append(item)
    return {"reports": reports, "total": len(reports)}


# ====== 需求上传与分析 ======
@app.get("/api/projects/{project_id}/requirements")
async def list_requirements(project_id: str):
    """已上传的需求文档（分析交给桌面端 Agent，平台只存文件与记录）"""
    require_project(project_id)
    conn = sqlite3.connect(get_project_db(project_id))
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT id, filename, size, status, created_at FROM requirements ORDER BY created_at DESC"
    ).fetchall()
    conn.close()
    return {"requirements": [dict(row) for row in rows]}


@app.post("/api/projects/{project_id}/requirements/upload")
async def upload_requirement(project_id: str, file: UploadFile = File(...)):
    """上传需求文档"""
    project_dir = WORKSPACE / project_id
    if not project_dir.exists():
        raise HTTPException(status_code=404, detail="项目不存在")

    specs_dir = project_dir / "specs"
    specs_dir.mkdir(exist_ok=True)

    # 保存文件
    file_path = specs_dir / file.filename
    content = await file.read()
    with open(file_path, "wb") as f:
        f.write(content)

    # 记录一条需求（后续分析由桌面端 Agent 读取该文件完成）。
    # 同名重新上传 = 覆盖：文件名就是这份需求的唯一标识，先删旧行再插，
    # 否则列表里会出现两条同名需求，删掉其中一条另一条还留着。
    db_path = get_project_db(project_id)
    if db_path.exists():
        conn = sqlite3.connect(db_path)
        conn.execute("DELETE FROM requirements WHERE filename = ?", (file.filename,))
        conn.execute(
            "INSERT INTO requirements (id, filename, filepath, size, status) VALUES (?, ?, ?, ?, ?)",
            (f"req_{uuid.uuid4().hex[:8]}", file.filename, str(file_path), len(content), "已上传"),
        )
        conn.commit()
        conn.close()

    return {
        "filename": file.filename,
        "size": len(content),
        "path": str(file_path),
        "message": "上传成功",
    }


# 需求分析与用例生成交给桌面端的 Agent（插件 agentTool + Skill），
# 平台只保留需求文档与用例的存储，不再内置模型调用。


@app.post("/api/projects/{project_id}/cases/{case_id}/status")
async def set_case_status(project_id: str, case_id: str, body: dict = Body(...)):
    """只改用例状态（执行结果回写用）。

    不复用 PUT /cases/{id}：那个接口会把 title/module/priority 等整行覆盖，
    回写结果时会把用例内容清空。
    """
    db_path = get_project_db(project_id)
    if not db_path.exists():
        raise HTTPException(status_code=404, detail="项目数据库不存在")
    status = str(body.get("status", "")).strip()
    if not status:
        raise HTTPException(status_code=400, detail="status is required")
    conn = sqlite3.connect(db_path)
    updated = conn.execute(
        "UPDATE test_cases SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        (status, case_id),
    ).rowcount
    conn.commit()
    conn.close()
    if not updated:
        raise HTTPException(status_code=404, detail="用例不存在")
    return {"id": case_id, "status": status}


@app.post("/api/projects/{project_id}/cases/{case_id}/run")
async def run_case(project_id: str, case_id: str, background: bool = False):
    """按用例跑它的脚本。

    用例本身没有可执行内容：执行单位一直是 scripts 行（scripts.case_id 指回
    用例）。面板上的「执行」按钮以前没有后端，只能去脚本页逐个跑；这里把
    「用例 → 脚本」的查找放到后端，并复用 execute_script 的同一套事件流与
    结果回写，所以用例状态、执行记录、报告的口径和脚本页完全一致。

    一个用例挂多个脚本时全部按顺序执行，任一失败即整体失败。
    ``background=true`` 立即返回（面板/Agent 用），随后轮询 /executions。
    """
    db_path = get_project_db(project_id)
    if not db_path.exists():
        raise HTTPException(status_code=404, detail="项目数据库不存在")

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    if not conn.execute("SELECT 1 FROM test_cases WHERE id = ?", (case_id,)).fetchone():
        conn.close()
        raise HTTPException(status_code=404, detail="用例不存在")
    rows = conn.execute(
        "SELECT * FROM scripts WHERE case_id = ? ORDER BY created_at ASC", (case_id,)
    ).fetchall()
    conn.close()

    if not rows:
        raise HTTPException(status_code=409, detail="该用例还没有关联脚本")

    scripts = [dict(row) for row in rows]
    project_dir = safe_project_dir(project_id)

    def run_all() -> dict:
        results = []
        for script in scripts:
            results.append(
                execute_script(
                    db_path,
                    project_id,
                    script,
                    project_dir=project_dir,
                    timeout_s=300.0,
                )
            )
        failed = [r for r in results if str(r.get("status", "")) not in ("pass", "passed")]
        return {
            "case_id": case_id,
            "status": "pass" if not failed else "fail",
            "runs": results,
        }

    if background:
        threading.Thread(
            target=run_all,
            daemon=True,
            name=f"run-case-{case_id}",
        ).start()
        return {"status": "started", "case_id": case_id, "scripts": len(scripts)}

    return await asyncio.to_thread(run_all)


@app.get("/api/projects/{project_id}/requirements/{filename}/content")
async def get_requirement_content(project_id: str, filename: str):
    """读需求文档正文（流水线阶段 1 的输入，Agent 侧不需要文件系统权限）。"""
    project_dir = WORKSPACE / project_id
    if not project_dir.exists():
        raise HTTPException(status_code=404, detail="项目不存在")
    if not filename or "/" in filename or "\\" in filename or filename in (".", ".."):
        raise HTTPException(status_code=400, detail="文件名不合法")
    specs_dir = (project_dir / "specs").resolve()
    file_path = (specs_dir / filename).resolve()
    if specs_dir not in file_path.parents or not file_path.is_file():
        raise HTTPException(status_code=404, detail="需求文件不存在")
    text = file_path.read_text(encoding="utf-8", errors="replace")
    return {"filename": filename, "text": text, "chars": len(text)}


@app.delete("/api/projects/{project_id}/requirements/{filename}")
async def delete_requirement(project_id: str, filename: str):
    """删掉一份已上传的需求（文件 + 记录）。

    `filename` 只接受纯文件名：需求都平铺在 `specs/` 下，带路径分隔符或 `..` 的
    请求一律拒绝，避免删到项目外的文件。
    """
    project_dir = require_project(project_id)
    name = filename.strip()
    if not name or "/" in name or "\\" in name or name in (".", ".."):
        raise HTTPException(status_code=400, detail="文件名不合法")

    specs_dir = (project_dir / "specs").resolve()
    target = (specs_dir / name).resolve()
    if specs_dir != target.parent:
        raise HTTPException(status_code=400, detail="文件名不合法")

    db_path = get_project_db(project_id)
    removed_rows = 0
    if db_path.exists():
        conn = sqlite3.connect(db_path)
        removed_rows = conn.execute("DELETE FROM requirements WHERE filename = ?", (name,)).rowcount
        conn.commit()
        conn.close()

    file_removed = False
    if target.is_file():
        target.unlink()
        file_removed = True

    if not file_removed and not removed_rows:
        raise HTTPException(status_code=404, detail=f"需求不存在: {name}")
    return {
        "filename": name,
        "file_removed": file_removed,
        "records_removed": int(removed_rows),
        "message": f"已删除需求 {name}",
    }


@app.post("/api/projects/{project_id}/scripts/{script_id}/gate")
async def gate_script(project_id: str, script_id: str):
    """静态闸门：python 语法编译、e2e 首行 @target、空内容一律拦下。

    路径用 `gate` 而不是 `check`：`check` 已被 basedpyright 类型检查占用。
    """
    db_path = get_project_db(project_id)
    if not db_path.exists():
        raise HTTPException(status_code=404, detail="项目数据库不存在")
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    row = conn.execute("SELECT name, language, filepath FROM scripts WHERE id = ?", (script_id,)).fetchone()
    conn.close()
    if not row:
        raise HTTPException(status_code=404, detail="脚本不存在")

    filepath = Path(row["filepath"] or "").resolve()
    failures: list[str] = []
    if not filepath.is_file():
        failures.append("脚本文件不存在")
        content = ""
    else:
        content = filepath.read_text(encoding="utf-8", errors="replace")

    if not content.strip():
        failures.append("脚本内容为空")
    elif row["language"] == "e2e":
        first = content.splitlines()[0] if content.splitlines() else ""
        if "// @target" not in first:
            failures.append("e2e 脚本首行缺少 `// @target <url>`")
        # 真实踩过的坑：@e2e-dev/web 不导出 expect，写错会在执行阶段 COLLECTION_ERROR，
        # 白跑一整轮。闸门在这里直接拦掉。
        for line in content.splitlines():
            if "@e2e-dev/web" in line and "expect" in line:
                failures.append("expect 必须从 \"e2e\" 导入，@e2e-dev/web 只导出 test")
                break
    elif row["language"] == "python":
        try:
            compile(content, str(filepath), "exec")
        except SyntaxError as error:
            failures.append(f"Python 语法错误：{error.msg} (line {error.lineno})")

    return {"scriptId": script_id, "name": row["name"], "ok": not failures, "failures": failures}


@app.get("/api/health")
async def health():
    # codeStamp 让插件判断端口上那份后端是不是**这次**的代码：
    # 旧代码的孤儿进程不能冒充新后端，否则改了半天提示词，跑的还是老逻辑。
    return {
        "status": "ok",
        "version": APP_VERSION,
        "codeStamp": os.environ.get("AUTOTEST_CODE_STAMP", ""),
        "pid": os.getpid(),
    }


@app.post("/api/backend/restart")
async def backend_restart():
    """在同一个解释器上再起一份后端，幂等。

    给前端离线横幅的"重启"按钮用：当前进程可能已半死，spawn 一个独立进程
    重新占住端口；端口已有人监听就直接跳过。只监听 127.0.0.1，无鉴权风险面。

    不再走 `scripts/run-backend.bat`：那个脚本指向早期的 `.venv`，而仓库已经
    改成「内置 Python + 服务自己的 `.deps`」，bat 在当前环境里必定起不来。
    """
    port = _current_port()
    if _port_open(port):
        return {"status": "already-running", "port": port}
    try:
        pid = _spawn_backend(port)
        return {"status": "spawning", "pid": pid, "port": port}
    except Exception as e:  # noqa: BLE001 — 任何 spawn 失败都如实上报
        raise HTTPException(status_code=500, detail=f"拉起失败: {e}") from e


def _port_open(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.5):
            return True
    except OSError:
        return False


def _spawn_backend(port: int) -> int:
    """Windows 下无窗口、脱离控制台的独立进程；返回 PID。

    `sys.executable` 就是宿主给的那份内置解释器，`PYTHONHOME` / `PYTHONPATH`
    由宿主环境继承，因此新进程与服务本体用同一套依赖。
    """
    cmd = [
        sys.executable,
        "-m",
        "uvicorn",
        "autotest.api.server:app",
        "--host",
        "127.0.0.1",
        "--port",
        str(port),
    ]
    kwargs: dict[str, Any] = {
        "close_fds": True,
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
    }
    if os.name == "nt":
        # 不弹窗口、不占控制台
        kwargs["creationflags"] = 0x00000008 | 0x00000200  # DETACHED_PROCESS | NEW_PROCESS_GROUP
    else:
        kwargs["start_new_session"] = True
    p = subprocess.Popen(cmd, **kwargs)
    return p.pid


_ENV_CACHE: dict[str, tuple[float, dict]] = {}
_ENV_TTL_S = 15.0


def _probe_env(project_id: str) -> dict:
    """同步探活（会阻塞）：只允许在线程里调用。

    以前这段直接写在 ``async def`` 里，三个 2s 超时的 urlopen 会把事件循环卡住
    6 秒，期间所有其他请求（列表/详情/脚本）全部挂起。
    """
    import shutil
    import time
    import urllib.request

    result = {
        "api": {"ok": True, "label": "后端 API"},
        "database": {"ok": False, "label": "数据库"},
        "python": {"ok": False, "label": "Python"},
        "mcp_can": {"ok": False, "label": "MCP CAN"},
        "mcp_hmi": {"ok": False, "label": "MCP HMI"},
        "mcp_logger": {"ok": False, "label": "MCP Logger"},
        "scripts_dir": {"ok": False, "label": "脚本目录"},
        "basedpyright": {"ok": False, "label": "basedpyright"},
    }

    db_path = get_project_db(project_id)
    if db_path.exists():
        result["database"]["ok"] = True

    scripts_dir = WORKSPACE / project_id / "scripts"
    if scripts_dir.exists():
        result["scripts_dir"]["ok"] = True

    bp = shutil.which("basedpyright-langserver")
    if bp:
        result["basedpyright"]["ok"] = True
    elif (Path.cwd() / ".venv" / "Scripts" / "basedpyright-langserver.exe").exists():
        result["basedpyright"]["ok"] = True

    py = Path.cwd() / ".venv" / "Scripts" / "python.exe"
    if py.exists():
        result["python"]["ok"] = True

    # MCP 工具链（硬件适配，非 AI 能力）：本机没起就是没起，1s 上限足够
    for name, url in [
        ("mcp_can", "http://127.0.0.1:9100/mcp"),
        ("mcp_hmi", "http://127.0.0.1:9101/mcp"),
        ("mcp_logger", "http://127.0.0.1:9102/mcp"),
    ]:
        try:
            urllib.request.urlopen(url, timeout=1)
            result[name]["ok"] = True
        except Exception:
            pass
    return result


@app.get("/api/runtime")
async def runtime_status(projectId: str = ""):
    """状态栏用的运行态摘要：这个项目一共调了多少次模型、花了多少 token。

    流水线走到哪一步现在由 Agent 写进 ``workflow_runs``，那份进度看
    ``/api/projects/{id}/workflow/runs``；这里只保留 token 账本，不维护第二份
    阶段计数（状态栏不能比数据库更"乐观"）。
    """
    payload: dict[str, object] = {"version": APP_VERSION, "projectId": projectId}
    if not projectId:
        return payload
    db_path = get_project_db(projectId)
    if not db_path.exists():
        return payload

    conn = sqlite3.connect(db_path)
    try:
        tokens = conn.execute(
            "SELECT COALESCE(SUM(tokens_in),0), COALESCE(SUM(tokens_out),0), COUNT(*) FROM agent_calls"
        ).fetchone()
    except sqlite3.Error:
        tokens = (0, 0, 0)
    finally:
        conn.close()
    payload["tokens"] = {"in": int(tokens[0]), "out": int(tokens[1]), "calls": int(tokens[2])}
    return payload


@app.get("/api/platform")
async def platform_info():
    """平台自身的运行参数。

    与 ``/api/runtime`` 分开：那个是「某个项目当前跑到哪」的状态栏投影（默认
    不带 projectId 就只回版本），这个是「平台安装成什么样」，与项目无关，
    设置页读的就是它。
    """
    return {
        "version": APP_VERSION,
        "healthy": True,
        "workspace": str(WORKSPACE),
        "python": sys.executable,
        "backend_port": _current_port(),
        "agents": _PLATFORM_STAGES,
        "mcp_servers": [
            {"id": name, "name": label, "url": url, "enabled": False}
            for name, label, url in MCP_HARDWARE_SERVERS
        ],
    }


class SettingsUpdate(BaseModel):
    workspace: str | None = None


@app.put("/api/settings")
async def update_settings(body: SettingsUpdate):
    """平台级配置的写入入口。

    目前只有 workspace（项目数据根目录）。它必须在**下一次启动后端**时生效，
    不能就地改：``WORKSPACE`` 在启动时被各服务持有，运行中改会让正在跑的
    执行与新建的项目指向两个不同的目录。
    """
    global PENDING_WORKSPACE
    if body.workspace is not None:
        target = Path(body.workspace).expanduser()
        if not str(target).strip():
            raise HTTPException(status_code=400, detail="workspace 不能为空")
        PENDING_WORKSPACE = str(target)
    _write_platform_settings()
    return {"workspace": str(WORKSPACE), "pendingWorkspace": PENDING_WORKSPACE}


@app.get("/api/projects/{project_id}/env-status")
async def env_status(project_id: str):
    """检查项目环境状态（线程内探活 + 15s 缓存，避免阻塞事件循环）"""
    import time

    cached = _ENV_CACHE.get(project_id)
    now = time.time()
    if cached and now - cached[0] < _ENV_TTL_S:
        return cached[1]

    result = await asyncio.to_thread(_probe_env, project_id)
    _ENV_CACHE[project_id] = (now, result)
    return result


@app.get("/api/reports")
async def list_reports():
    return {"reports": []}


def _find_langserver() -> Path | None:
    """找 basedpyright-langserver：项目 .venv → 便携解释器目录 → PATH。"""
    here = Path.cwd()
    candidates = [
        here / ".venv" / "Scripts" / "basedpyright-langserver.exe",
        here / ".venv" / "bin" / "basedpyright-langserver",
        Path(sys.executable).parent / "Scripts" / "basedpyright-langserver.exe",
        Path(sys.executable).parent / "basedpyright-langserver",
        Path(sys.executable).parent / "basedpyright-langserver.exe",
    ]
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    found = shutil.which("basedpyright-langserver")
    return Path(found) if found else None


def _lsp_python() -> str:
    """告诉 langserver 用哪个解释器解析导入：有 .venv 用 .venv，否则用自己。"""
    venv_python = Path.cwd() / ".venv" / "Scripts" / "python.exe"
    if venv_python.is_file():
        return str(venv_python.resolve())
    return str(Path(sys.executable).resolve())


# ====== basedpyright LSP WebSocket ======
@app.websocket("/ws/lsp/python/{project_id}")
async def lsp_websocket(websocket: WebSocket, project_id: str):
    """basedpyright LSP WebSocket 端点

    前端 WebSocket 上传输纯 JSON 消息（vscode-ws-jsonrpc 格式），
    basedpyright-langserver stdio 用 Content-Length 帧。
    后端负责两种格式之间的转换。
    """
    await websocket.accept()

    # LSP 进程工作目录设为脚本目录，便于解析导入和类型
    project_dir = Path.cwd() / "workspace" / "projects" / project_id
    scripts_dir = project_dir / "scripts"
    scripts_dir.mkdir(parents=True, exist_ok=True)

    # URI 重写：前端用虚拟 URI，basedpyright 需要真实磁盘路径
    # 前端可能发 file:///workspace/scripts/xxx 或 /workspace/scripts/xxx
    real_prefix = scripts_dir.resolve().as_uri()
    if not real_prefix.endswith("/"):
        real_prefix += "/"

    # 前端可能用的虚拟前缀（按长度从长到短替换）
    virtual_prefixes = [
        "file:///workspace/scripts/",
        "/workspace/scripts/",
    ]

    # langserver 可能装在 .venv（开发机）、便携解释器目录或 PATH 上。都没有时
    # 立刻关掉连接：前端据此退化成「没有补全、但能编辑/保存/运行」的编辑器，
    # 而不是卡在「正在初始化」等一个永远不会来的响应。
    langserver_path = _find_langserver()
    if langserver_path is None:
        print("[LSP] basedpyright-langserver 未安装，前端将退化为无 LSP 模式")
        await websocket.close(code=1011, reason="basedpyright-langserver 未安装")
        return
    langserver = str(langserver_path)
    python_exe = _lsp_python()

    def to_real_uris(text: str) -> str:
        """前端 → basedpyright：虚拟 URI 替换为真实磁盘 URI"""
        for vp in virtual_prefixes:
            text = text.replace(vp, real_prefix)
        return text

    def to_virtual_uris(text: str) -> str:
        """basedpyright → 前端：真实磁盘 URI 替换回虚拟 URI（用 file:///workspace/scripts/）"""
        return text.replace(real_prefix, virtual_prefixes[0])

    try:
        proc = await asyncio.create_subprocess_exec(
            langserver,
            "--stdio",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=str(scripts_dir),
        )
    except OSError as error:
        print(f"[LSP] 启动 langserver 失败：{error}")
        await websocket.close(code=1011, reason="langserver 启动失败")
        return

    async def pump_stdout():
        """读取 basedpyright 输出的 Content-Length 帧，提取 JSON 发给前端"""
        try:
            while True:
                # 读取 header，直到遇到空行
                content_length = 0
                while True:
                    line = await proc.stdout.readline()
                    if not line:
                        return
                    header = line.decode("ascii", errors="replace").strip()
                    if header == "":
                        break
                    if header.lower().startswith("content-length:"):
                        content_length = int(header.split(":", 1)[1].strip())
                if content_length == 0:
                    continue
                body = await proc.stdout.readexactly(content_length)
                # 把真实 URI 替换回虚拟 URI 发给前端
                out_text = to_virtual_uris(body.decode("utf-8"))
                # 调试：打印 LSP 方法名；拦截诊断，只保留语法高亮
                try:
                    _m = json.loads(out_text)
                    _method = _m.get("method", "<response>")
                    print(f"[LSP→FE] {_method}")
                    # 屏蔽 push 诊断（波浪线来源之一）
                    if _method == "textDocument/publishDiagnostics":
                        continue
                    # 屏蔽 pull 诊断刷新请求，前端就不会拉取 diagnostics
                    if _method == "workspace/diagnostic/refresh":
                        continue
                    # 从 initialize 响应中删除 diagnosticProvider，
                    # 客户端就不会发起 pull 诊断（textDocument/diagnostic）
                    if "result" in _m and isinstance(_m["result"], dict) \
                            and "capabilities" in _m["result"]:
                        caps = _m["result"]["capabilities"]
                        removed = False
                        for key in ("diagnosticProvider",):
                            if key in caps:
                                del caps[key]
                                removed = True
                        # 同时禁用 textDocument.diagnostic 能力声明
                        td = caps.get("textDocument", {})
                        if isinstance(td, dict) and "diagnostic" in td:
                            del td["diagnostic"]
                            removed = True
                        if removed:
                            print("[LSP→FE] stripped diagnostic capabilities from initialize response")
                            out_text = json.dumps(_m, ensure_ascii=False)
                except Exception:
                    pass
                await websocket.send_text(out_text)
        except Exception as e:
            print(f"[LSP] stdout pump error: {e}")

    async def pump_stdin():
        """读取前端 JSON，包装成 Content-Length 帧发给 basedpyright"""
        try:
            while True:
                data = await websocket.receive_text()
                # 拦截 textDocument/diagnostic 请求，直接返回空结果（不发波浪线）
                try:
                    _req = json.loads(data)
                    if _req.get("method") == "textDocument/diagnostic":
                        _resp = {
                            "jsonrpc": "2.0",
                            "id": _req.get("id"),
                            "result": {"kind": "full", "items": []},
                        }
                        await websocket.send_text(json.dumps(_resp))
                        continue
                except Exception:
                    pass
                # 把虚拟 URI 替换为真实磁盘 URI
                text = to_real_uris(data)
                # 在 initialize 请求里注入 pythonPath，让 basedpyright 用 .venv 环境
                try:
                    msg = json.loads(text)
                    if msg.get("method") == "initialize":
                        init_opts = msg.get("params", {}).get("initializationOptions", {})
                        if not isinstance(init_opts, dict):
                            init_opts = {}
                        init_opts.setdefault("settings", {})
                        init_opts["settings"].setdefault("python", {})
                        init_opts["settings"]["python"]["pythonPath"] = python_exe
                        init_opts["settings"].setdefault("basedpyright", {})
                        init_opts["settings"]["basedpyright"].setdefault("analysis", {})
                        init_opts["settings"]["basedpyright"]["analysis"]["autoSearchPaths"] = True
                        init_opts["settings"]["basedpyright"]["analysis"]["useLibraryCodeForTypes"] = True
                        init_opts["settings"]["basedpyright"]["analysis"]["typeCheckingMode"] = "off"
                        init_opts["settings"]["basedpyright"]["analysis"]["diagnosticMode"] = "off"
                        init_opts["settings"]["basedpyright"]["analysis"]["diagnosticSeverityOverrides"] = {
                            "reportMissingModuleSource": "none",
                            "reportMissingImports": "none",
                            "reportUndefinedVariable": "none",
                        }
                        msg["params"]["initializationOptions"] = init_opts
                        text = json.dumps(msg, ensure_ascii=False)
                except Exception:
                    pass
                # 调试：打印前端发来的 LSP 方法名
                try:
                    _m2 = json.loads(text)
                    print(f"[FE→LSP] {_m2.get('method', '<request>')}")
                except Exception:
                    pass
                body = text.encode("utf-8")
                frame = f"Content-Length: {len(body)}\r\n\r\n".encode("ascii") + body
                proc.stdin.write(frame)
                await proc.stdin.drain()
        except Exception as e:
            print(f"[LSP] stdin pump error: {e}")

    async def pump_stderr():
        """转发 basedpyright stderr 到后端日志，便于调试"""
        try:
            while True:
                line = await proc.stderr.readline()
                if not line:
                    break
                print(f"[basedpyright] {line.decode('utf-8', errors='replace').rstrip()}")
        except Exception:
            pass

    await asyncio.gather(
        pump_stdout(),
        pump_stdin(),
        pump_stderr(),
        return_exceptions=True,
    )

    try:
        proc.terminate()
    except Exception:
        pass


# Agent 原生工具的后端入口（PRD 解析 / 用例生成 / 评审 / 待确认决策）。
# 必须注册在 /api 的 catch-all 之前，否则新路由会被 404 兜底吞掉。
app.include_router(workflow_router)
# 知识库：文件导入 → 切分 → 落库（项目级，本地）。
app.include_router(knowledge_router)


@app.get("/api/projects/{project_id}/files")
async def read_project_file(project_id: str, path: str):
    """读项目目录内的文件（截图 / 日志 / 产物）。

    RunEvent 的 artifact 带的是执行现场的绝对路径，执行详情要能直接预览截图，
    所以这里按路径回读。安全口径是**必须落在本项目目录内**：绝对路径要满足包含
    关系，相对路径以项目目录为根，越界一律 404，不做任何"规范化后再放行"。
    """
    require_project(project_id)
    project_dir = (WORKSPACE / project_id).resolve()
    raw = Path(path)
    candidate = raw if raw.is_absolute() else (project_dir / raw)
    try:
        target = candidate.resolve(strict=True)
    except OSError:
        raise HTTPException(status_code=404, detail="文件不存在")
    root = project_dir
    try:
        target.relative_to(root)
    except ValueError:
        raise HTTPException(status_code=404, detail="文件不存在")
    if not target.is_file():
        raise HTTPException(status_code=404, detail="文件不存在")
    return FileResponse(target)

# 未匹配的 /api 路径一律 404 JSON（否则会落到静态文件挂载，返回 405/HTML）
@app.api_route(
    "/api/{rest:path}",
    methods=["GET", "POST", "PUT", "DELETE", "PATCH"],
    include_in_schema=False,
)
async def api_not_found(rest: str):
    raise HTTPException(status_code=404, detail="接口不存在")


# 生产模式下 serve 前端静态文件
if DIST.exists():
    class SPAStaticFiles(StaticFiles):
        """静态资源照常返回；未知路径回 index.html（vue-router history 模式深链/刷新）"""

        async def get_response(self, path, scope):  # type: ignore[override]
            try:
                return await super().get_response(path, scope)
            except StarletteHTTPException as error:
                if error.status_code == 404:
                    # API/WebSocket paths keep their own 404; only page routes
                    # fall back to the SPA shell.
                    request_path = str(scope.get("path", ""))
                    if request_path.startswith("/api") or request_path.startswith("/ws"):
                        raise
                    return await super().get_response("index.html", scope)
                raise

    app.mount("/", SPAStaticFiles(directory=DIST, html=True), name="ui")
elif SHELL.exists():
    # Vue dist 还没构建时，独立窗口先加载这份零构建页面：够看状态、审批、
    # 检索，等 ui/dist 出现后上面的分支自动接管，窗口层代码不用改。
    app.mount("/", StaticFiles(directory=SHELL, html=True), name="ui-shell")
