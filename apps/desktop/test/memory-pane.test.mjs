import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-workspace/i18n";
import { createServer } from "vite";

import { MEMORY_PAGE_SIZE, memoryView } from "../src/lib/memory-view.ts";

const here = dirname(fileURLToPath(import.meta.url));
const read = (path) => readFileSync(join(here, "..", path), "utf8");

const settingsPage = read("src/features/settings/SettingsPage.tsx");
const settingsNav = read("src/lib/settings-search.ts");
const pane = read("src/components/settings/MemoryPane.tsx");
const rows = read("src/components/settings/MemoryList.tsx");
const api = read("src/lib/api.ts");
const memoryIpc = read("electron/main/ipc/memory-ipc.ts");
const register = read("electron/main/ipc/register.ts");
const protocol = read("../../packages/shared/src/protocol.ts");
const locales = readdirSync(join(here, "..", "..", "..", "packages", "i18n", "src", "locales"));

/** One structured memory row, as `memory.list` returns it. */
const record = (overrides = {}) => ({
  id: "m-1",
  scope: "global",
  projectPath: null,
  sessionId: null,
  kind: "fact",
  title: "Cache root",
  body: "D:/PiWorkspace/cache holds the temp dir",
  tags: [],
  source: "agent",
  confidence: 0.7,
  pinned: false,
  useCount: 0,
  createdAt: 1,
  updatedAt: 1,
  lastUsedAt: null,
  validFrom: 1,
  validUntil: null,
  supersededBy: null,
  ...overrides,
});

/** Render the real row component through server rendering and the real locale. */
async function renderRows(t, records, locale = "en") {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  t.after(() => server.close());
  const { MemoryList } = await server.ssrLoadModule("/src/components/settings/MemoryList.tsx");
  const i18n = createInstance();
  await i18n.init({ lng: locale, resources: { [locale]: { translation: catalogs[locale] } } });
  return renderToStaticMarkup(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(MemoryList, {
        records,
        busyId: null,
        onTogglePin: () => {},
        onForget: () => {},
      }),
    ),
  );
}

// Source-oriented like the neighbouring desktop contracts for the wiring, real
// server rendering for what a person sees in a row.

test("memory is a first-class settings destination", () => {
  assert.match(settingsNav, /\| "memory"/);
  assert.match(settingsNav, /id: "memory",\s*\n\s*labelKey: "settings\.nav\.memory"/);
  assert.match(settingsPage, /import \{ MemoryPane \} from "\.\.\/\.\.\/components\/settings\/MemoryPane"/);
  assert.match(settingsPage, /tab === "memory" && <MemoryPane \/>/);
});

test("every memory channel is registered and forwarded to its host method", () => {
  const channels = [
    "memoryList",
    "memoryRecall",
    "memoryStats",
    "memoryUpdate",
    "memoryForget",
    "memoryTidy",
    "memorySupersede",
  ];
  for (const channel of channels) {
    assert.match(protocol, new RegExp(`${channel}: "pi-desktop/memory/`), `protocol is missing ${channel}`);
    assert.match(memoryIpc, new RegExp(`IPC\\.invoke\\.${channel}`), `memory-ipc does not handle ${channel}`);
  }
  const methods = [
    "memory.list",
    "memory.recall",
    "memory.stats",
    "memory.update",
    "memory.forget",
    "memory.tidy",
    "memory.supersede",
  ];
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
  assert.match(memoryIpc, /recallParams\(input\)/);
  assert.match(memoryIpc, /updateParams\(input\)/);
});

test("the pane uses shared primitives instead of raw controls", () => {
  for (const source of [pane, rows]) {
    assert.match(source, /from "\.\.\/ui"/);
    const primitives = source === rows ? ["Button", "Badge"] : ["Button", "Input", "SegmentedControl"];
    for (const primitive of primitives) {
      assert.match(source, new RegExp(`\\b${primitive}\\b`), `memory UI does not use ${primitive}`);
    }
    assert.doesNotMatch(source, /<button\b/, "memory UI must not hand-roll a button");
    assert.doesNotMatch(source, /className="badge-/, "memory UI must not hand-roll a badge");
    // Every visible string goes through i18n.
    assert.doesNotMatch(source, />\s*(Delete|Pin|Unpin|Clean up|Search|Used)\s*</);
  }
});

test("the renderer api exposes the structured memory surface", () => {
  for (const method of [
    "listMemories",
    "recallMemories",
    "memoryStats",
    "updateMemory",
    "forgetMemory",
    "tidyMemories",
    "supersedeMemory",
  ]) {
    assert.match(api, new RegExp(`${method}:`), `api.ts is missing ${method}`);
  }
  assert.match(api, /export type MemoryRecord/);
  assert.match(api, /export type MemoryHit/);
});

test("the retired flat entry list is gone from the page and its wrappers", () => {
  // ADR 0393: `memories` is the single store. The agent-entry section, its
  // per-entry delete and the legacy merge button have no store left to edit.
  assert.doesNotMatch(pane, /memoryEntries/);
  assert.doesNotMatch(pane, /writeMemoryEntries/);
  assert.doesNotMatch(pane, /mergeLegacy/);
  assert.doesNotMatch(api, /writeMemoryEntries/);
  assert.doesNotMatch(protocol, /memoryWriteEntries/);
  assert.doesNotMatch(memoryIpc, /memoryWriteEntries/);
});

test("all nine shipped locales carry every memory key", () => {
  assert.deepEqual([...locales].sort(), ["de", "en", "es", "fr", "ko", "pt-BR", "tr", "zh-CN", "zh-TW"]);
  const keys = [
    "memoryIntro", "memorySearchPlaceholder", "memoryFilterAll", "memoryScopeGlobal",
    "memoryScopeProject", "memoryScopeSession", "memoryKindFact", "memoryKindPreference",
    "memoryKindDecision", "memoryKindPitfall", "memoryKindProcedure", "memoryPinned",
    "memoryPin", "memoryUnpin", "memoryDelete", "memoryDeleteConfirm", "memoryTidy",
    "memoryTidying", "memoryTidyDone", "memoryEmpty", "memoryEmptyFiltered", "memoryLoading",
    "memoryStatsLine", "memorySuperseded", "memoryUsedCount", "memoryLastUsed",
    "memoryNeverUsed", "memoryTags", "memoryBody",
  ];
  for (const locale of locales) {
    const catalog = read(`../../packages/i18n/src/locales/${locale}/index.ts`);
    for (const key of keys) {
      assert.match(catalog, new RegExp(`^\\s*"?${key}"?: `, "m"), `${locale} is missing settings.${key}`);
    }
  }
  const en = read("../../packages/i18n/src/locales/en/index.ts");
  for (const retired of ["memoryAgentTitle", "memoryAgentRemove", "memoryMergeAction", "memoryMeta"]) {
    assert.doesNotMatch(en, new RegExp(retired), `en still carries settings.${retired}`);
  }
});

test("a row shows kind, tags, use count, pin state and the body behind a disclosure", async (t) => {
  const threeDaysAgo = Date.now() - 3 * 24 * 60 * 60 * 1000;
  const html = await renderRows(t, [
    record({
      id: "a",
      kind: "pitfall",
      title: "Trigram index",
      tags: ["sqlite", "fts"],
      pinned: true,
      useCount: 7,
      lastUsedAt: threeDaysAgo,
      body: "unicode61 cannot find a Chinese phrase; rebuild with trigram.",
    }),
    record({ id: "b", kind: "procedure", title: "Release order", useCount: 0 }),
  ]);

  assert.match(html, /Trigram index/);
  // kind badge, in the reader's language
  assert.match(html, />Pitfall</);
  assert.match(html, />Procedure</);
  // tags, with a localized group label
  assert.match(html, /aria-label="Tags"/);
  assert.match(html, />sqlite</);
  assert.match(html, />fts</);
  // "used N×" and relative last use; the never-used row says so instead
  assert.match(html, /Used 7×/);
  assert.match(html, /last used/);
  assert.match(html, /Never recalled/);
  // pin state is a toggle the user can see
  assert.match(html, /aria-pressed="true"/);
  assert.match(html, /aria-pressed="false"/);
  assert.match(html, />Pinned</);
  assert.match(html, />Unpin</);
  // the body is behind a disclosure, not spilling into the row
  const disclosure = html.indexOf("<details");
  assert.ok(disclosure > 0, "the body must live behind a disclosure");
  assert.ok(html.indexOf("unicode61 cannot find") > disclosure);
  // pinned rows come first in the rendered list
  assert.ok(html.indexOf("Trigram index") < html.indexOf("Release order"));
});

test("a typed query is a recall on the host and keeps its ranking", async () => {
  const calls = [];
  const client = {
    listMemories: async (filter) => {
      calls.push(["list", filter]);
      return { memories: [], total: 0 };
    },
    recallMemories: async (input) => {
      calls.push(["recall", input]);
      // Deliberately not score order: the host already ranked them, and the
      // page must not re-sort hits by a field it invented.
      return {
        memories: [
          { memory: record({ id: "second", title: "Second hit" }), score: 4.2 },
          { memory: record({ id: "first", title: "First hit" }), score: 0.5 },
        ],
      };
    },
  };

  const view = await memoryView(client, { scope: "all", query: "  pnpm  " });
  assert.equal(view.recalled, true);
  assert.deepEqual(view.records.map((row) => row.title), ["Second hit", "First hit"]);
  assert.deepEqual(calls, [["recall", { query: "pnpm", limit: MEMORY_PAGE_SIZE }]]);

  const scoped = [];
  await memoryView(
    {
      listMemories: async () => ({ memories: [], total: 0 }),
      recallMemories: async (input) => {
        scoped.push(input);
        return { memories: [] };
      },
    },
    { scope: "project", query: "cache" },
  );
  assert.deepEqual(scoped, [{ query: "cache", limit: MEMORY_PAGE_SIZE, scope: "project" }]);
});

test("an empty query restores the full list, pinned first and then most recently used", async (t) => {
  const listed = [
    record({ id: "old", title: "Old fact", useCount: 9, lastUsedAt: 1_000 }),
    record({ id: "pinned", title: "Pinned rule", pinned: true, lastUsedAt: 5 }),
    record({ id: "recent", title: "Recent fact", useCount: 1, lastUsedAt: 5_000 }),
  ];
  const filters = [];
  const client = {
    listMemories: async (filter) => {
      filters.push(filter);
      return { memories: listed, total: listed.length };
    },
    recallMemories: async () => {
      throw new Error("an empty query must not recall");
    },
  };

  const view = await memoryView(client, { scope: "all", query: "   " });
  assert.equal(view.recalled, false);
  assert.deepEqual(view.records.map((row) => row.id), ["pinned", "recent", "old"]);
  assert.deepEqual(filters, [{ limit: MEMORY_PAGE_SIZE }]);

  await memoryView(client, { scope: "session", query: "" });
  assert.deepEqual(filters[1], { scope: "session", limit: MEMORY_PAGE_SIZE });

  // The order the view hands back is the order the rows render in.
  const html = await renderRows(t, view.records);
  assert.ok(html.indexOf("Pinned rule") < html.indexOf("Recent fact"));
  assert.ok(html.indexOf("Recent fact") < html.indexOf("Old fact"));
});
