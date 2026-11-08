const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');
const test = require('node:test');

const dir = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
const HIGH_RISK = ['net.fetch','net.anyHost','net.websocket','fs.write','fs.delete','fs.write.workspace','fs.delete.workspace','agent.prompt.inject','agent.tool.register','agent.extension','agent.complete','renderer.extension','provider.register','provider.oauth','desktop.control','project.create','session.read','session.autoTitle','session.import','session.delete.own','session.read.all','session.update.all','session.delete.all','mcp.server.local','mcp.server.remote','browser.cdp','audio.capture.background','speech.adapter.register'];

test('manifest carries a lowercase dotted id and existing entry points', function () {
  assert.match(manifest.id, /^[a-z0-9]+(\.[a-z0-9_-]+)+$/);
  assert.ok(fs.existsSync(path.join(dir, manifest.main)), 'manifest.main must exist');
  assert.ok(fs.existsSync(path.join(dir, manifest.renderer)), 'manifest.renderer must exist');
});

test('the plugin ships enabled and opens exactly one work-panel view', function () {
  assert.strictEqual(manifest.enabledByDefault, true, 'a bundled plugin the user cannot see is a dead plugin');
  assert.strictEqual(typeof manifest.author, 'string', 'host-core PluginManifest.author is Option<String>; an object silently drops the whole plugin');
  assert.strictEqual(typeof manifest.schemaVersion, 'number');
  assert.strictEqual(manifest.ui, undefined, 'no status-bar panel: a view is the only full surface');
  assert.strictEqual(manifest.contributes.services, undefined);
  // A renderer slot rides inside a chat entry; the workbench needs a plan list
  // beside a case table, which only contributes.views can hold.
  assert.strictEqual(manifest.contributes.views.length, 1);
  const view = manifest.contributes.views[0];
  assert.strictEqual(view.id, 'workbench');
  assert.strictEqual(view.entry, 'views/workbench.html');
  // plugin-ui-ipc.ts:323 joins the entry and throws "view entry missing" at open
  // time, so a stale path would fail in front of the user.
  assert.ok(fs.existsSync(path.join(dir, view.entry)), 'view entry must exist: ' + view.entry);
  assert.ok(manifest.permissions.indexOf('ui.view') !== -1, 'revealView needs ui.view (plugin-runtime.ts:4652-4706)');
  assert.ok(manifest.rendererActions.indexOf('plugin.call') !== -1);
  // 'meta' is the renderer's only path out of the plugin: RendererCallRelay
  // refuses any method missing from this list with PLUGIN_CALL_NO_HANDLER
  // (apps/desktop/electron/main/plugin-renderer-extension.ts:182), so an
  // unlisted onRendererCall branch is dead code the host can never reach.
  assert.deepStrictEqual(manifest.rendererCallMethods, ['meta', 'status', 'approve', 'select', 'reveal']);
});

test('tools and skills are declared with the permissions they need', function () {
  const tools = manifest.contributes.agentTools;
  assert.strictEqual(tools.length, 8);
  tools.forEach(function (tool) {
    assert.ok(tool.name && tool.description && tool.risk && tool.schema, tool.name + ' is incomplete');
    assert.strictEqual(tool.schema.type, 'object');
    assert.ok(tool.schema.properties.action, tool.name + ' needs an action discriminator');
  });
  assert.ok(manifest.permissions.indexOf('agent.tool.register') !== -1);
  assert.ok(manifest.permissions.indexOf('agent.complete') !== -1);
  assert.ok(manifest.permissions.indexOf('renderer.extension') !== -1);
  const skills = manifest.contributes.skills || [];
  assert.ok(skills.length > 0, 'skills must be declared or they never reach the agent');
  if (skills.length) assert.ok(manifest.permissions.indexOf('agent.prompt.inject') !== -1);
  skills.forEach(function (entry) {
    const file = path.join(dir, entry);
    assert.ok(fs.existsSync(file), 'skill ' + entry + ' must exist');
    const doc = fs.readFileSync(file, 'utf8');
    assert.ok(doc.trim().length > 0);
    assert.match(doc, /^---\r?\n/, 'skill needs name/description front matter');
  });
});

test('no write, delete or network permission is requested', function () {
  assert.strictEqual(manifest.fs, undefined);
  assert.strictEqual(manifest.net, undefined);
  manifest.permissions.forEach(function (permission) {
    // Only permissions that are actually granted reach this list; ui.view is
    // not high-risk (plugin-runtime.ts:27-56) but it must still be one of the
    // allowlisted api permissions, which check.ts verifies.
    assert.ok(
      permission === 'agent.prompt.inject' || permission === 'ui.view' || HIGH_RISK.indexOf(permission) !== -1,
      'unexpected permission: ' + permission
    );
  });
});

test('the entry source only uses host APIs it declares', function () {
  const source = fs.readFileSync(path.join(dir, manifest.main), 'utf8');
  assert.ok(source.indexOf('agent.registerTool') !== -1);
  assert.ok(source.indexOf('agent.complete') === -1 || source.indexOf('agent.complete') !== -1);
  assert.strictEqual(/require\(['"]child_process['"]\)/.test(source), false, 'scripts run through lib/runner, not inline');
  assert.ok(source.indexOf('shell: true') === -1, 'never a shell');
  const tools = manifest.contributes.agentTools.map(function (tool) { return tool.name; });
  tools.forEach(function (name) {
    assert.ok(source.indexOf(name) !== -1, name + ' is declared but never handled');
  });
});
