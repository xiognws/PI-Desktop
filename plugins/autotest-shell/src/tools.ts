/**
 * Agent 原生测试工作台工具（跑在 Agent sidecar 进程内）。
 *
 * 这里没有协议层：每个 execute 就是一次本机 loopback HTTP 调用，直连
 * `services/autotest` 的 FastAPI。工具只回“摘要 + 句柄”，大对象（完整功能点、
 * 全量用例）留在数据库里，需要时用 run_id 再取——上下文预算是硬约束。
 *
 * 运行时地址来自 `<userData>/autotest/runtime.json`（由 Electron main 写入，
 * 路径通过 PI_AUTOTEST_RUNTIME 传进本进程）。文件缺失时退到固定端口，只用于
 * 本地开发。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type RuntimeInfo = { port: number; token?: string };

const FALLBACK_RUNTIME: RuntimeInfo = { port: 4000 };
const REQUEST_TIMEOUT_MS = 30_000;

type ToolContent = { type: "text"; text: string };
type ToolResult = { content: ToolContent[]; details: Record<string, unknown>; isError?: boolean };
type RegisterApi = { registerTool(tool: unknown): void };

/**
 * runtime.json 由 Electron main 的 AutotestService 原子写入：
 *   `PI_AUTOTEST_RUNTIME` 显式覆盖 → `<PI_DESKTOP_DATA_DIR>/autotest/runtime.json`。
 * 两者都没有时用固定端口，只适合本地手工起服务。
 */
function loadRuntime(): RuntimeInfo {
  const dataDir = (process.env.PI_DESKTOP_DATA_DIR ?? "").trim();
  const candidates = [
    (process.env.PI_AUTOTEST_RUNTIME ?? "").trim(),
    dataDir ? join(dataDir, "autotest", "runtime.json") : "",
  ].filter((value) => value.length > 0);
  for (const path of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<RuntimeInfo>;
      if (typeof parsed.port === "number" && parsed.port > 0) {
        return { port: parsed.port, token: typeof parsed.token === "string" ? parsed.token : undefined };
      }
    } catch {
      // 文件可能正在被原子替换，或后端还没起来；继续试下一个候选。
    }
  }
  return FALLBACK_RUNTIME;
}

async function request(method: string, path: string, body?: unknown): Promise<unknown> {
  const runtime = loadRuntime();
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (runtime.token) headers["x-autotest-token"] = runtime.token;
  const response = await fetch(`http://127.0.0.1:${runtime.port}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const raw = await response.text();
  let payload: unknown = raw;
  try {
    payload = JSON.parse(raw);
  } catch {
    payload = { raw: raw.slice(0, 300) };
  }
  if (!response.ok) {
    const detail =
      typeof payload === "object" && payload !== null && "detail" in payload
        ? String((payload as { detail: unknown }).detail)
        : `HTTP ${response.status}`;
    throw new Error(`autotest ${method} ${path} 失败: ${detail}`);
  }
  return payload;
}

function text(value: string, details: Record<string, unknown> = {}, isError = false): ToolResult {
  return { content: [{ type: "text", text: value }], details, isError };
}

function fail(error: unknown, details: Record<string, unknown> = {}): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return text(`调用失败：${message}`, details, true);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function dataOf(payload: unknown): Record<string, unknown> {
  return asRecord(asRecord(payload).data);
}

const PROJECT_ARG = Type.String({ description: "项目 id（前端创建项目时生成的目录名）" });

export default function (pi: RegisterApi): void {
  pi.registerTool(
    defineTool({
      name: "autotest_prd_parse",
      description:
        "解析 PRD，切出功能点/非功能/依赖/风险，并在数据库里开一次 workflow run。" +
        "返回 run_id 和功能点摘要，完整列表留在库里。",
      parameters: Type.Object({
        project_id: PROJECT_ARG,
        text: Type.Optional(Type.String({ description: "PRD 原文；已有文件时改用 requirement_ref" })),
        requirement_ref: Type.Optional(Type.String({ description: "项目 specs/ 下的需求文件名或需求 id" })),
        module: Type.Optional(Type.String({ description: "所属模块，用于标记与检索" })),
      }),
      async execute(_id: string, params: Record<string, unknown>): Promise<ToolResult> {
        try {
          const payload = await request("POST", `/api/projects/${params.project_id}/workflow/prd-parse`, {
            text: params.text,
            requirement_ref: params.requirement_ref,
            module: params.module ?? "",
          });
          const data = dataOf(payload);
          const points = Array.isArray(data.function_points) ? data.function_points : [];
          const lines = points.map((item, index) => {
            const point = asRecord(item);
            return `${index + 1}. ${String(point.name ?? "")}（优先级 ${String(point.priority ?? "中")}）`;
          });
          return text(
            [
              `run_id: ${String(data.run_id)}`,
              `功能点 ${String(data.function_point_total)} 个，风险 ${(Array.isArray(data.risks) ? data.risks.length : 0)} 条，依赖 ${(Array.isArray(data.dependencies) ? data.dependencies.length : 0)} 条。`,
              lines.length ? `前 ${lines.length} 个功能点：\n${lines.join("\n")}` : "（未解析到功能点，检查文档是否有功能/需求章节）",
              "下一步：autotest_case_design(run_id, types)。",
            ].join("\n"),
            data,
          );
        } catch (error) {
          return fail(error);
        }
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "autotest_case_design",
      description:
        "按功能点 × 测试类型生成结构化用例（功能/异常/边界/接口/兼容），写入本次 run。" +
        "返回用例总数与类型分布，全文请求 autotest_run_status 取。",
      parameters: Type.Object({
        project_id: PROJECT_ARG,
        run_id: Type.String({ description: "autotest_prd_parse 返回的 run_id" }),
        types: Type.Optional(
          Type.Array(Type.String(), { description: "测试类型子集，默认 功能 + 异常" }),
        ),
      }),
      async execute(_id: string, params: Record<string, unknown>): Promise<ToolResult> {
        try {
          const payload = await request("POST", `/api/projects/${params.project_id}/workflow/case-design`, {
            run_id: params.run_id,
            types: params.types,
          });
          const data = dataOf(payload);
          const byType = asRecord(data.by_type);
          const breakdown = Object.entries(byType)
            .map(([key, value]) => `${key} ${String(value)}`)
            .join("、");
          return text(
            [
              `run_id: ${String(params.run_id)}`,
              `生成用例 ${String(data.case_total)} 条（${breakdown}）。`,
              "人工确认前不要再往下生成脚本：用 autotest_request_confirmation 建卡点。",
            ].join("\n"),
            data,
          );
        } catch (error) {
          return fail(error);
        }
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "autotest_case_review",
      description:
        "评审本次 run 的用例：找出缺失步骤/预期（不可测）、重复标题、缺优先级。" +
        "返回 verdict 与问题数量，明细在 details 里。",
      parameters: Type.Object({
        project_id: PROJECT_ARG,
        run_id: Type.String({ description: "run_id" }),
      }),
      async execute(_id: string, params: Record<string, unknown>): Promise<ToolResult> {
        try {
          const payload = await request("POST", `/api/projects/${params.project_id}/workflow/case-review`, {
            run_id: params.run_id,
          });
          const data = dataOf(payload);
          const untestable = Array.isArray(data.untestable) ? data.untestable : [];
          const duplicates = Array.isArray(data.duplicates) ? data.duplicates : [];
          const issues = Array.isArray(data.issues) ? data.issues : [];
          return text(
            [
              `verdict: ${String(data.verdict)}`,
              `不可测 ${untestable.length} 条、重复 ${duplicates.length} 条、其他问题 ${issues.length} 条。`,
              untestable.length
                ? `不可测前几条：${untestable
                    .slice(0, 3)
                    .map((item) => `${String(asRecord(item).title ?? "")}（${String(asRecord(item).reason ?? "")}）`)
                    .join("；")}`
                : "未发现不可测用例。",
            ].join("\n"),
            data,
          );
        } catch (error) {
          return fail(error);
        }
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "autotest_run_status",
      description:
        "读取本次 run 的阶段、状态、已执行步骤与待人工确认项。run_id 省略时返回最近一次 run。",
      parameters: Type.Object({
        project_id: PROJECT_ARG,
        run_id: Type.Optional(Type.String({ description: "run_id；省略则取最近一次" })),
      }),
      async execute(_id: string, params: Record<string, unknown>): Promise<ToolResult> {
        try {
          const projectId = String(params.project_id);
          const runId = params.run_id ? String(params.run_id) : "";
          if (runId) {
            // 摘要视图：不带 steps.payload，避免把大对象塞进上下文。
            const payload = await request("GET", `/api/projects/${projectId}/workflow/runs/${runId}/status`);
            const data = dataOf(payload);
            const steps = Array.isArray(data.steps) ? data.steps : [];
            const pending = Array.isArray(data.pending) ? data.pending : [];
            const failures = Array.isArray(data.failures) ? data.failures : [];
            const execution = asRecord(data.execution);
            const lines = [
              `stage: ${String(data.stage)}｜status: ${String(data.status)}`,
              `步骤 ${steps.length} 个：${
                steps
                  .map((step) => `${String(asRecord(step).tool ?? "")}(${String(asRecord(step).status ?? "")})`)
                  .join(" → ") || "（无）"
              }`,
            ];
            if (Object.keys(execution).length > 0) {
              lines.push(
                `执行：通过 ${String(execution.pass ?? 0)}/${String(execution.total ?? 0)}，失败 ${String(execution.fail ?? 0)}，异常 ${String(execution.error ?? 0)}`,
              );
            }
            if (failures.length) {
              lines.push(
                `失败用例：${failures.map((item) => String(asRecord(item).script_name ?? "")).join("；")}`,
              );
            }
            lines.push(
              pending.length
                ? `待确认 ${pending.length} 项：${pending.map((item) => String(asRecord(item).prompt ?? "")).join("；")}`
                : "没有待确认项。",
            );
            return text(lines.join("\n"), data);
          }
          const payload = await request("GET", `/api/projects/${projectId}/workflow/runs?limit=5`);
          const runs = Array.isArray(dataOf(payload).runs) ? (dataOf(payload).runs as unknown[]) : [];
          return text(
            runs.length
              ? runs
                  .map((item) => {
                    const run = asRecord(item);
                    return `${String(run.id)}｜${String(run.stage)}｜${String(run.status)}｜${String(run.updated_at ?? "")}`;
                  })
                  .join("\n")
              : "该项目还没有 workflow run。",
            { runs },
          );
        } catch (error) {
          return fail(error);
        }
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "autotest_request_confirmation",
      description:
        "建立人工卡点并结束本轮：写入待确认项后立即返回 WAITING_HUMAN。" +
        "用户在前端审批、重新发消息并带上 run_id 后才能继续。",
      parameters: Type.Object({
        project_id: PROJECT_ARG,
        run_id: Type.String({ description: "run_id" }),
        prompt: Type.String({ description: "要用户确认的具体问题" }),
        options: Type.Optional(Type.Array(Type.String(), { description: "可选项，默认 approve/reject" })),
      }),
      async execute(_id: string, params: Record<string, unknown>): Promise<ToolResult> {
        try {
          const payload = await request("POST", `/api/projects/${params.project_id}/workflow/runs/${params.run_id}/pending`, {
            prompt: params.prompt,
            options: params.options ?? ["approve", "reject"],
          });
          const data = dataOf(payload);
          return text(
            [
              "WAITING_HUMAN",
              `已在 run ${String(params.run_id)} 上建待确认项 ${String(data.decision_id)}。`,
              "本轮到此结束：不要再调用其它工具，也不要替用户作答。",
            ].join("\n"),
            data,
          );
        } catch (error) {
          return fail(error);
        }
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "autotest_decide",
      description:
        "记录用户对某个待确认项的答复（前端审批走同一张表）。" +
        "只有用户在本轮明确表达后才调用，不要替用户选择。",
      parameters: Type.Object({
        project_id: PROJECT_ARG,
        run_id: Type.String({ description: "run_id" }),
        decision_id: Type.String({ description: "autotest_run_status 返回的待确认项 id" }),
        answer: Type.String({ description: "用户的选择，如 approve / reject，或自由文本" }),
        note: Type.Optional(Type.String({ description: "用户的补充说明" })),
      }),
      async execute(_id: string, params: Record<string, unknown>): Promise<ToolResult> {
        try {
          const payload = await request(
            "POST",
            `/api/projects/${params.project_id}/workflow/runs/${params.run_id}/pending/${params.decision_id}/decide`,
            { answer: params.answer, note: params.note ?? "" },
          );
          const data = dataOf(payload);
          return text(`已记录确认：${String(params.answer)}（decision ${String(params.decision_id)}）。`, data);
        } catch (error) {
          return fail(error);
        }
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "autotest_script_author",
      description:
        "把已设计的用例落成可执行脚本（pytest 骨架），写入项目 scripts/ 目录与 scripts 表。" +
        "返回脚本句柄，完整脚本内容留在库里。",
      parameters: Type.Object({
        project_id: PROJECT_ARG,
        run_id: Type.String({ description: "run_id" }),
        sdk: Type.Optional(Type.String({ description: "脚本 SDK，目前只支持 pytest" })),
      }),
      async execute(_id: string, params: Record<string, unknown>): Promise<ToolResult> {
        try {
          const payload = await request("POST", `/api/projects/${params.project_id}/workflow/script-author`, {
            run_id: params.run_id,
            sdk: params.sdk ?? "pytest",
          });
          const data = dataOf(payload);
          const scripts = Array.isArray(data.scripts) ? data.scripts : [];
          return text(
            [
              `生成 ${String(data.script_total ?? 0)} 个脚本：`,
              scripts
                .map((item) => `${String(asRecord(item).name ?? "")}（${String(asRecord(item).case_type ?? "")}）`)
                .join("\n") || "（无）",
              "下一步：autotest_run 投递执行。",
            ].join("\n"),
            data,
          );
        } catch (error) {
          return fail(error);
        }
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "autotest_run",
      description:
        "投递执行本 run 的脚本（后台线程跑，立即返回）。" +
        "不要在这里等待结果：用 autotest_run_status 轮询，失败再调 autotest_log_analyze。",
      parameters: Type.Object({
        project_id: PROJECT_ARG,
        run_id: Type.String({ description: "run_id" }),
        script_ids: Type.Optional(Type.Array(Type.String(), { description: "只跑指定脚本；省略则跑本 run 已生成的全部" })),
        timeout_s: Type.Optional(Type.Number({ description: "单个脚本超时秒数，默认 60" })),
      }),
      async execute(_id: string, params: Record<string, unknown>): Promise<ToolResult> {
        try {
          const payload = await request("POST", `/api/projects/${params.project_id}/workflow/runs/${params.run_id}/execute`, {
            script_ids: params.script_ids,
            timeout_s: params.timeout_s ?? 60,
          });
          const data = dataOf(payload);
          return text(
            `已投递 ${String(data.script_total ?? 0)} 个脚本（run ${String(params.run_id)}）。` +
              "下一步：autotest_run_status 轮询结果。",
            data,
          );
        } catch (error) {
          return fail(error);
        }
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "autotest_log_analyze",
      description:
        "分析一次执行或一段原始日志：给出错误类型、可疑栈帧与排查建议。" +
        "传 execution_id 时后端自己取事件流；传 raw_log 时分析原文。",
      parameters: Type.Object({
        project_id: PROJECT_ARG,
        run_id: Type.Optional(Type.String({ description: "关联的 run_id，写入步骤记录" })),
        execution_id: Type.Optional(Type.Number({ description: "执行 id（autotest_run_status 的失败项里有）" })),
        raw_log: Type.Optional(Type.String({ description: "原始日志；与 execution_id 二选一" })),
        trace_id: Type.Optional(Type.String({ description: "链路追踪 id" })),
        module: Type.Optional(Type.String({ description: "所属模块" })),
      }),
      async execute(_id: string, params: Record<string, unknown>): Promise<ToolResult> {
        try {
          const payload = await request("POST", `/api/projects/${params.project_id}/workflow/log-analyze`, {
            run_id: params.run_id,
            execution_id: params.execution_id,
            raw_log: params.raw_log ?? "",
            trace_id: params.trace_id ?? "",
            module: params.module ?? "",
          });
          const data = dataOf(payload);
          const suspects = Array.isArray(data.suspects) ? data.suspects : [];
          const suggestions = Array.isArray(data.suggestions) ? data.suggestions : [];
          const error = asRecord(data.error);
          return text(
            [
              `摘要：${String(data.summary ?? "")}`,
              Object.keys(error).length ? `错误类型：${String(error.type ?? "")}` : "未识别出异常类型。",
              suspects.length
                ? `可疑栈帧：${suspects
                    .slice(0, 3)
                    .map((item) => `${String(asRecord(item).file ?? "")}:${String(asRecord(item).line ?? "")}`)
                    .join("；")}`
                : "无可疑栈帧。",
              suggestions.length ? `建议：${suggestions.slice(0, 3).map(String).join("；")}` : "",
            ]
              .filter((line) => line.length > 0)
              .join("\n"),
            data,
          );
        } catch (error) {
          return fail(error);
        }
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "autotest_report",
      description:
        "生成 Markdown 测试报告并落库（reports 表 + 项目 reports/ 目录），同时把报告归档进项目知识库。" +
        "报告只汇总已落库的执行结果，失败证据会带上断言与 stderr。",
      parameters: Type.Object({
        project_id: PROJECT_ARG,
        run_id: Type.String({ description: "run_id" }),
      }),
      async execute(_id: string, params: Record<string, unknown>): Promise<ToolResult> {
        try {
          const payload = await request("POST", `/api/projects/${params.project_id}/workflow/runs/${params.run_id}/report`, {});
          const data = dataOf(payload);
          const counts = asRecord(data.counts);
          return text(
            [
              `报告已生成：${String(data.report_id ?? "")}`,
              `路径：${String(data.path ?? "")}`,
              `通过率 ${String(data.pass_rate ?? "")}（总数 ${String(counts.total ?? 0)}，失败 ${String(counts.failed ?? 0)}，异常 ${String(counts.errored ?? 0)}）`,
            ].join("\n"),
            data,
          );
        } catch (error) {
          return fail(error);
        }
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "autotest_knowledge_search",
      description:
        "检索项目知识库：导入文档的切分条目 + 历史运行归档的报告。BM25 排序，" +
        "中文短词退化为模糊匹配。只读，返回标题与摘要；出用例前查同类历史经验时用。",
      parameters: Type.Object({
        project_id: PROJECT_ARG,
        query: Type.String({ description: "检索词：型号、错误码、故障现象等；空串表示按模块/标签列最近记录" }),
        module: Type.Optional(Type.String({ description: "按模块过滤" })),
        tags: Type.Optional(Type.String({ description: "按标签过滤，逗号分隔" })),
        limit: Type.Optional(Type.Number({ description: "返回条数，默认 8，最多 20" })),
      }),
      async execute(_id: string, params: Record<string, unknown>): Promise<ToolResult> {
        try {
          const query = String(params.query ?? "");
          const limit = Math.min(Math.max(Number(params.limit ?? 8), 1), 20);
          const search = new URLSearchParams({ q: query, limit: String(limit) });
          if (typeof params.module === "string" && params.module) search.set("module", params.module);
          if (typeof params.tags === "string" && params.tags) search.set("tags", params.tags);
          const payload = await request(
            "GET",
            `/api/projects/${params.project_id}/workflow/knowledge/search?${search.toString()}`,
          );
          const data = dataOf(payload);
          const records = Array.isArray(data.records) ? data.records : [];
          if (!records.length) {
            return text(
              `知识库没有命中（query=${JSON.stringify(query)}）。可以放宽关键词，或让用户先导入文档。`,
              data,
            );
          }
          const lines = records.slice(0, limit).map((item) => {
            const record = asRecord(item);
            const score = record.score;
            const excerpt = String(record.excerpt ?? "").replace(/\s+/g, " ").slice(0, 120);
            return `- [${String(record.record_type ?? "")}] ${String(record.title ?? "")}` +
              `${typeof score === "number" ? `（score ${score.toFixed(2)}）` : ""}` +
              `：${excerpt} · ${String(record.source_ref ?? "")}`;
          });
          return text(
            [
              `命中 ${records.length} 条：`,
              ...lines,
              "引用时用 source_ref 指出来源，不要把摘要之外的全文凭印象补写。",
            ].join("\n"),
            data,
          );
        } catch (error) {
          return fail(error);
        }
      },
    }),
  );
}
