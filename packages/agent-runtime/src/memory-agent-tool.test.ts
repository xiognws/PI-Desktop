import { describe, expect, it } from "vitest";

import { createMemoryTool, type MemoryToolOptions } from "./memory-agent-tool.js";
import type { SkillSummary } from "./memory-skill-overlap.js";

type Call = { method: string; params: Record<string, unknown> };

/** A host that records the RPC it was asked for, so routing is visible in a test. */
function fakeHost(replies: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  return {
    calls,
    call: async <T>(method: string, params?: unknown): Promise<T> => {
      calls.push({ method, params: (params ?? {}) as Record<string, unknown> });
      if (method in replies) {
        const reply = replies[method];
        if (reply instanceof Error) throw reply;
        return reply as T;
      }
      if (method === "memory.remember") {
        return {
          memory: { id: "m-new", scope: "global", kind: "fact", title: "t", body: "b" },
          deduped: false,
        } as T;
      }
      if (method === "memory.update") return { memory: { id: "m-1" } } as T;
      if (method === "memory.forget") return { removed: 1 } as T;
      if (method === "memory.recall") return { memories: [] } as T;
      throw new Error(`unexpected method ${method}`);
    },
  };
}

type ToolResult = {
  text: string;
  isError: boolean | undefined;
  details: Record<string, unknown>;
};

async function run(
  params: Record<string, unknown>,
  options: { replies?: Record<string, unknown>; toolOptions?: MemoryToolOptions } = {},
): Promise<{ result: ToolResult; host: ReturnType<typeof fakeHost> }> {
  const host = fakeHost(options.replies);
  const tool = createMemoryTool(host, options.toolOptions ?? {});
  const raw = (await tool.execute("call-1", params as never, undefined as never)) as {
    content: { text: string }[];
    isError?: boolean;
    details?: Record<string, unknown>;
  };
  return {
    host,
    result: {
      text: raw.content.map((part) => part.text).join("\n"),
      isError: raw.isError,
      details: raw.details ?? {},
    },
  };
}

const skill: SkillSummary = {
  id: "add-desktop-ipc-channel",
  name: "Add a Desktop IPC Channel",
  description:
    "Use when adding a new frontend IPC channel in PI-Desktop: protocol.ts channel, electron/main/ipc handler, api.ts wrapper, test.",
};

describe("remember", () => {
  it("stores one structured memory through memory.remember", async () => {
    const { result, host } = await run({ action: "remember", title: "Build tool", body: "the repo builds with pnpm" });
    expect(result.isError).toBeFalsy();
    expect(host.calls).toHaveLength(1);
    expect(host.calls[0].method).toBe("memory.remember");
    // `kind` and `scope` are required host-side, so the tool always sends them.
    expect(host.calls[0].params).toEqual({
      scope: "global",
      kind: "fact",
      title: "Build tool",
      body: "the repo builds with pnpm",
    });
    expect(result.text).toContain("m-new");
    expect(result.text).toContain("scope global");
    expect(result.details.action).toBe("remember");
    expect(result.details.id).toBe("m-new");
  });

  it("carries kind, tags, pinned and the project it belongs to", async () => {
    const { host } = await run(
      {
        action: "remember",
        title: "Deploy target",
        body: "the deploy host is sda-build-02",
        kind: "decision",
        tags: ["deploy", "  host  "],
        scope: "project",
        pinned: true,
      },
      { toolOptions: { projectPath: "/w/pi", sessionId: "s1" } },
    );
    expect(host.calls[0].params).toEqual({
      scope: "project",
      kind: "decision",
      title: "Deploy target",
      body: "the deploy host is sda-build-02",
      tags: ["deploy", "host"],
      pinned: true,
      projectPath: "/w/pi",
    });
  });

  it("scopes to the conversation when asked", async () => {
    const { host } = await run(
      { action: "remember", title: "t", body: "this run is on the release branch", scope: "session" },
      { toolOptions: { projectPath: "/w/pi", sessionId: "s1" } },
    );
    expect(host.calls[0].params).toMatchObject({ scope: "session", sessionId: "s1" });
    expect(host.calls[0].params).not.toHaveProperty("projectPath");
  });

  it("refuses a project scope in a session with no project, before any RPC", async () => {
    const { result, host } = await run({
      action: "remember",
      title: "t",
      body: "b",
      scope: "project",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("needs an open project");
    expect(host.calls).toHaveLength(0);
  });

  it("requires a title and a body", async () => {
    const noTitle = await run({ action: "remember", body: "b" });
    expect(noTitle.result.isError).toBe(true);
    expect(noTitle.result.text).toContain("title is required");
    const noBody = await run({ action: "remember", title: "t" });
    expect(noBody.result.isError).toBe(true);
    expect(noBody.result.text).toContain("body is required");
    expect(noTitle.host.calls).toHaveLength(0);
    expect(noBody.host.calls).toHaveLength(0);
  });

  it("rejects an unknown kind or scope instead of forwarding it", async () => {
    const badKind = await run({ action: "remember", title: "t", body: "b", kind: "gossip" });
    expect(badKind.result.details.errorCode).toBe("MEMORY_INVALID_ARGUMENT");
    expect(badKind.host.calls).toHaveLength(0);
    const badScope = await run({ action: "remember", title: "t", body: "b", scope: "universe" });
    expect(badScope.result.details.errorCode).toBe("MEMORY_INVALID_ARGUMENT");
    expect(badScope.host.calls).toHaveLength(0);
  });

  it("says when the write refreshed an existing memory", async () => {
    const { result } = await run(
      { action: "remember", title: "t", body: "b" },
      {
        replies: {
          "memory.remember": {
            memory: { id: "m-1", title: "t", kind: "fact" },
            deduped: true,
          },
        },
      },
    );
    expect(result.text).toContain("Already stored");
    expect(result.details.deduped).toBe(true);
  });

  it("surfaces a host failure as a tool error", async () => {
    const { result } = await run(
      { action: "remember", title: "t", body: "b" },
      { replies: { "memory.remember": new Error("host offline") } },
    );
    expect(result.isError).toBe(true);
    expect(result.details.errorCode).toBe("MEMORY_WRITE_FAILED");
    expect(result.text).toContain("host offline");
  });

  it("masks a credential before it reaches the host, and says so", async () => {
    const { result, host } = await run({
      action: "remember",
      title: "provider key",
      body: "the provider key is sk-abcdefghijklmnop",
    });
    const sent = `${String(host.calls[0].params.title)} ${String(host.calls[0].params.body)}`;
    expect(sent).not.toContain("sk-abcdefghijklmnop");
    expect(sent).toContain("***REDACTED***");
    expect(result.details.masked).toBe(true);
    expect(result.text).toContain("***REDACTED***");
  });

  it("says nothing extra when there was nothing to mask", async () => {
    const { result } = await run({
      action: "remember",
      title: "Relay board",
      body: "the relay board is external-only",
    });
    expect(result.details.masked).toBeUndefined();
    expect(result.text).not.toContain("***REDACTED***");
  });
});

describe("the procedure gate", () => {
  it("refuses a procedure and names the skill to patch instead", async () => {
    // Measured: the same four-step procedure landed in the library *and* in
    // memory, written by two paths that never see each other's writes.
    const { result, host } = await run(
      {
        action: "remember",
        title: "Adding an IPC channel",
        body: "加新 IPC 通道四步：1. packages/shared/src/protocol.ts 注册通道 → 2. electron/main/ipc 加 handler → 3. src/lib/api.ts 封装 → 4. 补 node --test 用例",
      },
      { toolOptions: { skills: () => [skill] } },
    );
    expect(result.isError).toBe(true);
    expect(result.details.errorCode).toBe("MEMORY_PROCEDURE_NEEDS_SKILL");
    expect(result.details.skillId).toBe("add-desktop-ipc-channel");
    expect(result.text).toContain("add-desktop-ipc-channel");
    // Nothing was written.
    expect(host.calls).toHaveLength(0);
  });

  it("still stores a fact that merely mentions the same area", async () => {
    const { result, host } = await run(
      {
        action: "remember",
        title: "Electron binaries",
        body: "这台机器上 electron 二进制在 D:\\Code 下的 dist 目录",
      },
      { toolOptions: { skills: () => [skill] } },
    );
    expect(result.isError).toBeFalsy();
    expect(host.calls).toHaveLength(1);
    expect(host.calls[0].method).toBe("memory.remember");
  });

  it("does not gate update or search", async () => {
    // Retrieval and patching an existing memory must never be blocked by the
    // shape of a sentence the agent did not write this time.
    const updated = await run(
      { action: "update", id: "m-1", body: "1. first step → 2. second step" },
      { toolOptions: { skills: () => [skill] } },
    );
    expect(updated.result.isError).toBeFalsy();
    expect(updated.host.calls[0].method).toBe("memory.update");
    const searched = await run(
      { action: "search", query: "first step second step" },
      { toolOptions: { skills: () => [skill] } },
    );
    expect(searched.result.isError).toBeFalsy();
    expect(searched.host.calls[0].method).toBe("memory.recall");
  });
});

describe("update", () => {
  it("sends only the fields it was given", async () => {
    const { result, host } = await run({ action: "update", id: "m-1", body: "the deploy host moved" });
    expect(result.isError).toBeFalsy();
    expect(host.calls[0]).toEqual({
      method: "memory.update",
      params: { id: "m-1", body: "the deploy host moved" },
    });
    expect(result.details.fields).toEqual(["body"]);
    expect(result.text).toContain("m-1");
  });

  it("passes tags, pinned and confidence through", async () => {
    const { host } = await run({
      action: "update",
      id: "m-1",
      tags: ["deploy"],
      pinned: false,
      confidence: 0.4,
    });
    expect(host.calls[0].params).toEqual({
      id: "m-1",
      tags: ["deploy"],
      pinned: false,
      confidence: 0.4,
    });
  });

  it("requires an id and at least one field", async () => {
    const noId = await run({ action: "update", body: "x" });
    expect(noId.result.details.errorCode).toBe("MEMORY_INVALID_ARGUMENT");
    const nothing = await run({ action: "update", id: "m-1" });
    expect(nothing.result.isError).toBe(true);
    expect(nothing.result.text).toContain("nothing to update");
    expect(noId.host.calls).toHaveLength(0);
    expect(nothing.host.calls).toHaveLength(0);
  });

  it("rejects a confidence outside 0..1", async () => {
    const { result, host } = await run({ action: "update", id: "m-1", confidence: 4 });
    expect(result.details.errorCode).toBe("MEMORY_INVALID_ARGUMENT");
    expect(host.calls).toHaveLength(0);
  });

  it("turns a missing memory into a search hint", async () => {
    const { result } = await run(
      { action: "update", id: "m-gone", body: "x" },
      { replies: { "memory.update": new Error("memory m-gone not found: no rows") } },
    );
    expect(result.isError).toBe(true);
    expect(result.details.errorCode).toBe("MEMORY_NOT_FOUND");
    expect(result.text).toContain("No memory with id m-gone");
  });
});

describe("forget", () => {
  it("deletes by id", async () => {
    const { result, host } = await run({ action: "forget", id: "m-1" });
    expect(host.calls[0]).toEqual({ method: "memory.forget", params: { id: "m-1" } });
    expect(result.text).toContain("Forgot memory m-1");
    expect(result.details.removed).toBe(1);
  });

  it("says nothing was there instead of claiming success", async () => {
    const { result } = await run(
      { action: "forget", id: "m-missing" },
      { replies: { "memory.forget": { removed: 0 } } },
    );
    expect(result.isError).toBeFalsy();
    expect(result.text).toContain("nothing was removed");
    expect(result.details.removed).toBe(0);
  });

  it("requires an id", async () => {
    const { result, host } = await run({ action: "forget" });
    expect(result.details.errorCode).toBe("MEMORY_INVALID_ARGUMENT");
    expect(host.calls).toHaveLength(0);
  });
});

describe("search", () => {
  const hits = {
    "memory.recall": {
      memories: [
        {
          memory: {
            id: "m-1",
            kind: "preference",
            title: "Reply language",
            body: "prefers Chinese replies",
            tags: ["language"],
            confidence: 0.9,
          },
          score: -1.2,
        },
        {
          memory: { id: "m-2", kind: "fact", title: "Deploy host", body: "sda-build-02" },
          score: -2.4,
        },
      ],
    },
  };

  it("asks the host with the query, the limit and the session scope", async () => {
    const { host } = await run(
      { action: "search", query: "reply language", limit: 3 },
      { toolOptions: { projectPath: "/w/pi", sessionId: "s1" }, replies: hits },
    );
    expect(host.calls[0]).toEqual({
      method: "memory.recall",
      params: { query: "reply language", limit: 3, projectPath: "/w/pi", sessionId: "s1" },
    });
  });

  it("defaults the limit and caps it at the host maximum", async () => {
    const fallback = await run({ action: "search", query: "deploy" });
    expect(fallback.host.calls[0].params.limit).toBe(8);
    const capped = await run({ action: "search", query: "deploy", limit: 500 });
    expect(capped.host.calls[0].params.limit).toBe(50);
  });

  it("renders title, kind, tags, score and id in the host's order", async () => {
    const { result } = await run({ action: "search", query: "reply" }, { replies: hits });
    expect(result.isError).toBeFalsy();
    expect(result.text).toContain("2 memories matched 'reply', best first:");
    const first = result.text.indexOf("Reply language");
    const second = result.text.indexOf("Deploy host");
    // Re-sorting here would throw the host's ranking away.
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
    expect(result.text).toContain("[preference] Reply language (tags: language) — id m-1");
    expect(result.text).toContain("score -1.200");
    expect(result.text).toContain("prefers Chinese replies");
    expect(result.text).toContain("id m-2");
    expect(result.details.hits).toBe(2);
  });

  it("trims a long body so one memory cannot crowd out the rest", async () => {
    const { result } = await run(
      { action: "search", query: "long" },
      {
        replies: {
          "memory.recall": {
            memories: [{ memory: { id: "m-1", title: "Long", body: "x".repeat(1000) }, score: 0 }],
          },
        },
      },
    );
    expect(result.text).toContain("…");
    expect(result.text.length).toBeLessThan(600);
  });

  it("says plainly when nothing matched", async () => {
    const { result } = await run({ action: "search", query: "nothing here" });
    expect(result.isError).toBeFalsy();
    expect(result.text).toContain("No memory matched 'nothing here'");
    expect(result.details.hits).toBe(0);
  });

  it("skips a hit with no content", async () => {
    const { result } = await run(
      { action: "search", query: "empty" },
      { replies: { "memory.recall": { memories: [{ memory: { id: "m-1", title: "  ", body: " " } }] } } },
    );
    expect(result.text).toContain("No memory matched");
  });

  it("requires a query and reports a host failure", async () => {
    const missing = await run({ action: "search" });
    expect(missing.result.details.errorCode).toBe("MEMORY_INVALID_ARGUMENT");
    expect(missing.host.calls).toHaveLength(0);
    const failed = await run(
      { action: "search", query: "deploy" },
      { replies: { "memory.recall": new Error("host offline") } },
    );
    expect(failed.result.isError).toBe(true);
    expect(failed.result.details.errorCode).toBe("MEMORY_SEARCH_FAILED");
  });
});

describe("the action is required", () => {
  it("names the four actions when it is missing or unknown", async () => {
    const missing = await run({});
    expect(missing.result.isError).toBe(true);
    expect(missing.result.details.errorCode).toBe("MEMORY_INVALID_ACTION");
    expect(missing.result.text).toContain("remember");
    const unknown = await run({ action: "add" });
    expect(unknown.result.details.errorCode).toBe("MEMORY_INVALID_ACTION");
    expect(unknown.host.calls).toHaveLength(0);
  });
});
