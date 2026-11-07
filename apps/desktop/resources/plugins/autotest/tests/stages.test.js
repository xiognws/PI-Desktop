'use strict';
const test = require('node:test');
const assert = require('node:assert');

const stages = require('../lib/stages');

function makeState() {
  return {
    stages: {
      requirements: { status: 'idle' },
      cases: { status: 'idle' },
      scripts: { status: 'idle' },
      run: { status: 'idle' },
      verdict: { status: 'idle' },
      report: { status: 'idle' },
    },
    features: [],
    cases: [],
    scripts: [],
    runs: [],
    approvals: [],
  };
}

function approveCases(state) {
  state.approvals.push({ kind: 'cases', decision: 'approved', at: 'now' });
  state.stages.cases.status = 'done';
}

test('blockReason demands the predecessor stage', function () {
  const state = makeState();
  assert.strictEqual(stages.blockReason(state, 'requirements'), null);
  assert.match(stages.blockReason(state, 'cases'), /case set has not been generated yet/);
  assert.match(stages.blockReason(state, 'nope'), /unknown stage/);
});

test('blockReason skips a completed or skipped predecessor', function () {
  const state = makeState();
  state.stages.requirements.status = 'skipped';
  assert.strictEqual(stages.blockReason(state, 'cases'), null);
});

test('the run stage is blocked until a case set is approved', function () {
  const state = makeState();
  state.stages.requirements.status = 'done';
  state.stages.cases.status = 'done';
  state.stages.scripts.status = 'done';
  state.cases = [{ id: 'TC-001', selected: true, revision: 1 }];
  assert.match(stages.blockReason(state, 'run'), /not been approved yet|no approved case set/);
  approveCases(state);
  assert.strictEqual(stages.blockReason(state, 'run'), null);
});

test('the gate reopens when a case is edited after approval', function () {
  const state = makeState();
  state.cases = [{ id: 'TC-001', selected: true, revision: 2, approvedRevision: 1 }];
  approveCases(state);
  const gate = stages.reviewGate(state);
  assert.strictEqual(gate.ok, false);
  assert.match(gate.reason, /edited after approval/);
});

test('the gate rejects a case set awaiting review', function () {
  const state = makeState();
  state.cases = [{ id: 'TC-001', selected: true, revision: 1 }];
  state.approvals.push({ kind: 'cases', decision: 'approved', at: 'now' });
  state.stages.cases.status = 'awaiting_review';
  assert.match(stages.reviewGate(state).reason, /still awaiting review/);
});

test('the gate rejects an empty selection', function () {
  const state = makeState();
  state.cases = [{ id: 'TC-001', selected: false, revision: 1 }];
  approveCases(state);
  assert.match(stages.reviewGate(state).reason, /deselected/);
});

test('coverage counts only selected cases', function () {
  const state = makeState();
  state.features = [{ id: 'F-01' }, { id: 'F-02' }];
  state.cases = [
    { id: 'TC-001', featureId: 'F-01', selected: true },
    { id: 'TC-002', featureId: 'F-02', selected: false },
  ];
  const covered = stages.coverage(state);
  assert.strictEqual(covered.total, 2);
  assert.strictEqual(covered.covered, 1);
  assert.deepStrictEqual(covered.missing, ['F-02']);
  assert.strictEqual(covered.ratio, 0.5);
});

test('coverage of no features is zero rather than NaN', function () {
  const state = makeState();
  const covered = stages.coverage(state);
  assert.strictEqual(covered.ratio, 0);
});

test('duplicates normalise case and punctuation', function () {
  const dups = stages.duplicates([
    { id: 'TC-001', title: 'Verify Brake Response' },
    { id: 'TC-002', title: 'verify   brake response!' },
    { id: 'TC-003', title: 'other' },
  ]);
  assert.strictEqual(dups.length, 1);
  assert.strictEqual(dups[0].second, 'TC-002');
});

test('caseBudget clamps both ends', function () {
  assert.strictEqual(stages.caseBudget(0, {}), 8);
  assert.strictEqual(stages.caseBudget(2, {}), 8);
  assert.strictEqual(stages.caseBudget(5, {}), 15);
  assert.strictEqual(stages.caseBudget(1000, {}), 40);
  assert.strictEqual(stages.caseBudget(5, { casesPerFeature: 2, minCases: 3, maxCases: 9 }), 9);
});

test('nextStages walks the rail in order', function () {
  const state = makeState();
  assert.deepStrictEqual(stages.nextStages(state), ['requirements']);
  state.stages.requirements.status = 'done';
  assert.deepStrictEqual(stages.nextStages(state), ['cases']);
  ['requirements', 'cases', 'scripts', 'run', 'verdict', 'report'].forEach(function (stage) {
    state.stages[stage].status = 'done';
  });
  assert.deepStrictEqual(stages.nextStages(state), []);
});
test('stage status is literal: an absent stage is idle, never done', function () {
  const state = makeState();
  delete state.stages.cases;
  assert.strictEqual(stages.stageStatus(state, 'cases'), 'idle');
  assert.strictEqual(stages.stageFinished(state, 'cases'), false);
  assert.match(stages.nextStages(state).join(','), /requirements/);
});

test('rail marks exactly one ready stage and locks the rest', function () {
  const state = makeState();
  state.stages.requirements.status = 'done';
  state.stages.cases.status = 'awaiting_review';
  const view = stages.rail(state);
  assert.strictEqual(view.cursor, 'cases');
  const states = {};
  view.stages.forEach(function (entry) { states[entry.stage] = entry.state; });
  assert.strictEqual(states.requirements, 'done');
  assert.strictEqual(states.cases, 'awaiting_review');
  assert.strictEqual(states.scripts, 'locked');
  const locked = view.stages.find(function (entry) { return entry.stage === 'scripts'; });
  assert.ok(locked.reason);
});

test('environment gate reports a dead runtime with a reason', async function () {
  const dead = await stages.environmentGate({ selfCheck: async function () { return { ok: false, detail: 'spawn ENOENT' }; } }, {});
  assert.strictEqual(dead.ok, false);
  assert.match(dead.reason, /node: spawn ENOENT/);
  const alive = await stages.environmentGate({ selfCheck: async function () { return { ok: true, detail: 'ok' }; } }, {});
  assert.strictEqual(alive.ok, true);
  assert.strictEqual(alive.results.length, 1);
});