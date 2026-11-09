import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

import { readFile } from "node:fs/promises";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const { buildWorklines, worklineDetail, worklineState, WORKLINE_STATE_ORDER } = await import(
  "../src/lib/workline-activity.ts"
);

const sessions = [
  { id: "s1", title: "Refactor the tests" },
  { id: "s2", title: "Write the docs" },
  { id: "s3", title: "Idle session" },
];

function summary(overrides = {}) {
  return {
    sessionId: "s1",
    title: "Refactor the tests",
    status: "running",
    observedAt: "2026-11-09T00:00:00.000Z",
    recentExchanges: [],
    ...overrides,
  };
}

test("a permission prompt outranks a running turn", () => {
  assert.equal(worklineState(true, true, "running"), "waiting");
  assert.equal(worklineState(false, true, undefined), "waiting");
});

test("host status and store running flag both mean running", () => {
  assert.equal(worklineState(true, false, undefined), "running");
  assert.equal(worklineState(false, false, "running"), "running");
});

test("a queued delivery is queued, not running", () => {
  assert.equal(worklineState(false, false, "queued"), "queued");
  assert.equal(worklineState(true, false, "queued"), "queued");
});

test("an idle session is not a workline", () => {
  assert.equal(worklineState(false, false, "completed"), "idle");
  assert.equal(worklineState(false, false, undefined), "idle");
});

test("only busy sessions become worklines", () => {
  const entries = buildWorklines(
    sessions,
    { s1: true },
    {},
    { s1: summary() },
  );
  assert.deepEqual(entries.map((entry) => entry.sessionId), ["s1"]);
  assert.equal(entries[0].state, "running");
});

test("delegation and task text come from the host summary", () => {
  const entries = buildWorklines(
    sessions,
    { s2: true },
    {},
    {
      s2: summary({
        sessionId: "s2",
        createdBySession: { sessionId: "parent", title: "Supervisor" },
        currentTask: { messageId: "m1", senderSession: { sessionId: "parent", title: "Supervisor" }, text: "update the README quick start", status: "running", createdAt: "2026-11-09T00:00:00.000Z" },
      }),
    },
  );
  assert.equal(entries[0].delegatedBy, "Supervisor");
  assert.equal(entries[0].detail, "update the README quick start");
});

test("task detail is collapsed to one bounded line", () => {
  const long = `${"word ".repeat(60)}`;
  const detail = worklineDetail(summary({ currentTask: { messageId: "m", senderSession: { sessionId: "p", title: "p" }, text: `line one\n\n${long}`, status: "running", createdAt: "2026-11-09T00:00:00.000Z" } }));
  assert.ok(detail.startsWith("line one word word"));
  assert.ok(!detail.includes("\n"));
  assert.ok(detail.length <= 121, `detail length ${detail.length}`);
  assert.ok(detail.endsWith("…"));
});

test("blocked worklines sort ahead of busy ones, then by title", () => {
  const entries = buildWorklines(
    sessions,
    { s1: true, s2: true },
    { s2: [{}] },
    {},
  );
  assert.deepEqual(entries.map((entry) => entry.sessionId), ["s2", "s1"]);
  const order = entries.map((entry) => WORKLINE_STATE_ORDER.indexOf(entry.state));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});

test("a session the host has no summary for still lists", () => {
  const entries = buildWorklines(sessions, { s1: true }, {}, {});
  assert.equal(entries.length, 1);
  assert.equal(entries[0].delegatedBy, undefined);
  assert.equal(entries[0].detail, undefined);
});

test("the sidebar strings exist in every shipped locale", async () => {
  const locales = ["en", "zh-CN", "de", "es", "fr", "ko", "pt-BR", "tr", "zh-TW"];
  for (const locale of locales) {
    const source = await readFile(
      new URL(`../../../packages/i18n/src/locales/${locale}/index.ts`, import.meta.url),
      "utf8",
    );
    assert.match(source, /"?worklineTitle"?\s*:/, `${locale} is missing worklineTitle`);
    assert.match(source, /"?worklineActiveCount"?\s*:/, `${locale} is missing worklineActiveCount`);
  }
});
