import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createSkillReviewService } = await import("../electron/main/skill-review-service.ts");

const WRITE_DECISION = {
  decision: "update",
  reason: "the turn taught a flag that mattered",
  ops: [
    {
      action: "create",
      name: "npm-script",
      content: "---\nname: npm-script\ndescription: Use when adding a script.\n---\n## When to Use\n…\n",
    },
  ],
};

const SKIP_DECISION = { decision: "skip", reason: "one-off", ops: [] };

function harness({ decision = WRITE_DECISION, tidy, tidyThrows = false, completions, sessionMode } = {}) {
  const calls = [];
  const logs = [];
  const prompts = [];
  let completionIndex = 0;
  const host = {
    call: async (method, params) => {
      calls.push({ method, params });
      switch (method) {
        case "skills.list":
          return { skills: [] };
        case "skills.read":
          return { skill: null, body: null };
        case "skills.create":
          return { skill: { id: "npm-script", name: "npm-script" } };
        case "skills.tidy":
          if (tidyThrows) throw new Error("disk on fire");
          return tidy ?? { report: { references_removed: ["npm-script/references/x.md"], bytes_freed: 42 } };
        default:
          return {};
      }
    },
  };

  const review = createSkillReviewService({
    host: () => host,
    logger: { app: (category, level, event, data) => logs.push({ category, level, event, data }) },
    settings: async () => ({ defaultProviderId: "p", defaultModelId: "m" }),
    session: async () => ({
      projectPath: "/tmp/workspace",
      providerId: "p",
      modelId: "m",
      ...(sessionMode ? { mode: sessionMode } : {}),
      messages: [
        { role: "user", content: "add a npm script for the build" },
        { role: "assistant", content: "added it" },
      ],
    }),
    resolveLaunch: async () => ({
      providerId: "p",
      sidecarParams: {
        provider: { authKind: "api_key", baseUrl: "http://127.0.0.1:1", model: "m" },
        thinkingLevel: "off",
      },
    }),
    vendorOAuth: { resolveAuth: async () => "" },
    complete: async (_provider, context) => {
      prompts.push(context.messages.map((message) => String(message.content)).join("\n"));
      const next = completions?.[completionIndex++];
      return { text: next ?? JSON.stringify(decision) };
    },
    now: () => 1_000_000,
  });

  // No `mode`: the real scheduler sends only the turn's facts, which is exactly
  // why the mode gate needs the session.
  const run = (overrides = {}) =>
    review.run({ sessionId: "session-1", usedTools: true, toolCallCount: 5, ...overrides });
  return { run, schedule: (request) => review.schedule(request), calls, logs, prompts };
}

test("a review that wrote consolidates the library", async () => {
  const { run, calls, logs } = harness();
  const applied = await run();

  assert.equal(applied, 1, "one op was applied");
  const methods = calls.map((call) => call.method);
  assert.ok(methods.includes("skills.create"), "the review still writes through skills.*");
  assert.ok(methods.includes("skills.tidy"), "the pass runs right after a write");

  const tidy = logs.find((entry) => entry.event === "skill library tidied");
  assert.ok(tidy, "the tidy is observable, not silent");
  assert.deepEqual(tidy.data.data, {
    removed: 1,
    bytesFreed: 42,
    scanned: 0,
    references: 0,
    reported: { unlinked: 0, oversized: 0 },
  });
});

test("a tidy that removed nothing still says it ran", async () => {
  // The pass used to log only when it deleted something, so "ran, found nothing
  // provably redundant" was indistinguishable from "never ran".
  const { run, logs } = harness({
    tidy: {
      report: {
        skills_scanned: 3,
        references_scanned: 9,
        references_removed: [],
        bytes_freed: 0,
        unlinked: ["a/references/orphan.md"],
        oversized: [{ id: "b", chars: 9000 }],
      },
    },
  });
  await run();

  const tidy = logs.find((entry) => entry.event === "skill library tidied");
  assert.ok(tidy, "running and finding nothing is still an event");
  assert.deepEqual(tidy.data.data, {
    removed: 0,
    bytesFreed: 0,
    scanned: 3,
    references: 9,
    reported: { unlinked: 1, oversized: 1 },
  });
});

test("a tidy that fails never undoes a review that succeeded", async () => {
  const { run, logs } = harness({ tidyThrows: true });
  const applied = await run();

  assert.equal(applied, 1, "the review's own work stands");
  const failed = logs.find((entry) => entry.event === "skill tidy failed");
  assert.ok(failed);
  assert.equal(failed.level, "warn");
});

test("a review that wrote nothing leaves the library alone", async () => {
  const { run, calls } = harness({ decision: SKIP_DECISION });
  const applied = await run();

  assert.equal(applied, 0);
  assert.ok(
    !calls.some((call) => call.method === "skills.tidy"),
    "nothing was added, so there is nothing to consolidate",
  );
});

test("the pass asks for the conservative default policy", async () => {
  const { run, calls } = harness({
    tidy: { report: { references_removed: ["npm-script/references/x.md"], bytes_freed: 42, dry_run: true } },
  });
  await run();

  const request = calls.find((call) => call.method === "skills.tidy");
  assert.ok(request, "the pass is asked for the conservative default, not a dry run");
  assert.deepEqual(request.params, {});
});

test("a schedule that never reaches the model says why", () => {
  // Both of these gates used to return without a log line, so a turn skipped for
  // having no tools looked exactly like a turn where nothing ran at all.
  const idle = harness();
  idle.schedule({ sessionId: "session-1", usedTools: false, toolCallCount: 0 });
  const noTools = idle.logs.at(-1);
  assert.equal(noTools.event, "skill review skipped");
  assert.equal(noTools.data.data.reason, "no-tools");

  const busy = harness();
  // `schedule` claims the session synchronously, so the second call lands while
  // the first pass is still in flight.
  const request = { sessionId: "session-1", usedTools: true, toolCallCount: 9 };
  busy.schedule(request);
  busy.schedule(request);
  const running = busy.logs.find((entry) => entry.data?.data?.reason === "already-running");
  assert.ok(running, "a pass already in flight for this session is logged");
});

test("a truncated answer is retried with a size cap, not a prose scolding", async () => {
  const truncated =
    '{"decision":"update","reason":"the turn taught a flag","ops":[{"action":"write_file","name":"npm-script","file_path":"references/a.md","content":"# A\\n';
  const { run, logs, prompts } = harness({
    completions: [truncated, JSON.stringify(WRITE_DECISION)],
  });
  const applied = await run();

  const retry = logs.find((entry) => entry.event === "skill review retrying");
  assert.ok(retry);
  assert.equal(retry.data.data.reason, "truncated", "truncation is named as such");
  assert.equal(retry.data.data.chars, truncated.length, "and its size is recorded");

  const retryPrompt = prompts.at(-1);
  assert.match(retryPrompt, /被输出上限截断/);
  assert.match(retryPrompt, /最多 1 个 op/, "the repair is a smaller answer");
  assert.equal(applied, 1, "the retry still lands the write");
});

test("a prose answer still gets the prose repair", async () => {
  const { run, logs, prompts } = harness({
    completions: ["Reading the current file to repair the insertion.", JSON.stringify(SKIP_DECISION)],
  });
  await run();

  const retry = logs.find((entry) => entry.event === "skill review retrying");
  assert.equal(retry.data.data.reason, "no-json");
  assert.match(prompts.at(-1), /不是 JSON/);
});

test("a Plan or Goal session is not reviewed", async () => {
  // The gate reads the session's mode. It used to read only the request, which
  // never carried one, so Plan/Goal turns were reviewed although only Agent
  // executes — Plan and Goal negotiate a contract and share a denial-only tool
  // set, so there is no work in them to learn from.
  const plan = harness({ sessionMode: "plan" });
  assert.equal(await plan.run(), 0);
  const skipped = plan.logs.find((entry) => entry.data?.data?.reason === "mode");
  assert.ok(skipped, "the gate reports itself instead of vanishing");
  assert.equal(skipped.data.data.mode, "plan");
  assert.ok(
    !plan.calls.some((call) => call.method === "skills.create"),
    "and nothing was written off a Plan turn",
  );

  const agent = harness({ sessionMode: "agent" });
  assert.equal(await agent.run(), 1, "an Agent session is still reviewed");

  // An explicit mode on the request still wins over the session's.
  const overridden = harness({ sessionMode: "plan" });
  assert.equal(await overridden.run({ mode: "agent" }), 1);
});
