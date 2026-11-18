import { describe, expect, it } from "vitest";
import {
  CompressionFailureCooldownStore,
  compressionCooldownDiagnostic,
  compressionFailureCooldownMs,
} from "./compaction-cooldown.js";

describe("compressionFailureCooldownMs", () => {
  it("escalates on the ladder and repeats the last rung", () => {
    expect(compressionFailureCooldownMs(1)).toBe(60_000);
    expect(compressionFailureCooldownMs(2)).toBe(300_000);
    expect(compressionFailureCooldownMs(3)).toBe(900_000);
    expect(compressionFailureCooldownMs(9)).toBe(900_000);
  });

  it("treats a non-finite or zero streak as the first rung", () => {
    expect(compressionFailureCooldownMs(0)).toBe(60_000);
    expect(compressionFailureCooldownMs(Number.NaN)).toBe(60_000);
  });
});

describe("CompressionFailureCooldownStore", () => {
  it("suppresses automatic retries until the deadline lapses", () => {
    const store = new CompressionFailureCooldownStore();
    store.recordFailure("s1", { at: 1_000, error: "provider returned 500" });

    expect(store.active("s1", 1_500)).toMatchObject({
      cooldownUntil: 61_000,
      remainingMs: 59_500,
      consecutiveFailures: 1,
      error: "provider returned 500",
    });
    expect(store.active("s1", 61_000)).toBeUndefined();
    expect(store.active("s2", 1_500)).toBeUndefined();
  });

  it("never pulls an existing deadline forward", () => {
    const store = new CompressionFailureCooldownStore();
    store.recordFailure("s1", { at: 1_000, ladder: [900_000] });
    // A later, shorter write cannot reopen the window it just closed.
    store.recordFailure("s1", { at: 2_000, ladder: [1_000] });

    expect(store.row("s1")).toMatchObject({
      cooldownUntil: 901_000,
      consecutiveFailures: 2,
    });
  });

  it("keeps escalating across expiries and resets only on success", () => {
    const store = new CompressionFailureCooldownStore();
    store.recordFailure("s1", { at: 1_000 });
    expect(store.active("s1", 62_000)).toBeUndefined();
    expect(store.failures("s1")).toBe(1);

    store.recordFailure("s1", { at: 62_000 });
    // Second rung from the new attempt, not a fresh 60s window.
    expect(store.row("s1")?.cooldownUntil).toBe(62_000 + 300_000);

    store.clear("s1");
    expect(store.row("s1")).toBeUndefined();
    expect(store.failures("s1")).toBe(0);
  });

  it("keeps the latest bounded diagnostic", () => {
    const store = new CompressionFailureCooldownStore();
    store.recordFailure("s1", { at: 1_000, error: "first" });
    store.recordFailure("s1", { at: 1_000, error: "x".repeat(1_000) });

    const error = store.row("s1")?.error ?? "";
    expect(error).toHaveLength(400);
    expect(store.row("s1")?.cooldownUntil).toBe(1_000 + 300_000);
  });

  it("ignores an unusable session or timestamp", () => {
    const store = new CompressionFailureCooldownStore();
    expect(store.recordFailure("", { at: 1_000 })).toBeUndefined();
    expect(store.recordFailure("s1", { at: Number.NaN })).toBeUndefined();
    expect(store.row("s1")).toBeUndefined();
  });
});

describe("compressionCooldownDiagnostic", () => {
  it("publishes a bounded remaining time and the streak", () => {
    const store = new CompressionFailureCooldownStore();
    store.recordFailure("s1", { at: 1_000 });
    expect(compressionCooldownDiagnostic(store.active("s1", 1_250))).toEqual({
      coolingDown: true,
      cooldownRemainingMs: 59_750,
      cooldownFailures: 1,
    });
    expect(compressionCooldownDiagnostic(undefined)).toEqual({ coolingDown: false });
  });
});
