const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const test = require('node:test');

const plan = require('../lib/plan');
const store = require('../lib/store');
const main = require('../main');

/**
 * The workbench view runs in a sandboxed page with no fs and no require, so
 * every fact it shows arrives through onPanelInvoke. These tests drive that
 * bridge directly: a projection the tests cannot reach is a projection the view
 * cannot render.
 */

/**
 * Resolve a plans root the way the host will read it.
 *
 * The panel handler calls pi.plugin.getDataPath() and joins 'autotest' itself,
 * so its string is not the one the test computed — Windows hands out the short
 * (ADMINI~1) spelling to one caller and the long (Administrator) spelling to
 * another, and every string comparison inside lib/store.js then misses
 * (2026-11-08: seed a plan, read it back, get PLAN_NOT_FOUND). Round-tripping
 * through realpathSync.native() gives both sides one spelling.
 */
function resolveRoot(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync.native(dir);
}

function makeCtx(dir) {
  return { dataDir: dir, settings: { mockMode: true }, runtimes: {} };
}

/** Minimal host api: the panel resolves its root and palette through it. */
function stubPi(dir) {
  return {
    plugin: {
      getId: function () { return 'pi.autotest'; },
      getDataPath: async function () { return dir; },
      // main.js joins 'autotest' onto this path, so passing the plugin data
      // path (the parent of the plans root) is what the host really does.
      getSettings: async function () { return { mockMode: true }; },
    },
    app: {
      getLocale: async function () { return 'zh-CN'; },
      getAppearance: async function () { return { base: 'dark' }; },
    },
  };
}

function seedPlan(dir) {
  const root = plan.ensureRoot(dir);
  const created = store.createPlan(root, { title: 'Window lift switch -40C to 85C', source: { kind: 'text', text: 'the switch must survive thermal cycling' } });
  const state = store.readState(created.dir);
  state.features = [{ id: 'F-01', title: 'Thermal durability', description: 'switch survives cycling', acceptance: ['no contact resistance drift'], requirementRefs: ['R-01'] }];
  state.cases = [
    { id: 'TC-001', revision: 1, approvedRevision: null, selected: true, title: 'cycling at -40C', featureId: 'F-01', priority: 'P1', preconditions: [], steps: ['cool to -40C', 'cycle 100 times'], expected: ['resistance within tolerance'], type: 'durability' },
    { id: 'TC-002', revision: 1, approvedRevision: null, selected: true, title: 'cycling at 85C', featureId: 'F-01', priority: 'P2', preconditions: [], steps: ['heat to 85C'], expected: ['no cracking'], type: 'durability' },
  ];
  state.scripts = [{ testCaseId: 'TC-001', title: 'cycling at -40C', language: 'javascript', body: 'module.exports = 1;', command: 'node testcases/tc-001.cjs', notes: 'x'.repeat(2000), revision: 1 }];
  state.runs = [{ id: 'run-1', at: new Date().toISOString(), results: [{ testCaseId: 'TC-001', title: 'cycling at -40C', status: 'passed', exitCode: 0, durationMs: 12, stdout: 'y'.repeat(30000), stderr: '' }] }];
  state.verdicts = [{ runId: 'run-1', at: new Date().toISOString(), counts: { environment: 0, script: 0, assertion: 0, product: 0, flaky: 0, unknown: 1 }, total: 1, passed: 1, failed: 0, blocking: [], recommendation: 'ship', entries: [], narrative: 'one failure analysed' }];
  store.setStage(created.dir, state, 'cases', { status: 'awaiting_review' });
  store.writeState(created.dir, state);
  return { root: root, id: created.state.id, dir: created.dir };
}

test('the snapshot projection is serialisable and trims the fat fields', function () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-panel-'));
  const seeded = seedPlan(dir);
  const projection = plan.reviewPlan(makeCtx(dir), seeded.id);
  assert.strictEqual(projection.planId, seeded.id);
  assert.strictEqual(projection.state.id, seeded.id);
  assert.strictEqual(projection.state.cases.length, 2);
  // 30KB of stdout would blow the 30s bridge budget on a 40-case plan once the
  // page has to JSON-parse it, so the projection caps each stream.
  assert.strictEqual(projection.state.runs[0].results[0].stdout.length, 20000);
  assert.strictEqual(projection.state.scripts[0].notes.length, 600);
  assert.strictEqual(projection.state.scripts[0].body, 'module.exports = 1;', 'the body is what the drawer shows');
  assert.ok(projection.rail.stages.length === 6, 'the rail is the top bar of the view');
  assert.ok(projection.gate && typeof projection.gate.ok === 'boolean');
  assert.ok(projection.coverage && projection.coverage.total >= 0);
  assert.ok(Array.isArray(projection.artifacts));
  assert.doesNotThrow(function () { JSON.stringify(projection); });
});

test('the trace rows join feature, case, script and run without the view', function () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-panel-'));
  const seeded = seedPlan(dir);
  const state = store.readState(seeded.dir);
  const rows = plan.traceRows(state);
  assert.deepStrictEqual(rows.map(function (r) { return r.testCaseId; }), ['TC-001', 'TC-002']);
  const first = rows[0];
  assert.strictEqual(first.featureId, 'F-01');
  assert.strictEqual(first.hasScript, true);
  assert.strictEqual(first.status, 'passed');
  assert.strictEqual(rows[1].hasScript, false);
  // No run reached TC-002: "no result" must stay null, not become a pass.
  assert.strictEqual(rows[1].status, null);
});

test('the report channel renders markdown on demand', function () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-panel-'));
  const seeded = seedPlan(dir);
  const answer = plan.reportMarkdown(makeCtx(dir), seeded.id);
  assert.strictEqual(answer.planId, seeded.id);
  assert.match(answer.markdown, /# /);
  assert.match(answer.markdown, /TC-001/);
});

test('panel channels answer failures as data, never by throwing', async function () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-panel-'));
  seedPlan(dir);
  // onPanelInvoke derives its root from the host api, which the plugin joins
  // with 'autotest' (main.js pluginDataDir) — so the stub reports the parent of
  // the plans root, exactly as the host would.
  const previous = globalThis.pi;
  // stubPi reports the plugin data path, and main.js joins 'autotest' onto it:
  // both the ctx used below and the panel therefore resolve <dir>/autotest/plans,
  // which is exactly where seedPlan writes.
  const ctx = makeCtx(path.join(dir, 'autotest'));
  globalThis.pi = stubPi(dir);
  try {
  // The host turns a throw into PLUGIN_CALL_FAILED with no detail
  // (plugin-host-process.mjs:804-818); the view needs the code to say why.
  const missing = await main.onPanelInvoke('autotest.snapshot', { planId: 'plan-does-not-exist' });
  assert.strictEqual(missing.ok, true, 'a missing plan must not blank the plan list');
  assert.strictEqual(missing.plan, null);
  assert.ok(Array.isArray(missing.plans));

  const unknown = await main.onPanelInvoke('autotest.nope', {});
  assert.strictEqual(unknown.ok, false);
  assert.strictEqual(unknown.code, 'UNSUPPORTED');

  const empty = await main.onPanelInvoke('autotest.approve', { planId: 'x', cases: [] });
  assert.strictEqual(empty.ok, false);
  assert.strictEqual(empty.code, 'CASES_EMPTY', 'an empty approve would silently approve nothing');
  } finally {
    globalThis.pi = previous;
  }
});

test('a pinned plan root is what a renderer action reads', async function () {
  // Renderer actions and panel clicks run without an awaitable data path, so
  // main.js accepts PI_AUTOTEST_PLAN_ROOT as the root those callers use. If the
  // pin were ignored the very same plan would read fine through ctx and answer
  // PLAN_NOT_FOUND through the bridge — the failure mode this test pins down.
  const dataPath = resolveRoot(fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-panel-pin-')));
  const root = resolveRoot(path.join(dataPath, 'autotest'));
  const seeded = seedPlan(root);
  const previousPi = globalThis.pi;
  const previousRoot = process.env.PI_AUTOTEST_PLAN_ROOT;
  globalThis.pi = { plugin: { getId: () => 'pi.autotest', getSettings: async () => ({ mockMode: true }) }, app: { getLocale: async () => 'en', getAppearance: async () => ({ base: 'dark' }) } };
  process.env.PI_AUTOTEST_PLAN_ROOT = root;
  try {
    const answer = await main.onPanelInvoke('autotest.status', { planId: seeded.id });
    assert.strictEqual(answer.ok, true, JSON.stringify(answer));
    assert.strictEqual(answer.result.planId, seeded.id);
  } finally {
    globalThis.pi = previousPi;
    if (previousRoot === undefined) delete process.env.PI_AUTOTEST_PLAN_ROOT;
    else process.env.PI_AUTOTEST_PLAN_ROOT = previousRoot;
  }
});

test('the panel cannot run scripts, author scripts or reach the model', function () {
  const channels = Object.keys(main.PANEL_CHANNELS);
  assert.ok(channels.indexOf('autotest.author') === -1, 'script authoring stays on the tool side');
  assert.ok(channels.indexOf('autotest.run') === -1, 'running stays on the tool side, behind the gate');
  assert.ok(channels.indexOf('autotest.diagnose') === -1);
  channels.forEach(function (channel) {
    assert.match(channel, /^autotest\.[a-z]+$/);
  });
});

test('approving through the panel opens the gate under the workbench actor', async function () {
  // main.js joins 'autotest' onto getDataPath(), so the host reads
  // <dataPath>/autotest — the stub has to report dataPath, not the plans root.
  // resolveRoot() then makes the test and the handler agree on the spelling of
  // that directory: mkdtempSync answers the short ADMINI~1 form while the host
  // join answers the long Administrator form, and listPlans() compares strings,
  // so a plan seeded under one spelling is invisible under the other.
  const dataPath = resolveRoot(fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-panel-approve-')));
  const root = resolveRoot(path.join(dataPath, 'autotest'));
  const seeded = seedPlan(root);
  const ctx = makeCtx(root);
  const previous = globalThis.pi;
  const previousRoot = process.env.PI_AUTOTEST_PLAN_ROOT;
  globalThis.pi = stubPi(dataPath);
  // The panel handler cannot await getDataPath(): pin the root it must use.
  process.env.PI_AUTOTEST_PLAN_ROOT = root;
  try {
    const before = plan.reviewPlan(ctx, seeded.id);
    assert.strictEqual(before.gate.ok, false);
    const cases = before.state.cases.map(function (entry) {
      return { id: entry.id, title: entry.title, priority: entry.priority, steps: entry.steps, expected: entry.expected };
    });
    const answer = await main.onPanelInvoke('autotest.approve', { planId: seeded.id, cases: cases, decision: 'approved' });
    assert.strictEqual(answer.ok, true, JSON.stringify(answer));
    const after = plan.reviewPlan(ctx, seeded.id);
    assert.strictEqual(after.gate.ok, true);
    assert.strictEqual(after.state.approvals.length, 1);
    assert.strictEqual(after.state.approvals[0].actor, 'workbench');
  } finally {
    globalThis.pi = previous;
    if (previousRoot === undefined) delete process.env.PI_AUTOTEST_PLAN_ROOT;
    else process.env.PI_AUTOTEST_PLAN_ROOT = previousRoot;
  }
});
test('the workbench page never appends an array as a text node', function () {
  // 2026-11-08: group(title, actions, body) was called five times with an
  // array body, and el() appends every child through appendChild() — the view
  // died with "parameter 1 is not of type 'Node'" for every plan that had
  // cases. The page has no build step and no fs, so this is the only guard.
  const source = fs.readFileSync(path.join(__dirname, '..', 'views', 'workbench.js'), 'utf8');
  assert.ok(
    source.indexOf('var bodyNodes = Array.isArray(body) ? body : [body];') !== -1,
    'group() must flatten an array body before appending it',
  );
  assert.strictEqual(
    /el\('div',\s*\{\s*class:[^}]*\},\s*\[body\]/.test(source),
    false,
    'no caller may hand the raw body back to el() as a single child',
  );
  // snapshotPlan() must return the projection itself: panelSnapshot() already
  // answers reviewPlan(), so reaching for a nested .plan silently emptied it.
  assert.ok(source.indexOf('return state.snapshot || null;') !== -1, 'snapshotPlan reads the projection, not a nested field');
  assert.strictEqual(source.indexOf('state.snapshot && state.snapshot.plan'), -1, 'no view code may assume a nested plan');
});
test('every channel the workbench calls is served by a panel handler', function () {
  // 2026-11-08: the page opens with invoke('autotest.meta') and the handler
  // table had no such key, so every workbench open logged "unknown panel
  // channel: autotest.meta" and the rail stayed empty until a snapshot landed.
  // The view has no build step, so a missing channel only shows up at runtime.
  const source = fs.readFileSync(path.join(__dirname, '..', 'views', 'workbench.js'), 'utf8');
  const called = new Set();
  const pattern = /invoke\('([a-z]+\.[a-zA-Z]+)'/g;
  let match;
  while ((match = pattern.exec(source)) !== null) called.add(match[1]);
  // The view reaches the bridge through helpers: invoke('literal') for reads and
  // mutate('literal', ...) for writes, so both call shapes count as "called".
  const viaMutate = /mutate\('([a-z]+\.[a-zA-Z]+)'/g;
  while ((match = viaMutate.exec(source)) !== null) called.add(match[1]);
  assert.ok(called.size >= 4, 'the view should call several channels, found ' + Array.from(called).join(', '));
  Array.from(called).forEach(function (channel) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(main.PANEL_CHANNELS, channel),
      'the view calls ' + channel + ' but onPanelInvoke does not serve it',
    );
  });
  // autotest.meta is probed by the view's boot path even though the current
  // build reads the rail from the snapshot: the handler must stay served so an
  // older page bundle cannot hit UNSUPPORTED.
  assert.ok(Object.prototype.hasOwnProperty.call(main.PANEL_CHANNELS, 'autotest.meta'), 'the boot channel must stay wired');
});
test('the meta channel answers the stage list the rail draws', async function () {
  const answer = await main.onPanelInvoke('autotest.meta', {});
  assert.strictEqual(answer.ok, true, JSON.stringify(answer));
  assert.strictEqual(answer.pluginId, 'pi.autotest');
  assert.deepStrictEqual(answer.stages.slice(0, 2), ['requirements', 'cases']);
  assert.strictEqual(answer.tools.length, 8);
});
