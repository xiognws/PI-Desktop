/*
 * Widget packages may be written in a non-JavaScript language (ADR:
 * python-widget-entry-kind).
 *
 * The contract has to hold for two populations at once: packages already
 * installed, which say `apiVersion: 1` and have no `runtime`, and new ones that
 * name a Python entry. These tests pin that boundary — the version check is a
 * range, absence still means JavaScript, and a Python entry cannot escape its
 * own package directory.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  isSupportedWidgetApiVersion,
  readWidgetRuntime,
  WIDGET_API_VERSION,
  WIDGET_API_VERSION_MIN,
} from "@pi-workspace/shared";

import { readWidgetManifest, resolveRuntimeEntry } from "./runner.js";

const created: string[] = [];

function packageDir(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-widget-"));
  created.push(dir);
  for (const [name, body] of Object.entries(files)) {
    const full = join(dir, name);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, typeof body === "string" ? body : JSON.stringify(body));
  }
  return dir;
}

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    apiVersion: 2,
    id: "comtest-framework",
    name: "ComTest framework",
    version: "1.0.0",
    ...overrides,
  };
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("apiVersion is a range", () => {
  it("accepts every version between the floor and the ceiling", () => {
    expect(WIDGET_API_VERSION_MIN).toBe(1);
    expect(WIDGET_API_VERSION).toBeGreaterThanOrEqual(2);
    // A package installed before v2 existed must keep loading: an equality check
    // here would strand every one of them on upgrade.
    expect(isSupportedWidgetApiVersion(1)).toBe(true);
    expect(isSupportedWidgetApiVersion(WIDGET_API_VERSION)).toBe(true);
  });

  it("rejects what it cannot run", () => {
    expect(isSupportedWidgetApiVersion(0)).toBe(false);
    expect(isSupportedWidgetApiVersion(WIDGET_API_VERSION + 1)).toBe(false);
    expect(isSupportedWidgetApiVersion(1.5)).toBe(false);
    expect(isSupportedWidgetApiVersion("1")).toBe(false);
    expect(isSupportedWidgetApiVersion(undefined)).toBe(false);
  });
});

describe("readWidgetRuntime", () => {
  it("reads absence as JavaScript, which is what every v1 package says", () => {
    expect(readWidgetRuntime(undefined)).toEqual({ kind: "javascript", entry: "" });
    expect(readWidgetRuntime({ kind: "javascript" })).toEqual({ kind: "javascript", entry: "" });
  });

  it("normalises a python declaration", () => {
    expect(
      readWidgetRuntime({ kind: "Python", entry: " main.py ", pythonPath: ["src", "  ", 7, "lib"] }),
    ).toEqual({ kind: "python", entry: "main.py", pythonPath: ["src", "lib"] });
  });

  it("refuses an unknown kind instead of downgrading it", () => {
    // Quietly treating an unknown kind as JavaScript would run a package in a
    // process it was not written for.
    expect(readWidgetRuntime({ kind: "rust", entry: "main.rs" })).toBeNull();
    expect(readWidgetRuntime("python")).toBeNull();
    expect(readWidgetRuntime(["python"])).toBeNull();
  });
});

describe("readWidgetManifest", () => {
  it("still loads a v1 package written before runtime existed", () => {
    const dir = packageDir({
      "widget.json": manifest({ apiVersion: 1 }),
      "index.js": "export default () => ({});",
    });
    const { manifest: read, error } = readWidgetManifest(dir);
    expect(error).toBeUndefined();
    expect(read?.apiVersion).toBe(1);
  });

  it("refuses a version it cannot run, and says which it can", () => {
    const dir = packageDir({
      "widget.json": manifest({ apiVersion: WIDGET_API_VERSION + 1 }),
      "index.js": "export default () => ({});",
    });
    const { error } = readWidgetManifest(dir);
    expect(error).toMatch(/unsupported apiVersion/);
    expect(error).toContain(`${WIDGET_API_VERSION_MIN}..=${WIDGET_API_VERSION}`);
  });
});

describe("resolveRuntimeEntry", () => {
  it("resolves a JavaScript entry by convention", () => {
    const dir = packageDir({ "index.mjs": "export default () => ({});" });
    const { entry, error } = resolveRuntimeEntry(dir, { kind: "javascript", entry: "" });
    expect(error).toBeUndefined();
    expect(entry).toMatch(/index\.mjs$/);
  });

  it("resolves the Python entry the manifest names", () => {
    const dir = packageDir({ "main.py": "print('hi')\n" });
    const { entry, error } = resolveRuntimeEntry(dir, { kind: "python", entry: "main.py" });
    expect(error).toBeUndefined();
    expect(entry).toMatch(/main\.py$/);
  });

  it("requires a .py entry that exists", () => {
    const dir = packageDir({ "main.py": "print('hi')\n" });
    expect(resolveRuntimeEntry(dir, { kind: "python", entry: "" }).error).toMatch(
      /runtime\.entry is required/,
    );
    expect(resolveRuntimeEntry(dir, { kind: "python", entry: "main.js" }).error).toMatch(
      /must end in \.py/,
    );
    expect(resolveRuntimeEntry(dir, { kind: "python", entry: "missing.py" }).error).toMatch(
      /not found/,
    );
  });

  it("refuses an entry outside the package directory", () => {
    // Trust covers a package's own files. An entry elsewhere is code the user
    // never reviewed, so it is refused rather than resolved.
    const dir = packageDir({ "main.py": "print('hi')\n" });
    expect(
      resolveRuntimeEntry(dir, { kind: "python", entry: "../../evil.py" }).error,
    ).toMatch(/escapes the package directory/);
  });

  it("reports a package with no entry of its own", () => {
    const dir = packageDir({ "readme.txt": "nothing here" });
    expect(resolveRuntimeEntry(dir, { kind: "javascript", entry: "" }).error).toMatch(
      /no entry module/,
    );
  });
});
