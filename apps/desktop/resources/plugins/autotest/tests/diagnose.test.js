'use strict';
const test = require('node:test');
const assert = require('node:assert');

const diagnose = require('../lib/diagnose');

test('a passed run classifies as unknown without needing repair', function () {
  const verdict = diagnose.classifyRun({ status: 'passed', exitCode: 0 });
  assert.strictEqual(verdict.kind, 'unknown');
  assert.strictEqual(verdict.needsRepair, false);
  assert.strictEqual(verdict.reason, 'run passed');
});

test('a skipped run reports an environment class and no repair', function () {
  const verdict = diagnose.classifyRun({ status: 'skipped', reason: 'no runner command configured' });
  assert.strictEqual(verdict.kind, 'environment');
  assert.strictEqual(verdict.needsRepair, false);
  assert.match(verdict.reason, /never executed/);
});

test('a connection error classifies as environment and blocks a rewrite', function () {
  const verdict = diagnose.classifyRun({
    status: 'failed',
    exitCode: 1,
    stderr: 'Error: connect ECONNREFUSED 127.0.0.1:5555',
  });
  assert.strictEqual(verdict.kind, 'environment');
  assert.strictEqual(verdict.needsRepair, false);
});

test('a syntax error classifies as script and allows a rewrite', function () {
  const verdict = diagnose.classifyRun({ status: 'failed', exitCode: 1, stderr: 'SyntaxError: Unexpected token }' });
  assert.strictEqual(verdict.kind, 'script');
  assert.strictEqual(verdict.needsRepair, true);
});

test('an assertion failure classifies as assertion, not as product', function () {
  const verdict = diagnose.classifyRun({
    status: 'failed',
    exitCode: 1,
    stderr: 'AssertionError: expected 3 to equal 4',
  });
  assert.strictEqual(verdict.kind, 'assertion');
  assert.strictEqual(verdict.needsRepair, true);
  assert.match(verdict.reason, /reached an assertion/);
});

test('environment outranks script when both signatures appear', function () {
  const verdict = diagnose.classifyRun({
    status: 'failed',
    exitCode: 1,
    stderr: 'Cannot find module "./helper"\nError: connect ECONNREFUSED 10.0.0.2:22',
  });
  assert.strictEqual(verdict.kind, 'environment');
});

test('a timeout with no environment signature classifies as flaky', function () {
  const verdict = diagnose.classifyRun({ status: 'timeout', durationMs: 120000, stderr: '' });
  assert.strictEqual(verdict.kind, 'flaky');
  assert.strictEqual(verdict.needsRepair, true);
});

test('a timeout caused by a dead rig classifies as environment', function () {
  const verdict = diagnose.classifyRun({ status: 'timeout', durationMs: 5000, stderr: 'device not found: /dev/ttyACM0' });
  assert.strictEqual(verdict.kind, 'environment');
});

test('an unrecognised failure stays unknown and asks for review', function () {
  const verdict = diagnose.classifyRun({ status: 'failed', exitCode: 3, stderr: 'boom', stdout: '' });
  assert.strictEqual(verdict.kind, 'unknown');
  assert.strictEqual(verdict.needsRepair, false);
  assert.match(verdict.reason, /no deterministic signature/);
});

test('confidence rises with the number of matched signatures and caps below certainty', function () {
  const weak = diagnose.classifyRun({ status: 'failed', exitCode: 1, stderr: 'SyntaxError' });
  const strong = diagnose.classifyRun({
    status: 'failed',
    exitCode: 1,
    stderr: 'SyntaxError\nReferenceError\nx is not defined',
  });
  assert.ok(strong.confidence > weak.confidence);
  assert.ok(strong.confidence <= 0.95);
});

test('classifyBatch counts every failure class and flags blocking entries', function () {
  const summary = diagnose.classifyBatch([
    { testCaseId: 'TC-001', status: 'passed' },
    { testCaseId: 'TC-002', status: 'failed', exitCode: 1, stderr: 'SyntaxError: bad' },
    { testCaseId: 'TC-003', status: 'failed', exitCode: 1, stderr: 'ECONNREFUSED 10.0.0.1:80' },
    { testCaseId: 'TC-004', status: 'skipped', reason: 'no runner' },
  ]);
  assert.strictEqual(summary.total, 4);
  assert.strictEqual(summary.passed, 1);
  assert.strictEqual(summary.failed, 3);
  assert.strictEqual(summary.counts.script, 1);
  assert.strictEqual(summary.counts.environment, 2);
  assert.strictEqual(summary.counts.assertion, 0);
  assert.strictEqual(summary.blocking.length, 2);
  assert.match(summary.recommendation, /^stop:/);
});

test('classifyBatch recommends completion when everything passes', function () {
  const summary = diagnose.classifyBatch([{ testCaseId: 'TC-001', status: 'passed' }]);
  assert.strictEqual(summary.blocking.length, 0);
  assert.match(summary.recommendation, /all approved cases passed/);
});

test('classifyBatch tolerates empty input', function () {
  const summary = diagnose.classifyBatch([]);
  assert.strictEqual(summary.total, 0);
  assert.strictEqual(summary.failed, 0);
});
