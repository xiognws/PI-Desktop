import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const read = (path) => readFileSync(join(here, "..", path), "utf8");

const settingsPage = read("src/features/settings/SettingsPage.tsx");
const settingsNav = read("src/lib/settings-search.ts");
const pane = read("src/components/settings/MemoryPane.tsx");
const api = read("src/lib/api.ts");
const memoryIpc = read("electron/main/ipc/memory-ipc.ts");
const register = read("electron/main/ipc/register.ts");
const protocol = read("../../packages/shared/src/protocol.ts");
const en = read("../../packages/i18n/src/locales/en/index.ts");
const zh = read("../../packages/i18n/src/locales/zh-CN/index.ts");

// Source-oriented like the neighbouring desktop contracts: it catches the IA,
// wiring and i18n regressions without opening an Electron window.

test("memory is a first-class settings destination", () => {
  assert.match(settingsNav, /\| "memory"/);
  assert.match(settingsNav, /id: "memory",\s*\n\s*labelKey: "settings\.nav\.memory"/);
  assert.match(settingsPage, /import \{ MemoryPane \} from "\.\.\/\.\.\/components\/settings\/MemoryPane"/);
  assert.match(settingsPage, /tab === "memory" && <MemoryPane \/>/);
});

test("every memory channel is registered and forwarded to its host method", () => {
  const channels = ["memoryList", "memoryStats", "memoryUpdate", "memoryForget", "memoryTidy", "memorySupersede"];
  for (const channel of channels) {
    assert.match(protocol, new RegExp(`${channel}: "pi-desktop/memory/`), `protocol is missing ${channel}`);
    assert.match(memoryIpc, new RegExp(`IPC\\.invoke\\.${channel}`), `memory-ipc does not handle ${channel}`);
  }
  const methods = ["memory.list", "memory.stats", "memory.update", "memory.forget", "memory.tidy", "memory.supersede"];
  for (const method of methods) {
    assert.match(memoryIpc, new RegExp(`"${method.replace(".", "\\.")}"`), `memory-ipc never calls ${method}`);
  }
  assert.match(register, /registerMemoryIpc\(\{ registrar, getHost \}\)/);
});

test("the IPC bridge forwards only host-shaped fields", () => {
  // A renderer must not be able to smuggle arbitrary keys into host params.
  assert.match(memoryIpc, /function pickString/);
  assert.match(memoryIpc, /function pickBoolean/);
  assert.doesNotMatch(memoryIpc, /forward\("memory\.\w+", input\)/);
  assert.match(memoryIpc, /listParams\(input\)/);
  assert.match(memoryIpc, /updateParams\(input\)/);
});

test("the pane uses shared primitives instead of raw controls", () => {
  assert.match(pane, /from "\.\.\/ui"/);
  for (const primitive of ["Button", "Badge", "Input", "SegmentedControl"]) {
    assert.match(pane, new RegExp(`\\b${primitive}\\b`), `MemoryPane does not use ${primitive}`);
  }
  assert.doesNotMatch(pane, /<button\b/, "MemoryPane must not hand-roll a button");
  assert.doesNotMatch(pane, /className="badge-/, "MemoryPane must not hand-roll a badge");
  // Every visible string goes through i18n.
  assert.doesNotMatch(pane, />\s*(Delete|Pin|Clean up|Search)\s*</);
});

test("the renderer api exposes the memory surface", () => {
  for (const method of ["listMemories", "memoryStats", "updateMemory", "forgetMemory", "tidyMemories", "supersedeMemory"]) {
    assert.match(api, new RegExp(`${method}:`), `api.ts is missing ${method}`);
  }
  assert.match(api, /export type MemoryRecord/);
});

test("both shipped locales carry every memory key", () => {
  const keys = [
    "memoryIntro", "memorySearchPlaceholder", "memoryFilterAll", "memoryScopeGlobal",
    "memoryScopeProject", "memoryScopeSession", "memoryKindFact", "memoryKindPreference",
    "memoryKindDecision", "memoryKindPitfall", "memoryKindProcedure", "memoryPinned",
    "memoryPin", "memoryUnpin", "memoryDelete", "memoryDeleteConfirm", "memoryTidy",
    "memoryTidying", "memoryTidyDone", "memoryEmpty", "memoryEmptyFiltered", "memoryLoading",
    "memoryStatsLine", "memoryMeta", "memorySuperseded",
  ];
  for (const key of keys) {
    assert.match(en, new RegExp(`^\\s*${key}: `, "m"), `en is missing settings.${key}`);
    assert.match(zh, new RegExp(`^\\s*${key}: `, "m"), `zh-CN is missing settings.${key}`);
  }
  assert.match(en, /^\s*memory: "Memory",/m);
  assert.match(zh, /^\s*memory: "记忆",/m);
});
