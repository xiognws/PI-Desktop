import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { startPythonEntry, type PythonSpawn } from "./python-entry.js";

const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "__fixtures__",
  "python-echo.mjs",
);

/*
 * The interpreter is injected, so the fixture is a node process: the protocol is
 * interpreter-agnostic and these tests must not depend on a Python install.
 */
const spawnFixture: PythonSpawn = (_interpreter, entry, cwd, env) =>
  spawn(process.execPath, [entry], {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

function start(): ReturnType<typeof startPythonEntry> {
  return startPythonEntry({
    interpreter: process.execPath,
    entry: fixture,
    cwd: path.dirname(fixture),
    spawn: spawnFixture,
  });
}

describe("python widget entries", () => {
  it("starts the entry and answers a declared action", async () => {
    const entry = start();
    try {
      await entry.ready;
      const value = await entry.request("echo", { hello: "world" }, 5_000);
      expect(value).toEqual({ hello: "world" });
    } finally {
      entry.dispose();
    }
  });

  it("surfaces a program's own error message", async () => {
    const entry = start();
    try {
      await entry.ready;
      await expect(entry.request("boom", {}, 5_000)).rejects.toThrow("kaboom");
    } finally {
      entry.dispose();
    }
  });

  it("gives up on an action that never answers", async () => {
    const entry = start();
    try {
      await entry.ready;
      await expect(entry.request("hang", {}, 150)).rejects.toThrow(/exceeded 150ms/);
    } finally {
      entry.dispose();
    }
  });

  it("rejects in-flight work when the program exits", async () => {
    const entry = start();
    try {
      await entry.ready;
      await expect(entry.request("exit", {}, 5_000)).rejects.toThrow(/exited/);
    } finally {
      entry.dispose();
    }
  });

  it("keeps non-protocol output as logs instead of failing the call", async () => {
    const entry = start();
    try {
      await entry.ready;
      await entry.request("echo", 1, 5_000);
      expect(entry.stderr()).toContain("fixture starting");
    } finally {
      entry.dispose();
    }
  });

  it("refuses work after dispose", async () => {
    const entry = start();
    await entry.ready;
    entry.dispose();
    await expect(entry.request("echo", 1, 1_000)).rejects.toThrow(/disposed/);
  });
});
