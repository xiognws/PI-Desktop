/**
 * E2E-245 contract: the packaged sidecar output must load a TypeScript
 * extension through jiti from a directory with no node_modules, with the
 * kernel packages reachable through virtual modules.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
let work: string;

/**
 * Can this host write a built bundle anywhere outside the workspace?
 *
 * Both suites below must stage their bundle outside the repository: the first
 * runs it with `cwd` there, and the second asserts the child cannot resolve
 * `typebox` from an ancestor - a directory inside the checkout would satisfy that
 * through the repository's own `node_modules` and make the assertion meaningless.
 *
 * That is not always possible. A managed Windows host whose endpoint agent allows
 * writes only under the workspace fails the build itself with `Access is denied`
 * (measured: `%TEMP%`, a sibling of the repo and another drive are all refused,
 * the checkout is allowed), so the two suites skip there with a printed reason
 * instead of failing for a host policy that says nothing about the code.
 *
 * The probe runs the real build rather than checking a flag: only the spawn knows
 * whether its output is allowed, and a genuine build error still throws.
 */
async function canStageOutsideWorkspace(): Promise<boolean> {
  const probe = mkdtempSync(join(tmpdir(), "pi-ext-probe-"));
  try {
    await build({
      stdin: { contents: "export const probe = 1;", loader: "js" },
      bundle: true,
      outfile: join(probe, "out.js"),
      logLevel: "silent",
    });
    return true;
  } catch (error) {
    const detail = [
      ...((error as { errors?: { text: string }[] }).errors ?? []).map((entry) => entry.text),
      String(error),
    ].join(" ");
    if (!/access is denied|eperm|eacces/i.test(detail)) throw error;
    console.warn(
      "[E2E-245] skipping the out-of-workspace bundle suites: this host's endpoint " +
        "agent refuses writes outside the workspace, which is what these tests stage into.",
    );
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

const stageOutside = await canStageOutsideWorkspace();
/** `describe` normally, `describe.skip` on a host that cannot stage outside the repo. */
const outsideWorkspaceSuite = stageOutside ? describe : describe.skip;

beforeEach(() => {
  // Deliberately the platform temp directory, not `testTempRoot()`: the
  // typebox case below asserts the bundle does not resolve from above it, which
  // a path under the repository would satisfy through the repo's node_modules.
  // A host whose endpoint agent blocks writes outside the workspace cannot run
  // this file at all - the spawn fails before the assertion is reached.
  work = mkdtempSync(join(tmpdir(), "pi-ext-bundle-"));
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

outsideWorkspaceSuite("bundled loader (E2E-245)", () => {
  it("loads a TypeScript extension through split ESM chunks outside the repo", async () => {
    const entry = join(work, "entry.ts");
    writeFileSync(
      entry,
      `import { TrustedExtensionRunner } from ${JSON.stringify(resolve(here, "runner.ts"))};
const extension = process.argv[2];
const bridge = {
  sessionId: "s", cwd: process.cwd(), getModel: () => undefined, setModel: async () => true,
  getThinkingLevel: () => "off", setThinkingLevel: () => {}, isIdle: () => true, abort: () => {},
  hasPendingMessages: () => false, getContextUsage: () => undefined, compact: () => {},
  getSystemPrompt: () => "", getActiveTools: () => [], getAllTools: () => [], setActiveTools: () => {},
  getSessionName: () => undefined, setSessionName: () => {}, sendUserMessage: () => {},
  waitForIdle: async () => {}, newSession: async () => ({ cancelled: false }), fork: async () => ({ cancelled: false }),
  requestUi: async (_e: unknown, r: { kind: string }) => ({ kind: r.kind }), publishCommands: () => {}, publishDiagnostics: () => {},
};
const runner = new TrustedExtensionRunner({ specs: [{ id: extension, entry: extension, label: "typed", source: "user", root: process.cwd() }], bridge: bridge as any });
const [report] = await runner.load();
const [tool] = runner.getAgentTools();
const result = tool ? await tool.execute("1", { a: 20, b: 22 }) : undefined;
process.stdout.write(JSON.stringify({ state: report.state, diagnostics: runner.getDiagnostics(), text: result?.content[0] }));
`,
    );
    const bundleDir = join(work, "bundle");
    await build({
      entryPoints: [entry],
      bundle: true,
      platform: "node",
      format: "esm",
      minify: true,
      splitting: true,
      outdir: bundleDir,
      entryNames: "sidecar",
      chunkNames: "chunks/[name]-[hash]",
      logLevel: "silent",
      banner: {
        js: "import { createRequire as __piCreateRequire } from 'node:module'; const require = __piCreateRequire(import.meta.url);",
      },
    });
    writeFileSync(join(bundleDir, "package.json"), '{"type":"module"}\n');
    const extension = join(work, "typed.ts");
    writeFileSync(
      extension,
      `import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
interface P { a: number; b: number }
export default function (pi: any) {
  const unused: AgentMessage[] = [];
  pi.registerTool(defineTool({ name: "fx_add", description: "add", parameters: Type.Object({ a: Type.Number(), b: Type.Number() }),
    async execute(_id: string, p: P) { return { content: [{ type: "text", text: String(p.a + p.b + unused.length) }], details: {} }; } }));
}
`,
    );
    const out = execFileSync(process.execPath, [join(bundleDir, "sidecar.js"), extension], {
      cwd: work,
      encoding: "utf8",
    });
    expect(JSON.parse(out)).toEqual({
      state: "loaded",
      diagnostics: [],
      text: { type: "text", text: "42" },
    });
  }, 30_000);
});

/**
 * Regression for the packaged install: pi-coding-agent's own extension loader
 * picks jiti `virtualModules` only for compiled or bundled Node distributions.
 * Every other Node build falls back to `require.resolve("typebox")` relative to
 * the importing file. A packaged sidecar lives in `resources/agent-runtime/`,
 * which has no `node_modules` above it, so without the bundled-Node define the
 * sidecar fails every native Pi extension with
 * `Cannot find module 'typebox'`.
 */
outsideWorkspaceSuite("packaged sidecar extension loader", () => {
  // pi-coding-agent ships an import-only export map, so locate its directory
  // through the workspace layout the sidecar bundle resolves from.
  const extensionLoader = resolve(
    here,
    "..",
    "..",
    "node_modules",
    "@earendil-works/pi-coding-agent",
    "dist",
    "core",
    "extensions",
    "loader.js",
  );

  /** Read the esbuild defines from the production bundle configuration. */
  function bundleDefines(): Record<string, string> {
    const source = readFileSync(resolve(here, "..", "..", "scripts", "bundle.mjs"), "utf8");
    const value = source.match(/PI_BUNDLED_NODE:\s*"([^"]+)"/)?.[1];
    return value ? { PI_BUNDLED_NODE: value } : {};
  }

  it("loads a typebox-importing extension from a bundle outside the repo", async () => {
    expect(existsSync(extensionLoader)).toBe(true);
    expect(bundleDefines()).toEqual({ PI_BUNDLED_NODE: "true" });
    const entry = join(work, "entry.mjs");
    writeFileSync(
      entry,
      `import { createRequire } from "node:module";
import { loadExtensions } from ${JSON.stringify(extensionLoader)};
const [extension] = process.argv.slice(2);
const eventBus = { emit: () => {}, on: () => () => {}, off: () => {} };
const resolvesTypebox = (() => {
  try {
    createRequire(import.meta.url).resolve("typebox");
    return true;
  } catch {
    return false;
  }
})();
const loaded = await loadExtensions([extension], process.cwd(), eventBus, undefined);
process.stdout.write(JSON.stringify({ resolvesTypebox, loaded: loaded.extensions.length, errors: loaded.errors.map((error) => error.error) }));
`,
    );
    // `--platform`, `--format` and the banner are duplicated from the bundle
    // script on purpose; only `--define:` flags are read back from it, so a
    // future non-define flag in the script has to be mirrored here.
    await build({
      entryPoints: [entry],
      bundle: true,
      platform: "node",
      format: "esm",
      minify: true,
      outfile: join(work, "sidecar.js"),
      logLevel: "silent",
      define: bundleDefines(),
      banner: {
        js: "import { createRequire as __piCreateRequire } from 'node:module'; const require = __piCreateRequire(import.meta.url);",
      },
    });

    const extension = join(work, "typed.ts");
    writeFileSync(
      extension,
      `import { Type } from "typebox";
export default function (pi: any) {
  pi.registerTool({
    name: "fx_noop",
    description: "no-op",
    parameters: Type.Object({ a: Type.Number() }),
    async execute() {
      return { content: [{ type: "text", text: "ok" }], details: {} };
    },
  });
}
`,
    );

    // vitest exports NODE_PATH into its workers and the child would inherit
    // the repository's node_modules through it. A packaged install has no such
    // fallback, so scrub it before running the bundle under test.
    const childEnv = { ...process.env };
    delete childEnv.NODE_PATH;
    const out = execFileSync(process.execPath, [join(work, "sidecar.js"), extension], {
      cwd: work,
      encoding: "utf8",
      env: childEnv,
    });
    const report = JSON.parse(out) as { resolvesTypebox: boolean; loaded: number; errors: string[] };
    expect(report.errors).toEqual([]);
    expect(report.loaded).toBe(1);
    // The child resolves `typebox` as soon as something above the bundle
    // provides it, and a `TMPDIR` inside the repository does, which would let
    // this case pass without the bundle define.
    expect(report.resolvesTypebox, "TMPDIR must lie outside any node_modules tree").toBe(false);
  }, 60_000);
});
