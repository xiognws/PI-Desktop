const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

// Renderer modules import 'react' as an ESM bare specifier, which the host
// import map provides at runtime. A node test has no import map, so the stub
// lives behind a loader hook: every 'react' import resolves to this file.
// The stub keeps elements as plain objects and calls components, so a render
// pass proves the props each card reads actually exist.
const stubPath = path.join(os.tmpdir(), 'autotest-react-stub-' + process.pid + '.mjs');
fs.writeFileSync(
  stubPath,
  [
    'function createElement(type, props) {',
    '  const children = Array.prototype.slice.call(arguments, 2);',
    '  return { type: type, props: Object.assign({}, props || {}, { children: children.length === 1 ? children[0] : children }) };',
    '}',
    'export const Fragment = "Fragment";',
    'export function useState(value) { return [typeof value === "function" ? value() : value, function () {}]; }',
    'export function useEffect() {}',
    'export function useMemo(factory) { return factory(); }',
    'export function useCallback(callback) { return callback; }',
    'export { createElement };',
    'export default { createElement: createElement, useState: useState, useEffect: useEffect, useMemo: useMemo, useCallback: useCallback, Fragment: Fragment };',
  ].join(''),
  'utf8',
);
const hookPath = path.join(os.tmpdir(), 'autotest-react-hook-' + process.pid + '.mjs');
fs.writeFileSync(
  hookPath,
  [
    'export async function resolve(specifier, context, next) {',
    '  if (specifier === "react") { return { url: ' + JSON.stringify('file:///' + stubPath.replace(/\\/g, '/')) + ', shortCircuit: true }; }',
    '  if (specifier === "react-dom") { return { url: ' + JSON.stringify('data:text/javascript,export function createPortal(n){return n;}') + ', shortCircuit: true }; }',
    '  return next(specifier, context);',
    '}',
  ].join(''),
  'utf8',
);

const schema = require('../lib/schema');
const store = require('../lib/store');
const report = require('../lib/report');
const stages = require('../lib/stages');

function flatten(node, out) {
  if (node === null || node === undefined || node === false) return out;
  if (Array.isArray(node)) {
    node.forEach(function (child) { flatten(child, out); });
    return out;
  }
  if (typeof node === 'object' && node.type) {
    if (typeof node.type === 'function') {
      flatten(node.type(node.props || {}), out);
      return out;
    }
    out.push(String(node.type) + (node.props && node.props.className ? '.' + node.props.className : ''));
    flatten(node.props && node.props.children, out);
    return out;
  }
  out.push(String(node));
  return out;
}

// Registering the hook here keeps the whole render check inside one process.
const { register } = require('node:module');
if (typeof register === 'function') register('file:///' + hookPath.replace(/\\/g, '/'));

async function loadRenderer() {
  return await import('../renderer/cards.mjs');
}

function buildPlan() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'at-render-'));
  const created = store.createPlan(root, { title: 'render', source: { kind: 'text', text: 'x' } });
  const state = created.state;
  state.features = [{ id: 'F-01', title: 'Boot', acceptance: ['boots'] }];
  state.cases = [{ id: 'TC-001', title: 'boots', featureId: 'F-01', priority: 'P0', steps: ['a'], expected: ['b'], revision: 1, approvedRevision: null, selected: true }];
  state.stages.requirements.status = 'done';
  state.stages.cases.status = 'awaiting_review';
  return { root: root, state: state };
}

test('every tool card renders against a real plan payload', async function () {
  const cards = await loadRenderer();
  const built = buildPlan();
  const state = built.state;
  const statusPayload = {
    planId: state.id,
    state: state,
    rail: stages.rail(state),
    gate: stages.reviewGate(state),
    summary: report.summarize(state),
    artifacts: [],
    next: stages.nextStages(state),
  };
  const payloads = {
    RequirementCard: { features: state.features, gaps: ['no timing budget'] },
    CasesCard: { planId: state.id, cases: state.cases, coverage: stages.coverage(state), duplicates: [], review: 'approve before scripts' },
    ScriptsCard: { planId: state.id, scripts: [{ testCaseId: 'TC-001', language: 'javascript', lines: 3, file: 'x.js' }] },
    RunCard: { planId: state.id, results: [{ testCaseId: 'TC-001', status: 'passed', exitCode: 0, durationMs: 12 }], summary: { total: 1, passed: 1, failed: 0 } },
    DiagnoseCard: { planId: state.id, entries: [{ testCaseId: 'TC-001', kind: 'script', confidence: 0.8, needsRepair: true }], blocking: [], counts: { script: 1 }, narrative: 'one script bug', repairAllowed: true },
    ReportCard: { planId: state.id, file: 'report.md', summary: report.summarize(state) },
    StatusCard: statusPayload,
  };
  Object.keys(payloads).forEach(function (name) {
    const component = cards[name];
    assert.strictEqual(typeof component, 'function', name + ' must be exported');
    const tree = component({
      toolName: 'x',
      toolCallId: 'c1',
      toolArgs: {},
      toolStatus: 'success',
      toolResult: Object.assign({ ok: true, durationMs: 5 }, payloads[name]),
      durationMs: 5,
      sessionId: 's1',
      run: function () {},
      busy: false,
    });
    const flat = flatten(tree, []).join(' ');
    assert.ok(flat.length > 0, name + ' rendered nothing');
    assert.ok(flat.indexOf('at-root') !== -1, name + ' lost the root wrapper');
  });
  const gateTree = cards.CasesCard({
    toolStatus: 'success',
    toolResult: { cases: state.cases, coverage: stages.coverage(state) },
    run: function () {},
    busy: false,
  });
  const flat = flatten(gateTree, []);
  assert.ok(
    flat.some(function (entry) { return entry === 'input' || entry === 'textarea' || entry === 'select'; }),
    'the review gate must offer editable controls',
  );
  fs.rmSync(built.root, { recursive: true, force: true });
});

test('a failed tool renders its error code instead of a blank card', async function () {
  const cards = await loadRenderer();
  const tree = cards.RunCard({ toolStatus: 'error', toolResult: { ok: false, code: 'ENVIRONMENT_UNAVAILABLE', message: 'device missing' } });
  const flat = flatten(tree, []).join(' ');
  assert.ok(flat.indexOf('ENVIRONMENT_UNAVAILABLE') !== -1);
  assert.ok(flat.indexOf('device missing') !== -1);
});

test('schema exposes the six stages the rail renders', function () {
  assert.deepStrictEqual(schema.STAGES, ['requirements', 'cases', 'scripts', 'run', 'verdict', 'report']);
  assert.strictEqual(Object.keys(schema.STAGE_LABELS).length, 6);
});
// The bridge key is the whole reason renderer calls work at all: the host reads
// `payload.args` (renderer-host/dispatch.ts:118-127). A regression here is
// silent — every call still resolves, just with undefined arguments — so it is
// asserted directly instead of through a component.
test('the renderer bridge sends arguments under the key the host reads', async function () {
  const bridge = await import('../renderer/bridge.mjs');
  const sent = [];
  bridge.bindBridge({
    plugin: { id: 'pi.autotest' },
    dispatch: async function (action, payload) {
      sent.push({ action: action, payload: payload });
      return { ok: true };
    },
  });
  await bridge.call('approve', { planId: 'p-1', cases: [] });
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].action, 'plugin.call');
  assert.strictEqual(sent[0].payload.method, 'approve');
  assert.deepStrictEqual(sent[0].payload.args, { planId: 'p-1', cases: [] });
  assert.strictEqual(sent[0].payload.payload, undefined, 'the host never reads a payload key');
});

test('the review gate sends expected results as an array', async function () {
  const gate = await import('../renderer/gate.mjs');
  const cases = [{ id: 'TC-001', title: 'boots', priority: 'P0', steps: ['a'], expected: ['b'], revision: 1, approvedRevision: null, selected: true }];
  const sent = [];
  const tree = gate.ReviewGate({
    state: { cases: cases },
    busy: false,
    run: function (method, payload) { sent.push({ method: method, payload: payload }); },
  });
  assert.ok(tree, 'the gate must render');
  // lib/plan.js:488-495 applies a patch only when the value is an array; a
  // string expected would be dropped without any error.
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'gate.mjs'), 'utf8');
  assert.ok(source.indexOf('expected: lines(local.expected)') !== -1, 'expected must be split into lines');
});

test('the rail maps every projection state onto a painted status', async function () {
  const gate = await import('../renderer/gate.mjs');
  Object.keys(gate.RAIL_STATUS).forEach(function (key) {
    assert.ok(typeof gate.RAIL_STATUS[key] === 'string', key + ' must map to a status');
  });
  assert.strictEqual(gate.RAIL_STATUS.ready, 'running', 'the cursor stage is next to run, not done');
  assert.strictEqual(gate.RAIL_STATUS.locked, 'blocked');
});
