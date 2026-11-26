import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

/**
 * Collapsing the file list must never remove the code editor.
 *
 * `0.9.1-pi.3` moved the list to the right but left the
 * `treeCollapsed ? null : …` gate on the editor while the tree rendered
 * unconditionally, so hiding the list — which opening a file does on purpose —
 * left the user with only the tree. This journey drives the real view in a real
 * Electron window with both preference states and reads the DOM back.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const viewEntry =
  process.env.PI_FILE_MANAGER_VIEW ??
  join(root, "apps/desktop/resources/plugins/pi.file-manager/views/index.html");
const electronBinary =
  process.env.PI_DESKTOP_ELECTRON_BIN ?? resolveElectronBinary(root).electronBinary;

const preloadFixture = String.raw`
const { contextBridge } = require("electron");

const collapsedArgument = process.argv.find((value) => value.startsWith("--fixture-collapsed="));
const treeCollapsed = collapsedArgument?.split("=")[1] === "1";
const workspace = {
  path: "C:/fixture/project",
  name: "project",
  projectId: "fixture-project",
  roots: [{ path: "C:/fixture/project", name: "project", primary: true }],
};
const prefs = {
  splitRatio: 0.32,
  treeCollapsed,
  showIgnored: false,
  watchFiles: false,
  mdPreview: false,
  csvTable: true,
  jsonTree: false,
  tablePageSize: 1000,
  projectRoots: {},
};

contextBridge.exposeInMainWorld("pluginBridge", {
  async invoke(channel, payload = {}) {
    switch (channel) {
      case "app.getAppearance":
        return { base: "dark", locale: "en" };
      case "workspace.get":
        return workspace;
      case "fm.hello":
        return {
          ok: true,
          root: workspace,
          limits: {
            maxReadBytes: 2 * 1024 * 1024,
            maxWriteBytes: 8 * 1024 * 1024,
            maxListEntries: 5000,
          },
          ignoreFiles: [],
          prefs,
        };
      case "fm.list":
        return {
          ok: true,
          path: payload.path ?? "",
          entries: payload.path
            ? []
            : [
                {
                  name: "test.ts",
                  path: "test.ts",
                  isDirectory: false,
                  size: 22,
                  mtimeMs: 1,
                  ignored: false,
                  isSymlink: false,
                  outside: false,
                },
              ],
          truncated: false,
          ignoreActive: false,
        };
      case "fm.read":
        return {
          ok: true,
          kind: "text",
          path: payload.path,
          text: "const visible = true;\n",
          eol: "lf",
          bom: false,
          size: 22,
          mtimeMs: 1,
        };
      case "fm.prefs.set":
        return { ok: true, prefs: { ...prefs, ...(payload.partial ?? {}) } };
      default:
        throw new Error("Unexpected fixture channel: " + channel);
    }
  },
  on() {
    return () => {};
  },
});
`;

const mainFixture = String.raw`
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const viewEntry = process.env.PI_FILE_MANAGER_VIEW;
app.setPath("userData", path.join(__dirname, "profile"));

async function waitFor(window, expression) {
  const timeoutMessage = JSON.stringify("timed out: " + expression);
  await window.webContents.executeJavaScript(
    "new Promise((resolve, reject) => {" +
      "const deadline = Date.now() + 10000;" +
      "const poll = () => {" +
        "if (" + expression + ") resolve();" +
        "else if (Date.now() > deadline) reject(new Error(" + timeoutMessage + "));" +
        "else setTimeout(poll, 50);" +
      "}; poll();" +
    "})",
  );
}

async function probe(collapsed, openFile) {
  const window = new BrowserWindow({
    show: false,
    width: 1000,
    height: 720,
    webPreferences: {
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      preload: path.join(__dirname, "preload.cjs"),
      additionalArguments: ["--fixture-collapsed=" + (collapsed ? "1" : "0")],
    },
  });
  const viewUrl = pathToFileURL(viewEntry);
  if (openFile) viewUrl.searchParams.set("piViewOpen", "test.ts");
  await window.loadURL(viewUrl.href).catch((error) => {
    throw new Error("collapsed=" + collapsed + " openFile=" + openFile + " load failed: " + error.message);
  });
  await waitFor(
    window,
    openFile
      ? "document.querySelector('.cm-content')?.textContent.includes('visible')"
      : "Boolean(document.querySelector('.cm-content'))",
  );
  const report = await window.webContents.executeJavaScript("(() => {" +
    "const editor = document.querySelector('.cm-content');" +
    "const tree = [...document.querySelectorAll('aside')];" +
    "return {" +
      "editorMounted: editor !== null," +
      "editorText: editor ? editor.textContent.slice(0, 40) : null," +
      "editorWidth: editor ? Math.round(editor.getBoundingClientRect().width) : 0," +
      "treeCount: tree.length," +
      "treeWidth: tree.length ? Math.round(tree[0].getBoundingClientRect().width) : 0," +
      "resizeHandles: document.querySelectorAll('[role=\"separator\"]').length," +
    "};" +
  "})()");
  if (!window.isDestroyed()) window.destroy();
  return report;
}

app.whenReady().then(async () => {
  try {
    const result = {
      collapsed: await probe(true, false),
      expanded: await probe(false, false),
      // Opening a file collapses the list on purpose, to give the editor the full
      // width. That is the path that used to remove the code view.
      collapsedAfterOpen: await probe(true, true),
    };
    console.log("FILE_MANAGER_COLLAPSE_PROBE " + JSON.stringify({ ok: true, result }));
    app.exit(0);
  } catch (error) {
    console.error(
      "FILE_MANAGER_COLLAPSE_PROBE " +
        JSON.stringify({ ok: false, error: String(error?.stack ?? error) }),
    );
    app.exit(1);
  }
});
`;

test(
  "collapsing the file list keeps the code editor and hides the tree",
  {
    skip:
      process.platform === "linux" && !process.env.DISPLAY
        ? "Electron requires a display"
        : false,
  },
  async () => {
    const temp = await mkdtemp(join(tmpdir(), "pi-file-manager-collapse-"));
    try {
      await writeFile(join(temp, "preload.cjs"), preloadFixture);
      await writeFile(join(temp, "main.cjs"), mainFixture);

      const env = { ...process.env, PI_FILE_MANAGER_VIEW: viewEntry };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(electronBinary, [join(temp, "main.cjs")], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      for (const stream of [child.stdout, child.stderr]) {
        stream.setEncoding("utf8");
        stream.on("data", (chunk) => {
          output += chunk;
        });
      }
      const timeout = setTimeout(() => child.kill("SIGKILL"), 60_000);
      let code;
      try {
        code = await new Promise((resolve, reject) => {
          child.once("error", reject);
          child.once("close", resolve);
        });
      } finally {
        clearTimeout(timeout);
      }

      const line = output
        .split(/\r?\n/)
        .find((item) => item.startsWith("FILE_MANAGER_COLLAPSE_PROBE "));
      assert.ok(line, output.slice(-6000));
      assert.equal(code, 0, output.slice(-6000));
      const report = JSON.parse(line.slice("FILE_MANAGER_COLLAPSE_PROBE ".length));
      assert.equal(report.ok, true, output.slice(-6000));

      // The editor is the surface that must survive a collapsed tree.
      for (const [state, probe] of Object.entries(report.result)) {
        assert.equal(probe.editorMounted, true, `${state}: the code editor must stay mounted`);
        assert.ok(probe.editorWidth > 0, `${state}: the code editor must keep a visible width`);
      }
      // Collapsed means the file list and its resize handle are gone.
      assert.equal(report.result.collapsed.treeCount, 0, "collapsed: the file tree must be hidden");
      assert.equal(
        report.result.collapsed.resizeHandles,
        0,
        "collapsed: the tree's resize handle must be hidden with it",
      );
      // Expanded means both surfaces are on screen.
      assert.ok(report.result.expanded.treeCount >= 1, "expanded: the file tree must be visible");
      assert.ok(report.result.expanded.treeWidth > 0, "expanded: the tree must keep a visible width");
      assert.equal(report.result.expanded.resizeHandles, 1, "expanded: the resize handle must show");
      // Opening a file collapses the list on purpose; the code must still be there.
      assert.match(
        report.result.collapsedAfterOpen.editorText ?? "",
        /visible/,
        "collapsed after opening a file: the opened file must stay in the editor",
      );
      assert.equal(
        report.result.collapsedAfterOpen.treeCount,
        0,
        "collapsed after opening a file: the list stays hidden",
      );
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  },
);
