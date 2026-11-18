import { describe, expect, it } from "vitest";

import {
  COMPRESS_TOOL_NAME,
  MAX_COMPRESSION_REASON_CHARS,
  compressionReason,
  createCompressTool,
  queueCompressionRequest,
  type CompressionRequestOutcome,
  type PendingCompression,
} from "./compress-agent-tool.js";

/** A host that records what the tool asked for and answers with one verdict. */
function hostReturning(outcome: CompressionRequestOutcome) {
  const calls: Array<string | undefined> = [];
  return {
    calls,
    host: {
      requestCompression: (reason?: string): CompressionRequestOutcome => {
        calls.push(reason);
        return outcome;
      },
    },
  };
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((part) => (part.type === "text" ? part.text ?? "" : "")).join("\n");
}

const pending = (at: number, manual = true, note?: string): PendingCompression => ({
  at,
  manual,
  ...(note ? { note } : {}),
});

describe("compress tool", () => {
  it("takes one optional reason and nothing else", () => {
    const tool = createCompressTool(hostReturning("queued").host);
    expect(tool.name).toBe(COMPRESS_TOOL_NAME);
    expect(COMPRESS_TOOL_NAME).toBe("compress");
    const schema = tool.parameters as { properties: Record<string, unknown>; additionalProperties?: boolean };
    expect(Object.keys(schema.properties)).toEqual(["reason"]);
    expect(schema.additionalProperties).toBe(false);
    // A model mid-batch must not run this beside a file tool: the queue is
    // runtime state, not a call-local effect.
    expect(tool.executionMode).toBe("sequential");
  });

  it("says when not to use it, and what compression costs", () => {
    const tool = createCompressTool(hostReturning("queued").host);
    expect(tool.description).toContain("summary");
    expect(tool.description).toContain("next turn boundary");
    expect(tool.description).toContain("Call it once");
    expect(tool.description).toContain("clearly longer");
  });

  it("queues the first request and passes the reason through", async () => {
    const fake = hostReturning("queued");
    const tool = createCompressTool(fake.host);
    const result = await tool.execute("call-1", { reason: "long tool output" });

    expect(fake.calls).toEqual(["long tool output"]);
    expect(textOf(result)).toContain("Compression queued");
    expect(result.details).toMatchObject({ queued: true, reason: "long tool output" });
    expect(result.isError).toBeUndefined();
  });

  it("queues without a reason when the model gives none", async () => {
    const fake = hostReturning("queued");
    const tool = createCompressTool(fake.host);
    const result = await tool.execute("call-1", {});

    expect(fake.calls).toEqual([undefined]);
    expect(textOf(result)).toContain("Compression queued");
    expect(result.details).not.toHaveProperty("reason");
  });

  it("reports a request that is already queued instead of adding one", async () => {
    const tool = createCompressTool(hostReturning("already-queued").host);
    const result = await tool.execute("call-2", { reason: "again" });

    expect(textOf(result)).toContain("already queued");
    expect(result.details).toMatchObject({ queued: true, alreadyQueued: true });
  });

  it("reports a session where compression is disabled", async () => {
    const tool = createCompressTool(hostReturning("disabled").host);
    const result = await tool.execute("call-1", { reason: "full" });

    expect(textOf(result)).toContain("disabled for this session");
    expect(result.details).toMatchObject({ queued: false, disabled: true });
    // Retrying cannot turn the setting on, so this is not an error the model
    // should spend a turn on.
    expect(result.isError).toBeUndefined();
  });

  it("refuses a non-string reason without reaching the runtime", async () => {
    const fake = hostReturning("queued");
    const tool = createCompressTool(fake.host);
    const result = await tool.execute("call-1", { reason: 42 } as unknown as Record<string, unknown>);

    expect(fake.calls).toEqual([]);
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({ errorCode: "COMPRESSION_INVALID_ARGUMENT" });
  });

  it("caps the reason the runtime stores", async () => {
    const fake = hostReturning("queued");
    const tool = createCompressTool(fake.host);
    await tool.execute("call-1", { reason: "x".repeat(MAX_COMPRESSION_REASON_CHARS * 2) });

    const sent = fake.calls[0] ?? "";
    expect(sent).toHaveLength(MAX_COMPRESSION_REASON_CHARS);
    expect(sent.endsWith("…")).toBe(true);
  });
});

describe("compressionReason", () => {
  it("trims, collapses whitespace and keeps a short line intact", () => {
    expect(compressionReason("  too   much\nlog noise  ")).toBe("too much log noise");
  });

  it("treats an empty or non-string reason as absent", () => {
    expect(compressionReason("   ")).toBeUndefined();
    expect(compressionReason(undefined)).toBeUndefined();
    expect(compressionReason(7)).toBeUndefined();
    expect(compressionReason({ text: "no" })).toBeUndefined();
  });

  it("caps long text at the documented length, ellipsis included", () => {
    const capped = compressionReason("y".repeat(MAX_COMPRESSION_REASON_CHARS + 60));
    expect(capped).toHaveLength(MAX_COMPRESSION_REASON_CHARS);
    expect(capped?.endsWith("…")).toBe(true);
  });
});

describe("queueCompressionRequest", () => {
  it("queues the first request as a manual checkpoint", () => {
    const { outcome, pending: next } = queueCompressionRequest({
      pending: undefined,
      enabled: true,
      reason: "history is mostly build logs",
      at: 1_000,
    });
    expect(outcome).toBe("queued");
    expect(next).toEqual({
      at: 1_000,
      manual: true,
      note: "history is mostly build logs",
    });
  });

  it("keeps the queued entry untouched when a second request arrives", () => {
    const queued = pending(1_000, true, "first");
    const { outcome, pending: next } = queueCompressionRequest({
      pending: queued,
      enabled: true,
      reason: "second",
      at: 2_000,
    });
    // Same entry, not a refreshed one: a model calling this every turn must not
    // keep postponing the boundary that consumes it.
    expect(outcome).toBe("already-queued");
    expect(next).toBe(queued);
  });

  it("recognises a request queued by new_context as already queued", () => {
    const fromNewContext = pending(1_000, false);
    const { outcome } = queueCompressionRequest({
      pending: fromNewContext,
      enabled: true,
      at: 2_000,
    });
    expect(outcome).toBe("already-queued");
  });

  it("refuses while compaction is disabled and leaves the queue alone", () => {
    const { outcome, pending: next } = queueCompressionRequest({
      pending: undefined,
      enabled: false,
      reason: "no room",
      at: 1_000,
    });
    expect(outcome).toBe("disabled");
    expect(next).toBeUndefined();
  });

  it("queues nothing above the cap and everything below it", () => {
    const long = queueCompressionRequest({
      pending: undefined,
      enabled: true,
      reason: "z".repeat(MAX_COMPRESSION_REASON_CHARS * 3),
      at: 5,
    });
    expect(long.pending?.note).toHaveLength(MAX_COMPRESSION_REASON_CHARS);

    const blank = queueCompressionRequest({
      pending: undefined,
      enabled: true,
      reason: "   ",
      at: 5,
    });
    expect(blank.outcome).toBe("queued");
    expect(blank.pending).toEqual({ at: 5, manual: true });
  });
});
