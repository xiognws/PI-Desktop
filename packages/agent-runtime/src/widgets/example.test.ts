/**
 * The shipped example package must actually load and run: it is the one thing a
 * new package author copies, so a drift between the manifest, the entry module
 * and the runner API would be copied too.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { WidgetSummary } from "@pi-workspace/shared";

import { WidgetRunner } from "./runner.js";

const here = dirname(fileURLToPath(import.meta.url));
const exampleDir = join(here, "..", "..", "..", "..", "examples", "widgets", "tide-probe");

describe("examples/widgets/tide-probe", () => {
  it("loads from its manifest and runs a declared action", async () => {
    const runner = new WidgetRunner({ call: async () => ({ entries: [] }) });
    const summary: WidgetSummary = {
      id: "example.tide-probe",
      name: "Tide probe",
      version: "0.1.0",
      description: "example",
      dirName: "tide-probe",
      path: exampleDir,
      requestedPermissions: ["read", "host"],
      grantedPermissions: ["read", "host"],
      actions: [
        { name: "now", description: "time" },
        { name: "remember", description: "count" },
      ],
      enabled: true,
      trust: "trusted" as const,
      digest: "0".repeat(64),
    };

    const states = await runner.load([summary]);

    expect(states).toHaveLength(1);
    expect(states[0]?.state).toBe("loaded");
    expect(states[0]?.actionNames).toEqual(["now", "remember"]);

    const result = await runner.invoke("example.tide-probe", "now", undefined);
    expect(typeof (result.value as { now?: unknown }).now).toBe("string");
  });
});
