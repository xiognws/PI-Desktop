/*
 * Session token totals in the status bar.
 *
 * The number has to cover the whole session, so it comes from the host's turn
 * ledger: the renderer's transcript window is bounded and a session's earliest
 * turns leave it. These tests pin what the bar adds up, how it is wired, and
 * that every locale names it.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { compactTokens, sessionTokensUsed } from "../src/lib/status-bar.ts";

const read = (rel) => readFile(new URL(rel, import.meta.url), "utf8");

const LOCALES = ["en", "de", "es", "fr", "ko", "pt-BR", "tr", "zh-CN", "zh-TW"];
const KEYS = [
  "tokens",
  "tokenInput",
  "tokenOutput",
  "tokenCacheRead",
  "tokenCacheWrite",
  "tokenReasoning",
  "tokenTurns",
];

test("a session total is every bucket the provider processed", () => {
  assert.equal(
    sessionTokensUsed({
      inputTokens: 120,
      outputTokens: 30,
      cacheReadTokens: 400,
      cacheWriteTokens: 50,
    }),
    600,
  );
  assert.equal(
    sessionTokensUsed({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    }),
    0,
  );
  // A malformed bucket cannot poison the total into NaN.
  assert.equal(
    sessionTokensUsed({
      inputTokens: -5,
      outputTokens: Number.NaN,
      cacheReadTokens: 10,
      cacheWriteTokens: 0,
    }),
    10,
  );
  // Reasoning is already inside the output count; adding it would double-count.
  assert.equal(
    sessionTokensUsed({
      inputTokens: 1,
      outputTokens: 9,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 9,
    }),
    10,
  );
});

test("a session total is compacted like every other token number", () => {
  assert.equal(compactTokens(842), "842");
  assert.equal(compactTokens(42_100), "42.1k");
  assert.equal(compactTokens(1_240_000), "1.2M");
});

test("the total comes from the host ledger, not from the loaded transcript", async () => {
  const protocol = await read("../../../packages/shared/src/protocol.ts");
  const ipc = await read("../electron/main/ipc/session-ipc.ts");
  const api = await read("../src/lib/api.ts");
  const bar = await read("../src/components/StatusBarUsage.tsx");
  const rust = await read("../../../crates/host-core/src/sessions/usage.rs");
  const rustRpc = await read("../../../crates/host-core/src/rpc/mod.rs");
  const sessions = await read("../../../crates/host-core/src/sessions.rs");

  assert.match(protocol, /sessionUsageTotals: "pi-desktop\/session\/usageTotals"/);
  assert.match(
    ipc,
    /handle\(IPC\.invoke\.sessionUsageTotals[\s\S]{0,300}host\.call\("session\.usageTotals", \{ sessionId \}\)/,
  );
  assert.match(ipc, /sessionUsageTotals expects a sessionId/);
  assert.match(
    api,
    /sessionUsageTotals: \(sessionId: string\) =>[\s\S]{0,140}IPC\.invoke\.sessionUsageTotals/,
  );

  assert.match(rust, /pub fn session_totals\(db: &Database, session_id: &str\)/);
  assert.match(rust, /FROM turns WHERE session_id = \?1/);
  assert.match(sessions, /pub use usage::session_totals;/);
  assert.match(rustRpc, /"session\.usageTotals" =>[\s\S]{0,400}sessions::session_totals/);

  assert.match(bar, /api\.sessionUsageTotals\(sessionId\)/);
  assert.match(bar, /const used = sessionTokensUsed\(totals\);/);
  assert.match(bar, /s\.activeSessionId \? s\.runningSessions\[s\.activeSessionId\] : false/);
  // A windowed transcript must never be the source of a whole-session number.
  assert.doesNotMatch(bar, /messages\.(reduce|filter|map)/);
});

test("the bar item can be hidden like every other one", async () => {
  const sidebar = await read("../src/components/Sidebar.tsx");
  assert.match(sidebar, /StatusBarTokens,/);
  assert.match(sidebar, /\{ id: "tokens", label: t\("statusBar\.tokens"\) \}/);
  assert.match(
    sidebar,
    /statusBarPrefs\.hidden\.includes\("tokens"\) \? null : <StatusBarTokens \/>/,
  );
});

test("every locale names the total and its breakdown", async () => {
  for (const locale of LOCALES) {
    const catalog = await read(`../../../packages/i18n/src/locales/${locale}/index.ts`);
    for (const key of KEYS) {
      assert.match(catalog, new RegExp(`"?${key}"?:`), `${locale} is missing statusBar.${key}`);
    }
  }
});
