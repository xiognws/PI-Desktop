/**
 * e2e full-chain harness: proves the UI channel also survives
 * author → gate → execute(fail) → judge → repair → execute(pass) → report.
 *
 * Run: node pipeline/selftest_e2e.mjs <baseUrl> <projectId> [targetUrl]
 *
 * The stub's first script asserts text that is not on the page, so the first run
 * must fail and keep its screenshot; the repair round only changes the expected
 * string, and the second run must pass. If artifacts or the repair evidence are
 * missing, the harness fails — that is the point.
 */
import { createEngine } from "./engine.mjs";
import { createClient } from "./client.mjs";

const baseUrl = process.argv[2] || "http://127.0.0.1:4030";
const projectId = process.argv[3];
const targetUrl = process.argv[4] || baseUrl;
const requirementFilename = process.argv[5] || "pipeline-req.md";
if (!projectId) {
  console.error("usage: node pipeline/selftest_e2e.mjs <baseUrl> <projectId> [targetUrl] [requirement]");
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

function e2eScript(expectText) {
  return `// @target ${targetUrl}
import { test } from "@e2e-dev/web";
import { expect } from "e2e";

test("home shows the platform title", async ({ app, browser }) => {
  await app.open("/");
  await expect(browser.locator("body")).toContainText(${JSON.stringify(expectText)});
});
`;
}

const WRONG = "这段文案页面上不存在-7f2c";
const RIGHT = "测试平台";

const stub = {
  analyze: {
    function_points: [{ name: "首页标题可见", module: "工作台", description: "首页展示平台标题", priority: "高" }],
  },
  design: {
    cases: [
      {
        title: "首页标题可见",
        function_point: "首页标题可见",
        steps: ["打开首页", "检查标题文案"],
        expected: "页面包含平台标题",
        priority: "高",
        scene: "正向",
        case_type: "功能",
      },
    ],
  },
  author: {
    scripts: [
      {
        case_title: "首页标题可见",
        name: "e2e_home_title.e2e.ts",
        language: "e2e",
        content: e2eScript(WRONG),
      },
    ],
  },
};

let repairScriptId = "";
const engine = createEngine({
  api: createClient({ request }),
  log: (message) => console.log(`  · ${message}`),
  complete: async ({ stage, prompt }) => {
    if (stage === "repair") {
      const match = /"scriptId":\s*"([^"]+)"/.exec(prompt);
      repairScriptId = match?.[1] || repairScriptId;
      return {
        text: JSON.stringify({
          patched: [
            {
              scriptId: repairScriptId,
              scriptName: "e2e_home_title.e2e.ts",
              content: e2eScript(RIGHT),
              note: "断言文案与页面实际标题不符（失败截图显示页面标题为“AI 测试平台”），改为存在的文案，断言强度不变",
            },
          ],
        }),
        modelKey: "stub/selftest",
        usage: { inputTokens: prompt.length, outputTokens: 96, totalTokens: prompt.length + 96 },
      };
    }
    const value = stub[stage];
    return {
      text: JSON.stringify(value),
      modelKey: "stub/selftest",
      usage: { inputTokens: 64, outputTokens: 64, totalTokens: 128 },
    };
  },
});

const created = await request(`/api/projects/${projectId}/pipelines`, {
  method: "POST",
  body: { requirementFilename, checkpointPolicy: "auto", modelKey: "stub/selftest", targetUrl },
});
const pipelineId = created.pipeline.id;
console.log(`pipeline ${pipelineId} target=${targetUrl}`);

const state = await engine.run(projectId, pipelineId, { maxSteps: 40 });
console.log(`status=${state.pipeline.status} stage=${state.pipeline.current_stage}`);
for (const row of state.stages) {
  console.log(`  - ${row.stage} #${row.attempt} ${row.status}${row.error ? ` error=${row.error}` : ""}`);
}

const executes = state.stages.filter((row) => row.stage === "execute");
const run1 = executes[0]?.output_json?.executions?.[0];
const run2 = executes[1]?.output_json?.executions?.[0];
console.log("run1:", JSON.stringify(run1));
console.log("run2:", JSON.stringify(run2));

const report = await request(`/api/projects/${projectId}/pipelines/${pipelineId}/report`).catch((error) => ({
  markdown: `REPORT ERROR: ${error.message}`,
}));
const markdown = report.markdown || "";
console.log("report chars:", markdown.length);
console.log(markdown.split("\n").slice(0, 30).join("\n"));

const hasArtifact = (run1?.artifacts || []).some((item) =>
  /screen|shot|trace|log/i.test(item.kind + item.path),
);
const ok =
  state.pipeline.status === "done" &&
  run1?.status === "fail" &&
  run2?.status === "pass" &&
  hasArtifact &&
  /## 修复记录/.test(markdown) &&
  /## 产物/.test(markdown) &&
  /全部通过/.test(markdown);
console.log("artifact kept:", hasArtifact, JSON.stringify(run1?.artifacts ?? []));
console.log(ok ? "SELFTEST_E2E OK" : "SELFTEST_E2E FAILED");
process.exit(ok ? 0 : 1);
