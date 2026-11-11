import { describe, expect, it } from "vitest";
import {
  createMemoryTool,
  readMemoryOperations,
  renderMemoryResult,
} from "./memory-agent-tool.js";
import { ENTRY_DELIMITER } from "./memory-store.js";

describe("readMemoryOperations", () => {
  it("normalizes each single action", () => {
    expect(readMemoryOperations({ action: "add", content: "a note" })).toEqual({
      operations: [{ action: "add", content: "a note" }],
    });
    expect(readMemoryOperations({ action: "remove", old_text: "a note" })).toEqual({
      operations: [{ action: "remove", old_text: "a note" }],
    });
    expect(
      readMemoryOperations({ action: "patch", old_text: "tea", content: "coffee" }),
    ).toEqual({ operations: [{ action: "patch", old_text: "tea", content: "coffee" }] });
    expect(
      readMemoryOperations({ action: "replace", old_text: "tea", content: "coffee" }),
    ).toEqual({ operations: [{ action: "replace", old_text: "tea", content: "coffee" }] });
  });

  it("requires the fields each action needs", () => {
    expect(readMemoryOperations({ action: "add" })).toHaveProperty("error");
    expect(readMemoryOperations({ action: "patch", content: "x" })).toHaveProperty("error");
    expect(readMemoryOperations({ action: "remove" })).toHaveProperty("error");
    expect(readMemoryOperations({})).toHaveProperty("error");
    expect(readMemoryOperations({ action: "nonsense" })).toHaveProperty("error");
  });

  it("refuses a batch that is not an operations list", () => {
    expect(readMemoryOperations({ action: "batch" })).toHaveProperty("error");
    expect(readMemoryOperations({ operations: [] })).toHaveProperty("error");
  });

  it("refuses both an action and an operations list", () => {
    const result = readMemoryOperations({
      action: "add",
      operations: [{ action: "add", content: "x" }],
    });
    expect(result).toHaveProperty("error");
  });

  it("normalizes a batch and validates each operation", () => {
    expect(
      readMemoryOperations({
        operations: [
          { action: "remove", old_text: "stale" },
          { action: "add", content: "fresh" },
        ],
      }),
    ).toEqual({
      operations: [
        { action: "remove", old_text: "stale" },
        { action: "add", content: "fresh" },
      ],
    });
    const bad = readMemoryOperations({
      operations: [{ action: "remove", old_text: "stale" }, { action: "add" }],
    });
    expect(bad).toHaveProperty("error");
    expect((bad as { error: string }).error).toContain("operation 2");
  });
});

describe("renderMemoryResult", () => {
  it("echoes the new list, because the prompt snapshot is frozen", () => {
    const text = renderMemoryResult("memory", {
      success: true,
      message: "Entry added.",
      entries: ["one", "two"],
    });
    expect(text).toContain("Entry added.");
    expect(text).toContain("2 entries");
    expect(text).toContain(`one${ENTRY_DELIMITER}two`);
  });

  it("shows the budget in use", () => {
    const text = renderMemoryResult("user", {
      success: true,
      message: "Entry added.",
      entries: ["x".repeat(10)],
    });
    expect(text).toContain("/1375");
  });

  it("lists the closest entries when nothing matched", () => {
    const text = renderMemoryResult("memory", {
      success: false,
      error: "No entry matched 'tea'.",
      failureClass: "no_match",
      closestEntries: ["the user prefers coffee"],
    });
    expect(text).toContain("closest_entries:");
    expect(text).toContain("- the user prefers coffee");
  });

  it("lists current entries when the budget is exceeded", () => {
    const text = renderMemoryResult("memory", {
      success: false,
      error: "Would put memory at 3000/2200 chars",
      failureClass: "over_budget",
      currentEntries: ["a big entry"],
    });
    expect(text).toContain("current_entries:");
    expect(text).toContain("- a big entry");
  });
});

/** Minimal host that keeps one target's entries in memory. */
function fakeHost(initial: string[] = []) {
  const state = { entries: [...initial] };
  return {
    state,
    call: async <T>(method: string, params: unknown): Promise<T> => {
      const input = params as { target?: string; entries?: string[] };
      if (method === "memory.entries") {
        return { entries: [...state.entries] } as T;
      }
      if (method === "memory.writeEntries") {
        state.entries = [...(input.entries ?? [])];
        return { entries: [...state.entries] } as T;
      }
      throw new Error(`unexpected method ${method}`);
    },
  };
}

async function run(host: ReturnType<typeof fakeHost>, params: Record<string, unknown>) {
  const tool = createMemoryTool(host as never);
  const result = (await tool.execute(
    "call-1",
    params as never,
    undefined as never,
  )) as { content: { text: string }[]; isError?: boolean; details?: Record<string, unknown> };
  return { text: result.content.map((part) => part.text).join("\n"), isError: result.isError };
}

/** A host plus the skill catalogue the runtime would pass in. */
function runWithSkills(
  host: ReturnType<typeof fakeHost>,
  params: Record<string, unknown>,
  skills: { id: string; name: string; description: string }[],
) {
  const tool = createMemoryTool(host as never, { skills: () => skills });
  return tool
    .execute("call-1", params as never, undefined as never)
    .then((result) => {
      const value = result as {
        content: { text: string }[];
        isError?: boolean;
        details?: Record<string, unknown>;
      };
      return {
        text: value.content.map((part) => part.text).join("\n"),
        isError: value.isError,
        details: value.details,
      };
    });
}

describe("memory refuses what a skill already carries", () => {
  const skill = {
    id: "add-desktop-ipc-channel",
    name: "Add a Desktop IPC Channel",
    description:
      "Use when adding a new frontend IPC channel in PI-Desktop: protocol.ts channel, electron/main/ipc handler, api.ts wrapper, test.",
  };

  it("names the skill instead of storing the procedure twice", async () => {
    // Measured: the same four-step IPC procedure ended up as a skill and as two
    // memory entries, written by two paths that never see each other.
    const host = fakeHost([]);
    const { text, isError, details } = await runWithSkills(
      host,
      {
        target: "memory",
        operations: [
          {
            action: "add",
            content:
              "加新 IPC 通道四步：1. packages/shared/src/protocol.ts 注册通道 → 2. electron/main/ipc 加 handler → 3. src/lib/api.ts 封装 → 4. 补 node --test 用例",
          },
        ],
      },
      [skill],
    );
    expect(isError).toBe(true);
    expect(details?.errorCode).toBe("MEMORY_COVERED_BY_SKILL");
    expect(text).toContain("add-desktop-ipc-channel");
    // Nothing was written.
    expect(host.state.entries).toEqual([]);
  });

  it("still stores a fact that merely mentions the same area", async () => {
    const host = fakeHost([]);
    const { isError } = await runWithSkills(
      host,
      { target: "memory", operations: [{ action: "add", content: "这台机器上 electron 二进制在 D:\Code 下的 dist 目录" }] },
      [skill],
    );
    expect(isError).toBeFalsy();
    expect(host.state.entries).toHaveLength(1);
  });
});

describe("createMemoryTool", () => {
  it("adds an entry and persists it", async () => {
    const host = fakeHost(["existing"]);
    const { text, isError } = await run(host, {
      target: "memory",
      action: "add",
      content: "a new note",
    });
    expect(isError).toBeFalsy();
    expect(text).toContain("Entry added.");
    expect(host.state.entries).toEqual(["existing", "a new note"]);
  });

  it("patches one span and keeps the rest of the entry", async () => {
    const host = fakeHost(["likes tea and biscuits"]);
    await run(host, { target: "user", action: "patch", old_text: "tea", content: "coffee" });
    expect(host.state.entries).toEqual(["likes coffee and biscuits"]);
  });

  it("applies a batch atomically", async () => {
    const host = fakeHost(["stale note", "keep"]);
    await run(host, {
      target: "memory",
      operations: [
        { action: "remove", old_text: "stale note" },
        { action: "add", content: "fresh note" },
      ],
    });
    expect(host.state.entries).toEqual(["keep", "fresh note"]);
  });

  it("reports a refused edit as text so the model can retry, not as a tool error", async () => {
    const host = fakeHost(["the user prefers coffee"]);
    const { text, isError } = await run(host, {
      target: "memory",
      action: "replace",
      old_text: "the user prefers tea",
      content: "x",
    });
    expect(isError).toBeFalsy();
    expect(text).toContain("No entry matched");
    expect(text).toContain("closest_entries:");
    // Nothing was written.
    expect(host.state.entries).toEqual(["the user prefers coffee"]);
  });

  it("rejects a missing target before touching the store", async () => {
    const host = fakeHost(["a"]);
    const { isError, text } = await run(host, { action: "add", content: "x" });
    expect(isError).toBe(true);
    expect(text).toContain("target is required");
    expect(host.state.entries).toEqual(["a"]);
  });

  it("surfaces a write failure as a tool error", async () => {
    const host = fakeHost([]);
    const failing = {
      state: host.state,
      call: async (method: string) => {
        if (method === "memory.entries") return { entries: [] };
        throw new Error("host offline");
      },
    };
    const { isError, text } = await run(failing as never, {
      target: "memory",
      action: "add",
      content: "x",
    });
    expect(isError).toBe(true);
    expect(text).toContain("was not saved");
  });
});

describe("the memory tool scrubs what it stores", () => {
  function harness() {
    const writes: Array<{ target: string; entries: string[] }> = [];
    const host = {
      call: async (method: string, params: never) => {
        if (method === "memory.entries") return { entries: [] };
        if (method === "memory.writeEntries") {
          writes.push(params as { target: string; entries: string[] });
          return {};
        }
        return {};
      },
    };
    return { writes, tool: createMemoryTool(host as never) };
  }

  it("masks a credential before it reaches the host, and says so", async () => {
    const { writes, tool } = harness();
    const result = (await (tool.execute as never as (
      id: string,
      params: unknown,
    ) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }>)(
      "call-1",
      { target: "memory", action: "add", content: "the provider key is sk-ABCDEFGHIJKLMNOPQRST" },
    ));

    expect(writes).toHaveLength(1);
    expect(writes[0].entries[0]).not.toContain("sk-ABCDEFGHIJKLMNOPQRST");
    expect(writes[0].entries[0]).toContain("***REDACTED***");
    expect(result.content[0].text).toContain("***REDACTED***");
    expect(result.details.masked).toBe(true);
  });

  it("says nothing extra when there was nothing to mask", async () => {
    const { writes, tool } = harness();
    const result = (await (tool.execute as never as (
      id: string,
      params: unknown,
    ) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }>)(
      "call-2",
      { target: "memory", action: "add", content: "the relay board is external-only" },
    ));

    expect(writes[0].entries[0]).toContain("external-only");
    expect(result.content[0].text).not.toContain("***REDACTED***");
    expect(result.details.masked).toBeUndefined();
  });
});

/** Host that keeps both stores separate, so a misrouted write is visible. */
function twoStoreHost(initial: { memory?: string[]; user?: string[] } = {}) {
  const state = { memory: [...(initial.memory ?? [])], user: [...(initial.user ?? [])] };
  const writes: Array<{ target: string; entries: string[] }> = [];
  return {
    state,
    writes,
    call: async <T>(method: string, params: unknown): Promise<T> => {
      const input = params as { target?: "memory" | "user"; entries?: string[] };
      if (method === "memory.entries") {
        return { entries: [...(state[input.target ?? "memory"] ?? [])] } as T;
      }
      if (method === "memory.writeEntries") {
        const store = input.target ?? "memory";
        state[store] = [...(input.entries ?? [])];
        writes.push({ target: store, entries: [...state[store]] });
        return { entries: [...state[store]] } as T;
      }
      throw new Error(`unexpected method ${method}`);
    },
  };
}

describe("a batch may address both stores", () => {
  it("routes each operation to the store it names", async () => {
    const host = twoStoreHost({ memory: ["project uses pnpm"], user: ["prefers short replies"] });
    const tool = createMemoryTool(host as never);
    const result = (await (tool.execute as never as (
      id: string,
      params: unknown,
    ) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }>)("call-1", {
      target: "memory",
      operations: [
        { action: "add", content: "release tags are signed" },
        { action: "add", target: "user", content: "works in UTC+8" },
      ],
    }));

    // The pre-fix code dropped the per-operation target and wrote both entries into
    // `memory`, then reported success, so the user store silently lost its entry.
    expect(host.state.memory).toEqual(["project uses pnpm", "release tags are signed"]);
    expect(host.state.user).toEqual(["prefers short replies", "works in UTC+8"]);
    expect(result.details.targets).toEqual(["memory", "user"]);
    expect(result.content[0].text).toContain("works in UTC+8");
  });

  it("writes nothing in either store when one operation is refused", async () => {
    const host = twoStoreHost({ memory: ["keep me"], user: ["keep me too"] });
    const tool = createMemoryTool(host as never);
    const result = (await (tool.execute as never as (
      id: string,
      params: unknown,
    ) => Promise<{ content: Array<{ text: string }> }>)("call-2", {
      target: "memory",
      operations: [
        { action: "add", content: "should not land" },
        { action: "remove", target: "user", old_text: "not present" },
      ],
    }));

    expect(host.state.memory).toEqual(["keep me"]);
    expect(host.state.user).toEqual(["keep me too"]);
    expect(host.writes).toHaveLength(0);
    expect(result.content[0].text).toContain("No entry matched");
  });

  it("rejects an unknown per-operation target instead of dropping it", () => {
    const parsed = readMemoryOperations({
      target: "memory",
      operations: [{ action: "add", target: "project", content: "x" }],
    });
    expect(parsed).toHaveProperty("error");
    expect((parsed as { error: string }).error).toContain("target must be");
  });

  it("keeps one store's batch unchanged when the call names only that store", async () => {
    const host = twoStoreHost({ memory: ["stale"], user: [] });
    const tool = createMemoryTool(host as never);
    await (tool.execute as never as (id: string, params: unknown) => Promise<unknown>)("call-3", {
      target: "memory",
      operations: [{ action: "remove", old_text: "stale" }, { action: "add", content: "fresh" }],
    });
    expect(host.state.memory).toEqual(["fresh"]);
    expect(host.state.user).toEqual([]);
  });
});
