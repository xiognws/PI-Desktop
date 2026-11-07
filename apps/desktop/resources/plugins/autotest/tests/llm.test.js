'use strict';
const test = require('node:test');
const assert = require('node:assert');

const llm = require('../lib/llm');

test('extractJson reads a bare object', function () {
  assert.deepStrictEqual(llm.extractJson('{"a":1}'), { a: 1 });
});

test('extractJson unwraps a fenced code block', function () {
  const text = 'sure:' + String.fromCharCode(10) + '```json' + String.fromCharCode(10) + '{"a":[1,2]}' + String.fromCharCode(10) + '```';
  assert.deepStrictEqual(llm.extractJson(text), { a: [1, 2] });
});

test('extractJson ignores prose before and after the value', function () {
  assert.deepStrictEqual(llm.extractJson('Here you go { "ok": true } hope that helps'), { ok: true });
});

test('extractJson is not confused by braces inside strings', function () {
  assert.deepStrictEqual(llm.extractJson('{"text":"a { b } c"}'), { text: 'a { b } c' });
});

test('extractJson is not confused by escaped quotes', function () {
  const text = '{"text":"say \\"hi\\""}';
  assert.deepStrictEqual(llm.extractJson(text), { text: 'say "hi"' });
});

test('extractJson returns null for unparseable or absent payloads', function () {
  assert.strictEqual(llm.extractJson('no json here'), null);
  assert.strictEqual(llm.extractJson('{broken:'), null);
  assert.strictEqual(llm.extractJson(null), null);
});

test('isMockMode honours settings then the environment flag', function () {
  const previous = process.env[llm.MOCK_ENV];
  try {
    delete process.env[llm.MOCK_ENV];
    assert.strictEqual(llm.isMockMode({ mockMode: true }), true);
    assert.strictEqual(llm.isMockMode({ mockMode: false }), false);
    assert.strictEqual(llm.isMockMode({}), false);
    process.env[llm.MOCK_ENV] = '1';
    assert.strictEqual(llm.isMockMode({}), true);
    assert.strictEqual(llm.isMockMode({ mockMode: false }), false);
  } finally {
    if (previous === undefined) delete process.env[llm.MOCK_ENV];
    else process.env[llm.MOCK_ENV] = previous;
  }
});

test('buildPrompt keeps system, context and task in order', function () {
  const prompt = llm.buildPrompt({ system: 'SYS', context: 'CTX', instruction: 'DO', jsonSchemaHint: '{"a":1}' });
  assert.ok(prompt.indexOf('SYS') < prompt.indexOf('CTX'));
  assert.ok(prompt.indexOf('CTX') < prompt.indexOf('DO'));
  assert.ok(prompt.indexOf('## Output') > prompt.indexOf('DO'));
});

test('completeJson parses a host reply', async function () {
  const pi = { agent: { complete: async function () { return '{"features":[{"id":"F-01"}]}'; } } };
  const result = await llm.completeJson(pi, { purpose: 'requirement', instruction: 'x' });
  assert.deepStrictEqual(result.data.features, [{ id: 'F-01' }]);
});

test('completeJson accepts a structured host reply', async function () {
  const pi = { agent: { complete: async function () { return { text: '```json' + String.fromCharCode(10) + '{"ok":1}' + String.fromCharCode(10) + '```' }; } } };
  const result = await llm.completeJson(pi, { purpose: 'cases', instruction: 'x' });
  assert.deepStrictEqual(result.data, { ok: 1 });
});

test('the host is asked through the request shape it actually reads', async function () {
  // runAgentComplete (apps/desktop/electron/main/plugin-runtime.ts:4815-4900)
  // reads input.messages and ignores input.prompt. A prompt-only request is not
  // rejected, it never answers, and the tool call dies on the host's 110s
  // "did not answer call" timeout instead of naming this defect.
  const seen = [];
  const pi = {
    agent: {
      complete: async function (request) {
        seen.push(request);
        return '{"ok":1}';
      },
    },
  };
  await llm.completeJson(pi, { purpose: 'requirement', instruction: 'x', modelKey: 'prov-1/model-1' });
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].modelKey, 'prov-1/model-1');
  assert.strictEqual(seen[0].prompt, undefined);
  assert.ok(Array.isArray(seen[0].messages), 'messages must be an array');
  assert.strictEqual(seen[0].messages.length, 1);
  assert.strictEqual(seen[0].messages[0].role, 'user');
  assert.ok(seen[0].messages[0].content.indexOf('## Task') !== -1);
});

test('a bare model id is completed with the configured provider id', function () {
  assert.strictEqual(llm.resolveModelKey({ modelKey: 'prov-1/model-1' }), 'prov-1/model-1');
  assert.strictEqual(
    llm.resolveModelKey({ modelKey: 'model-1', settings: { defaultProviderId: 'prov-1' } }),
    'prov-1/model-1',
  );
  assert.strictEqual(llm.resolveModelKey({ modelKey: 'model-1', settings: {} }), undefined);
  assert.strictEqual(llm.resolveModelKey({}), undefined);
});

test('completeJson rejects a non-JSON reply with the raw text attached', async function () {
  const pi = { agent: { complete: async function () { return 'I cannot do that.'; } } };
  await assert.rejects(
    function () { return llm.completeJson(pi, { purpose: 'cases', instruction: 'x' }); },
    function (error) {
      assert.strictEqual(error.code, 'MODEL_OUTPUT_INVALID');
      assert.match(error.raw, /cannot do that/);
      return true;
    },
  );
});

test('completeJson refuses an array reply because stages need an object', async function () {
  const pi = { agent: { complete: async function () { return '[1,2,3]'; } } };
  await assert.rejects(
    function () { return llm.completeJson(pi, { purpose: 'cases', instruction: 'x' }); },
    /did not return a JSON object/,
  );
});

test('a missing host completion surfaces MODEL_UNAVAILABLE', async function () {
  await assert.rejects(
    function () { return llm.completeJson({}, { purpose: 'cases', instruction: 'x' }); },
    function (error) {
      assert.strictEqual(error.code, 'MODEL_UNAVAILABLE');
      return true;
    },
  );
});

test('mock mode returns a JSON object for each purpose', async function () {
  const purposes = ['requirement', 'cases', 'author', 'diagnose', 'report'];
  for (const purpose of purposes) {
    const result = await llm.completeJson({}, { purpose: purpose, instruction: 'x', settings: { mockMode: true } });
    assert.strictEqual(typeof result.data, 'object');
  }
});

test('mock mode never calls the host', async function () {
  let called = 0;
  const pi = { agent: { complete: async function () { called += 1; return '{}'; } } };
  await llm.completeJson(pi, { purpose: 'cases', instruction: 'x', settings: { mockMode: true } });
  assert.strictEqual(called, 0);
});
