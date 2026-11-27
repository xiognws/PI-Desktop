/**
 * The router keeps a sticky main turn after a cheap turn failed. That safety net is the
 * only thing between a stuck free model and a burned turn: the routing rules decide before
 * dispatch, so a cheap turn that errors has to be able to say "next one is on the strong
 * half".
 *
 * Today's live sessions suggest it never fired: six consecutive sub turns in one session,
 * two of which ended `error`/`aborted`, and not one `sticky-main` route in the log. This
 * pins the behaviour so the claim is measured rather than argued.
 */
import assert from "node:assert/strict";
import test from "node:test";

const { createSmartRouting } = await import("../electron/main/runtime/smart-routing.ts");

const SESSION = "s-1";
const logger = { app() {} };

const smartMode = {
  templateId: "default",
  main: { providerId: "p-main", modelId: "strong" },
  sub: { providerId: "p-sub", modelId: "cheap" },
  policy: {
    delegateToSub: true,
    turnRouting: true,
    stickyMainTurns: 1,
    escalateAfterToolErrors: 2,
    escalateAfterBudgetUsed: 0.6,
    mainPromptChars: 1800,
    simplePromptChars: 600,
  },
};

const providers = [
  {
    id: "p-main",
    enabled: true,
    baseUrl: "http://main",
    models: [{ id: "strong" }],
    authKind: "none",
  },
  {
    id: "p-sub",
    enabled: true,
    baseUrl: "http://sub",
    models: [{ id: "cheap" }],
    authKind: "none",
  },
];

const plan = (routing, messageCount = 3) =>
  routing.planTurn({
    sessionId: SESSION,
    smartMode,
    providers,
    prompt: "继续",
    attachments: 0,
    stagedMode: false,
    messageCount,
  });

test("a cheap turn that failed keeps the next turn on the strong half", () => {
  const routing = createSmartRouting({ logger });
  assert.equal(plan(routing).tier, "sub", "a short follow-up starts cheap");

  routing.observeEvent({ sessionId: SESSION, event: { type: "tool_start" } });
  routing.observeEvent({ sessionId: SESSION, event: { type: "error" } });
  routing.observeEvent({ sessionId: SESSION, event: { type: "turn_end" } });

  const next = plan(routing);
  assert.equal(next.tier, "main", "the failure must not be routed back to the cheap half");
  assert.equal(next.reason, "sticky-main");
});

test("a cheap turn that answered nothing also keeps the next turn on the strong half", () => {
  const routing = createSmartRouting({ logger });
  assert.equal(plan(routing).tier, "sub");

  // A silent turn: no assistant text, no tools, and it closed.
  routing.observeEvent({ sessionId: SESSION, event: { type: "turn_end" } });

  const next = plan(routing);
  assert.equal(next.tier, "main");
  assert.equal(next.reason, "sticky-main");
});

test("one good cheap turn spends the sticky turn", () => {
  const routing = createSmartRouting({ logger });
  plan(routing);
  routing.observeEvent({ sessionId: SESSION, event: { type: "error" } });
  routing.observeEvent({ sessionId: SESSION, event: { type: "turn_end" } });

  assert.equal(plan(routing).reason, "sticky-main");
  assert.equal(plan(routing).tier, "sub", "and then the pair is back to cheap");
});

test("the owed sticky turn survives a restart", async () => {
  // The live case: the cheap turn failed at 09:01, the app restarted at 10:40, and the
  // next turn went cheap again because the memory was a Map. A restart is exactly when a
  // turn has just died, so this is the one moment the memory has to be on disk.
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "smart-routing-"));
  const statePath = join(dir, "smart-routing.json");
  try {
    const before = createSmartRouting({ logger, statePath });
    assert.equal(plan(before).tier, "sub");
    before.observeEvent({ sessionId: SESSION, event: { type: "tool_start" } });
    before.observeEvent({ sessionId: SESSION, event: { type: "error" } });
    before.observeEvent({ sessionId: SESSION, event: { type: "turn_end" } });
    before.flush();

    const written = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(written.sessions[SESSION].stickyMain, 1);
    assert.equal(written.sessions[SESSION].previousTurnSteps, 1);

    // A new process: fresh router, same file.
    const after = createSmartRouting({ logger, statePath });
    const next = plan(after);
    assert.equal(next.tier, "main", "the restart must not erase an owed strong turn");
    assert.equal(next.reason, "sticky-main");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a long turn keeps the next one supervised", () => {
  // 758 steps once ran on the cheap half because the follow-up prompt was "继续".
  const routing = createSmartRouting({ logger });
  plan(routing);
  for (let index = 0; index < 60; index += 1) {
    routing.observeEvent({ sessionId: SESSION, event: { type: "tool_start" } });
  }
  routing.observeEvent({ sessionId: SESSION, event: { type: "message_end", message: { role: "assistant", content: "done" } } });
  routing.observeEvent({ sessionId: SESSION, event: { type: "turn_end" } });

  const next = plan(routing);
  assert.equal(next.tier, "main");
  assert.equal(next.reason, "work-followup");
});
