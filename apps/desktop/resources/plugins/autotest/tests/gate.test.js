const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const test = require('node:test');

const plan = require('../lib/plan');

function dataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-gate-'));
}

function ctxFor(dir) {
  process.env.AUTOTEST_MOCK_MODE = '1';
  return {
    pi: { plugin: { getDataPath: function () { return dir; } }, agent: { complete: async function () { throw new Error('mock mode must not call the model'); } } },
    dataDir: dir,
    settings: { mockMode: true },
    modelKey: 'test',
    runtimes: { selfCheck: async function () { return { ok: true, detail: 'stub probe' }; } },
  };
}

async function planAwaitingReview(dir) {
  const ctx = ctxFor(dir);
  const created = await plan.requirement(ctx, { action: 'decompose', title: 'Gate rig', source: 'The rig reports pressure within 10 ms.' });
  const cases = await plan.cases(ctx, { planId: created.planId });
  return { ctx: ctx, planId: created.planId, cases: cases.cases };
}

test('a plain approval opens the gate', async function () {
  const dir = dataDir();
  const prepared = await planAwaitingReview(dir);
  const approve = plan.approveCaseSet(prepared.ctx, { planId: prepared.planId, actor: 'reviewer' });
  assert.strictEqual(approve.gate.ok, true);
  const status = await plan.status(prepared.ctx, { planId: prepared.planId });
  assert.strictEqual(status.rail.cursor, 'scripts');
});

test('approving the untouched card rows opens the gate', async function () {
  // Regression: the card always posts every row, so bumping a revision on an
  // unchanged row made approval self-defeating and the gate never opened.
  const dir = dataDir();
  const prepared = await planAwaitingReview(dir);
  const rows = prepared.cases.map(function (entry) {
    return {
      id: entry.id,
      title: entry.title,
      priority: entry.priority,
      steps: entry.steps,
      expected: entry.expected,
      selected: true,
    };
  });
  const approve = plan.approveCaseSet(prepared.ctx, { planId: prepared.planId, cases: rows, decision: 'approved', actor: 'reviewer' });
  assert.strictEqual(approve.gate.ok, true, 'unchanged rows must not invalidate the approval');
});

test('editing a row closes the gate until it is approved again', async function () {
  const dir = dataDir();
  const prepared = await planAwaitingReview(dir);
  const first = prepared.cases[0];
  const edited = [{ id: first.id, title: 'renamed by the reviewer', selected: true }];
  const approve = plan.approveCaseSet(prepared.ctx, { planId: prepared.planId, cases: edited, decision: 'approved', actor: 'reviewer' });
  assert.strictEqual(approve.gate.ok, false);
  assert.strictEqual(approve.gate.reason, 'the case set has not been approved yet; review the card and approve it');
  const stored = JSON.parse(fs.readFileSync(path.join(dir, 'plans', prepared.planId, 'state.json'), 'utf8'));
  assert.strictEqual(stored.cases[0].title, 'renamed by the reviewer');
  assert.strictEqual(stored.cases[0].revision, first.revision + 1);
  assert.strictEqual(stored.cases[0].approvedRevision, null);
});

test('rows missing from the card are deselected, not silently approved', async function () {
  const dir = dataDir();
  const prepared = await planAwaitingReview(dir);
  const approve = plan.approveCaseSet(prepared.ctx, { planId: prepared.planId, cases: [], decision: 'approved', actor: 'reviewer' });
  assert.strictEqual(approve.cases, prepared.cases.length);
  assert.strictEqual(approve.selected, prepared.cases.length);
});