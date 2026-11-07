'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const plan = require('../lib/plan');

function makePi(replies) {
  const queue = Array.isArray(replies) ? replies.slice() : [];
  const calls = [];
  return {
    calls: calls,
    plugin: {
      getDataPath: function () {
        return fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-data-'));
      },
    },
    agent: {
      complete: async function (request) {
        calls.push(request);
        const next = queue.shift();
        return typeof next === 'function' ? next(request) : next;
      },
    },
  };
}

function baseCtx(pi, extra) {
  return Object.assign(
    {
      pi: pi,
      settings: { mockMode: false },
      dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-root-')),
      // Stand-in for the runner probe: the environment gate must be exercised,
      // but a unit test should not spawn a process.
      runtimes: {
        selfCheck: async function () {
          return { ok: true, detail: 'stub probe' };
        },
      },
    },
    extra || {},
  );
}

function requirementReply() {
  return JSON.stringify({
    features: [
      { id: 'F-01', title: 'Startup', description: 'The unit boots', acceptance: ['boots in 2s'], requirementRefs: ['R-01'] },
      { id: 'F-02', title: 'Shutdown', description: 'The unit stops', acceptance: ['stops cleanly'], requirementRefs: ['R-02'] },
    ],
    gaps: ['No timing budget for shutdown'],
  });
}

function casesReply() {
  return JSON.stringify({
    cases: [
      { title: 'boots', featureId: 'F-01', priority: 'P0', preconditions: [], steps: ['power on'], expected: ['boots'], type: 'functional' },
      { title: 'stops', featureId: 'F-02', priority: 'P2', preconditions: [], steps: ['power off'], expected: ['stops'], type: 'functional' },
    ],
  });
}

test('requirement creates a plan and records features plus gaps', async function () {
  const pi = makePi([requirementReply()]);
  const ctx = baseCtx(pi);
  const result = await plan.requirement(ctx, { action: 'decompose', title: 'Boot plan', source: 'unit shall boot' });
  assert.strictEqual(result.features.length, 2);
  assert.deepStrictEqual(result.gaps, ['No timing budget for shutdown']);
  const state = plan.resolvePlan(ctx, { planId: result.planId }).state;
  assert.strictEqual(state.stages.requirements.status, 'done');
  assert.strictEqual(state.features[0].id, 'F-01');
  assert.strictEqual(state.requirements.length, 2);
});

test('requirement refuses to run without source material', async function () {
  const pi = makePi([]);
  await assert.rejects(
    function () { return plan.requirement(baseCtx(pi), { action: 'decompose', source: '   ' }); },
    function (error) {
      assert.strictEqual(error.code, 'REQUIREMENT_SOURCE_MISSING');
      return true;
    },
  );
});

test('cases is blocked until the requirement stage is done', async function () {
  const pi = makePi([requirementReply()]);
  const ctx = baseCtx(pi);
  const created = await plan.requirement(ctx, { action: 'decompose', title: 'p', source: 'text' });
  const state = plan.resolvePlan(ctx, { planId: created.planId }).state;
  state.stages.requirements.status = 'running';
  const resolved = plan.resolvePlan(ctx, { planId: created.planId });
  require('../lib/store').setStage(resolved.dir, resolved.state, 'requirements', { status: 'running' });
  await assert.rejects(
    function () { return plan.cases(ctx, { planId: created.planId }); },
    function (error) {
      assert.strictEqual(error.code, 'STAGE_BLOCKED');
      return true;
    },
  );
});

test('cases assigns stable ids and asks for review', async function () {
  const pi = makePi([requirementReply(), casesReply()]);
  const ctx = baseCtx(pi);
  const created = await plan.requirement(ctx, { action: 'decompose', title: 'p', source: 'text' });
  const result = await plan.cases(ctx, { planId: created.planId });
  assert.deepStrictEqual(result.cases.map(function (c) { return c.id; }), ['TC-001', 'TC-002']);
  assert.strictEqual(result.cases[0].priority, 'P0');
  assert.strictEqual(result.cases.every(function (c) { return c.selected === true; }), true);
  const state = plan.resolvePlan(ctx, { planId: created.planId }).state;
  assert.strictEqual(state.stages.cases.status, 'awaiting_review');
  assert.strictEqual(state.status, 'awaiting_review');
});

test('cases rewrites an unknown feature reference to a real one', async function () {
  const pi = makePi([
    requirementReply(),
    JSON.stringify({ cases: [{ title: 'x', featureId: 'GHOST', priority: 'P1', steps: [], expected: [] }] }),
  ]);
  const ctx = baseCtx(pi);
  const created = await plan.requirement(ctx, { action: 'decompose', title: 'p', source: 'text' });
  const result = await plan.cases(ctx, { planId: created.planId });
  assert.strictEqual(result.cases[0].featureId, 'F-01');
});

test('author refuses while the review gate is closed', async function () {
  const pi = makePi([requirementReply(), casesReply()]);
  const ctx = baseCtx(pi);
  const created = await plan.requirement(ctx, { action: 'decompose', title: 'p', source: 'text' });
  await plan.cases(ctx, { planId: created.planId });
  const resolved = plan.resolvePlan(ctx, { planId: created.planId });
  // cases done but no approval recorded: the stage check passes, the gate must still refuse.
  require('../lib/store').setStage(resolved.dir, resolved.state, 'cases', { status: 'done' });
  await assert.rejects(
    function () { return plan.author(ctx, { planId: created.planId }); },
    function (error) {
      assert.strictEqual(error.code, 'REVIEW_GATE_CLOSED');
      return true;
    },
  );
});

test('approval opens the gate and author writes one script per selected case', async function () {
  const pi = makePi([
    requirementReply(),
    casesReply(),
    JSON.stringify({ language: 'javascript', script: 'console.log(1);\n', command: null, notes: null }),
    JSON.stringify({ language: 'javascript', script: 'console.log(2);\n', command: null, notes: null }),
  ]);
  const ctx = baseCtx(pi);
  const created = await plan.requirement(ctx, { action: 'decompose', title: 'p', source: 'text' });
  await plan.cases(ctx, { planId: created.planId });
  plan.approveCaseSet(ctx, { planId: created.planId, actor: 'reviewer' });
  const result = await plan.author(ctx, { planId: created.planId });
  assert.strictEqual(result.scripts.length, 2);
  assert.strictEqual(result.scripts[0].testCaseId, 'TC-001');
  assert.strictEqual(result.scripts[0].lines, 2);
});

test('approval records edits, bumps revision and keeps the gate closed on stale edits', async function () {
  const pi = makePi([requirementReply(), casesReply()]);
  const ctx = baseCtx(pi);
  const created = await plan.requirement(ctx, { action: 'decompose', title: 'p', source: 'text' });
  await plan.cases(ctx, { planId: created.planId });
  // Editing and approving in one call is refused: the edited row has content no
  // reviewer has seen yet, so the approval is dropped and the gate stays shut.
  plan.approveCaseSet(ctx, { planId: created.planId, cases: [{ id: 'TC-001', title: 'boots (edited)' }] });
  let state = plan.resolvePlan(ctx, { planId: created.planId }).state;
  assert.strictEqual(state.cases[0].title, 'boots (edited)');
  assert.strictEqual(state.cases[0].revision, 2);
  assert.strictEqual(state.cases[0].approvedRevision, null);
  assert.strictEqual(require('../lib/stages').reviewGate(state).ok, false);
  // Approving the edited row on its own call opens the gate.
  plan.approveCaseSet(ctx, { planId: created.planId });
  state = plan.resolvePlan(ctx, { planId: created.planId }).state;
  assert.strictEqual(state.cases[0].approvedRevision, 2);
  assert.strictEqual(require('../lib/stages').reviewGate(state).ok, true);
});

test('rejecting a case set closes the gate again', async function () {
  const pi = makePi([requirementReply(), casesReply()]);
  const ctx = baseCtx(pi);
  const created = await plan.requirement(ctx, { action: 'decompose', title: 'p', source: 'text' });
  await plan.cases(ctx, { planId: created.planId });
  const result = plan.approveCaseSet(ctx, { planId: created.planId, decision: 'rejected' });
  assert.strictEqual(result.decision, 'rejected');
  const state = plan.resolvePlan(ctx, { planId: created.planId }).state;
  assert.strictEqual(state.stages.cases.status, 'failed');
  assert.strictEqual(require('../lib/stages').reviewGate(state).ok, false);
});

test('select changes only the listed cases', async function () {
  const pi = makePi([requirementReply(), casesReply()]);
  const ctx = baseCtx(pi);
  const created = await plan.requirement(ctx, { action: 'decompose', title: 'p', source: 'text' });
  await plan.cases(ctx, { planId: created.planId });
  const result = await plan.select(ctx, { planId: created.planId, testCaseIds: ['TC-002'] });
  assert.strictEqual(result.selectedCases, 1);
  assert.strictEqual(result.coverage.covered, 1);
  assert.deepStrictEqual(result.coverage.missing, ['F-01']);
});

test('select rejects an empty id list', async function () {
  const pi = makePi([requirementReply(), casesReply()]);
  const ctx = baseCtx(pi);
  const created = await plan.requirement(ctx, { action: 'decompose', title: 'p', source: 'text' });
  await plan.cases(ctx, { planId: created.planId });
  await assert.rejects(
    function () { return plan.select(ctx, { planId: created.planId, testCaseIds: [] }); },
    function (error) {
      assert.strictEqual(error.code, 'SELECTION_EMPTY');
      return true;
    },
  );
});

test('run is blocked before approval and executes after it', async function () {
  const pi = makePi([
    requirementReply(),
    casesReply(),
    JSON.stringify({ language: 'javascript', script: 'void 0;', command: null }),
    JSON.stringify({ language: 'javascript', script: 'process.exit(1);', command: null }),
  ]);
  const ctx = baseCtx(pi);
  const created = await plan.requirement(ctx, { action: 'decompose', title: 'p', source: 'text' });
  await plan.cases(ctx, { planId: created.planId });
  await assert.rejects(
    function () { return plan.run(ctx, { planId: created.planId }); },
    function (error) {
      assert.strictEqual(error.code, 'STAGE_BLOCKED');
      return true;
    },
  );
  plan.approveCaseSet(ctx, { planId: created.planId });
  await plan.author(ctx, { planId: created.planId });
  const result = await plan.run(ctx, { planId: created.planId });
  assert.strictEqual(result.summary.total, 2);
  assert.strictEqual(result.summary.passed, 1);
  assert.strictEqual(result.summary.failed, 1);
  const state = plan.resolvePlan(ctx, { planId: created.planId }).state;
  assert.strictEqual(state.status, 'partial');
});

test('diagnose classifies the last run and keeps a narrative', async function () {
  const pi = makePi([
    requirementReply(),
    casesReply(),
    JSON.stringify({ language: 'javascript', script: "console.error('ECONNREFUSED 10.0.0.9:22'); process.exit(1);", command: null }),
    JSON.stringify({ language: 'javascript', script: 'void 0;', command: null }),
    'The rig refused the connection, so this is not a script defect.',
  ]);
  const ctx = baseCtx(pi);
  const created = await plan.requirement(ctx, { action: 'decompose', title: 'p', source: 'text' });
  await plan.cases(ctx, { planId: created.planId });
  plan.approveCaseSet(ctx, { planId: created.planId });
  await plan.author(ctx, { planId: created.planId });
  await plan.run(ctx, { planId: created.planId });
  const result = await plan.diagnoseTool(ctx, { planId: created.planId });
  assert.strictEqual(result.counts.environment, 1);
  assert.strictEqual(result.blocking.length, 1);
  assert.strictEqual(result.repairAllowed, false);
  assert.match(result.narrative, /not a script defect/);
});

test('diagnose is blocked before a run exists', async function () {
  const pi = makePi([requirementReply(), casesReply()]);
  const ctx = baseCtx(pi);
  const created = await plan.requirement(ctx, { action: 'decompose', title: 'p', source: 'text' });
  await plan.cases(ctx, { planId: created.planId });
  plan.approveCaseSet(ctx, { planId: created.planId });
  await assert.rejects(
    function () { return plan.diagnoseTool(ctx, { planId: created.planId }); },
    function (error) {
      assert.strictEqual(error.code, 'STAGE_BLOCKED');
      return true;
    },
  );
});

test('report writes report.md next to the state', async function () {
  const pi = makePi([requirementReply(), casesReply()]);
  const ctx = baseCtx(pi);
  const created = await plan.requirement(ctx, { action: 'decompose', title: 'p', source: 'text' });
  await plan.cases(ctx, { planId: created.planId });
  plan.approveCaseSet(ctx, { planId: created.planId });
  const result = await plan.reportTool(ctx, { planId: created.planId });
  assert.ok(fs.existsSync(result.file));
  const text = fs.readFileSync(result.file, 'utf8');
  assert.match(text, /# p/);
  assert.match(text, /Review gate: (open|closed)/);
});

test('status lists plans when no id is given', async function () {
  const pi = makePi([requirementReply()]);
  const ctx = baseCtx(pi);
  await plan.requirement(ctx, { action: 'decompose', title: 'listed', source: 'text' });
  const result = await plan.status(ctx, {});
  assert.strictEqual(result.plans.length, 1);
  assert.strictEqual(result.plans[0].title, 'listed');
});

test('renderer actions are allow-listed', async function () {
  const pi = makePi([]);
  const ctx = baseCtx(pi);
  await assert.rejects(
    function () { return plan.callRendererAction(ctx, 'run', { planId: 'x' }); },
    function (error) {
      assert.strictEqual(error.code, 'RENDERER_ACTION_UNSUPPORTED');
      return true;
    },
  );
});

test('renderer reveal explains that there is nothing yet', async function () {
  const pi = makePi([requirementReply()]);
  const ctx = baseCtx(pi);
  const created = await plan.requirement(ctx, { action: 'decompose', title: 'p', source: 'text' });
  await assert.rejects(
    function () { return plan.callRendererAction(ctx, 'reveal', { planId: created.planId, file: 'report' }); },
    function (error) {
      assert.strictEqual(error.code, 'NOTHING_TO_REVEAL');
      return true;
    },
  );
});

test('a model reply that is not JSON surfaces MODEL_OUTPUT_INVALID', async function () {
  const pi = makePi(['I will not do that']);
  await assert.rejects(
    function () { return plan.requirement(baseCtx(pi), { action: 'decompose', source: 'text' }); },
    function (error) {
      assert.strictEqual(error.code, 'MODEL_OUTPUT_INVALID');
      return true;
    },
  );
});

test('mock mode runs the whole rail without touching the model', async function () {
  const pi = makePi([]);
  const ctx = baseCtx(pi, { settings: { mockMode: true } });
  const created = await plan.requirement(ctx, { action: 'decompose', title: 'mock', source: 'text' });
  await plan.cases(ctx, { planId: created.planId });
  plan.approveCaseSet(ctx, { planId: created.planId });
  await plan.author(ctx, { planId: created.planId });
  const runResult = await plan.run(ctx, { planId: created.planId });
  assert.strictEqual(runResult.summary.total, 1);
  await plan.diagnoseTool(ctx, { planId: created.planId });
  const final = await plan.reportTool(ctx, { planId: created.planId });
  assert.ok(final.file);
  assert.strictEqual(pi.calls.length, 0);
});
test('a dead runtime fails the requirement stage before any model call', async function () {
  const pi = makePi([requirementReply()]);
  const ctx = baseCtx(pi, {
    runtimes: {
      selfCheck: async function () {
        return { ok: false, detail: 'spawn ENOENT' };
      },
    },
  });
  await assert.rejects(
    function () {
      return plan.requirement(ctx, { action: 'decompose', title: 'p', source: 'text' });
    },
    function (error) {
      assert.strictEqual(error.code, 'ENVIRONMENT_UNAVAILABLE');
      assert.match(error.message, /spawn ENOENT/);
      return true;
    },
  );
  assert.strictEqual(pi.calls.length, 0, 'no model call may happen after a failed environment gate');
});
