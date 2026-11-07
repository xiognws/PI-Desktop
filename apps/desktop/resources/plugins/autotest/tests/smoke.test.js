const path = require('node:path');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert');
const test = require('node:test');

const root = path.join(__dirname, '..');

// The six-stage walk is the plugin's whole promise: requirement, cases, a gate
// that actually holds, scripts, run, diagnosis, report. It has its own script
// because a person needs to run it by hand while wiring the host, and this test
// keeps that script honest.
test('the six-stage walk completes end to end in mock mode', function () {
  const child = spawnSync(process.execPath, [path.join(root, 'scripts', 'smoke.cjs')], {
    cwd: root,
    env: Object.assign({}, process.env, { AUTOTEST_MOCK_MODE: '1' }),
    encoding: 'utf8',
    timeout: 120000,
  });
  const output = String(child.stdout || '') + String(child.stderr || '');
  assert.strictEqual(child.status, 0, output.slice(-2000));
  assert.match(output, /SMOKE OK/);
});
