/**
 * Scheduled-run harness: schedule → fire → auto pipeline → engine → report.
 *
 * Run: node pipeline/selftest_schedule.mjs <baseUrl> <projectId> [requirement]
 *
 * Proves the nightly path end to end without waiting for a wall-clock slot: the
 * fire call is exactly what the plugin's 30 s loop performs when a schedule is
 * due. The firing path must create an `auto` pipeline (no checkpoint), and the
 * report + advanced next-run must both be there afterwards.
 */
import { createEngine } from "./engine.mjs";
import { createClient } from "./client.mjs";

const baseUrl = process.argv[2] || "http://127.0.0.1:4040";
const projectId = process.argv[3];
const requirementFilename = process.argv[4] || "pipeline-req.md";
if (!projectId) {
  console.error("usage: node pipeline/selftest_schedule.mjs <baseUrl> <projectId> [requirement]");
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

const stub = {
  analyze: {
    function_points: [{ name: "首页项目列表", module: "工作台", description: "首页展示项目", priority: "高" }],
  },
  design: {
    cases: [
      {
        title: "定时回归用例",
        function_point: "首页项目列表",
        steps: ["打开首页"],
        expected: "看到项目卡片",
        priority: "高",
        scene: "正向",
        case_type: "功能",
      },
    ],
  },
  author: {
    scripts: [
      {
        case_title: "定时回归用例",
        name: "scheduled_case.py",
        language: "python",
        content: "rows = ['proj']\nassert rows, 'no rows'\nprint('scheduled run ok')\n",
      },
    ],
  },
};

const engine = createEngine({
  api: createClient({ request }),
  log: (message) => console.log(`  · ${message}`),
  complete: async ({ stage, prompt }) => ({
    text: JSON.stringify(stub[stage]),
    modelKey: "stub/selftest",
    usage: { inputTokens: prompt.length, outputTokens: 64, totalTokens: prompt.length + 64 },
  }),
});

const schedule = await request(`/api/projects/${projectId}/schedules`, {
  method: "POST",
  body: {
    name: "夜间回归（验证）",
    requirementFilename,
    kind: "interval",
    intervalMinutes: 5,
    targetUrl: "",
  },
});
console.log(`schedule ${schedule.id} next=${schedule.next_run_at}`);

const fired = await request(`/api/projects/${projectId}/schedules/${schedule.id}/fire`, {
  method: "POST",
  body: {},
});
const pipelineId = fired.pipeline.id;
console.log(`fired → ${pipelineId} policy=${fired.pipeline.checkpoint_policy}`);

const state = await engine.run(projectId, pipelineId, { maxSteps: 40 });
console.log(`status=${state.pipeline.status} stage=${state.pipeline.current_stage}`);

const after = (await request(`/api/projects/${projectId}/schedules`)).schedules.find(
  (row) => row.id === schedule.id,
);
const report = await request(`/api/projects/${projectId}/pipelines/${pipelineId}/report`).catch(
  (error) => ({ markdown: "" , error: String(error.message || error) }),
);
const markdown = report.markdown || "";
console.log(`schedule after: last=${after?.last_run_at} next=${after?.next_run_at} pipeline=${after?.last_pipeline_id}`);
console.log(`report chars=${markdown.length}`);
console.log(markdown.split("\n").slice(0, 14).join("\n"));

// due list must not contain the schedule right after firing (next run is 5 min out)
const due = (await request("/api/pipelines/due")).due || [];
const stillDue = due.some((row) => row.id === schedule.id);

const ok =
  fired.pipeline.checkpoint_policy === "auto" &&
  state.pipeline.status === "done" &&
  markdown.includes("全部通过") &&
  after?.last_pipeline_id === pipelineId &&
  after?.next_run_at > after?.last_run_at &&
  !stillDue;
console.log("due contains schedule:", stillDue);
console.log(ok ? "SELFTEST_SCHEDULE OK" : "SELFTEST_SCHEDULE FAILED");
process.exit(ok ? 0 : 1);
