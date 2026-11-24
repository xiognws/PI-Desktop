/**
 * 端点自报容量的解析契约（model-discovery 的纯函数面）。
 *
 * 背景：changan/wk 这类私有网关在 /models 行上用字符串上报容量
 * （`"context_length": "256K"` / `"1000K"`），旧解析器只认 number，
 * 这些端点自动解析上下文窗口的链路整条断掉、全部落到 128K 兜底。
 * 这里锁住两件事：字符串容量按十进制倍数入账（低估是安全方向——
 * 预算会先于真实窗口触发压缩，而不是把请求推出真实窗口）；
 * 解析不了的值依旧「什么都不猜」。
 */

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { register } from "node:module";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "..", "..", "test", "helpers", "ts-import-hooks.mjs")));

const { normalizeModelList, reportedModelLimits } = await import(
  "../../electron/main/model-discovery.ts"
);

test("端点自报的字符串容量按十进制入账", () => {
  assert.deepEqual(
    reportedModelLimits({ id: "9554", context_length: "256K" }),
    { contextWindow: 256_000 },
  );
  assert.deepEqual(
    reportedModelLimits({ id: "12039", context_length: "1000K" }),
    { contextWindow: 1_000_000 },
  );
  assert.deepEqual(reportedModelLimits({ id: "m", context_window: "1M" }), {
    contextWindow: 1_000_000,
  });
  assert.deepEqual(reportedModelLimits({ id: "m", contextWindow: "256k" }), {
    contextWindow: 256_000,
  });
  assert.deepEqual(reportedModelLimits({ id: "m", max_tokens: "32K" }), {
    maxTokens: 32_000,
  });
  assert.deepEqual(reportedModelLimits({ id: "m", context_window: "131,072" }), {
    contextWindow: 131_072,
  });
});

test("数值路径行为不变", () => {
  assert.deepEqual(
    reportedModelLimits({ id: "m", context_window: 262_144, max_tokens: 8_192 }),
    { contextWindow: 262_144, maxTokens: 8_192 },
  );
});

test("解析不了的值什么都不猜", () => {
  for (const garbage of ["abc", "0K", "", "  ", "2.5M", "1e6", "K", "-256K"]) {
    assert.deepEqual(
      reportedModelLimits({ id: "m", context_window: garbage }),
      {},
      `expected nothing for ${JSON.stringify(garbage)}`,
    );
  }
  assert.deepEqual(reportedModelLimits({ id: "m" }), {});
});

test("同排多个键时第一个能解析的容量获胜", () => {
  assert.deepEqual(
    reportedModelLimits({
      id: "m",
      context_window: "not-a-number",
      context_length: "256K",
    }),
    { contextWindow: 256_000 },
  );
});

test("normalizeModelList 把字符串容量带进发现行", () => {
  const rows = normalizeModelList("openai", {
    data: [
      { id: "9554", context_length: "256K" },
      { id: "8859", context_length: "1000K", max_tokens: "32K" },
      { id: "broken", context_length: "many" },
    ],
  });
  const byId = new Map(rows.map((row) => [row.modelId, row]));
  assert.equal(byId.get("9554").contextWindow, 256_000);
  assert.equal(byId.get("8859").contextWindow, 1_000_000);
  assert.equal(byId.get("8859").maxTokens, 32_000);
  assert.equal(byId.get("broken").contextWindow, undefined);
});
