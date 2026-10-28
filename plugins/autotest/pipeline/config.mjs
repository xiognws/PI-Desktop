/**
 * Pipeline rules: prompts, output contracts and per-stage limits.
 *
 * The Python side owns the authoritative output validation; these prompts just
 * aim at the same shape so a normal model answer passes on the first try. Keep
 * the two in sync — `platform/src/autotest/pipelines/service.py`.
 */

export const STAGES = ["analyze", "design", "author", "gate", "execute", "judge", "repair", "report"];

export const CHECKPOINT_POLICIES = {
  auto: [],
  analyze: ["analyze"],
  analyze_author: ["analyze", "author"],
};

export const RULES = {
  analyze: { maxAttempts: 2, label: "需求分析", produces: "功能点" },
  design: { maxAttempts: 2, label: "用例设计", produces: "test_cases" },
  author: { maxAttempts: 3, label: "脚本工程", produces: "scripts" },
  gate: { maxAttempts: 1, label: "静态闸门", produces: "闸门结果" },
  execute: { maxAttempts: 1, label: "脚本执行", produces: "executions", pollMs: 500, pollLimit: 640 },
  judge: { maxAttempts: 1, label: "结果判定", produces: "verdicts" },
  repair: { maxAttempts: 2, label: "脚本修复", produces: "patched scripts" },
  report: { maxAttempts: 1, label: "结果收集", produces: "report.md" },
};

/** 修复轮上限，与后端 MAX_REPAIR_ROUNDS 一致。 */
export const MAX_REPAIR_ROUNDS = 2;

const ANALYZE_SYSTEM = `你是汽车电子测试分析师。阅读需求文档，拆出可测试的功能点。
只输出 JSON，不要 Markdown 代码块，不要解释。`;

const DESIGN_SYSTEM = `你是汽车电子测试设计工程师。把功能点拆成可执行的手工用例。
每条用例必须能落到"打开哪个页面/接口 → 做什么 → 期望什么"，禁止写"验证功能正常"这种不可执行的期望。
只输出 JSON，不要 Markdown 代码块，不要解释。`;

const E2E_CONTRACT = `e2e 契约（违反任意一条都会整轮失败）：
- import 只能是：\`import { test } from "@e2e-dev/web";\` 与 \`import { expect } from "e2e";\`
- 可用 fixture 只有 app / screen / browser / agent；**没有 page**，也**没有 browser.locator**
- 导航：\`await app.open("/")\`
- 定位/交互：\`screen.getByRole("button", { name: "新建项目" })\`、\`screen.getByText("我的项目")\`、\`screen.getByTestId("x")\`；动作是 \`.tap()\` / \`.fill()\` / \`.check()\`
- 断言：\`await expect(screen.getByText("我的项目")).toBeVisible()\`、\`.toBeHidden()\`、\`.toHaveCount(2)\`；URL/标题：\`await expect(browser).toHaveURL("/")\`、\`toHaveTitle(/…/)\`
- 禁止：page.*、browser.locator、browser.viewportSize、locator.locator(...)`;

const REPAIR_SYSTEM = `你是自动化测试脚本修复工程师。根据失败证据修改脚本，只改导致失败的部分。
${E2E_CONTRACT}
不要降低断言强度来"让它通过"（例如删掉断言、改成 print、加 try/except 吞异常）；修不了就保留原断言并说明原因。
只输出 JSON，不要 Markdown 代码块，不要解释。`;

const AUTHOR_SYSTEM = `你是自动化测试脚本工程师，产出可直接运行的用例脚本。
${E2E_CONTRACT}
- e2e 用例是 TypeScript，**import 必须且只能是这样**（写错就是整轮执行全挂）：
  \`import { test } from "@e2e-dev/web";\`
  \`import { expect } from "e2e";\`
  \`@e2e-dev/web\` 只导出 test，**没有 expect**；expect 只从 "e2e" 导入。
- python 用例是纯脚本：断言失败必须抛异常（assert 或 raise），退出码非 0 才算失败。
只输出 JSON，不要 Markdown 代码块，不要解释。`;

/** Build the model input for one stage. */
export function buildPrompt(stage, ctx) {
  switch (stage) {
    case "analyze":
      return {
        system: ANALYZE_SYSTEM,
        prompt: [
          `需求文档（${ctx.requirementFilename || "未命名"}）：`,
          "----- 需求开始 -----",
          ctx.requirementText.slice(0, 12000),
          "----- 需求结束 -----",
          "",
          "输出 JSON：",
          '{"function_points":[{"name":"功能点名称","module":"所属模块","description":"一句话说明","priority":"高|中|低"}]}',
          "要求：function_points 非空、名称去重、只写文档里真实存在的功能。",
        ].join("\n"),
      };
    case "design":
      return {
        system: DESIGN_SYSTEM,
        prompt: [
          "功能点：",
          JSON.stringify(ctx.functionPoints, null, 2),
          "",
          "输出 JSON：",
          '{"cases":[{"title":"用例标题（唯一）","function_point":"对应功能点名称","steps":["1. ...","2. ..."],"expected":"可判定的期望结果","priority":"高|中|低","scene":"正向|异常|边界","case_type":"功能|接口|性能"}]}',
          "要求：每个功能点至少 1 条；标题不得重复；steps 至少 1 条且可执行。",
        ].join("\n"),
      };
    case "author":
      return {
        system: AUTHOR_SYSTEM,
        prompt: [
          ctx.targetUrl
            ? `被测应用地址：${ctx.targetUrl}（e2e 脚本首行必须写 \`// @target ${ctx.targetUrl}\`）`
            : "被测应用地址未知：只写 python 脚本，不要写 e2e。",
          "",
          "用例：",
          JSON.stringify(ctx.cases, null, 2),
          "",
          "输出 JSON：",
          '{"scripts":[{"case_title":"对应用例标题","name":"snake_case 文件名（.e2e.ts 或 .py）","language":"e2e|python","content":"完整脚本内容"}]}',
          "要求：每条用例对应一个脚本；content 必须是完整可运行文件，不要占位符。",
        ].join("\n"),
      };
    case "repair":
      return {
        system: REPAIR_SYSTEM,
        prompt: [
          ctx.targetUrl ? `被测应用地址：${ctx.targetUrl}` : "",
          "",
          "失败的脚本及其证据：",
          JSON.stringify(ctx.failures, null, 2),
          "",
          "输出 JSON：",
          '{"patched":[{"scriptId":"脚本 id","scriptName":"脚本名","content":"完整的修复后脚本内容","note":"改了什么、依据哪条失败证据"}]}',
          "要求：content 必须是完整文件（不是 diff）；只修改证据指向的问题；note 必须引用具体失败信息。",
        ]
          .filter(Boolean)
          .join("\n"),
      };
    default:
      return { system: "", prompt: "" };
  }
}

/** Tolerant JSON extraction: models still wrap answers in fences now and then. */
export function parseModelJson(text) {
  const trimmed = String(text ?? "").trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [trimmed, fenced?.[1]?.trim()].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === "object") return value;
    } catch {
      // try the next candidate
    }
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        const value = JSON.parse(candidate.slice(start, end + 1));
        if (value && typeof value === "object") return value;
      } catch {
        // give up on this candidate
      }
    }
  }
  return null;
}
