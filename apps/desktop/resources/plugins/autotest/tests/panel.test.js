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

// 工作台把频道名写成字面量再交给桥，没有构建步骤，拼错一个字母只有运行时才炸。
// 页面通过四个入口发频道：invoke(读)、mutate(写)、startJob(长任务)、kbCall(知识库)，
// 所以四个都要扫。频道名允许两级点号（autotest.job.cancel、autotest.cases.generate）。
function collectChannels(source) {
  const called = new Set();
  const patterns = [
    /invoke\('([a-z][a-zA-Z.]*)'/g,
    /mutate\('([a-z][a-zA-Z.]*)'/g,
    /startJob\(\s*'([a-z][a-zA-Z.]*)'/g,
    /kbCall\(\s*'([a-z][a-zA-Z.]*)'/g,
  ];
  patterns.forEach(function (pattern) {
    let match;
    while ((match = pattern.exec(source)) !== null) called.add(match[1]);
  });
  return called;
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

test('the panel dispatches stages as jobs instead of running them inline', function () {
  // 2026-11-08 (m08671): the user asked for a page that can *drive* the whole
  // pipeline, not a read-only board. The trust boundary moved by exactly one
  // step: a panel may now start a stage, but only through the job registry, so
  // the 30s panel budget is never spent on a model call, and never through its
  // own re-implementation of the gate.
  const channels = Object.keys(main.PANEL_CHANNELS);
  // Starting a stage is allowed; the gate itself still lives in lib/plan.js.
  ['autotest.start', 'autotest.cases.generate', 'autotest.author', 'autotest.execute', 'autotest.diagnose', 'autotest.report'].forEach(function (channel) {
    assert.ok(channels.indexOf(channel) !== -1, channel + ' must be served so the page can drive the pipeline');
  });
  // The stage channels are asynchronous tickets, not results: a synchronous
  // handler would answer TIMEOUT on the host's 30s panel budget.
  assert.ok(channels.indexOf('autotest.job') !== -1, 'the page needs a progress channel to poll');
  assert.ok(channels.indexOf('autotest.job.cancel') !== -1);
  channels.forEach(function (channel) {
    // Two namespaces live on one bridge: the pipeline (autotest.*) and the
    // knowledge base (kb.*). Both are dotted lowercase verbs; autotest.job.cancel
    // is the one compound.
    assert.match(channel, /^(autotest\.[a-z]+(\.[a-z]+)?|kb\.[a-z]+)$/);
  });
});

test('every stage channel hands back a job ticket rather than a stage result', async function () {
  const dataPath = resolveRoot(fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-panel-jobs-')));
  const root = resolveRoot(path.join(dataPath, 'autotest'));
  const seeded = seedPlan(root);
  const previousPi = globalThis.pi;
  const previousRoot = process.env.PI_AUTOTEST_PLAN_ROOT;
  globalThis.pi = stubPi(dataPath);
  process.env.PI_AUTOTEST_PLAN_ROOT = root;
  try {
    // mockMode makes the model call a local stub, so the job finishes without
    // a network; the point of the assertion is the *shape* of the answer.
    const answer = await main.onPanelInvoke('autotest.cases.generate', { planId: seeded.id });
    assert.strictEqual(answer.ok, true, JSON.stringify(answer));
    assert.ok(answer.job && answer.job.id, 'a stage channel answers a job ticket');
    assert.strictEqual(answer.job.kind, 'cases');
    assert.strictEqual(answer.job.status, 'running');
    assert.strictEqual(answer.job.planId, seeded.id);
    const polled = await main.onPanelInvoke('autotest.job', { jobId: answer.job.id });
    assert.strictEqual(polled.ok, true, JSON.stringify(polled));
    assert.strictEqual(polled.job.id, answer.job.id);
    const byPlan = await main.onPanelInvoke('autotest.job', { planId: seeded.id });
    assert.strictEqual(byPlan.ok, true, JSON.stringify(byPlan));
    assert.ok(byPlan.jobs.length >= 1, 'a plan-scoped poll lists its jobs');
  } finally {
    globalThis.pi = previousPi;
    if (previousRoot === undefined) delete process.env.PI_AUTOTEST_PLAN_ROOT;
    else process.env.PI_AUTOTEST_PLAN_ROOT = previousRoot;
  }
});

test('a stage channel refuses to start without a plan', async function () {
  // A click on the rail before any plan exists must name what is missing, not
  // start a job against a directory that cannot be addressed. lastPanelPlanId
  // is process state that another test may have filled, so clear it the way a
  // fresh plugin process would arrive: by pointing the panel at an empty root
  // and naming no plan.
  const dataPath = resolveRoot(fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-panel-noplan-')));
  const previousPi = globalThis.pi;
  const previousRoot = process.env.PI_AUTOTEST_PLAN_ROOT;
  globalThis.pi = stubPi(dataPath);
  process.env.PI_AUTOTEST_PLAN_ROOT = resolveRoot(path.join(dataPath, 'autotest'));
  try {
    // A snapshot against an empty root leaves lastPanelPlanId null: no plan is
    // listed, so nothing is remembered.
    await main.onPanelInvoke('autotest.snapshot', {});
    const answer = await main.onPanelInvoke('autotest.execute', { planId: null });
    assert.strictEqual(answer.ok, false, JSON.stringify(answer));
    assert.strictEqual(answer.code, 'PLAN_ID_REQUIRED');
  } finally {
    globalThis.pi = previousPi;
    if (previousRoot === undefined) delete process.env.PI_AUTOTEST_PLAN_ROOT;
    else process.env.PI_AUTOTEST_PLAN_ROOT = previousRoot;
  }
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
  const called = collectChannels(source);
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
test('the workbench dispatches all six stage channels from the page', function () {
  // The whole point of the rebuild: the page itself starts stages instead of
  // asking the agent to. A typo in a channel literal is invisible without a
  // build step, so the literals are pinned here.
  const source = fs.readFileSync(path.join(__dirname, '..', 'views', 'workbench.js'), 'utf8');
  const called = collectChannels(source);
  [
    'autotest.start',
    'autotest.cases.generate',
    'autotest.author',
    'autotest.execute',
    'autotest.diagnose',
    'autotest.report',
    'autotest.job',
    'autotest.job.cancel',
  ].forEach(function (channel) {
    assert.ok(called.has(channel), 'the workbench never calls ' + channel);
  });
  // The knowledge base panel is part of the same view and reaches the same bridge.
  ['kb.list', 'kb.read', 'kb.write', 'kb.remove', 'kb.search', 'kb.collections', 'kb.attach', 'kb.detach'].forEach(
    function (channel) {
      assert.ok(called.has(channel), 'the workbench never calls ' + channel);
    },
  );
});
test('the workbench shows the gate verdict instead of recomputing it', function () {
  // lib/stages.js reviewGate() is the only authority on whether the gate is
  // open: it knows about the approved record, the awaiting_review stage, the
  // deselected rows and the stale revision. The page used to re-derive the
  // stale-revision rule itself (entry.revision <= entry.approvedRevision) in two
  // views, which drifted from the server the moment the rule changed. The page
  // may only read gate.ok / gate.reason and the per-case approvedRevision field
  // for display.
  const source = fs.readFileSync(path.join(__dirname, '..', 'views', 'workbench.js'), 'utf8');
  assert.strictEqual(
    /revision\s*[<>]=?\s*[a-zA-Z_.]*approvedRevision/.test(source),
    false,
    'the page must not compare revisions to decide whether the gate is open',
  );
  assert.strictEqual(
    /approvedRevision\s*[<>]=?\s*[a-zA-Z_.]*revision/.test(source),
    false,
    'the page must not compare revisions to decide whether the gate is open',
  );
  // The verdict itself has to be on screen, verbatim from the server.
  assert.ok(source.indexOf('gate.reason') !== -1, 'the page must render the server supplied gate reason');
  assert.ok(source.indexOf('gate.ok') !== -1, 'the page must render the server supplied gate verdict');
});
test('the workbench page loads no inline script and reaches no network', function () {
  // CSP is default-src 'none'; connect-src 'none'; script-src 'self' file:.
  // An inline <script> block or a fetch() would be blocked at runtime and the
  // page would die silently, so both are pinned at the source level.
  const html = fs.readFileSync(path.join(__dirname, '..', 'views', 'workbench.html'), 'utf8');
  const inline = /<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/i;
  assert.strictEqual(inline.test(html), false, 'the page must not carry an inline script block');
  const scripts = html.match(/<script\b[^>]*>/gi) || [];
  assert.strictEqual(scripts.length, 1, 'the page loads exactly one script, found ' + scripts.join(' '));
  assert.ok(/<script[^>]*\bsrc="\.\/workbench\.js"/.test(html), 'the one script must be the local workbench.js');
  const js = fs.readFileSync(path.join(__dirname, '..', 'views', 'workbench.js'), 'utf8');
  assert.strictEqual(/\bfetch\s*\(/.test(js), false, 'connect-src is none, so the page must not call fetch()');
  assert.strictEqual(/XMLHttpRequest|new\s+WebSocket\b|EventSource/.test(js), false, 'the page must not open its own transport');
  // The bridge is the only way out of the sandbox.
  assert.ok(js.indexOf('window.pluginBridge') !== -1, 'the page must talk through window.pluginBridge');
});
test('the bench keeps its four regions in the page, not in a tab', function () {
  // 实验台布局的意义就是这四块同时在场：左树、中执行、右证据、下日志。
  // 任意一块退回成「某个 tab 里才有」，排查失败时就得来回切换，功能也就
  // 退化回改动前的样子了。
  const html = fs.readFileSync(path.join(__dirname, '..', 'views', 'workbench.html'), 'utf8');
  const page = fs.readFileSync(path.join(__dirname, '..', 'views', 'workbench.js'), 'utf8');
  ['wb-bench', 'wb-side', 'wb-main', 'wb-evidence', 'wb-console'].forEach(function (name) {
    assert.match(html, new RegExp('class="[^"]*' + name), 'missing region: ' + name);
  });
  // 三个入口都要有各自的渲染函数，否则区域是死的空壳。
  ['renderEvidence', 'renderConsole', 'renderPlans'].forEach(function (fn) {
    assert.ok(page.indexOf('function ' + fn) !== -1, 'missing renderer: ' + fn);
    assert.ok(page.indexOf(fn + '();') !== -1, 'renderer never called: ' + fn);
  });
});

test('the evidence rail distinguishes "not generated yet" from "no match"', function () {
  const page = fs.readFileSync(path.join(__dirname, '..', 'views', 'workbench.js'), 'utf8');
  // 两种空栏必须给不同的话：前者是还没跑，后者是跑了但语料没命中。
  // 都写「暂无」的话，用户分不清功能没生效和知识库为空。
  assert.match(page, /这个阶段还没生成过/);
  assert.match(page, /没有命中任何条目/);
  assert.match(page, /检索失败/);
});

test('the console merges job progress with plan stage history', function () {
  const page = fs.readFileSync(path.join(__dirname, '..', 'views', 'workbench.js'), 'utf8');
  const body = page.slice(page.indexOf('function consoleLines'), page.indexOf('function renderConsole'));
  assert.match(body, /job\.log/, 'job progress must appear in the console');
  // 阶段历史住在 projection.state 里，顶层没有 stages（见 lib/plan.js reviewPlan）。
  // 早先这里断言的是 plan.stages，于是测试守着一个页面永远读不到的形状。
  assert.match(body, /state0\.stages/, 'plan stage history must appear in the console');
  // 排序是按时间，不是按来源：两路混排才有「一条时间线」的意义。
  assert.match(body, /lines\.sort/);
});

test('the rail and console read the projection through its state, never the flat shell', function () {
  // 生成依据（retrievals）和用例、脚本都挂在 projection.state 下，projection 顶层
  // 只有 planId/title/summary/rail/gate/coverage。页面对着顶层读只会恒空，右栏就
  // 永远显示「还没生成过」——功能在线却看不出在线（2026-11-08）。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-panel-flat-'));
  const seeded = seedPlan(dir);
  const state = store.readState(seeded.dir);
  state.retrievals = [{
    stage: 'cases',
    query: 'thermal cycling',
    at: new Date().toISOString(),
    total: 1,
    corpus: 2,
    hits: [{ id: 'kb-thermal-0001', title: 'thermal cycling practice', layer: 'global', excerpt: 'cycle before measuring' }],
  }];
  store.writeState(seeded.dir, state);
  const projection = plan.reviewPlan(makeCtx(dir), seeded.id);
  assert.strictEqual(projection.state.retrievals.length, 1);
  ['cases', 'stages', 'scripts', 'retrievals'].forEach(function (key) {
    assert.strictEqual(projection[key], undefined, key + ' must not sit on the projection top level');
  });

  const page = fs.readFileSync(path.join(__dirname, '..', 'views', 'workbench.js'), 'utf8');
  const region = page.slice(page.indexOf('function retrievalsFor'), page.indexOf('function render()'));
  ['retrievals', 'cases', 'scripts', 'stages'].forEach(function (key) {
    assert.doesNotMatch(region, new RegExp('plan\\.' + key + '\\b'), 'the rail read plan.' + key + ' off the flat shell');
  });
  assert.match(region, /planState\(\)/, 'the rail must read the nested projection state');
});

test('every tab labels its own evidence rail', function () {
  const page = fs.readFileSync(path.join(__dirname, '..', 'views', 'workbench.js'), 'utf8');
  const tabs = page.slice(page.indexOf('var TABS = ['), page.indexOf('var FAILURE_LABELS'));
  const labels = page.slice(page.indexOf('var LABELS = {'), page.indexOf('if (title) title.textContent'));
  const ids = (tabs.match(/'[a-z]+'/g) || []).map(function (s) { return s.slice(1, -1); });
  ids.forEach(function (id) {
    // 每换一个 tab 都写「证据」时，用户不知道右栏为什么换了内容。
    assert.ok(labels.indexOf(id + ':') !== -1, 'tab without an evidence title: ' + id);
  });
});


test('the meta channel answers the stage list the rail draws', async function () {
  const answer = await main.onPanelInvoke('autotest.meta', {});
  assert.strictEqual(answer.ok, true, JSON.stringify(answer));
  assert.strictEqual(answer.pluginId, 'pi.autotest');
  assert.deepStrictEqual(answer.stages.slice(0, 2), ['requirements', 'cases']);
  assert.strictEqual(answer.tools.length, 8);
});
