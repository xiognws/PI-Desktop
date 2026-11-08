'use strict';
/**
 * End-to-end smoke: drive the eight tools through the host injection path.
 *
 * This deliberately does not import lib/* directly. toolContext() is where the
 * plugin identity, settings and data directory are resolved, and every bug
 * found while wiring the plugin into the desktop lived exactly there: an
 * unawaited getSettings(), an unawaited getDataPath(), an extra option that
 * overwrote `pi`. A smoke that bypasses that seam proves nothing.
 *
 *   node scripts/smoke.cjs                     # mock model, temp data dir
 *   AUTOTEST_MOCK_MODE=1 node scripts/smoke.cjs
 *   AUTOTEST_DATA=<dir> node scripts/smoke.cjs # keep the plans
 *
 * The model is mocked unless AUTOTEST_MOCK_MODE is explicitly disabled, so the
 * smoke runs on a machine with no provider configured.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

if (process.env.AUTOTEST_MOCK_MODE === undefined) process.env.AUTOTEST_MOCK_MODE = '1';

const DATA_ROOT = process.env.AUTOTEST_DATA || fs.mkdtempSync(path.join(os.tmpdir(), 'pi-autotest-smoke-'));
const workspace = path.join(DATA_ROOT, 'workspace');
fs.mkdirSync(workspace, { recursive: true });

// The host installs the api on globalThis before the module loads
// (plugin-host-process.mjs:582) and calls onLoad() with no arguments (:593).
globalThis.pi = {
  plugin: {
    getId: () => 'pi.autotest',
    getSettings: async () => ({}),
    getDataPath: async () => DATA_ROOT,
    log: () => {},
  },
  agent: {
    registerTool: async () => {},
    unregisterTool: async () => {},
  },
};

const plugin = require(path.join(__dirname, '..', 'main.js'));
const tools = new Map();

function line(label, value) {
  console.log('[' + label + '] ' + JSON.stringify(value));
}

function fail(label, detail) {
  console.error('SMOKE FAILED at ' + label + ': ' + JSON.stringify(detail));
  process.exit(1);
}

async function call(name, args) {
  const handler = tools.get(name);
  if (!handler) fail(name, 'tool not registered');
  const started = Date.now();
  const result = await handler(args || {}, {
    sessionId: 'smoke',
    turnId: 'turn-1',
    mode: 'agent',
    workspacePath: workspace,
  });
  result.elapsedMs = Date.now() - started;
  return result;
}

async function callRenderer(method, payload) {
  const result = await plugin.onRendererCall(method, payload);
  return result;
}

(async function () {
  await plugin.onLoad();
  plugin.registerTools(globalThis.pi).forEach(function (entry) {
    tools.set(entry.definition.name, entry.handler);
  });
  if (tools.size !== plugin.TOOLS.length) fail('registerTools', { registered: tools.size });

  const requirement = await call('autotest_requirement', {
    action: 'decompose',
    title: '车窗升降开关环境适应性',
    source:
      '车窗升降开关在 -40C 到 85C、12V 到 16V 供电范围内必须能在 300ms 内完成一次全行程动作，并且防夹力不超过 100N。',
    sourceKind: 'text',
  });
  line('requirement', { ok: requirement.ok, planId: requirement.planId, code: requirement.code, message: requirement.message });
  if (!requirement.ok) fail('requirement', requirement);
  const planId = requirement.planId;

  const cases = await call('autotest_cases', { action: 'generate', planId });
  line('cases', { ok: cases.ok, code: cases.code, count: cases.cases && cases.cases.length });
  if (!cases.ok || !cases.cases || cases.cases.length === 0) fail('cases', cases);

  // The gate must hold before approval, or a script could be written against
  // test cases nobody reviewed.
  const blocked = await call('autotest_author', { action: 'author', planId });
  line('author-before-gate', { ok: blocked.ok, code: blocked.code });
  if (blocked.ok || blocked.code !== 'STAGE_BLOCKED') fail('gate-closed', blocked);

  const beforeApproval = await call('autotest_status', { action: 'status', planId });
  if (beforeApproval.gate && beforeApproval.gate.ok) fail('gate-closed-status', beforeApproval.gate);

  // The gate opens from the renderer approval, not from selection: selection
  // only marks which cases a run covers.
  const card = await call('autotest_status', { action: 'status', planId });
  const cardRows = card.state.cases.map(function (entry) {
    return { id: entry.id, title: entry.title, priority: entry.priority, steps: entry.steps, expected: entry.expected };
  });
  const approve = await callRenderer('approve', { planId, cases: cardRows, decision: 'approved' });
  line('approve', { cases: approve.cases, selected: approve.selected, gate: approve.gate && approve.gate.ok });
  // approve() answers the refreshed card, not an {ok} envelope: the gate it
  // carries is the assertion that matters.
  if (!approve.gate || !approve.gate.ok) fail('approve', approve);

  const afterApproval = await call('autotest_status', { action: 'status', planId });
  if (!afterApproval.gate || !afterApproval.gate.ok) fail('gate-open', afterApproval.gate);
  line('status-after-approve', { ok: afterApproval.ok, gate: afterApproval.gate.ok, stage: afterApproval.stage });

  const author = await call('autotest_author', { action: 'author', planId });
  line('author', { ok: author.ok, code: author.code, scripts: author.scripts && author.scripts.length });
  if (!author.ok) fail('author', author);

  const run = await call('autotest_run', { action: 'run', planId });
  line('run', { ok: run.ok, summary: run.summary });
  if (!run.ok) fail('run', run);

  const diagnose = await call('autotest_diagnose', { action: 'diagnose', planId });
  line('diagnose', { ok: diagnose.ok, blocking: diagnose.blocking });
  if (!diagnose.ok) fail('diagnose', diagnose);

  const report = await call('autotest_report', { action: 'report', planId });
  line('report', { ok: report.ok, file: report.file });
  if (!report.ok) fail('report', report);

  // The report may legitimately catch itself mid-write ("Report | running |
  // rendering report.md"), never as "idle": an idle row means the rail was
  // rendered before the stage recorded anything at all.
  const markdown = fs.readFileSync(report.file, 'utf8');
  if (/\|\s*Report\s*\|\s*idle\s*\|/.test(markdown)) fail('report-rail', markdown.split('\n').slice(6, 16).join('\n'));

  const finalStatus = await call('autotest_status', { action: 'status', planId });
  line('final', {
    ok: finalStatus.ok,
    rail: finalStatus.rail && finalStatus.rail.stages && finalStatus.rail.stages.map((s) => s.stage + ':' + s.status),
    cursor: finalStatus.rail && finalStatus.rail.cursor,
    gate: finalStatus.gate && finalStatus.gate.ok,
  });
  const stages = (finalStatus.rail && finalStatus.rail.stages) || [];
  if (stages.length !== 6 || stages.some((s) => s.status !== 'done')) fail('rail-complete', stages);
  if (finalStatus.rail.cursor !== null) fail('rail-cursor', finalStatus.rail.cursor);

  // The renderer trust boundary: it may look and approve, never run.
  let leaked = null;
  try {
    await callRenderer('run', { planId });
    leaked = 'renderer called run';
  } catch (error) {
    leaked = error && error.code;
  }
  line('renderer-boundary', { refused: leaked });
  // Inside the host the relay refuses first (PLUGIN_CALL_NO_HANDLER, because
  // 'run' is absent from manifest.rendererCallMethods); calling the plugin
  // module directly reaches callRendererAction instead. Either answer is a
  // refusal, and the smoke accepts exactly those.
  const refusals = ['PLUGIN_CALL_NO_HANDLER', 'RENDERER_ACTION_UNSUPPORTED'];
  if (refusals.indexOf(leaked) === -1) fail('renderer-boundary', leaked);

  line('data', { root: DATA_ROOT, planId });
  console.log('SMOKE OK');
})().catch(function (error) {
  console.error('SMOKE FAILED: ' + error.message);
  console.error(error.stack);
  process.exit(1);
});
