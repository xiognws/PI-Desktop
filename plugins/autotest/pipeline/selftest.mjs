/**
 * Offline harness for the pipeline engine: runs the real state machine against
 * a live backend with a stub model, so the rules can be verified without the
 * Desktop host. Run with `node pipeline/selftest.mjs <baseUrl> <projectId> [policy]`.
 *
 * It is not a unit test of the prompts (those need a real model); it proves the
 * stage order, the output contracts, the side effects, the checkpoint policies
 * and the audit ledger.
 */
import { createEngine } from "./engine.mjs";
import { createClient } from "./client.mjs";

const baseUrl = process.argv[2] || "http://127.0.0.1:4011";
const projectId = process.argv[3];
const policy = process.argv[4] || "auto";
const requirementFilename = process.argv[5] || "pipeline-req.md";
if (!projectId) {
  console.error("usage: node pipeline/selftest.mjs <baseUrl> <projectId> [policy] [requirement]");
  process.exit(2);
}

async function request(path, { method = "GET", body } = {}) {
  const response = await fetch(baseUrl + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (response.status >= 400) {
    throw new Error(`backend ${response.status}: ${text.slice(0, 400)}`);
  }
  return text ? JSON.parse(text) : {};
}

const TARGET = "http://127.0.0.1:4011";

const stub = {
  analyze: {
    function_points: [
      { name: "项目列表展示", module: "工作台", description: "首页展示项目卡片", priority: "高" },
      { name: "执行记录查询", module: "执行", description: "按项目查看执行记录", priority: "中" },
    ],
  },
  design: {
    cases: [
      {
        title: "首页展示项目列表",
        function_point: "项目列表展示",
        steps: ["1. 打开首页", "2. 查看项目卡片"],
        expected: "至少有一个项目卡片且显示项目名称",
        priority: "高",
        scene: "正向",
        case_type: "功能",
      },
      {
        title: "执行记录页可打开",
        function_point: "执行记录查询",
        steps: ["1. 打开执行页", "2. 读取表格行"],
        expected: "页面显示执行记录表头",
        priority: "中",
        scene: "正向",
        case_type: "功能",
      },
    ],
  },
  author: (prompt) => ({
    scripts: [
      {
        case_title: "首页展示项目列表",
        name: "pipeline_home_list.py",
        language: "python",
        content: "rows = ['proj_a']\nassert rows, 'no project rows'\nprint('home list ok', rows)\n",
      },
      {
        case_title: "执行记录页可打开",
        name: "pipeline_exec_page.e2e.ts",
        language: "e2e",
        content: `// @target ${TARGET}\nimport { test } from "@e2e-dev/web";\nimport { expect } from "e2e";\n\ntest("executions page opens", async ({ app, browser }) => {\n  await app.open("/");\n  await expect(browser.locator("body")).toBeVisible();\n});\n`,
      },
    ],
    _echoLength: prompt.length,
  }),
};

const seen = [];
const engine = createEngine({
  api: createClient({ request }),
  log: (message) => console.log(`  · ${message}`),
  complete: async ({ stage, prompt }) => {
    seen.push({ stage, promptChars: prompt.length });
    const value = typeof stub[stage] === "function" ? stub[stage](prompt) : stub[stage];
    return {
      text: JSON.stringify(value),
      modelKey: "stub/selftest",
      usage: { inputTokens: prompt.length, outputTokens: 64, totalTokens: prompt.length + 64 },
    };
  },
});

const created = await request(`/api/projects/${projectId}/pipelines`, {
  method: "POST",
  body: {
    requirementFilename,
    checkpointPolicy: policy,
    modelKey: "stub/selftest",
    targetUrl: TARGET,
  },
});
const pipelineId = created.pipeline.id;
console.log(`pipeline ${pipelineId} (policy=${policy})`);

let state = await engine.run(projectId, pipelineId);
console.log(`status=${state.pipeline.status} stage=${state.pipeline.current_stage}`);
for (const row of state.stages) {
  console.log(`  - ${row.stage} #${row.attempt} ${row.status} ${row.error ? `error=${row.error}` : ""}`);
}

if (state.pipeline.status === "waiting") {
  console.log("approving…");
  await request(`/api/projects/${projectId}/pipelines/${pipelineId}/approve`, { method: "POST", body: {} });
  state = await engine.run(projectId, pipelineId);
  console.log(`after approve: status=${state.pipeline.status} stage=${state.pipeline.current_stage}`);
  for (const row of state.stages) {
    console.log(`  - ${row.stage} #${row.attempt} ${row.status} ${row.error ? `error=${row.error}` : ""}`);
  }
}

const cases = (await request(`/api/projects/${projectId}/cases`)).cases || [];
const scripts = (await request(`/api/projects/${projectId}/scripts`)).scripts || [];
console.log("calls:", JSON.stringify(seen));
console.log("cases:", cases.length, cases.map((item) => item.name).join(" | "));
console.log(
  "scripts:",
  scripts.length,
  scripts.map((item) => `${item.name}[${item.language}]→${item.case_id || "-"}`).join(" | "),
);
console.log("ledger:", JSON.stringify(state.agent_calls));

const gate = state.stages.find((row) => row.stage === "gate");
console.log("gate:", JSON.stringify(gate?.output_json ?? null));
const ok = state.pipeline.status === "done" && cases.length >= 2 && scripts.length >= 2;
console.log(ok ? "SELFTEST OK" : "SELFTEST FAILED");
process.exit(ok ? 0 : 1);
