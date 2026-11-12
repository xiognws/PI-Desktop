import { describe, expect, it } from "vitest";

import {
  coveredBySkill,
  duplicateOfSkill,
  looksLikeProcedure,
  procedureNeedingASkill,
  topicTokens,
} from "./memory-skill-overlap.js";

const ipcSkill = {
  id: "add-desktop-ipc-channel",
  name: "Add a Desktop IPC Channel",
  description:
    "Use when adding a new frontend IPC channel in PI-Desktop: protocol.ts channel, electron/main/ipc handler, api.ts wrapper, test.",
};

describe("looksLikeProcedure", () => {
  it("separates steps from a sentence", () => {
    expect(
      looksLikeProcedure(
        "本仓库加新 IPC 通道固定四步：1. protocol.ts 注册 → 2. ipc handler → 3. api.ts 封装 → 4. 补测试",
      ),
    ).toBe(true);
    expect(
      looksLikeProcedure(
        "首先在 protocol.ts 注册通道，然后在 electron/main/ipc 加 handler，最后补测试",
      ),
    ).toBe(true);
    expect(looksLikeProcedure("这台机器封了 TCP 22，github 走 gh-proxy")).toBe(false);
    // One ordering word alone is not a procedure.
    expect(looksLikeProcedure("first the disk was full, that is all")).toBe(false);
  });
});

describe("coveredBySkill", () => {
  it("finds the skill a copied procedure came from", () => {
    const entry =
      "给本仓库加新 IPC 通道（前端链路）固定四步：1. packages/shared/src/protocol.ts 注册通道名 → 2. electron/main/ipc 加 handler → 3. src/lib/api.ts 加封装 → 4. 补 node --test 用例";
    expect(coveredBySkill(entry, [ipcSkill])?.skillId).toBe("add-desktop-ipc-channel");
  });

  it("leaves a plain fact alone even when it shares vocabulary", () => {
    // Exactly what memory is for: a fact next to the skill it relates to.
    expect(coveredBySkill("这台机器上 electron 二进制在 D:\\Code 下的 dist 目录", [ipcSkill])).toBeUndefined();
  });

  it("catches a Chinese procedure against an English skill document", () => {
    // The case that escaped in a live session: the catalogue line is one sentence
    // of English, the dictated procedure is Chinese and full of paths, and the
    // one-line description shares exactly one token with it.
    const body = [
      "Fixed four-step procedure for wiring a new Electron IPC channel end to end.",
      "1. Register the channel name in packages/shared/src/protocol.ts.",
      "2. Add the handler under electron/main/ipc.",
      "3. Wrap the call in src/lib/api.ts.",
      "4. Add a node --test case.",
    ].join("\n");
    const entry =
      "桌面端加 IPC 通道四步：1. protocol.ts 注册 → 2. ipc handler 写法 → 3. api 封装 → 4. 补测试";
    expect(coveredBySkill(entry, [{ id: "add-desktop-ipc-channel", description: "Use when adding IPC.", body }])?.skillId).toBe(
      "add-desktop-ipc-channel",
    );
    // The description alone cannot see it: that is why the body is read.
    expect(coveredBySkill(entry, [{ id: "add-desktop-ipc-channel", description: "Use when adding IPC." }])).toBeUndefined();
  });

  it("ignores a procedure that no skill covers", () => {
    const entry = "1. 先跑 git fetch → 2. 再 rebase → 3. 最后 push";
    expect(coveredBySkill(entry, [ipcSkill])).toBeUndefined();
  });
});

describe("duplicateOfSkill", () => {
  it("only judges entries being added", () => {
    const stored = "1. protocol.ts → 2. ipc handler → 3. api.ts 封装";
    // Already stored before the skill existed: a later batch must not refuse.
    expect(duplicateOfSkill([stored], [stored], [ipcSkill])).toBeUndefined();
    const added =
      "加新 IPC 通道四步：1. protocol.ts 注册通道 → 2. electron/main/ipc 加 handler → 3. api.ts 加封装 → 4. 补测试";
    expect(duplicateOfSkill([stored, added], [stored], [ipcSkill])?.skillId).toBe(
      "add-desktop-ipc-channel",
    );
  });
});

describe("procedureNeedingASkill", () => {
  const npmSkill = {
    id: "add-npm-script",
    description: "Use when asked to add or modify an npm script in a project's package.json.",
    body: "Adds a new entry to the scripts block of a project's package.json, then verifies it runs.",
  };

  it("refuses a procedure even when no skill matches its words", () => {
    // The gate is the sentence type: this procedure belongs in a skill whether or
    // not one exists yet, and the lexical comparison is what failed twice live.
    const entry =
      "给某个包加 npm 脚本的做法：1. 打开那个包的 package.json → 2. 在 scripts 里加一条 → 3. 从根目录用 pnpm 跑一次确认能执行";
    const hit = procedureNeedingASkill([entry], [], [npmSkill]);
    expect(hit).toBeDefined();
    expect(hit?.skillId).toBe("add-npm-script");
  });

  it("names no skill when the library has nothing close", () => {
    const entry = "发布流程：1. 先 fetch → 2. 再 rebase → 3. 最后 push";
    const hit = procedureNeedingASkill([entry], [], []);
    expect(hit).toBeDefined();
    expect(hit?.skillId).toBeUndefined();
  });

  it("never re-judges an entry that is already stored", () => {
    const stored = "1. protocol.ts → 2. ipc handler → 3. api.ts 封装";
    expect(procedureNeedingASkill([stored], [stored], [npmSkill])).toBeUndefined();
  });
});

describe("topicTokens", () => {
  it("keeps words and CJK shingles", () => {
    const tokens = topicTokens("IPC 通道 protocol.ts");
    expect(tokens).toContain("ipc");
    expect(tokens).toContain("通道");
  });
});
