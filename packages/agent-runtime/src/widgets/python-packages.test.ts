/**
 * D699 + ADR `python-widget-entry-kind`: a package whose entry is a Python
 * program is executed out of process and answers only the actions it declared.
 *
 * The interpreter here is `process.execPath` and the fixture below is the node
 * protocol program written into `main.py`: the bridge is interpreter-agnostic,
 * and these tests must pass on a machine with no Python installed. What they pin
 * down is the contract, not the language.
 */
import { testTempRoot } from "../test-temp-root.js";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  WIDGET_API_VERSION,
  WIDGET_SCHEMA_VERSION,
  type WidgetSummary,
} from "@pi-workspace/shared";

import { WidgetRegistry } from "./index.js";

let root: string;
/** Every registry a test created, so its child processes are stopped first. */
let registries: WidgetRegistry[];

beforeEach(() => {
  root = mkdtempSync(join(testTempRoot(), "pi-widget-py-"));
  registries = [];
});

afterEach(async () => {
  // A child process holds a handle on its working directory on Windows, so the
  // package tree can only be removed once every registry has unloaded: unloading
  // is what stops the program.
  for (const registry of registries) await registry.sync([]);
  // kill() is asynchronous: the child releases its working directory when it
  // actually exits, which is a moment after dispose returns.
  await new Promise((resolve) => setTimeout(resolve, 300));
  rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

/** Registries must be created through here: the teardown depends on it. */
function registryWith(interpreter?: string): WidgetRegistry {
  const registry = new WidgetRegistry(
    { call: async () => ({}) },
    interpreter ? { pythonInterpreter: () => interpreter } : {},
  );
  registries.push(registry);
  return registry;
}

const PROGRAM = `
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    const value = request.action === "echo" ? request.args : "pong";
    process.stdout.write(JSON.stringify({ id: request.id, ok: true, value }) + "\\n");
  }
});
`;

function writePythonPackage(id: string, overrides: Partial<WidgetSummary> = {}): WidgetSummary {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  const actions = [
    { name: "ping", description: "say pong" },
    { name: "echo", description: "return the args" },
  ];
  writeFileSync(
    join(dir, "widget.json"),
    JSON.stringify({
      schemaVersion: WIDGET_SCHEMA_VERSION,
      apiVersion: WIDGET_API_VERSION,
      id,
      name: id,
      version: "1.0.0",
      description: "python test package",
      permissions: [],
      runtime: { kind: "python", entry: "main.py" },
      actions,
    }),
  );
  writeFileSync(join(dir, "main.py"), PROGRAM);
  return {
    id,
    name: id,
    version: "1.0.0",
    description: "python test package",
    dirName: id,
    path: dir,
    requestedPermissions: [],
    grantedPermissions: [],
    actions: actions.map((action) => ({ ...action, description: action.description ?? "" })),
    enabled: true,
    trust: "trusted",
    digest: "0".repeat(64),
    ...overrides,
  };
}

describe("python widget packages", () => {
  it("runs the entry and answers a declared action", async () => {
    const registry = registryWith(process.execPath);
    const pkg = writePythonPackage("py-demo");

    const states = await registry.sync([pkg]);

    expect(states).toEqual([
      { id: "py-demo", state: "loaded", actionNames: ["ping", "echo"] },
    ]);
    await expect(registry.invoke("py-demo", "echo", { n: 7 })).resolves.toMatchObject({
      id: "py-demo",
      action: "echo",
      value: { n: 7 },
    });
  });

  it("reports a package that cannot start instead of loading it silently", async () => {
    const registry = registryWith(join(root, "does-not-exist.exe"));
    const pkg = writePythonPackage("py-broken");

    const states = await registry.sync([pkg]);

    expect(states[0]?.state).toBe("error");
    expect(states[0]?.error ?? "").toMatch(/failed to start|ENOENT/i);
  });

  it("refuses a python package when no interpreter is configured", async () => {
    const registry = registryWith();
    const pkg = writePythonPackage("py-nointerp");

    const states = await registry.sync([pkg]);

    expect(states[0]?.state).toBe("error");
    expect(states[0]?.error ?? "").toMatch(/no Python interpreter/);
  });

  it("an undeclared action never reaches the program", async () => {
    const registry = registryWith(process.execPath);
    const pkg = writePythonPackage("py-scope");
    await registry.sync([pkg]);

    await expect(registry.invoke("py-scope", "rm-rf", {})).rejects.toThrow(/no action/);
  });

  it("dropping the package stops its process", async () => {
    const registry = registryWith(process.execPath);
    const pkg = writePythonPackage("py-life");
    await registry.sync([pkg]);
    await registry.invoke("py-life", "ping", {});

    const states = await registry.sync([]);

    expect(states).toEqual([]);
    await expect(registry.invoke("py-life", "ping", {})).rejects.toThrow(/not loaded/);
  });
});
