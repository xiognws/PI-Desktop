import { describe, expect, it } from "vitest";

import {
  coveredBySkill,
  duplicateOfSkill,
  looksLikeProcedure,
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

describe("topicTokens", () => {
  it("keeps words and CJK shingles", () => {
    const tokens = topicTokens("IPC 通道 protocol.ts");
    expect(tokens).toContain("ipc");
    expect(tokens).toContain("通道");
  });
});
