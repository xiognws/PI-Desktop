import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { resolveManualPath } from "../electron/main/manual-path.ts";

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(desktopRoot, "../..");
const stagedDir = join(desktopRoot, "resources", "manual");
const handbookDir = join(repoRoot, "docs", "handbook");

test("the staged handbook ships with the app under resources/manual", () => {
  assert.ok(existsSync(stagedDir), "apps/desktop/resources/manual must be staged");
  const handbook = resolveManualPath();
  assert.ok(handbook, "resolveManualPath must find the staged handbook");
  assert.match(handbook, /Pi-Workspace-.*\.md$/i);
});

test("the staged handbook matches its docs/handbook source", () => {
  const handbook = resolveManualPath();
  assert.ok(handbook);
  const name = handbook.split(/[\\/]/).pop();
  assert.ok(existsSync(join(handbookDir, name)), `docs/handbook/${name} is missing`);
  assert.equal(
    readFileSync(join(stagedDir, name), "utf8"),
    readFileSync(join(handbookDir, name), "utf8"),
    "staged copy drifted from docs/handbook; run pnpm stage:manual",
  );
});

test("resolveManualPath prefers the packaged resources/manual root", () => {
  const fakeResources = mkdtempSync(join(tmpdir(), "pi-manual-resources-"));
  try {
    mkdirSync(join(fakeResources, "manual"));
    writeFileSync(join(fakeResources, "manual", "Pi-Workspace-9.9.9-handbook.md"), "# fake");
    assert.equal(
      resolveManualPath(import.meta.url, fakeResources),
      join(fakeResources, "manual", "Pi-Workspace-9.9.9-handbook.md"),
    );
  } finally {
    rmSync(fakeResources, { recursive: true, force: true });
  }
});

test("every screenshot the staged handbook links is staged beside it", () => {
  const handbook = resolveManualPath();
  assert.ok(handbook);
  const text = readFileSync(handbook, "utf8");
  const links = [...text.matchAll(/!?\[[^\]]*\]\((shots\/[^)\s]+\.(?:png|jpg|jpeg|webp))\)/g)].map(
    (match) => match[1],
  );
  assert.ok(links.length > 0, "the handbook must embed screenshots");
  for (const link of links) {
    assert.ok(existsSync(join(stagedDir, link)), `staged handbook links a missing image: ${link}`);
  }
});
