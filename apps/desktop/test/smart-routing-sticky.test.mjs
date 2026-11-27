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
