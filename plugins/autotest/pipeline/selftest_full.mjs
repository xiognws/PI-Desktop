/**
 * Full-chain harness: analyze → design → author → gate → execute → judge →
 * repair → execute → judge → report, with **real** processes for the execution
 * stages and a stub for the model calls.
 *
 * Run: node pipeline/selftest_full.mjs <baseUrl> <projectId> [policy]
 *
 * The stub writes one passing and one failing python case, so the first judge
 * finds a failure, the repair round patches it, and the second judge passes —
 * that is the only way to prove the repair loop actually re-runs rather than
 * declaring victory.
 */
import { createEngine } from "./engine.mjs";
import { createClient } from "./client.mjs";

const baseUrl = process.argv[2] || "http://127.0.0.1:4020";
const projectId = process.argv[3];
const policy = process.argv[4] || "auto";
const requirementFilename = process.argv[5] || "pipeline-req.md";
if (!projectId) {
  console.error("usage: node pipeline/selftest_full.mjs <baseUrl> <projectId> [policy] [requirement]");
  process.exit(2);
}

async function request(path, { method = "GET", body } = {}) {
  const response = await fetch(baseUrl + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (response.status >= 400) throw new Error(`backend ${response.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

const GOOD = "value = 1\nassert value == 1, 'expected 1'\nprint('ok')\n";
const BAD = "value = 0\nassert value == 1, 'expected 1 got 0'\nprint('unreachable')\n";
const FIXED = "value = 1\nassert value == 1, 'expected 1 got 0'\nprint('fixed')\n";

const stub = {
  analyze: {
    function_points: [
      { name: "首页项目列表", module: "工作台", description: "首页展示项目", priority: "高" },
      { name: "执行记录查询", module: "执行", description: "查看执行记录", priority: "中" },
    ],
  },
  design: {
    cases: [
      { title: "首页展示项目列表", function_point: "首页项目列表", steps: ["打开首页"], expected: "看到项目卡片", priority: "高", scene: "正向", case_type: "功能" },
      { title: "执行记录可查询", function_point: "执行记录查询", steps: ["打开执行页"], expected: "看到执行表头", priority: "中", scene: "正向", case_type: "功能" },
    ],
  },
  author: {
    scripts: [
      { case_title: "首页展示项目列表", name: "pipeline_ok.py", language: "python", content: GOOD },
      { case_title: "执行记录可查询", name: "pipeline_bad.py", language: "python", content: BAD },
    ],
  },
  repair: (prompt) => ({
    patched: [
      {
        scriptId: /"scriptId": "([^"]+)"/.exec(prompt)?.[1] || "",
        scriptName: "pipeline_bad.py",
        content: FIXED,
        note: "失败为 AssertionError expected 1 got 0：把被测值改为 1，断言保持不变",
      },
    ],
  }),
};

const seen = [];
let repairScriptId = "";
const engine = createEngine({
  api: createClient({ request }),
  log: (message) => console.log(`  · ${message}`),
  complete: async ({ stage, prompt }) => {
    seen.push(stage);
    let value;
    if (stage === "repair") {
      // the prompt JSON carries the failing script's id; reuse it for the patch
      const match = /"scriptId":\s*"([^"]+)"/.exec(prompt);
      repairScriptId = match?.[1] || repairScriptId;
      value = {
        patched: [
          {
            scriptId: repairScriptId,
            scriptName: "pipeline_bad.py",
            content: FIXED,
            note: "AssertionError: expected 1 got 0 → 修正被测值，断言保留",
          },
        ],
      };
    } else {
      value = stub[stage];
    }
    return {
      text: JSON.stringify(value),
      modelKey: "stub/selftest",
      usage: { inputTokens: prompt.length, outputTokens: 64, totalTokens: prompt.length + 64 },
    };
  },
});

const created = await request(`/api/projects/${projectId}/pipelines`, {
  method: "POST",
  body: { requirementFilename, checkpointPolicy: policy, modelKey: "stub/selftest", targetUrl: "" },
});
const pipelineId = created.pipeline.id;
console.log(`pipeline ${pipelineId} (policy=${policy})`);

let state = await engine.run(projectId, pipelineId, { maxSteps: 40 });
if (state.pipeline.status === "waiting") {
  console.log(`waiting at ${state.pipeline.current_stage}, approving…`);
  await request(`/api/projects/${projectId}/pipelines/${pipelineId}/approve`, { method: "POST", body: {} });
  state = await engine.run(projectId, pipelineId, { maxSteps: 40 });
}

console.log(`status=${state.pipeline.status} stage=${state.pipeline.current_stage}`);
for (const row of state.stages) {
  console.log(`  - ${row.stage} #${row.attempt} ${row.status}${row.error ? ` error=${row.error}` : ""}`);
}
console.log("model stages called:", seen.join(","));

const report = await request(`/api/projects/${projectId}/pipelines/${pipelineId}/report`).catch((error) => ({
  markdown: `REPORT ERROR: ${error.message}`,
}));
const markdown = report.markdown || "";
console.log("report chars:", markdown.length);
console.log(markdown.split("\n").slice(0, 22).join("\n"));

const cases = (await request(`/api/projects/${projectId}/cases`)).cases || [];
console.log("cases:", cases.map((item) => `${item.name}:${item.status}`).join(" | "));

const executed = state.stages.filter((row) => row.stage === "execute").length;
const judged = state.stages.filter((row) => row.stage === "judge").length;
const repaired = state.stages.filter((row) => row.stage === "repair").length;
const firstJudge = state.stages.filter((row) => row.stage === "judge")[0]?.output_json?.counts;
const lastJudge = state.stages.filter((row) => row.stage === "judge").pop()?.output_json?.counts;
console.log("rounds:", JSON.stringify({ executed, judged, repaired, firstJudge, lastJudge }));

const ok =
  state.pipeline.status === "done" &&
  executed === 2 &&
  judged === 2 &&
  repaired === 1 &&
  firstJudge?.fail === 1 &&
  lastJudge?.fail === 0 &&
  markdown.includes("全部通过") &&
  markdown.includes("## 修复记录") &&
  cases.every((item) => item.status === "通过");
console.log(ok ? "SELFTEST_FULL OK" : "SELFTEST_FULL FAILED");
process.exit(ok ? 0 : 1);
