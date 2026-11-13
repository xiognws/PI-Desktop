---
name: autotest-workflow
description: 在 Autotest 工作台上跑一条测试流水线（PRD 解析 → 用例 → 评审 → 人工确认 → 脚本 → 执行 → 日志分析 → 报告）。当用户要求“根据这份 PRD 出用例/出测试计划/跑一轮测试/分析这批失败用例”时使用。
---

# Autotest Workflow

编排在 Agent 侧完成，没有外部状态机。工具只做确定性动作并落库；顺序、分支、
什么时候停下来问人，由你按下面的规则决定。

## 固定提示词（不得自创格式）

每个阶段的产出规则固定在 `services/autotest/prompts/`，用 `id@version` 标识：

| 阶段 | 文件 | 当前引用 |
| --- | --- | --- |
| 需求解析 | `prompts/prd-parse.md` | `autotest.prd-parse@1.0.0` |
| 用例设计 | `prompts/case-design.md` | `autotest.case-design@1.0.0` |
| 用例评审 | `prompts/case-review.md` | `autotest.case-review@1.0.0` |
| 脚本生成 | `prompts/script-author.md` | `autotest.script-author@1.0.0` |
| 日志分析 | `prompts/log-analyze.md` | `autotest.log-analyze@1.0.0` |
| 测试报告 | `prompts/report.md` | `autotest.report@1.0.0` |

规则：

1. 进入某个阶段前先读对应文件，按它的"硬性规则 / 输出契约"产出，不要凭习惯写格式。
2. 每次调用的返回里都带 `data.prompt.ref` —— 把它当作这一批产物按哪一版规则生成的凭证。
3. 用例设计返回还带 `data.consistency`（不合格项 + `by_field` 计数）。`ok=false` 时先按
   明细修用例，不要直接进评审/脚本。
4. 要改规则就改 md 文件并**升 version**，不要只改代码或只在会话里口头约定。
5. 想确认线上生效版本：`GET /api/projects/{project_id}/workflow/prompts`。

## 入口条件

先确认三件事，缺一件就停下来问用户，不要自行假设：

1. 项目 id（`autotest_run_status` 不带 run_id 可查最近记录，但新任务需要明确项目）
2. 需求来源：PRD 文本，或项目 `specs/` 下已上传的文件名（用 `requirement_ref`）
3. 本轮范围：只出用例，还是跑到脚本/执行/报告

## 主线

| 步骤 | 工具 | 产出 | 停止条件 |
| --- | --- | --- | --- |
| 0 | `autotest_knowledge_search` | 同类需求的历史经验（文档切分 + 上一轮归档报告） | 无命中就跳过，不要同一个词反复重试 |
| 1 | `autotest_prd_parse` | `run_id` + 功能点摘要 | 功能点为 0 → 停，让用户补文档章节 |
| 2 | `autotest_case_design` | 用例数与类型分布 | — |
| 3 | `autotest_request_confirmation` | 待确认项 | **必须停**：用例是人的资产，未经确认不得生成脚本 |
| 4 | `autotest_case_review` | verdict + 不可测/重复明细 | `needs_fix` → 修完用例再回到 3 |
| 5 | `autotest_script_author` | 脚本句柄 + 类型分布 | 脚本为 0 → 停，先确认用例是否为空 |
| 6 | `autotest_run` | `状态 queued` + 脚本数 | 投递完**不要等**，立刻进 7 |
| 7 | `autotest_run_status` | 执行统计 + 失败清单 | 没有 `autotest_run_result` → 等 30 秒再查一次 |
| 8 | `autotest_log_analyze` | 错误类型 + 可疑栈帧 + 建议 | 只在有失败时调；无失败直接进 9 |
| 9 | `autotest_report` | `report_id` + 路径 + 通过率 + `bug_ids` | — |

执行是后台线程：`autotest_run` 返回 `queued` 后，用 `autotest_run_status` 轮询，
看到 `autotest_run_result` 这一步出现即完成。失败时把 `execution_id` 传给
`autotest_log_analyze`，不要自己读日志文件。

缺陷单由后端确定性生成：`autotest_report` 会把每个失败用例映射成一条 `bug-xxxx`，
同一用例跨 run 反复失败会归并到同一张单（按脚本名 + 用例名做签名，`occurrences`
累加），同一 run 重复出报告不会重复计数。报告里多一节「缺陷清单」，带出现次数。
你不要自己编 bug id，也不要把 `bug_ids` 之外的内容补写成缺陷描述。

修复上限：同一批用例最多修两轮（改脚本 → 重跑 → 再看）。两轮后仍失败，出报告
并把失败归因留给用户，不要无限重试。

## 先查历史

`autotest_knowledge_search` 只读项目知识库（导入文档的切分条目 + 历史运行归档的报告）：

- 出用例前查一次：模块名、错误码、故障现象都值得查（`DTC`、`0x22`、`UDS` 这类命中率最高）。
- 命中只给标题 + 120 字摘要 + `source_ref`，全文在库里。引用时用 `source_ref` 指出出处，
  不要凭印象补写没读到的内容。
- 两个字的检索词（如“诊断”）走模糊匹配，结果宽但排序不可靠；优先用型号/错误码这类 ≥3 字符的词。
- 检索是辅助不是阻塞：没命中就按 PRD 正常往下走，检索记录不要贴进回复。

## 人工卡点规则

- 卡点只有一种真源：`workflow_decisions` 行。调 `autotest_request_confirmation`
  之后本轮就结束，返回 `WAITING_HUMAN` 是正常结束，不是失败。
- 用户审批后会在新消息里带上 `run_id`。收到后先 `autotest_run_status` 确认该
  decision 已 `decided`，再继续；`answer` 是 `reject` 时不要继续，先问改什么。
- 不要用对话里的“我觉得可以了”替代审批行。没有 decision 记录就没有确认。

## 上下文纪律

- 工具返回的是摘要 + 句柄；完整功能点和用例在数据库里。需要细节时用
  `autotest_run_status(run_id)`，不要要求工具一次吐出 200 条用例。
- 不要把整份 PRD 或全量用例贴进回复。引用功能点时用编号和名称。
- 每完成一步，用一句话汇报“跑了哪个工具、拿到什么、下一步是什么”。

## 失败分支

- `prd_parse` 报 400：`text` 和 `requirement_ref` 都没给，或给的文本为空。
- `case_design` 报 409：还没解析 PRD。回到步骤 1。
- 404 `运行不存在`：`run_id` 属于别的项目或已清理。用 `autotest_run_status`
  重新确认，不要编造 run_id。
- 连接失败（`autotest ... 失败`）：后端没起来。让用户确认桌面端 Autotest 服务
  状态，不要改用别的数据源“凑”结果。
