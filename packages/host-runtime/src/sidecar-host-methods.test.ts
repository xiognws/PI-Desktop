/**
 * The kernel may only reach the host through methods this proxy allows.
 *
 * `HOST_PROXY_ALLOWED` is a security boundary — the sidecar is a separate process
 * and the list is what keeps it from calling host methods nobody intended it to
 * have. The cost of that design is a silent failure mode: a method the kernel
 * calls but the list omits is refused at runtime with
 * "host method not allowed from sidecar", which reads like a kernel bug and leaves
 * the feature looking deployed while doing nothing. The session ledger shipped
 * exactly that way for one build.
 *
 * So the boundary is checked mechanically instead: every `bridge.call("…")` the
 * kernel source contains must be in the list. Adding a host call to the kernel
 * without adding it here fails this test rather than a user's session.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { HOST_PROXY_ALLOWED } from "./agent-sidecar.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const KERNEL_SOURCES = join(REPO_ROOT, "crates", "agent-core", "src");

function rustFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...rustFiles(full));
      continue;
    }
    if (entry.endsWith(".rs")) out.push(full);
  }
  return out;
}

/** Every `…call("<method>"` literal in the kernel's host-call sites. */
function kernelHostCalls(): Map<string, string[]> {
  const calls = new Map<string, string[]>();
  // `\s*` spans newlines on purpose: the largest call sites are formatted across
  // several lines, and a line-based search silently misses them.
  const pattern = /\.call\(\s*"([a-zA-Z0-9_]+\.[a-zA-Z0-9_.]+)"/g;
  for (const file of rustFiles(KERNEL_SOURCES)) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(pattern)) {
      const method = match[1];
      const where = calls.get(method) ?? [];
      where.push(file.slice(REPO_ROOT.length + 1));
      calls.set(method, where);
    }
  }
  return calls;
}

describe("the sidecar's host proxy", () => {
  it("allows every host method the kernel actually calls", () => {
    const calls = kernelHostCalls();
    // A regex that stopped matching would make the assertion below vacuous, so the
    // scan has to prove it found the call sites it is meant to check.
    expect(calls.size).toBeGreaterThan(5);

    const refused = [...calls.entries()]
      .filter(([method]) => !HOST_PROXY_ALLOWED.has(method))
      .map(([method, where]) => `${method} (called from ${[...new Set(where)].join(", ")})`);

    expect(refused, "add these to HOST_PROXY_ALLOWED in agent-sidecar.ts").toEqual([]);
  });
});
