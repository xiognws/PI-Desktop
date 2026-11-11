# 测试工作台：从「插件 + pipeline 引擎」改成「Agent 原生工具」

状态：方案（未开工）。上游文档：`docs/project/autotest-plugin.md`（现有 P0–P4 实现记录）。

## 1. 结论

你的构想有 90% 能落地，但有三个假设必须按本仓库的进程模型改写，否则做出来仍然
是「外挂」：

| 你的假设 | 本仓库的现实 | 改写后的形态 |
|---|---|---|
| 工具是 Python 函数，直接 import 进 Agent | Agent 运行时是 Node sidecar（`packages/agent-runtime`，pi-agent-core）；工具是 TS 的 `AgentTool`（`execute` 是 Node 函数）。Python 无法进入该进程 | 工具 = TS 原生函数；Python 实现留在平台侧，由 TS 函数经 **loopback RPC** 调用。链路里没有 MCP、没有 stdio、没有工具网关，只有「函数 → 本机 HTTP」一跳 |
| 不做插件 | 自定义工具只有两个入口：① 改 `packages/agent-runtime` 注册**内置工具**；② `contributes.agentExtensions`（跑在 Agent sidecar 内、`registerTool` 直接挂到同一个 loop） | **选 ②**。调用方式和 ① 一样是进程内函数调用，零 fork、零上游冲突；代价只是保留一个"壳插件"（manifest + no-op `main`），不注册 plugin tools、不承载 UI。① 只在"必须调任意 `host.call` RPC"或"要成为所有会话的默认能力"时才值得 |
| 前端自由设计、与 Agent 只靠任务状态交互 | Desktop 的 UI 承载只有 plugin panel / work-panel view；不走插件就要在 Electron main 里加一个内置窗口 | 把 Vue SPA 独立成 `apps/autotest-ui`，由 main 开一个 `BrowserWindow` 加载它（dev 期也可直接用浏览器打开） |

一句话：**能力走 agentExtensions（进程内、不改 core），数据留在 Python 服务，界面独立成窗口，
编排交给 Agent + Skill + 后端状态机（不用 `ui.confirm` 绑死界面）。**

## 2. 目标架构

```text
apps/autotest-ui (Vue SPA)              ← 独立 BrowserWindow / 开发期浏览器
   │ 只读状态 · 上传 · 审批（写 pending decision）
   ▼
services/autotest (FastAPI, 127.0.0.1:<port>)     ← 应用服务，不是插件
   ├─ /api/projects /cases /scripts /executions   （现有）
   ├─ /api/workflow/*                             （新增：工具后端）
   ├─ /api/workflow-runs/{id}/pending             （新增：人工卡点状态）
   ├─ /api/knowledge/search                       （新增：前端检索）
   └─ 每项目一个 SQLite + 文件目录
   ▲                                   ▲
   │ 启动/停止/健康检查                 │ 直连 fetch（只读 runtime.json 拿 port+token）
   │                                   │
Electron main                    Agent sidecar (packages/agent-runtime)
   └─ autotest/service.ts            ├─ 壳插件 contributes.agentExtensions
                                     │    └─ 8 个 AgentTool（execute 内直接 fetch）
                                     └─ Skill: autotest-workflow（流程知识）
```

与现有 `docs/project/autotest-plugin.md` §3 的差异只有四处：

1. 工具从 `contributes.agentTools`（15 个，跨进程经权限网关）移到
   `contributes.agentExtensions`（8 个，sidecar 内函数调用）。
2. 编排从 `pipeline/engine.mjs` 的状态机移到 Agent 的会话循环。
3. 平台从「插件 resident service」改为「应用内置服务」，由 main 直接监管。
4. 前端从 plugin panel 改为独立 SPA 窗口。

## 3. 现有资产怎么处置

| 现有 | 处置 | 理由 |
|---|---|---|
| `platform/src/autotest/storage/*`（每项目 SQLite + 迁移） | **保留** | 正好符合「普通关系库，不上 RAG」 |
| `platform/src/autotest/executors/*`（python_native / e2e_node / events / watchdog） | **保留** | 执行器是 Agent 不该碰的脏活；RunEvent v1 契约已经稳定 |
| `platform/src/autotest/api/server.py`（~70 条路由） | **保留主干，新增 `/api/workflow/*`** | 前端 CRUD 与执行查询已经在用 |
| `platform/src/autotest/pipelines/service.py`（阶段顺序/校验/checkpoint/账本） | **保留校验与账本，废弃阶段机** | 规则仍要代码兜底（模型不能自己宣布通过），但「下一步是什么」由 Agent 决定 |
| `plugins/autotest/pipeline/engine.mjs` | **下线** | 它用 `pi.agent.complete` 做单次补全，是「流程驱动模型」；用户要的是「模型驱动流程」 |
| `plugins/autotest/main.js`（15 个 agentTools + 服务监管） | **拆分**：工具删掉，服务监管搬到 `apps/desktop/electron/autotest/` | 去掉插件这层壳 |
| `plugins/autotest/manifest.json` | **删除**（连同 `renderer/`、`build-panel.mjs`） | 不保留第二套 UI 入口，避免双写 |
| `platform/ui`（17 个视图的 Vue） | **裁剪进 `apps/autotest-ui`** | 只留：任务创建、流水线进度、人工审批、知识检索、执行详情、报告 |
| `platform/tests`（50 passed） | **保留，补 workflow 用例** | 迁移时唯一的安全网 |

迁移原则：**新旧不能并存**。`engine.mjs` 与扩展工具同时在跑，会出现「同一条需求被两套编排各写一遍用例」。切换点放在 P4 一次性完成。

## 4. 工具清单（8 个，不是 11 个）

11 个函数会挤占上下文（`runtime.ts` 的 `toolDeclarationPolicy` 对 128 函数上限和
context budget 都有硬约束），而且 `prd_parser`/`testpoint_extract` 这类纯转换可以合并。
工具只返回**摘要 + 句柄**，大对象落库；这是控制上下文的关键，不是可选项。

```ts
// packages/agent-runtime/src/autotest/tools.ts
export function createAutotestTools(rpc: AutotestRpc): AgentTool[]
```

| 工具 | 入参 | 返回（摘要 + 句柄） | 后端 |
|---|---|---|---|
| `autotest_prd_parse` | `requirementRef`, `module` | `{runId, functionPoints[], risks[], deps[], docId}` | `POST /api/workflow/prd-parse` |
| `autotest_case_design` | `runId`, `types[]`, `template` | `{caseCount, byType{}, caseSetId, preview[]≤5}` | `POST /api/workflow/case-design`（内含 testpoint + case） |
| `autotest_case_review` | `caseSetId`, `module` | `{issues[], duplicates[], untestable[], verdict}` | `POST /api/workflow/case-review` |
| `autotest_script_author` | `caseSetId`, `sdk`(`pytest`\|`e2e`) | `{scriptIds[], files[], gate:{ok,errors}}` | `POST /api/workflow/script-author` |
| `autotest_run` | `scriptIds[]`, `envId`, `timeoutS` | `{executionIds[], state:"queued"}` | `POST …/scripts/{id}/run`（复用现有） |
| `autotest_run_status` | `executionIds[]` | `{rows[{id,status,counts,durationMs}], done}` | `GET …/executions/{id}?summary=1` |
| `autotest_log_analyze` | `executionId` 或 `rawLog`+`traceId` | `{rootCause, timeline[], suspectFiles[], reproduce}` | `POST /api/workflow/log-analyze` |
| `autotest_report` | `runId`, `bugIds[]` | `{reportId, path, markdownLen, counts}` | `POST /api/workflow/report` |
| `autotest_knowledge_search` | `project_id`, `query`, `module?`, `tags?`, `limit≤20` | `[{title, record_type, excerpt≤120, source_ref, score}]` | `GET …/workflow/knowledge/search` |

`bug_organizer` 不单独暴露：它是 `log_analyze` 结果到 bug 表的**确定性映射**，放在
`report` 里执行（失败用例 → `bug-xxxxxxxx`）。归并口径：按 `script_name + case_id`
算 `signature`，同一签名跨 run 反复失败落回同一张单（`occurrences` 累计、`last_run_id`
指向最近一次），每次命中另记一行 `bug_occurrences(bug_id, run_id, script_name,
execution_id)`，所以同一 run 重复出报告既不新建也不加计数，第二个 run 也能在自己的
缺陷列表里看到这张单。报告多一节「缺陷清单」（带出现次数），`autotest_report` 的返回带
`bug_ids`。少一次模型往返，也不会让模型自己编缺陷描述。
反向也自动：`report` 里同一签名（脚本 + 用例）这次跑**通过**、而库里还挂着
`open/fixed` 的缺陷单，就直接置 `verified` 并在本 run 记一条 occurrence，
返回体多一个 `verified_bug_ids`；`verified`/`wontfix` 不会再被后续失败自动改回。
`knowledge_save` 也不单独暴露：每次 `workflow_run` 结束由后端按 `runId` 归档，
Agent 只在 `report` 之后显式标注 tags。
`knowledge_search` 是**只读**的额外工具（实际注册 11 个）：Agent 在出用例前查项目
历史（导入文档 + 上一轮归档报告），只回标题/摘要/`source_ref`，全文留在库里。
入库仍然只由前端与后端写，Agent 不能往知识库塞内容。

统一返回结构（所有工具）：

```jsonc
{
  "ok": true,
  "summary": "一句话给模型看的结果",
  "data": { /* ≤ 8KB，超出部分替换为 ref */ },
  "refs": [{ "kind": "run|caseSet|execution|report", "id": "...", "url": "..." }],
  "next": ["建议的下一步工具名，可选"]
}
```

失败时 `ok:false` + `errorCode`（`ENV_MISSING` / `GATE_FAILED` / `NOT_FOUND` /
`TIMEOUT`），不抛异常给 Agent——异常会中断整条会话，模型无法自愈。

## 5. 调用路径：扩展直连 loopback，不经 main

agentExtensions 跑在 sidecar 内、是 trusted code，有 Node 的网络能力，但 **没有
`this.host.call`**（`ExtensionAPI` 只给白名单：`registerTool` / `exec` /
`setActiveTools` / `on(...)` / `ui.*`）。所以链路只有一跳：

```text
工具 execute（扩展模块内）
  → resolveBase()   读 <userData>/autotest/runtime.json  ({ port, token, startedAt, version })
  → fetch(`http://127.0.0.1:${port}/api/workflow/...`, { headers: { authorization } })
```

`runtime.json` 由 `apps/desktop/electron/autotest/service.ts` 在健康检查通过后
**原子写入**（tmp + rename），内容是 `{ port, pid, workspace, startedAt }`；服务停止时删除。扩展读不到文件 → 直接返回
`ENV_MISSING`，不重试到超时。

约束：

- 单次 ≤ 90s；`autotest_run` 只投递，不等执行；`run_status` 单次轮询 ≤ 25s。
- 端口漂移不需要重启会话：每次调用重读 `runtime.json`（进程内缓存 5s）。
- 不经 main 转发，就不新增 `autotest.invoke` RPC，也不动 IPC 面
  （`apps/desktop/electron/ipc/AGENTS.md` 不受影响）。
- token 只走 HTTP header，不进日志。**当前尚未实现**：`runtime.json` 里没有
  token，服务只绑 `127.0.0.1` + 每次启动换随机端口，本机任意进程仍可直接访问
  API。分发前要么补 token（`service.ts` 生成 → `runtime.json` → 工具带 header，
  页面那份由后端注入），要么保持「仅自用」的现状说明。
- 不让 main 转发的理由：`ExtensionAPI` 本来就没有 `host.call`，为了转发还得给
  core 加能力；而扩展自己就能发请求，多一层只是多一次序列化。

## 6. 编排：Skill + 后端状态机，而不是写死规划器或 `ui.confirm`

你的方案说「在 Planner 提示词里写死分支」。在本仓库里更合适的载体是 **Skill**：

- 流程知识（阶段顺序、每种测试类型的关注点、卡点规则、失败后的修复上限）写进
  `skills/autotest-workflow/SKILL.md`，由模型按需加载，不占常驻 system prompt。
- 硬性约束（用例必须有用例 ID 才能生成脚本、脚本未过 gate 不得执行）写在
  **工具本身**（返回 `GATE_FAILED`），不写在提示词里——提示词会被上下文压缩冲掉。
- 人工卡点**不用 `ui.confirm` 当唯一真源**：它把「界面长什么样」绑在会话上。
  卡点落 `workflow_decisions` 一行（`status=waiting_human`），工具用短轮询等答案
  （25s × 3 轮），等不到就返回 `WAITING_HUMAN`，让模型结束本轮、等用户回来。
  前端审批面板 `POST …/pending/{id}/decide` 写同一行；会话内也可以用一次
  `ui.confirm` 加速，但答案必须落同一行，不产生第二份状态。

典型会话：

```text
用户：把这份 PRD 跑一遍，用例设计完让我确认
Agent: autotest_prd_parse → autotest_case_design
       → autotest_case_review（落 waiting_human，前端审批面板接管；工具返回
         WAITING_HUMAN，模型结束本轮）                        ← 人工卡点
用户：确认，但把 P2 优先级去掉
Agent: 后端按反馈修订 caseSet → autotest_case_review
       → autotest_script_author → autotest_run
       → （轮询）autotest_run_status
       → 有失败：autotest_log_analyze（每失败 1 次，最多 3 条）
       → autotest_report
```

失败修复上限（3 轮）写在 Skill 里，同时 `script_author` 记录 attempt，超限后工具
拒绝再生成，逼模型进报告。**不存在「模型自己宣布通过」的路径**：`report` 的
counts 只从 `execution_cases` 聚合，模型只写结论段落。

## 7. 存储

沿用现有「每项目一个 SQLite」（`storage/sqlite.py` + `migrations.py`），只加四张表：

```sql
-- 一次 Agent 驱动的运行（替代 pipelines 表的编排语义）
CREATE TABLE workflow_runs (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, module TEXT,
  requirement_ref TEXT, stage TEXT NOT NULL,   -- parsed|designed|reviewed|authored|executed|reported
  status TEXT NOT NULL,                         -- running|waiting_human|done|failed|cancelled
  session_id TEXT,                              -- 哪个 Agent 会话发起
  created_at TEXT, updated_at TEXT
);
CREATE TABLE workflow_steps (   -- 每次工具调用一行，前端时间线直接读
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL, seq INTEGER, tool TEXT, stage TEXT,
  status TEXT, summary TEXT, payload_json TEXT, error_code TEXT,
  started_at TEXT, ended_at TEXT
);
CREATE TABLE knowledge_records ( -- 你要的「标签 + 文本模糊检索」
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT, module TEXT, record_type TEXT,  -- case|script|bug|report|log-analysis
  title TEXT, content TEXT, tags TEXT,             -- tags 用逗号分隔，不做向量
  source_ref TEXT, created_at TEXT
);
CREATE TABLE agent_context_refs ( -- 人工「粘贴进上下文」的痕迹，可审计
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT, run_id TEXT, knowledge_id INTEGER, inserted_at TEXT
);
```

实际落地与上面草稿的差异（以代码为准）：

- `workflow_decisions` 取代了 `agent_context_refs` 的位置——人工卡点必须是可查询的
  行，前端审批与 Agent 续跑都读它；「粘贴进上下文」的审计表暂未建。
- 另外有 `bugs` + `bug_occurrences`（`autotest_report` 按失败用例确定性写入，
  按 `script_name + case_id` 的 `signature` 跨 run 归并，重复出现累计 `occurrences`、
  最近一次记 `last_run_id`，每次命中落一行 occurrence）、`knowledge_docs`（导入文件
  元数据 + `sha256` 去重）与 `knowledge_fts`（FTS5 外部内容表 + 三个触发器），
  以及沿用既有的 `scripts`/`executions`/`reports`。

检索只做 `WHERE module=? AND (title LIKE ? OR content LIKE ? OR tags LIKE ?)` +
`ORDER BY created_at DESC`，与你的要求一致，不做 RAG。

### 7.1 知识库的建立方式（文件 → 切分 → 项目库）

知识库不是"手写几条记录"，而是**吃文件**。落地结构：

```
<project>/knowledge/<doc_id>/<原文件名>    ← 原文留档，删文档时一起删
data.db: knowledge_docs                    ← 一份文档一行（文件名/格式/条数/模块/标签）
data.db: knowledge_records                 ← 切分后的条目，record_type='doc-chunk'
                                            source_ref = doc:<doc_id>#<序号>
data.db: knowledge_fts (FTS5, trigram)     ← BM25 索引，触发器跟随 knowledge_records
```

- **支持格式**：md / markdown / txt / log / csv / tsv / json / jsonl / yaml / yml / xml /
  ini / cfg / conf / properties / 常见源码后缀（内置文本读取，UTF-8 → GB18030 回退）；
  html / htm（BeautifulSoup 抽正文）；pdf（pdfplumber 按页抽）；docx（python-docx
  抽段落与表格，`Heading*` 保留为 `#`）。`.doc` 等旧二进制格式不支持，明确报错。
- **切分策略**：先按 Markdown 标题切语义单元，单块超 `chunk_chars`（默认 1200）时
  按空行拆段、贪心装箱，相邻块重叠约 120 字符。无标题文本（日志/CSV/JSON）直接
  走长度切分。条目上限 5000，超过即拒绝并要求先拆文档。
- **入口**：`POST /api/projects/{id}/knowledge/documents`（multipart，单文件）、
  `POST .../knowledge/documents/batch`（multipart 多文件，可混合格式，一次最多 50 个，
  逐个抽文本/切分/查重，单文件失败只记进 `failed` 不影响其它）、
  `POST .../knowledge/documents/text`（直接粘一段文字）、
  `POST .../knowledge/documents/from-specs`（把项目 `specs/` 下已上传的需求文档一次性入库，
  不复制文件，`stored_path` 直接指向原路径）、
  `GET .../knowledge/documents`、
  `GET .../knowledge/documents/{doc_id}/chunks`（切分预览：标题、`source_ref`、
  每条字符数与正文摘要，`limit/offset` 分页）、
  `DELETE .../knowledge/documents/{doc_id}`。
- **报告归档**：`POST .../workflow/runs/{id}/report` 出完 Markdown 后，把这份报告
  写进 `knowledge_records`（`record_type='run-report'`、`source_ref='run:<run_id>'`、
  tags `report/workflow-run`），流水线的"入库"这一步由后端确定性完成，不靠模型自觉。
  重复出报告按 `source_ref` 去重，不会产生第二条归档。
- **前端读报告与缺陷**：`GET .../workflow/runs/{id}/report-content` 读最后一次 report
  步骤记下的路径并返回 Markdown（限制在项目 `reports/` 内，越界 404，没出报告 409）；
  `GET .../workflow/runs/{id}/bugs` 返回该 run 的缺陷单明细；
  `PATCH .../workflow/runs/{id}/bugs/{bug_id}`（body `{"status": ...}`）做人工状态
  流转，只接受 `open / fixed / verified / wontfix`，且只允许改本 run 里出现过的缺陷
  （否则 404）。注意同一个 run 里
  `autotest_report` 会写两条步骤（正文 + 归档），取路径时必须按 `payload.path`
  找，不能取最后一条（`store.find_payload`）。
- **「缺陷」页（项目级视图）**：`GET .../workflow/bugs?status=&limit=` 跨 run 列出
  本项目所有缺陷单（按 `last_seen_at` 倒序，`status` 非法 400、`limit` 夹在 1..500），
  `PATCH .../workflow/bugs/{bug_id}` 不要求指定 run 就能流转状态（只接受同一组状态
  值，缺陷单不属于本项目则 404）。归并后的单子是跨 run 的同一张，所以页面不必再让人
  先选中 run 才能处理缺陷。
- **去重**：`knowledge_docs.sha256` 记原始字节摘要，同一项目重复导入直接返回
  `skipped: true` 并指回已有 `doc_id`，不再建第二条（文本导入用内容摘要）。
  该列是后加的，`ensure_knowledge_tables` 会补列，并对历史行按 `stored_path`
  上的原文件回填摘要（每轮最多 200 条），所以老库升级后也能命中。
- **检索**：`GET .../workflow/knowledge/search` 走 `knowledge_store.search_records`——
  查询里所有 ≥3 字符的词拼成 FTS5 短语走 BM25；出现 2 字中文词或 FTS5 不可用时
  退化为 LIKE。实测（老 UDS/HMI 知识 5 篇）：`DTC` / `0x22` 命中带 `score`，
  `诊断` / `响应` 走 LIKE。
- **喂上下文**：检索结果在页面上渲染成卡片（命中带 `score` 的描边高亮），
  每条带「复制」，拷贝的是 `标题 + source_ref + 400 字符摘要`，由人粘贴进会话。
  页面没有直接写会话的通道——这条留在 P5 接 Desktop 会话接口。

**平台库位置由宿主显式指定**：`storage/sqlite.py` 的 `resolve_default_db()` 读
`AUTOTEST_PLATFORM_DB`，缺失时才退回 cwd 下的 `data/autotest.db`。
`service.ts` 的 `buildServiceEnv()` 固定传 `<dataDir>/autotest/platform.db`——
服务子进程的 cwd 是服务目录，在安装包里就是 `resources/autotest`，
不给这个变量会把库写进安装目录。项目库不受影响，仍在
`<dataDir>/autotest/workspace/<project>/data.db`。

**检索由前端触发**：`GET /api/knowledge/search?module=&q=&tags=&limit=`
前端把命中项渲染成卡片，用户点「加入上下文」→ 前端调用 Desktop 的会话接口，
把一段纯文本（`content` 截断 2KB + `source_ref`）作为**用户消息附件**送入当前会话。
Agent 侧不做自动注入——这一点和你原方案完全一致，不需要改 core。

## 8. 前端

`apps/autotest-ui`（Vue 3 + Vite），5 个页面，不复制现有 17 视图：

| 页面 | 数据来源 | 能做什么 |
|---|---|---|
| 任务 | `POST /api/workflow-runs` | 选项目/模块、上传 PRD、选测试类型、启动 |
| 进度 | `GET /api/workflow-runs/{id}` + SSE | 阶段时间线、每次工具调用的摘要、实时日志 |
| 审批 | `GET /api/workflow-runs/{id}/pending` | 用例表格（可改优先级/删行）、批准/驳回 |
| 执行 | 现有 executions/events 路由 | 步骤、截图、产物、取消 |
| 知识库 | `GET /api/knowledge/search` | 关键词+标签+模块，复制/加入上下文 |

承载方式：**独立窗口**，但 P4 才接；P2 先用浏览器。

| | plugin panel | 独立 `BrowserWindow` |
|---|---|---|
| core 改动 | 0 | `autotest/window.ts` + `main/index.ts` 一处注册（热点文件只加一行） |
| 外框 | 固定 46px 拖拽带 + 右上三键胶囊，改不掉（`01-plugin-system.md` §6.3，v3 也只能铺底） | 自己的 titlebar、可全屏 |
| 网络 | `sandbox: true` 但仍受 `net.domains` 的 `webRequest` 过滤 | 无过滤，但只允许 `127.0.0.1` |
| Node | 无，仅 `pi.*` preload | 自定 preload（仍保持 `contextIsolation: true`、`nodeIntegration: false`） |
| 加载 | `file://` 插件目录页面 | `loadURL(127.0.0.1:<port>/)`，同源、无 CORS、改完刷新即生效 |
| 打包 | Vue dist 进插件包（受 ≤50 MiB / ≤2000 files 约束） | 由后端托管，Desktop 包不背 UI 产物 |

选独立窗口的理由不是「自由设计」这种偏好，而是：工作台要常驻、要大屏、要并排三块
（用例表 / 执行日志 / 截图），panel 的固定胶囊与单窗口形态不合适；而 P0 已经在 main
加了 `service.ts`，再加 `window.ts` 是同一处的边际改动。

审批的唯一真源是 `workflow_decisions`：窗口点「批准」→
`POST …/pending/{id}/decide` → 写库；工具端下次轮询读到 `approved` 继续。
不需要 `session.answer`，因为这个设计里根本没有会话卡在 `asktool` 上。

入口与失败路径（已落地）：菜单「视图 → 测试工作台」是唯一 UI 入口，主进程直接调
`openAutotestWorkbench()`（不经 renderer 命令通道），服务 `ready` 才开窗，已开则
`focus()` 复用。服务没就绪（`starting` / `failed` / `stopped`）时不再只写一条 warn
日志，而是弹一个带当前状态与失败原因的提示框，按钮是「关闭 / 重试启动」；点重试
走 `AutotestService.restart()`（先 `stop()` 收掉半启动子进程，再完整 `start()`），
成功就直接开窗，仍失败就带着新的 `error` 再提示一次。提示框同层互斥，重复点菜单
不会叠对话框。

## 9. 落地顺序

每阶段独立可验收，失败可回退到「插件版」（旧代码在 P4 前一直保留）。

### P0 服务迁出 + 独立启动（1–1.5 天）
- `git mv plugins/autotest/platform services/autotest`（保留历史），同步改
  `PYTHONPATH=services/autotest/src`、pytest 的 `rootdir`、dev 脚本。
- `apps/desktop/electron/autotest/service.ts`：启动/停止/端口探测/健康检查/写
  `runtime.json`，用 `pythonPath` 设置。
- 迁移放在 P0 而不是 P4：P0 本来要重写启动路径，此时只需改一处；拖到 P4 就是
  第二次改同一处，还得多改一遍 pytest 配置。
- 验收：`curl 127.0.0.1:<port>/api/health` 返回 ok；`services/autotest` 下
  `pytest -q` 全绿（原有 50 条）；关窗后进程退出；
  `pnpm --filter @pi-workspace/desktop typecheck` 通过。
- 回退：旧插件仍在，`git mv` 可逆。

### P1 workflow 后端（2–3 天）
- `services/autotest/src/autotest/workflow/` 下写纯函数：
  `prd_parse(doc_text) -> dict`、`case_design(prd_result, types) -> dict`、
  `log_analyze(raw_log, trace_id) -> dict`。全部无 IO、可 pytest。
- `api/workflow_routes.py` 暴露 `/api/workflow/{prd-parse,case-design,log-analyze}`，
  写 `workflow_runs`/`workflow_steps`。
- 验收：`pytest services/autotest/tests -q` 全绿，新增 ≥ 12 条（含空 PRD、
  超长 PRD 截断、无 traceId、日志 20MB 截断）。

### P2 壳插件 + agentExtensions（2–3 天，不需要 ADR）
- 新建 `plugins/autotest-shell/`：manifest 只声明
  `contributes.agentExtensions: ["src/tools.ts"]`、权限 `["agent.extension"]`，
  一个 no-op `main.cjs`；**不含** panel / views / services / agentTools。
- `src/tools.ts`：8 个工具（typebox schema），`execute` 读 `runtime.json` 直连 loopback。
- `skills/autotest-workflow/SKILL.md`：流程、卡点、修复上限（中文即可）。
- 验收：`pnpm pi-plugin check plugins/autotest-shell` 通过；新会话发一份 PRD →
  观察到 `prd_parse → case_design → waiting_human`，三份产出都能在 DB 里对上；
  `pnpm --filter @pi-workspace/desktop typecheck` + `pnpm -r --if-present test` 通过。

注意：v1.1 里带 `agent.extension` 的插件不走 marketplace，只接受本地导入。
本机自用没问题，若将来要分发，要么内置工具、要么等 spec 08 的签名。

### P3 执行闭环（3–4 天）
- 加 `script_author` / `run` / `run_status` / `report`。
- 复用执行器，不新建进程模型；`autotest_run` 只投递，轮询交给 `run_status`。
- 验收：故意让 1 条断言失败 → `log_analyze` 给出根因与可疑文件 → `report` 的
  counts 与 `execution_cases` 一致 → 报告中包含该失败证据与截图路径。

### P4 前端切换 + 下线旧路径（3 天）
- UI 定版：**`services/autotest/ui`（Vue 3 + Vite）就是工作台**，没有
  `apps/autotest-ui` 这一份。窗口加载后端托管的 `ui/dist`；`dist` 不存在时
  （源码仓库未构建）退回零构建的 `services/autotest/ui-shell/index.html`，
  两者同源、窗口层代码不用改。
- 已删除 `plugins/autotest/`（含随包副本 `apps/desktop/resources/plugins/autotest`）
  与 `pipelines/service.py` 的阶段机；`validate_*` 与账本拆到
  `pipelines/validation.py`、`pipelines/ledger.py` 保留。`plugins/autotest-shell`
  保留（它是工具的唯一载体）。
- 验收：`rg -n "agentTools|pipeline/engine" plugins/autotest` 无结果（目录已不存在）；
  `pnpm pi-plugin check plugins/autotest-shell` 通过（5 文件 36.5 KB，只有
  `agent.extension` 高危权限的预期告警）；旧 UI 打不开；`pytest tests -q` 108 passed。
- 打包：`apps/desktop/package.json` 的 `extraResources` 已补 `autotest/src`、
  `autotest/ui-shell`、`autotest/ui/dist`、`autotest/runner`、`autotest/.deps`
  五条，`apps/desktop/electron/test/autotest-packaging.test.mjs` 守住配置与源码目录，
  并断言「凡是带 `bundle:python` 的发布链也必须带 `bundle:autotest-ui`」——
  漏了这条，安装版的服务在跑、界面却退回 ui-shell，官方包看不出区别只在窗口里。
  打包机必须先跑一次 `pip install --target services/autotest/.deps -r requirements.lock`，
  否则 `.deps` 目录不存在、包内后端起不来；Vue 产物由 `pnpm run bundle:autotest-ui`
  （`npm ci && npm run build`，锁文件是 `services/autotest/ui/package-lock.json`）在
  同一条链上生成。
- `scripts/run-backend.bat` 已删除：它指向早期的 `.venv`，与「内置 Python +
  服务自己的 `.deps`」口径冲突；`/api/backend/restart` 改成用 `sys.executable`
  直接 spawn，端口取 `--port` 的实际值（`_current_port` 现在读命令行，不再只看
  env 默认 4000，否则会在错端口上多起一份）。

### P5 知识库（2 天）
- 归档 + 检索 + 前端「加入上下文」。
- 验收：检索 3 类记录各 1 条，加入上下文后模型能引用其 `source_ref`。

## 10. 风险与必须接受的代价

| 风险 | 影响 | 处理 |
|---|---|---|
| 扩展工具是 trusted code | 它在 sidecar 内，绕不过 bash/edit 权限；一个坏工具等于把 Agent 权限放大 | 工具只做 HTTP 调用，不读写本地文件；只有 `runtime.json` 一个读取点 |
| `agent.extension` 的分发限制 | v1.1 不走 marketplace，只能本地导入 | 自用可接受；要分发时改成内置工具（那时再写 ADR） |
| `runtime.json` 泄露 | 里面是端口 + 本地 token | 只给当前用户 ACL；token 每次启动重生成；不进日志 |
| 上下文膨胀 | 42 条用例全文塞进会话会让后续每轮都重发 | 工具返回摘要 + 句柄；全文只经 `report`/UI 读，永不进会话 |
| 审批时序 | 工具轮询超时、用户晚点才批，出现「批了但 Agent 早结束了」 | 答案落 `workflow_decisions` 后不丢；下次会话用 `runId` 续跑，不依赖上一轮还活着 |
| 旧 pipeline 与新工具并存 | 同一条需求被写两遍 | P4 一次性删除，禁止灰度期双开 |
| Python 侧冷启动 | 首次调用 3–8s（uvicorn + pandas） | 服务由 main 常驻，不按需拉起；健康检查 1s 超时 |
| loopback 代理变量 | 本机 `curl` 走代理返回 000（已在旧文档记录） | 所有请求 `NO_PROXY=127.0.0.1` / `127.0.0.1` 直连 |
| 编码 | `.ps1` 必须 UTF-8 BOM；SQL 迁移文件不要 BOM | 走 `pnpm check:powershell-encoding` |

## 11. 明确不做

- 不接 MCP、不做 stdio 工具协议、不做插件热加载。
- 不在 Python 里再放一套「Agent 编排」（现有 `engine.mjs` 就是因此被删）。
- 不让模型自己判 pass/fail：`counts` 只从执行记录聚合。
- 不做向量检索/RAG；标签 + LIKE 足够。
- 不改 `packages/agent-runtime`，也不新增 IPC 面：扩展直连 loopback，
  `apps/desktop/electron/ipc/AGENTS.md` 的契约完全不动。
- 不用 `ui.confirm` 当审批真源，不做「界面状态 + 会话状态」双份。

## 12. 已定的三件事

1. **工具入口**：`contributes.agentExtensions`（sidecar 进程内、不改 core）。
   将来要「所有会话默认可用」或「必须调任意 `host.call`」时，再改内置工具并写 ADR。
2. **UI 承载**：独立 `BrowserWindow`（P4 接），P2 先用浏览器把页面做到能用。
   plugin panel 被否：固定 46px 胶囊 + `net.domains` 过滤 + 单窗口形态，不适合工作台。
3. **服务位置**：`services/autotest`，在 P0 就迁（与启动路径重写同一次改动）。
