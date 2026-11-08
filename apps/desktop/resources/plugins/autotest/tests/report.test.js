'use strict';
const test = require('node:test');
const assert = require('node:assert');

const report = require('../lib/report');

function makeState(overrides) {
  return Object.assign(
    {
      id: 'plan-1',
      title: 'Brake regression',
      status: 'running',
      activeStage: 'run',
      stages: {
        requirements: { status: 'done', updatedAt: '2026-01-01T00:00:00.000Z', note: null },
        cases: { status: 'done', updatedAt: null, note: 'reviewed' },
        scripts: { status: 'done', updatedAt: null, note: null },
        run: { status: 'running', updatedAt: null, note: null },
        verdict: { status: 'idle', updatedAt: null, note: null },
        report: { status: 'idle', updatedAt: null, note: null },
      },
      features: [{ id: 'F-01' }],
      cases: [
        { id: 'TC-001', title: 'nominal', featureId: 'F-01', priority: 'P1', selected: true, revision: 1, approvedRevision: 1 },
        { id: 'TC-002', title: 'edge', featureId: 'F-01', priority: 'P2', selected: false, revision: 1, approvedRevision: 1 },
      ],
      scripts: [{ testCaseId: 'TC-001', language: 'javascript', body: 'void 0;' }],
      runs: [],
      verdicts: [],
      approvals: [{ kind: 'cases', decision: 'approved', at: '2026-01-01T00:00:00.000Z', actor: 'me' }],
    },
    overrides || {},
  );
}

test('summarize counts cases, selection and priorities', function () {
  const sum = report.summarize(makeState());
  assert.strictEqual(sum.cases, 2);
  assert.strictEqual(sum.selectedCases, 1);
  assert.deepStrictEqual(sum.priorities, { P1: 1 });
  assert.strictEqual(sum.scripts, 1);
  assert.strictEqual(sum.runnableScripts, 1);
});

test('summarize exposes the gate state', function () {
  const open = report.summarize(makeState());
  assert.strictEqual(open.gate.ok, true);
  const closed = report.summarize(
    makeState({ approvals: [], stages: { requirements: { status: 'done' }, cases: { status: 'idle' } } }),
  );
  assert.strictEqual(closed.gate.ok, false);
  assert.match(closed.gate.reason, /not been approved yet|no approved case set/);
});

test('summarize reports the last run tallies', function () {
  const sum = report.summarize(
    makeState({
      runs: [
        {
          id: 'run-01',
          at: '2026-01-02T00:00:00.000Z',
          results: [{ status: 'passed' }, { status: 'failed' }, { status: 'skipped' }],
        },
      ],
    }),
  );
  assert.strictEqual(sum.runs, 1);
  assert.strictEqual(sum.lastRun.total, 3);
  assert.strictEqual(sum.lastRun.passed, 1);
  assert.strictEqual(sum.lastRun.skipped, 1);
});

test('summarize tolerates a plan with no runs and no features', function () {
  const sum = report.summarize(makeState({ features: [], cases: [], scripts: [], runs: [] }));
  assert.strictEqual(sum.lastRun, null);
  assert.strictEqual(sum.coverage.total, 0);
  assert.strictEqual(sum.coverage.ratio, 0);
});

test('renderMarkdown produces a stage table and a case table', function () {
  const md = report.renderMarkdown(makeState());
  assert.match(md, /# Brake regression/);
  assert.ok(md.indexOf('| Requirements | done |') !== -1);
  assert.ok(md.indexOf('| TC-001 | P1 | nominal | F-01 | yes |') !== -1);
  assert.ok(md.indexOf('| TC-002 | P2 | edge | F-01 | no |') !== -1);
});

test('renderMarkdown marks a closed gate with its reason', function () {
  const md = report.renderMarkdown(makeState({ approvals: [], stages: { requirements: { status: 'idle' } } }));
  assert.match(md, /Review gate: closed - /);
});

test('renderMarkdown lists uncovered features', function () {
  const md = report.renderMarkdown(makeState({ features: [{ id: 'F-01' }, { id: 'F-02' }] }));
  assert.match(md, /Uncovered features: F-02/);
});

test('renderMarkdown escapes a pipe in a case title', function () {
  const md = report.renderMarkdown(
    makeState({ cases: [{ id: 'TC-001', title: 'a | b', featureId: 'F-01', priority: 'P1', selected: true }] }),
  );
  assert.ok(md.indexOf('a \\| b') !== -1);
});

test('renderMarkdown carries the diagnosis recommendation', function () {
  const md = report.renderMarkdown(
    makeState({
      verdicts: [
        { recommendation: 'stop: 1 failure points at the rig', counts: { environment: 1 }, blocking: ['TC-001: environment'] },
      ],
    }),
  );
  assert.match(md, /Recommendation: stop/);
  assert.match(md, /environment=1/);
  assert.ok(md.indexOf('Blocking (not a script problem): TC-001: environment') !== -1);
});

test('renderMarkdown records the audit trail', function () {
  const md = report.renderMarkdown(makeState());
  assert.match(md, /cases approved by me/);
  const empty = report.renderMarkdown(makeState({ approvals: [] }));
  assert.match(empty, /no approvals recorded/);
});
