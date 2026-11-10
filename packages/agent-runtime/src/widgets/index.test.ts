/**
 * D691 contract: a widget package is loaded, driven and contained by the
 * sidecar registry — never by the window.
 *
 * What these tests pin down, because each one is a way the client could break:
 * - a package entry is evaluated once and its declared actions become callable;
 * - an untrusted or disabled package never runs;
 * - a throwing entry, an unknown action and a missing manifest each fail as a
 *   reported row instead of an exception escaping into the sidecar;
 * - `host` is the only way to reach host-core, and only with the permission;
 * - an action that outlives the invoke budget still rejects the caller.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  WIDGET_API_VERSION,
  WIDGET_INVOKE_TIMEOUT_MS,
  WIDGET_SCHEMA_VERSION,
  type WidgetSummary,
} from "@pi-workspace/shared";

import { WidgetRegistry } from "./index.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pi-widget-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.useRealTimers();
});

type PackageOptions = {
  id: string;
  permissions?: string[];
  actions?: Array<{ name: string; description?: string }>;
  entry?: string;
  trust?: WidgetSummary["trust"];
  enabled?: boolean;
  skipManifest?: boolean;
};

/** Write one package directory and return the host-side summary for it. */
function writePackage(options: PackageOptions): WidgetSummary {
  const dir = join(root, options.id);
  mkdirSync(dir, { recursive: true });
  const actions = options.actions ?? [{ name: "ping", description: "say pong" }];
  if (!options.skipManifest) {
    writeFileSync(
      join(dir, "widget.json"),
      JSON.stringify({
        schemaVersion: WIDGET_SCHEMA_VERSION,
        apiVersion: WIDGET_API_VERSION,
        id: options.id,
        name: options.id,
        version: "1.0.0",
        description: "test package",
        permissions: options.permissions ?? [],
        actions,
      }),
    );
  }
  if (options.entry) writeFileSync(join(dir, "index.mjs"), options.entry);
  return {
    id: options.id,
    name: options.id,
    version: "1.0.0",
    description: "test package",
    dirName: options.id,
    path: dir,
    requestedPermissions: (options.permissions ?? []) as WidgetSummary["requestedPermissions"],
    grantedPermissions: (options.permissions ?? []) as WidgetSummary["grantedPermissions"],
    actions: actions.map((action) => ({ ...action, description: action.description ?? "" })),
    enabled: options.enabled ?? true,
    trust: options.trust ?? "trusted",
    digest: "0".repeat(64),
  };
}

const PING_ENTRY = "export default (api) => { api.action('ping', () => 'pong'); };";

describe("widget registry (D691)", () => {
  it("loads a package entry and invokes the action it registered", async () => {
    const call = vi.fn(async () => ({ ok: true }));
    const registry = new WidgetRegistry({ call });
    const pkg = writePackage({ id: "demo", entry: PING_ENTRY });

    const states = await registry.sync([pkg]);

    expect(states).toEqual([{ id: "demo", state: "loaded", actionNames: ["ping"] }]);
    await expect(registry.invoke("demo", "ping", { n: 1 })).resolves.toMatchObject({
      id: "demo",
      action: "ping",
      value: "pong",
    });
    expect(registry.has("demo", "ping")).toBe(true);
    expect(registry.list().map((entry) => entry.id)).toEqual(["demo"]);
  });

  it("never loads a disabled or untrusted package", async () => {
    const registry = new WidgetRegistry({ call: async () => null });
    const disabled = writePackage({ id: "off", enabled: false, entry: PING_ENTRY });
    const untrusted = writePackage({ id: "new", trust: "untrusted", entry: PING_ENTRY });

    const states = await registry.sync([disabled, untrusted]);

    expect(states).toEqual([
      { id: "new", state: "skipped", actionNames: [], error: "package is not trusted yet" },
    ]);
    expect(registry.list()).toEqual([]);
    await expect(registry.invoke("new", "ping", {})).rejects.toThrow("is not loaded");
  });

  it("reports a package whose manifest cannot be read, and keeps loading the rest", async () => {
    const registry = new WidgetRegistry({ call: async () => null });
    const broken = writePackage({ id: "broken", skipManifest: true, entry: PING_ENTRY });
    const healthy = writePackage({ id: "healthy", entry: PING_ENTRY });

    const states = await registry.sync([broken, healthy]);

    expect(states).toContainEqual(
      expect.objectContaining({ id: "broken", state: "error" }),
    );
    expect(states).toContainEqual(
      expect.objectContaining({ id: "healthy", state: "loaded" }),
    );
  });

  it("contains a throwing entry instead of failing the sync", async () => {
    const registry = new WidgetRegistry({ call: async () => null });
    const pkg = writePackage({ id: "thrower", entry: "export default () => { throw new Error('boom'); };" });

    const states = await registry.sync([pkg]);

    expect(states).toEqual([
      { id: "thrower", state: "error", actionNames: [], error: "boom" },
    ]);
  });

  it("refuses an action the manifest did not declare and the entry did not register", async () => {
    const registry = new WidgetRegistry({ call: async () => null });
    const pkg = writePackage({ id: "demo", entry: PING_ENTRY });
    await registry.sync([pkg]);

    await expect(registry.invoke("demo", "sweep", {})).rejects.toThrow("has no action sweep");
  });

  it("reaches host-core only through the host permission", async () => {
    const call = vi.fn(async (method: string) => ({ method }));
    const registry = new WidgetRegistry({ call });
    const sandboxed = writePackage({
      id: "sandboxed",
      permissions: ["read"],
      entry: "export default (api) => { api.action('ping', (input) => input.call('memory.recall', {}).then(() => 'leaked', (error) => error.message)); };",
    });
    const privileged = writePackage({
      id: "privileged",
      permissions: ["host"],
      entry: "export default (api) => { api.action('ping', (input) => input.call('memory.recall', {})); };",
    });
    await registry.sync([sandboxed, privileged]);

    await expect(registry.invoke("sandboxed", "ping", {})).resolves.toMatchObject({
      value: "widget sandboxed has no host permission",
    });
    await expect(registry.invoke("privileged", "ping", {})).resolves.toMatchObject({
      value: { method: "memory.recall" },
    });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("rejects an action that outlives the invoke budget", async () => {
    vi.useFakeTimers();
    const registry = new WidgetRegistry({ call: async () => null });
    const pkg = writePackage({
      id: "hung",
      entry: "export default (api) => { api.action('ping', () => new Promise(() => {})); };",
    });
    await registry.sync([pkg]);

    const pending = registry.invoke("hung", "ping", {});
    const assertion = expect(pending).rejects.toThrow(
      `exceeded ${WIDGET_INVOKE_TIMEOUT_MS}ms`,
    );
    await vi.advanceTimersByTimeAsync(WIDGET_INVOKE_TIMEOUT_MS + 1);
    await assertion;
  });

  it("forgets every package on clear()", async () => {
    const registry = new WidgetRegistry({ call: async () => null });
    await registry.sync([writePackage({ id: "demo", entry: PING_ENTRY })]);

    registry.clear();

    expect(registry.list()).toEqual([]);
    expect(registry.states()).toEqual([]);
  });
});

describe("widget agent tool (D691)", () => {
  it("lists what the model may call and invokes one action", async () => {
    const registry = new WidgetRegistry({ call: async () => null });
    await registry.sync([writePackage({ id: "demo", entry: PING_ENTRY })]);
    const tool = registry.agentTool();

    const listed = (await tool.execute("call-1", { action: "list" }, undefined, undefined)) as {
      content: Array<{ text: string }>;
    };
    expect(listed.content[0].text).toContain('"id":"demo"');
    expect(listed.content[0].text).toContain('"name":"ping"');

    const invoked = (await tool.execute(
      "call-2",
      { action: "invoke", widgetId: "demo", actionName: "ping" },
      undefined,
      undefined,
    )) as { content: Array<{ text: string }> };
    expect(invoked.content[0].text).toContain('"value":"pong"');
  });

  it("answers plainly when nothing is installed", async () => {
    const tool = new WidgetRegistry({ call: async () => null }).agentTool();

    const listed = (await tool.execute("call-1", { action: "list" }, undefined, undefined)) as {
      content: Array<{ text: string }>;
    };

    expect(listed.content[0].text).toBe("No widget package is installed and enabled.");
  });

  it("refuses an invoke without a target", async () => {
    const tool = new WidgetRegistry({ call: async () => null }).agentTool();

    await expect(
      tool.execute("call-1", { action: "invoke" }, undefined, undefined),
    ).rejects.toThrow("widgetId and actionName are required");
  });
});
