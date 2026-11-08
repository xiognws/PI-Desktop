'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const runner = require('../lib/runner');

test('the environment probe has its own short budget', function () {
  // The probe runs before any model call and the host tool budget is 110s
  // (plugin-runtime.ts:690-691). Using the script budget here made the gate
  // report 'exceeded 120000ms' after the host had already given up.
  assert.ok(runner.PROBE_TIMEOUT_MS > 0);
  assert.ok(runner.PROBE_TIMEOUT_MS < 30000);
  assert.ok(runner.PROBE_TIMEOUT_MS < runner.DEFAULT_TIMEOUT_MS);
});

test('splitCommand keeps quoted arguments together', function () {
  assert.deepStrictEqual(runner.splitCommand('python -m pytest "my tests"'), ['python', '-m', 'pytest', 'my tests']);
  assert.deepStrictEqual(runner.splitCommand("node 'a b.js'"), ['node', 'a b.js']);
  assert.deepStrictEqual(runner.splitCommand('   '), []);
});

test('extensionFor maps known languages', function () {
  assert.strictEqual(runner.extensionFor('python'), '.py');
  // CommonJS contract: authored scripts use require(), so the extension is .cjs.
  assert.strictEqual(runner.extensionFor('javascript'), '.cjs');
  assert.strictEqual(runner.extensionFor('powershell'), '.ps1');
  assert.strictEqual(runner.extensionFor('weird'), '.txt');
});

test('tail keeps short text and truncates long text from the head', function () {
  const short = runner.tail('abc', 10);
  assert.strictEqual(short.text, 'abc');
  assert.strictEqual(short.truncated, false);
  const long = runner.tail('0123456789abcdef', 4);
  assert.strictEqual(long.text, 'cdef');
  assert.strictEqual(long.truncated, true);
});

test('resolveInvocation runs a configured command with the script appended once', function () {
  const resolved = runner.resolveInvocation({ language: 'python', command: 'python -m pytest' }, 'C:/tmp/tc-001.py');
  assert.deepStrictEqual(resolved.argv, ['python', '-m', 'pytest', 'C:/tmp/tc-001.py']);
  assert.strictEqual(resolved.reason, null);
});

test('resolveInvocation honours an explicit script placeholder', function () {
  const resolved = runner.resolveInvocation({ language: 'python', command: 'pytest {script} -q' }, 'x.py');
  assert.deepStrictEqual(resolved.argv, ['pytest', 'x.py', '-q']);
});

test('resolveInvocation falls back to the node binary only for javascript', function () {
  // Not process.execPath: inside the plugin host that is electron.exe, and
  // starting it as a plain node costs an extra browser bootstrap on every
  // script (2026-11-08: the environment probe alone exceeded 10s there).
  const js = runner.resolveInvocation({ language: 'javascript' }, 'x.mjs');
  assert.strictEqual(js.argv[0], 'node');
  assert.strictEqual(js.argv[1], 'x.mjs');
  const pinned = runner.resolveInvocation({ language: 'javascript' }, 'x.mjs', { nodeCommand: 'C:/node/node.exe' });
  assert.strictEqual(pinned.argv[0], 'C:/node/node.exe', 'a caller-supplied interpreter wins');
  const py = runner.resolveInvocation({ language: 'python' }, 'x.py');
  assert.strictEqual(py.argv, null);
  assert.match(py.reason, /no runner command configured/);
});

test('runScript reports a skipped script instead of pretending it passed', async function () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-runner-'));
  const record = await runner.runScript({ script: { testCaseId: 'TC-001', language: 'ruby', body: 'puts 1' }, scriptDir: dir });
  assert.strictEqual(record.status, 'skipped');
  assert.strictEqual(record.exitCode, null);
  assert.match(record.reason, /no runner command configured/);
  assert.ok(fs.existsSync(record.file));
});

test('runScript passes a zero-exit javascript script', async function () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-runner-'));
  const record = await runner.runScript({
    script: { testCaseId: 'TC-002', language: 'javascript', body: "console.log('ok');" },
    scriptDir: dir,
  });
  assert.strictEqual(record.status, 'passed');
  assert.strictEqual(record.exitCode, 0);
  assert.match(record.stdout, /ok/);
});

test('runScript fails a non-zero exit and keeps stderr', async function () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-runner-'));
  const record = await runner.runScript({
    script: { testCaseId: 'TC-003', language: 'javascript', body: "console.error('AssertionError: nope'); process.exit(1);" },
    scriptDir: dir,
  });
  assert.strictEqual(record.status, 'failed');
  assert.strictEqual(record.exitCode, 1);
  assert.match(record.stderr, /AssertionError/);
});

test('runScript enforces the timeout budget', async function () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-runner-'));
  const record = await runner.runScript({
    script: { testCaseId: 'TC-004', language: 'javascript', body: 'setTimeout(function () {}, 30000);' },
    scriptDir: dir,
    timeoutMs: 300,
  });
  assert.strictEqual(record.status, 'timeout');
});

test('runScript reports a spawn failure as errored', async function () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-runner-'));
  const record = await runner.runScript({
    script: { testCaseId: 'TC-005', language: 'python', command: 'definitely-not-a-real-binary-xyz' },
    scriptDir: dir,
  });
  assert.strictEqual(record.status, 'errored');
  assert.match(record.reason, /spawn failed|ENOENT/);
});

test('runBatch keeps order and records a cancellation before start', async function () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-runner-'));
  const controller = new AbortController();
  const seen = [];
  const results = await runner.runBatch({
    scripts: [
      { testCaseId: 'TC-001', language: 'javascript', body: 'void 0;' },
      { testCaseId: 'TC-002', language: 'javascript', body: 'void 0;' },
    ],
    scriptDir: dir,
    signal: controller.signal,
    onProgress: function (done, total, last) {
      seen.push(done + '/' + total + ':' + last.status);
      if (done === 1) controller.abort();
    },
  });
  assert.strictEqual(results.length, 2);
  assert.strictEqual(results[0].testCaseId, 'TC-001');
  assert.strictEqual(results[0].status, 'passed');
  assert.strictEqual(results[1].status, 'errored');
  assert.match(results[1].reason, /cancelled/);
  // The cancelled item never starts, so it does not emit a progress tick.
  assert.strictEqual(seen.length, 1);
});

test('the interpreter probe prefers a real node over the host binary', async function () {
  // The probe decides whether a plan may start at all, so a probe that can only
  // time out is worse than no probe: it reported the host as a dead runtime.
  const found = await runner.resolveInterpreter({ timeoutMs: 8000 });
  assert.ok(found.argv.length >= 1);
  if (found.ok) {
    assert.match(found.version, /^v\d+\./);
    assert.ok(['settings.runnerCommand', 'PI_NODE_PATH', 'PATH', 'process.execPath'].indexOf(found.source) !== -1);
  } else {
    assert.strictEqual(found.source, 'process.execPath', 'only the last resort is reported as the failure');
  }
});