/**
 * Local detection for the WorkBuddy model entry.
 *
 * The fixtures mirror the two files the desktop app really writes: an auth store
 * whose token is sealed and whose account/expiry fields are plaintext, and a
 * `local_storage` model cache that mixes chat models with image/video entries.
 * The assertions therefore pin three promises: an unexpired store counts as
 * signed in, non-chat catalog entries never reach the model list, and no byte of
 * the sealed token reaches the caller.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { detectWorkBuddy } from "../electron/main/workbuddy/detect.ts";
import {
  mergeCatalogs,
  normalizeDesktopModel,
  parseCredits,
  toModelBindings,
} from "../electron/main/workbuddy/catalog.ts";

const SEALED = "sealed-envelope-must-never-surface";

async function fixtureRoot({ bare = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-workbuddy-"));
  const home = join(root, "home");
  const localAppData = join(root, "localappdata");
  if (!bare) {
    await mkdir(join(home, ".workbuddy", "local_storage"), { recursive: true });
    await mkdir(join(localAppData, "CodeBuddyExtension", "Data", "Public", "auth"), {
      recursive: true,
    });
  }
  return {
    root,
    home,
    localAppData,
    programFiles: join(root, "programs"),
    platform: "win32",
    cleanup: () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  };
}

function environment(fixture, now) {
  return {
    homeDir: fixture.home,
    localAppData: fixture.localAppData,
    programFiles: fixture.programFiles,
    platform: "win32",
    // The fixture describes one machine; the real drive sweep must not leak into
    // it, or a developer's own install would make "not installed" untestable.
    executables: [],
    now,
  };
}

async function writeStore(fixture, { uid = "user-1", expiresAt, token = "plain" } = {}) {
  const store = {
    account: {
      uid,
      enterpriseId: "enterprise-1",
      enterpriseName: "ACME Motors",
      type: "enterprise",
    },
    auth: {
      accessToken: token === "sealed" ? { $wbEncrypted: 1, envelope: SEALED } : "plain-token",
      expiresAt,
    },
  };
  await writeFile(
    join(
      fixture.localAppData,
      "CodeBuddyExtension",
      "Data",
      "Public",
      "auth",
      "workbuddy-desktop.info",
    ),
    JSON.stringify(store),
  );
}

async function writeCatalog(fixture, models) {
  await writeFile(
    join(fixture.home, ".workbuddy", "local_storage", "entry_1.info"),
    JSON.stringify({ data: { models } }),
  );
}

const CATALOG = [
  {
    id: "hy4free",
    name: "Hy4",
    maxInputTokens: 960000,
    maxOutputTokens: 64000,
    supportsImages: true,
    supportsReasoning: true,
    supportsToolCall: true,
    descriptionZh: "最新旗舰模型",
    credits: "x0.00 credits",
    isDefault: true,
  },
  { id: "deepseek-v4.1-flash", name: "Deepseek-V4.1-Flash", maxInputTokens: 1000000, maxOutputTokens: 128000 },
  { id: "hunyuan-image-alpha", name: "Hunyuan Image Alpha" },
  { id: "kling-video-v3", name: "Kling-Video-V3" },
  { id: "deepseek-v3-0324-taco-completion", name: "deepseek-v3-0324" },
];

test("an unexpired store with an account counts as signed in", async (t) => {
  const fixture = await fixtureRoot();
  t.after(fixture.cleanup);
  const now = 1_700_000_000_000;
  await writeStore(fixture, { expiresAt: now + 3_600_000, token: "sealed" });
  await writeCatalog(fixture, CATALOG);

  const discovery = detectWorkBuddy(environment(fixture, now));

  assert.equal(discovery.installation.installed, true);
  assert.equal(discovery.installation.loggedIn, true);
  assert.equal(discovery.installation.account?.uid, "user-1");
  assert.equal(discovery.installation.account?.enterpriseName, "ACME Motors");
  assert.ok(discovery.installation.sources.includes("auth-store"));
  assert.ok(discovery.installation.sources.includes("model-cache"));
});

test("a sealed token is never read out of the store", async (t) => {
  const fixture = await fixtureRoot();
  t.after(fixture.cleanup);
  const now = 1_700_000_000_000;
  await writeStore(fixture, { expiresAt: now + 3_600_000, token: "sealed" });
  await writeCatalog(fixture, CATALOG);

  const serialized = JSON.stringify(detectWorkBuddy(environment(fixture, now)));

  assert.equal(serialized.includes(SEALED), false);
  assert.equal(serialized.includes("envelope"), false);
});

test("the published model list carries chat models and their stated limits", async (t) => {
  const fixture = await fixtureRoot();
  t.after(fixture.cleanup);
  const now = 1_700_000_000_000;
  await writeStore(fixture, { expiresAt: now + 3_600_000 });
  await writeCatalog(fixture, CATALOG);

  const { models } = detectWorkBuddy(environment(fixture, now));
  const ids = models.map((model) => model.id);

  assert.ok(ids.includes("hy4free"));
  assert.ok(ids.includes("deepseek-v4.1-flash"));
  assert.equal(ids.includes("hunyuan-image-alpha"), false);
  assert.equal(ids.includes("kling-video-v3"), false);
  assert.equal(ids.includes("deepseek-v3-0324-taco-completion"), false);
  // The account's own default model opens the list.
  assert.equal(models[0].id, "hy4free");
  const flagship = models.find((model) => model.id === "hy4free");
  assert.equal(flagship.contextWindow, 960000);
  assert.equal(flagship.maxOutputTokens, 64000);
  assert.equal(flagship.supportsImages, true);
  assert.equal(flagship.credits, 0);
});

test("an expired session is reported as signed out, with the reason", async (t) => {
  const fixture = await fixtureRoot();
  t.after(fixture.cleanup);
  const now = 1_700_000_000_000;
  await writeStore(fixture, { expiresAt: now - 60_000 });
  await writeCatalog(fixture, CATALOG);

  const discovery = detectWorkBuddy(environment(fixture, now));

  assert.equal(discovery.installation.installed, true);
  assert.equal(discovery.installation.loggedIn, false);
  assert.match(discovery.installation.detail ?? "", /expired/i);
  // Models stay readable: the entry can still list them before a token is pasted.
  assert.ok(discovery.models.length > 0);
});

test("a machine with no WorkBuddy data is simply unavailable", async (t) => {
  const fixture = await fixtureRoot({ bare: true });
  t.after(fixture.cleanup);

  const discovery = detectWorkBuddy(environment(fixture, 1_700_000_000_000));

  assert.equal(discovery.installation.installed, false);
  assert.equal(discovery.installation.loggedIn, false);
  assert.deepEqual(discovery.models, []);
  assert.match(discovery.installation.detail ?? "", /not installed/i);
});

test("an app data directory alone means installed but not signed in", async (t) => {
  const fixture = await fixtureRoot();
  t.after(fixture.cleanup);

  const discovery = detectWorkBuddy(environment(fixture, 1_700_000_000_000));

  assert.equal(discovery.installation.installed, true);
  assert.equal(discovery.installation.loggedIn, false);
  assert.ok(discovery.installation.sources.includes("profile"));
});

test("catalog normalization keeps the richer statement of the same model", () => {
  const desktop = normalizeDesktopModel({
    id: "glm-5.3",
    name: "GLM-5.3",
    maxInputTokens: 1000000,
    maxOutputTokens: 64000,
  });
  const connector = normalizeDesktopModel({
    id: "glm-5.3",
    name: "glm-5.3",
    contextWindow: 200000,
    reasoning: { supports: true },
    billing: { credits: "x0.29 credits", free: false },
  });

  assert.ok(desktop && connector);
  const [merged] = mergeCatalogs([[desktop], [connector]]);

  // A connector value overrides the desktop's, and the desktop's real display
  // name survives a connector row that only repeats the id.
  assert.equal(merged.contextWindow, 200000);
  assert.equal(merged.name, "GLM-5.3");
  assert.equal(merged.supportsReasoning, true);
  assert.equal(merged.credits, 0.29);
});

test("model bindings omit limits a catalog never stated", () => {
  const [binding] = toModelBindings([
    { id: "mystery-model", name: "Mystery Model" },
  ]);

  assert.deepEqual(binding, { id: "mystery-model", alias: "Mystery Model" });
});

test("credit strings parse to a number, or null when unstated", () => {
  assert.equal(parseCredits("x0.29 credits"), 0.29);
  assert.equal(parseCredits("x0.00 credits"), 0);
  assert.equal(parseCredits(1.2), 1.2);
  assert.equal(parseCredits(null), null);
  assert.equal(parseCredits("free"), null);
});
