import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, "..");
const hostProcessEntry = join(desktopRoot, "electron/main/plugin-host-process.mjs");
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");

/**
 * `app.isFocused` and `app.getFileIcon` exist so a plugin never has to spawn a
 * hidden PowerShell probe to ask the OS which window is in front or what an
 * executable's icon looks like -- the shape antivirus behaviour detection reads
 * as malicious. Both answer from the host.
 */
const APP_FACTS_PLUGIN = `
  module.exports = {
    onPanelInvoke: async (channel, payload) => {
      try {
        if (channel === "probe.window") return { ok: true, result: await pi.app.isFocused() };
        const target = payload?.path;
        return { ok: true, result: await pi.app.getFileIcon(target) };
      } catch (error) {
        return { ok: false, code: error.code, message: error.message };
      }
    },
  };
`;

function forkPluginProcess({ entry }) {
  const child = fork(entry, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  return {
    postMessage: (message) => { if (child.connected) child.send(message); },
    onMessage: (handler) => child.on("message", handler),
    onExit: (handler) => child.on("exit", (code) => handler(code ?? 0)),
    kill: () => child.kill(),
  };
}

let pluginSeq = 0;

function writePlugin(permissions) {
  const dir = mkdtempSync(join(tmpdir(), "pi-app-facts-plugin-"));
  const id = `demo.app-facts.${++pluginSeq}`;
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({
    schemaVersion: 1,
    id,
    name: "app facts",
    version: "0.0.1",
    main: "main.js",
    permissions,
  }), "utf8");
  writeFileSync(join(dir, "main.js"), APP_FACTS_PLUGIN, "utf8");
  return { dir, id };
}

function createRuntime(t, services) {
  const runtime = new PluginRuntime({
    hostEntry: hostProcessEntry,
    spawnProcess: forkPluginProcess,
    ...services,
  });
  t.after(async () => {
    for (const loaded of runtime.listLoaded()) await runtime.unload(loaded.manifest.id);
  });
  return runtime;
}

/** Load the probe plugin with `granted` permissions and call one probe channel. */
async function loadProbe(t, granted, services) {
  const runtime = createRuntime(t, services);
  const { dir, id } = writePlugin(granted);
  await runtime.loadFromPath(dir, granted);
  return { runtime, pluginId: id };
}

const ICON = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";

test("app.isFocused answers the host's own window state", async (t) => {
  const { runtime, pluginId } = await loadProbe(t, ["desktop.control"], {
    isWindowFocused: () => true,
  });
  const result = await runtime.invokePanelBridge(pluginId, "probe.window", {});
  assert.deepEqual(result, { ok: true, result: true });
});

test("app.isFocused is refused without desktop.control", async (t) => {
  const { runtime, pluginId } = await loadProbe(t, [], {
    isWindowFocused: () => true,
  });
  const result = await runtime.invokePanelBridge(pluginId, "probe.window", {});
  assert.equal(result.ok, false);
  assert.equal(result.code, "PERMISSION_DENIED");
});

test("app.getFileIcon returns a png data url for an existing file", async (t) => {
  const seen = [];
  const { runtime, pluginId } = await loadProbe(t, ["desktop.control"], {
    getFileIcon: async (absPath) => {
      seen.push(absPath);
      return ICON;
    },
  });
  const file = join(mkdtempSync(join(tmpdir(), "pi-app-facts-file-")), "setup.exe");
  writeFileSync(file, "MZ", "utf8");
  const result = await runtime.invokePanelBridge(pluginId, "probe.icon", { path: file });
  assert.deepEqual(result, { ok: true, result: ICON });
  assert.equal(seen.length, 1);
  assert.equal(seen[0], file);
});

test("app.getFileIcon answers null for a path that is not an existing file", async (t) => {
  let called = 0;
  const { runtime, pluginId } = await loadProbe(t, ["desktop.control"], {
    getFileIcon: async () => {
      called += 1;
      return ICON;
    },
  });
  const root = mkdtempSync(join(tmpdir(), "pi-app-facts-absent-"));
  const dir = join(root, "folder");
  mkdirSync(dir, { recursive: true });
  const missing = await runtime.invokePanelBridge(pluginId, "probe.icon", {
    path: join(root, "ghost.exe"),
  });
  const folder = await runtime.invokePanelBridge(pluginId, "probe.icon", { path: dir });
  assert.deepEqual(missing, { ok: true, result: null });
  assert.deepEqual(folder, { ok: true, result: null });
  // The host never reaches Electron for a path statSync already refused.
  assert.equal(called, 0);
});

test("app.getFileIcon rejects a malformed argument instead of answering null", async (t) => {
  const { runtime, pluginId } = await loadProbe(t, ["desktop.control"], {
    getFileIcon: async () => ICON,
  });
  for (const path of ["", "   ", "C:/tmp/bad\0name.exe", 42]) {
    const result = await runtime.invokePanelBridge(pluginId, "probe.icon", { path });
    assert.equal(result.ok, false, `expected a rejection for ${JSON.stringify(path)}`);
    assert.equal(result.code, "INVALID_ARGUMENT");
  }
});

test("app.getFileIcon is refused without desktop.control", async (t) => {
  const { runtime, pluginId } = await loadProbe(t, [], {
    getFileIcon: async () => ICON,
  });
  const file = join(mkdtempSync(join(tmpdir(), "pi-app-facts-denied-")), "setup.exe");
  writeFileSync(file, "MZ", "utf8");
  const result = await runtime.invokePanelBridge(pluginId, "probe.icon", { path: file });
  assert.equal(result.ok, false);
  assert.equal(result.code, "PERMISSION_DENIED");
});

test("both APIs report UNSUPPORTED when the host supplies no hook", async (t) => {
  const { runtime, pluginId } = await loadProbe(t, ["desktop.control"], {});
  const focused = await runtime.invokePanelBridge(pluginId, "probe.window", {});
  const file = join(mkdtempSync(join(tmpdir(), "pi-app-facts-unbacked-")), "setup.exe");
  writeFileSync(file, "MZ", "utf8");
  const icon = await runtime.invokePanelBridge(pluginId, "probe.icon", { path: file });
  assert.equal(focused.ok, false);
  assert.equal(focused.code, "UNSUPPORTED");
  assert.match(focused.message, /host api not available: app\.isFocused/);
  assert.equal(icon.ok, false);
  assert.equal(icon.code, "UNSUPPORTED");
  assert.match(icon.message, /host api not available: app\.getFileIcon/);
});

test("the desktop host and the plugin child both expose the two APIs", () => {
  const servicesSrc = readFileSync(
    join(desktopRoot, "electron/main/services/plugin-services.ts"),
    "utf8",
  );
  // The wiring a behavioural test cannot see: real Electron `app.getFileIcon`
  // and the main window's focus/visibility, not a second implementation.
  assert.match(servicesSrc, /isWindowFocused: \(\) => \{/);
  assert.match(servicesSrc, /window\.isFocused\(\) === true/);
  assert.match(servicesSrc, /window\.isVisible\(\) === true/);
  assert.match(servicesSrc, /app\.getFileIcon\(stripWinLongPrefix\(absPath\), \{ size: "normal" \}\)/);
  assert.match(servicesSrc, /toPNG\(\)\.toString\("base64"\)/);
  const childSrc = readFileSync(hostProcessEntry, "utf8");
  assert.match(childSrc, /isFocused: \(\) => call\("app\.isFocused"\)/);
  assert.match(childSrc, /getFileIcon: \(targetPath\) => call\("app\.getFileIcon", \[targetPath\]\)/);
});
