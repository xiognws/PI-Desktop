'use strict';
/**
 * The knowledge base has to reach the prompt, and the result has to cite it.
 *
 * The feature this file guards is easy to fake: `plan.attachKnowledge` already
 * wrote a `knowledgeRefs` field, `lib/plan.js` already had a `cases` stage, and
 * a README already described "references" — none of which put a single byte of
 * an entry in front of the model. So these tests assert on the request the
 * plugin actually built, not on the presence of a field.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const plan = require('../lib/plan');
const kb = require('../lib/kb');
const store = require('../lib/store');

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
      runtimes: {
        selfCheck: async function () {
          return { ok: true, detail: 'stub probe' };
        },
      },
    },
    extra || {},
  );
}

const REQUIREMENT = JSON.stringify({
  features: [
    { id: 'F-01', title: 'DTC read', description: 'read fault codes', acceptance: ['returns stored codes'], requirementRefs: ['R-01'] },
  ],
  gaps: [],
});

const CASES = JSON.stringify({
  cases: [
    {
      title: 'read DTC after entering extended session',
      featureId: 'F-01',
      priority: 'P1',
      preconditions: ['ignition on'],
      steps: ['0x10 03'],
      expected: ['0x50 03'],
      type: 'functional',
      referenceIds: ['uds-diag-0001'],
    },
  ],
});

/** The text a request carried, whichever key the host uses. */
function requestText(request) {
  const parts = [];
  ['system', 'context', 'prompt', 'instruction'].forEach(function (key) {
    if (typeof request[key] === 'string') parts.push(request[key]);
  });
  if (Array.isArray(request.messages)) {
    request.messages.forEach(function (message) {
      parts.push(typeof message === 'string' ? message : String((message && message.content) || ''));
    });
  }
  return parts.join('\n');
}

/** A shipped-layer entry, so the test does not depend on the package seed. */
function seedShipped(dir, collection, title, text, tags) {
  const target = path.join(dir, collection);
  fs.mkdirSync(target, { recursive: true });
  const entry = {
    id: 'kb-' + collection + '-fixture-20260101000000',
    collection: collection,
    title: title,
    tags: tags || [],
    source: { kind: 'standard', ref: 'unit' },
    text: text,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    bytes: Buffer.byteLength(text, 'utf8'),
  };
  fs.writeFileSync(path.join(target, entry.id + '.json'), JSON.stringify(entry, null, 2), 'utf8');
  return entry.id;
}

test('the case stage puts retrieved entries in the request the model receives', async function () {
  const pi = makePi([REQUIREMENT, CASES]);
  const shipped = fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-global-'));
  const entryId = seedShipped(
    shipped,
    'uds-diagnostics',
    'Extended session before a DID read',
    'Enter extended session 0x10 03 before any 0x22 read; the session must be refreshed within 5000 ms.',
    ['DTC', 'session'],
  );
  const ctx = baseCtx(pi, { globalKbRoot: shipped });

  const created = await plan.requirement(ctx, { action: 'decompose', title: 'DTC plan', source: 'the unit shall report fault codes' });
  const planId = created.planId;
  await plan.cases(ctx, { planId: planId });

  // The second call is the case-generation request. The feature title is "DTC
  // read", which is what the retrieval query is built from.
  const request = pi.calls[pi.calls.length - 1];
  const text = requestText(request);
  assert.match(text, /Knowledge base/);
  assert.match(text, /0x10 03/, 'the entry body must reach the prompt, not just its id');
  assert.match(text, new RegExp(entryId));

  // And the record of what was shown is kept on the plan.
  const status = await plan.status(ctx, { planId: planId });
  const retrieval = status.state.retrievals.filter(function (row) {
    return row.stage === 'cases';
  });
  assert.strictEqual(retrieval.length, 1);
  assert.deepStrictEqual(retrieval[0].hits.map(function (hit) { return hit.id; }), [entryId]);
  assert.strictEqual(retrieval[0].hits[0].layer, 'global');
});

test('a case keeps the reference ids it reported, unfiltered', async function () {
  const pi = makePi([REQUIREMENT, CASES]);
  const ctx = baseCtx(pi);
  const created = await plan.requirement(ctx, { action: 'decompose', title: 'DTC plan', source: 'the unit shall report fault codes' });
  const planId = created.planId;
  const result = await plan.cases(ctx, { planId: planId });

  // An id that is not in any corpus is preserved: the entry may have been
  // deleted since, and a reviewer needs to see that drift rather than a case
  // that silently reads as fully sourced.
  assert.deepStrictEqual(result.cases[0].referenceIds, ['uds-diag-0001']);
});

test('an empty knowledge base still generates, and says so in the instruction', async function () {
  const pi = makePi([REQUIREMENT, CASES]);
  // An explicit empty global root: without it `globalRoot` walks up from
  // `__dirname` and finds the seed shipped in the package, which is exactly
  // what "empty knowledge base" is trying not to be.
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-global-empty-'));
  const ctx = baseCtx(pi, { globalKbRoot: empty });
  const created = await plan.requirement(ctx, { action: 'decompose', title: 'Empty base', source: 'the unit shall report fault codes' });
  const planId = created.planId;
  await plan.cases(ctx, { planId: planId });

  const text = requestText(pi.calls[pi.calls.length - 1]);
  // The heading, not the phrase: the system prompt says "the knowledge base
  // section" in its rules, so a bare /Knowledge base/ matches even with no hit.
  assert.doesNotMatch(text, /## Knowledge base \(/);
  // Silence is not an instruction; the model has to be told in words.
  assert.match(text, /No knowledge base entry matched/);

  const status = await plan.status(ctx, { planId: planId });
  const retrieval = status.state.retrievals.filter(function (row) { return row.stage === 'cases'; });
  assert.strictEqual(retrieval[0].hits.length, 0);
  assert.strictEqual(retrieval[0].total, 0);
});

test('the script stage retrieves per case and records one entry per case', async function () {
  const pi = makePi([REQUIREMENT, CASES, JSON.stringify({
    language: 'javascript',
    script: 'module.exports = async function () { return true; };',
    command: null,
    notes: 'ok',
    referenceIds: ['kb-uds-diagnostics-fixture-20260101000000'],
  })]);
  const shipped = fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-global-'));
  seedShipped(
    shipped,
    'uds-diagnostics',
    'Extended session before a DID read',
    'Enter extended session 0x10 03 before any 0x22 read.',
    ['DTC'],
  );
  const ctx = baseCtx(pi, { globalKbRoot: shipped });
  const created = await plan.requirement(ctx, { action: 'decompose', title: 'DTC plan', source: 'the unit shall report fault codes' });
  const planId = created.planId;
  await plan.cases(ctx, { planId: planId });
  // Authoring is gated on an approved case set, by design: nothing is written
  // before a human (or here, the test) has seen the cases.
  plan.approveCaseSet(ctx, { planId: planId, actor: 'test' });
  await plan.author(ctx, { planId: planId });

  const text = requestText(pi.calls[pi.calls.length - 1]);
  assert.match(text, /0x10 03/);

  const status = await plan.status(ctx, { planId: planId });
  const scriptRuns = status.state.retrievals.filter(function (row) {
    return row.stage.indexOf('scripts:') === 0;
  });
  assert.strictEqual(scriptRuns.length, 1);
  assert.strictEqual(scriptRuns[0].stage, 'scripts:TC-001');
  assert.strictEqual(status.state.scripts[0].referenceIds.length, 1);
});

test('re-running the case stage keeps both retrieval records', async function () {
  const pi = makePi([REQUIREMENT, CASES, CASES]);
  const ctx = baseCtx(pi);
  const created = await plan.requirement(ctx, { action: 'decompose', title: 'Twice', source: 'the unit shall report fault codes' });
  const planId = created.planId;
  await plan.cases(ctx, { planId: planId });
  await plan.cases(ctx, { planId: planId, regenerate: true });

  const status = await plan.status(ctx, { planId: planId });
  const runs = status.state.retrievals.filter(function (row) { return row.stage === 'cases'; });
  // A map keyed by stage would have dropped the first run, and the cases from
  // that run are still in the approval history.
  assert.strictEqual(runs.length, 2);
  assert.notStrictEqual(runs[0].at, undefined);
});

test('a shipped entry cannot be edited or deleted through the project layer', function () {
  const shipped = fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-global-'));
  const id = seedShipped(shipped, 'standards', 'Company rule', 'Always assert explicitly.');
  const ctx = { dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-root-')), globalKbRoot: shipped };

  assert.throws(
    function () { kb.write(ctx, { id: id, title: 'edited', text: 'x' }); },
    function (error) { return error.code === 'KB_ENTRY_READ_ONLY'; },
  );
  assert.throws(
    function () { kb.remove(ctx, { id: id }); },
    function (error) { return error.code === 'KB_ENTRY_READ_ONLY'; },
  );
  // And the shipped file is untouched.
  const file = path.join(shipped, 'standards', id + '.json');
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).title, 'Company rule');
});

test('same-named collections merge, and the project copy wins on an id clash', function () {
  const shipped = fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-global-'));
  const shared = seedShipped(shipped, 'standards', 'Shipped rule', 'from the package');
  const ctx = { dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-root-')), globalKbRoot: shipped };

  // A user entry in the same collection, plus one that reuses the shipped id.
  kb.write(ctx, { collection: 'standards', title: 'Local rule', text: 'from the project' });
  const dir = path.join(ctx.dataDir, 'kb', 'standards');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, shared + '.json'), JSON.stringify({
    id: shared,
    collection: 'standards',
    title: 'Overridden rule',
    tags: [],
    source: null,
    text: 'project override',
    createdAt: '2026-02-01T00:00:00.000Z',
    updatedAt: '2026-02-01T00:00:00.000Z',
  }, null, 2), 'utf8');

  const list = kb.list(ctx, {});
  const titles = list.items.map(function (entry) { return entry.title; }).sort();
  // The shipped entry is not hidden by the project collection existing...
  assert.deepStrictEqual(titles, ['Local rule', 'Overridden rule']);
  // ...and the id clash resolves to the project copy, which is the editable one.
  assert.strictEqual(kb.read(ctx, { id: shared }).layer, 'project');
  assert.strictEqual(kb.read(ctx, { id: shared }).text, 'project override');

  const summary = kb.collections(ctx).items.filter(function (item) { return item.name === 'standards'; })[0];
  assert.strictEqual(summary.layer, 'project');
  assert.strictEqual(summary.writable, true);
  assert.strictEqual(summary.count, 2);
});

test('retrieval is bounded and a long entry is trimmed, not dropped', function () {
  const shipped = fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-global-'));
  const body = 'header line that matters\n' + 'filler '.repeat(600) + '\ntail line';
  seedShipped(shipped, 'big', 'DTC read procedure', body, ['DTC']);
  const ctx = { dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-root-')), globalKbRoot: shipped };

  const result = kb.retrieve(ctx, { query: 'DTC read procedure', k: 4 });
  assert.strictEqual(result.hits.length, 1);
  assert.strictEqual(result.hits[0].truncated, true);
  assert.ok(result.hits[0].text.length <= kb.RETRIEVAL_CHARS);
  // The opening line usually carries the acceptance criterion, so it survives.
  assert.match(result.hits[0].text, /header line that matters/);
  assert.ok(result.usedChars <= kb.RETRIEVAL_TOTAL_CHARS);
});

test('an empty query retrieves nothing rather than the whole base', function () {
  const shipped = fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-global-'));
  seedShipped(shipped, 'standards', 'Anything', 'some body');
  const ctx = { dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-root-')), globalKbRoot: shipped };
  const result = kb.retrieve(ctx, { query: '   ' });
  assert.deepStrictEqual(result.hits, []);
  assert.strictEqual(result.total, 0);
});
