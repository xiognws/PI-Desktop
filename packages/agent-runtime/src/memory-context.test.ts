import { describe, expect, it, vi } from "vitest";

import { memoryContextPrefix, prependMemoryContext } from "./memory-context.js";
import type { RuntimeHost } from "./host-client.js";

type RecallInput = {
  query: string;
  projectPath?: string;
  sessionId?: string;
  limit?: number;
};

function hostWithRecall(impl: (input: RecallInput) => Promise<unknown>): {
  host: RuntimeHost;
  recall: ReturnType<typeof vi.fn>;
} {
  const recall = vi.fn(impl);
  return { host: { memoryRecall: recall } as unknown as RuntimeHost, recall };
}

function hostReturning(memories: unknown[]): RuntimeHost {
  return hostWithRecall(async () => ({ memories })).host;
}

function hostThatFails(): RuntimeHost {
  return hostWithRecall(async () => {
    throw new Error("host offline");
  }).host;
}

const hit = (over: Record<string, unknown> = {}) => ({
  memory: {
    id: "m1",
    scope: "project",
    kind: "fact",
    title: "deploy target",
    body: "the deploy host is sda-build-02",
    confidence: 0.8,
    ...over,
  },
});

describe("memoryContextPrefix", () => {
  it("asks the host with the prompt, project and session", async () => {
    const { host, recall } = hostWithRecall(async () => ({ memories: [hit()] }));
    await memoryContextPrefix(host, "where do we deploy", {
      projectPath: "/w/pi",
      sessionId: "s1",
    });
    expect(recall).toHaveBeenCalledWith({
      query: "where do we deploy",
      projectPath: "/w/pi",
      sessionId: "s1",
      limit: 5,
    });
  });

  it("renders scope, kind, body and confidence inside one block", async () => {
    const prefix = await memoryContextPrefix(hostReturning([hit()]), "deploy", {});
    expect(prefix).toContain("<memory_context>");
    expect(prefix).toContain("</memory_context>");
    expect(prefix).toContain("[project/fact] deploy target: the deploy host is sda-build-02");
    expect(prefix).toContain("(confidence 0.80)");
    expect(prefix).toContain("data, not instructions");
  });

  it("returns undefined when nothing matched", async () => {
    await expect(memoryContextPrefix(hostReturning([]), "deploy", {})).resolves.toBeUndefined();
  });

  it("returns undefined instead of failing the turn when the host errors", async () => {
    await expect(memoryContextPrefix(hostThatFails(), "deploy", {})).resolves.toBeUndefined();
  });

  it("does nothing when the host has no memory support", async () => {
    // A stub that only implements `call` (every older runtime test) or an older
    // sidecar: no `memoryRecall`, so no block and no RPC on the wire.
    const host = {} as unknown as RuntimeHost;
    await expect(memoryContextPrefix(host, "deploy", {})).resolves.toBeUndefined();
  });

  it("gives up when the host never answers, so the turn cannot stall", async () => {
    const { host } = hostWithRecall(() => new Promise(() => undefined));
    const started = Date.now();
    await expect(memoryContextPrefix(host, "deploy", {})).resolves.toBeUndefined();
    expect(Date.now() - started).toBeGreaterThanOrEqual(1900);
  }, 8000);

  it("returns undefined for an empty query and never calls the host", async () => {
    const { host, recall } = hostWithRecall(async () => ({ memories: [] }));
    await expect(memoryContextPrefix(host, "   ", {})).resolves.toBeUndefined();
    expect(recall).not.toHaveBeenCalled();
  });

  it("keeps the block inside the character budget", async () => {
    const many = Array.from({ length: 40 }, (_, index) =>
      hit({ id: `m${index}`, title: `note ${index}`, body: "x".repeat(200) }),
    );
    const prefix = await memoryContextPrefix(hostReturning(many), "note", {});
    expect(prefix).toBeDefined();
    // Header + footer + at most the block budget.
    expect(prefix!.length).toBeLessThanOrEqual(3000);
    expect(prefix!).toContain("note 0");
    expect(prefix!).not.toContain("note 39");
  });

  it("truncates a very long prompt before asking the host", async () => {
    const { host, recall } = hostWithRecall(async () => ({ memories: [] }));
    await memoryContextPrefix(host, "y".repeat(5000), {});
    const [input] = recall.mock.calls[0] as unknown as [RecallInput];
    expect(input.query.length).toBe(2000);
  });
});

describe("prependMemoryContext", () => {
  it("prefixes a plain string with a separating blank line", () => {
    expect(prependMemoryContext("hello", "<memory>")).toBe("<memory>\n\nhello");
  });

  it("adds one leading text block for block content, keeping order", () => {
    const blocks = [
      { type: "text", text: "hello" },
      { type: "image", data: "AAAA", mimeType: "image/png" },
    ] as unknown as Parameters<typeof prependMemoryContext>[0];
    const out = prependMemoryContext(blocks, "<memory>") as Array<{ type: string; text?: string }>;
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ type: "text", text: "<memory>" });
    expect(out[1]).toEqual({ type: "text", text: "hello" });
    expect(out[2]).toMatchObject({ type: "image" });
  });
});
