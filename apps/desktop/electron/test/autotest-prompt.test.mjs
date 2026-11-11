/**
 * `electron/autotest/prompt.ts` 的单元测试。
 *
 * 只验证可判定的部分：按钮顺序/默认值、状态与失败原因的呈现、应答解析。
 * 真正的弹窗属于 Electron 运行时，这里注入假的 `showMessageBox`。
 */

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { register } from "node:module";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "..", "..", "test", "helpers", "ts-import-hooks.mjs")));

const { AUTOTEST_CLOSE_RESPONSE, AUTOTEST_RETRY_RESPONSE, askAutotestRetry, autotestUnavailableDialog, recoverAutotestWorkbench } =
  await import("../autotest/prompt.ts");

const LABELS = {
  unavailableTitle: "Autotest Workbench Unavailable",
  unavailableMessage: "The local Autotest service is not ready (status: {status}).",
  unavailableDetail: "The backend did not answer /api/health.",
  retry: "Retry Start",
  close: "Close",
};

test("dialog states the status and offers retry as the default action", () => {
  const options = autotestUnavailableDialog(LABELS, { status: "starting", error: "" });
  assert.equal(options.type, "warning");
  assert.equal(options.title, "Autotest Workbench Unavailable");
  assert.match(options.message, /status: starting/);
  assert.doesNotMatch(options.message, /\{status\}/);
  assert.equal(options.detail, LABELS.unavailableDetail);
  assert.deepEqual(options.buttons, ["Close", "Retry Start"]);
  assert.equal(options.defaultId, AUTOTEST_RETRY_RESPONSE);
  assert.equal(options.cancelId, AUTOTEST_CLOSE_RESPONSE);
  assert.equal(options.noLink, true);
});

test("failure reason is appended to the detail so the user can act on it", () => {
  const options = autotestUnavailableDialog(LABELS, {
    status: "failed",
    error: "python runtime not found (resources/python or PI_DESKTOP_PYTHON)",
  });
  assert.match(options.message, /status: failed/);
  assert.ok(options.detail.includes(LABELS.unavailableDetail));
  assert.ok(options.detail.includes("python runtime not found"));
});

test("askAutotestRetry maps the retry button to true and close to false", async () => {
  const seen = [];
  const retry = await askAutotestRetry(
    {
      showMessageBox: async (options) => {
        seen.push(options);
        return { response: AUTOTEST_RETRY_RESPONSE };
      },
    },
    LABELS,
    { status: "stopped" },
  );
  assert.equal(retry, true);
  assert.equal(seen.length, 1);
  assert.match(seen[0].message, /status: stopped/);

  const dismissed = await askAutotestRetry(
    { showMessageBox: async () => ({ response: AUTOTEST_CLOSE_RESPONSE }) },
    LABELS,
    { status: "stopped" },
  );
  assert.equal(dismissed, false);
});

test("closing the prompt never restarts the service", async () => {
  let restarts = 0;
  let opened = 0;
  const prompts = [];
  await recoverAutotestWorkbench(
    {
      showMessageBox: async (options) => {
        prompts.push(options);
        return { response: AUTOTEST_CLOSE_RESPONSE };
      },
      state: () => ({ status: "failed", error: "boom" }),
      restart: async () => {
        restarts += 1;
      },
      onReady: () => {
        opened += 1;
      },
    },
    LABELS,
    { status: "failed", error: "boom" },
  );
  assert.equal(prompts.length, 1);
  assert.equal(restarts, 0);
  assert.equal(opened, 0);
});

test("retry restarts once and opens the workbench when the service comes up", async () => {
  let restarts = 0;
  let opened = 0;
  let ready = false;
  await recoverAutotestWorkbench(
    {
      showMessageBox: async () => ({ response: AUTOTEST_RETRY_RESPONSE }),
      state: () => ({ status: ready ? "ready" : "failed", error: ready ? "" : "boom" }),
      restart: async () => {
        restarts += 1;
        ready = true;
      },
      onReady: () => {
        opened += 1;
      },
    },
    LABELS,
    { status: "stopped", error: "" },
  );
  assert.equal(restarts, 1);
  assert.equal(opened, 1);
});

test("a failed restart asks again with the new reason instead of giving up silently", async () => {
  const prompts = [];
  let restarts = 0;
  const errors = ["python runtime not found", "backend did not answer /api/health"];
  await recoverAutotestWorkbench(
    {
      showMessageBox: async (options) => {
        prompts.push(options);
        // 第一次重试，第二次放弃。
        return { response: prompts.length === 1 ? AUTOTEST_RETRY_RESPONSE : AUTOTEST_CLOSE_RESPONSE };
      },
      state: () => ({ status: "failed", error: errors[Math.min(restarts, errors.length - 1)] }),
      restart: async () => {
        restarts += 1;
      },
      onReady: () => {
        throw new Error("must not open a window when the service is still down");
      },
    },
    LABELS,
    { status: "failed", error: errors[0] },
  );
  assert.equal(restarts, 1);
  assert.equal(prompts.length, 2);
  assert.ok(prompts[0].detail.includes(errors[0]));
  assert.ok(prompts[1].detail.includes(errors[1]));
});
