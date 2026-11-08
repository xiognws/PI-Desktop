'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../lib/store');
const schema = require('../lib/schema');

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-store-'));
}

test('the plan id keeps words and drops bare numbers', function () {
  // Regression: a title carrying measurements ("-40C to 85C") used to produce
  // `40c-85c` as the plan name, because every alphanumeric run was kept. A run
  // that is all digits is a unit or a threshold, not a word.
  assert.strictEqual(store.slug('Brake regression'), 'brake-regression');
  assert.strictEqual(store.slug('3.5V nominal supply'), 'nominal-supply');
  assert.strictEqual(store.slug('windows: -40C to 85C cycles'), 'windows-to-cycles');
  assert.strictEqual(store.slug('---'), 'plan');
  assert.strictEqual(store.slug(''), 'plan');
  assert.strictEqual(store.slug('车窗升降开关 -40C 到 85C'), 'plan');
});

test('createPlan writes state.json and an artifact directory', function () {
  const root = tempRoot();
  const plan = store.createPlan(root, { title: 'Brake regression', source: { text: 'req' } });
  assert.ok(fs.existsSync(path.join(plan.dir, 'state.json')));
  assert.ok(fs.existsSync(path.join(plan.dir, 'artifacts')));
  assert.strictEqual(plan.state.status, 'draft');
  assert.strictEqual(plan.state.activeStage, 'requirements');
  assert.deepStrictEqual(Object.keys(plan.state.stages), schema.STAGES);
  assert.match(plan.state.id, /^brake-regression-\d{14}$/);
});

test('createPlan slugs a title into a filesystem safe id', function () {
  const root = tempRoot();
  const plan = store.createPlan(root, { title: '  ECU / HMI: smoke!! ' });
  assert.match(plan.state.id, /^ecu-hmi-smoke-\d{14}$/);
});

test('planDir rejects traversal and unknown ids', function () {
  assert.throws(function () {
    store.planDir('root', '../escape');
  }, /invalid plan id/);
  assert.throws(function () {
    store.planDir('root', 'has space');
  }, /invalid plan id/);
});

test('readState backfills missing stage entries', function () {
  const root = tempRoot();
  const plan = store.createPlan(root, { title: 'backfill' });
  const file = path.join(plan.dir, 'state.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.stages = { requirements: { status: 'done', updatedAt: null, artifactId: 'requirements-01', note: null } };
  fs.writeFileSync(file, JSON.stringify(raw), 'utf8');
  const state = store.readState(plan.dir);
  assert.strictEqual(state.stages.requirements.status, 'done');
  assert.strictEqual(state.stages.report.status, 'idle');
});

test('readState rejects a missing plan', function () {
  assert.throws(function () {
    store.readState(path.join(tempRoot(), 'nope'));
  }, /plan not found/);
});

test('saveArtifact appends ordinals and readArtifact round trips', function () {
  const root = tempRoot();
  const plan = store.createPlan(root, { title: 'artifacts' });
  const first = store.saveArtifact(plan.dir, 'cases', { cases: [1] });
  const second = store.saveArtifact(plan.dir, 'cases', { cases: [2] });
  assert.strictEqual(first, 'cases-01');
  assert.strictEqual(second, 'cases-02');
  assert.deepStrictEqual(store.readArtifact(plan.dir, first).payload, { cases: [1] });
  assert.deepStrictEqual(
    store.listArtifacts(plan.dir).map(function (entry) {
      return entry.id;
    }),
    ['cases-01', 'cases-02'],
  );
});

test('setStage rejects an unknown stage and records running as active', function () {
  const root = tempRoot();
  const plan = store.createPlan(root, { title: 'stage' });
  assert.throws(function () {
    store.setStage(plan.dir, plan.state, 'nope', { status: 'done' });
  }, /unknown stage/);
  store.setStage(plan.dir, plan.state, 'cases', { status: 'running' });
  assert.strictEqual(plan.state.activeStage, 'cases');
  assert.ok(plan.state.stages.cases.updatedAt);
});

test('listPlans sorts by recency and survives a corrupt plan', function () {
  const root = tempRoot();
  const a = store.createPlan(root, { title: 'one' });
  fs.mkdirSync(path.join(root, 'plans', 'broken'), { recursive: true });
  fs.writeFileSync(path.join(root, 'plans', 'broken', 'state.json'), '{not json', 'utf8');
  const listed = store.listPlans(root);
  assert.strictEqual(listed.length, 2);
  const broken = listed.find(function (entry) {
    return entry.id === 'broken';
  });
  assert.strictEqual(broken.status, 'corrupt');
  assert.ok(
    listed.some(function (entry) {
      return entry.id === a.state.id;
    }),
  );
});