import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { readMainModuleSync } from "./helpers/source-contracts.mjs";
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

test("the Info panel hands the handbook to the system viewer", () => {
  const manualIpc = readMainModuleSync("ipc/manual-ipc.ts");
  // The reader is whatever this machine uses for Markdown; the app renders no
  // manual of its own. A missing handler degrades to selecting the file.
  assert.match(manualIpc, /shell\.openPath\(stripWinLongPrefix\(manual\)\)/);
  assert.match(manualIpc, /shell\.showItemInFolder\(stripWinLongPrefix\(manual\)\)/);
  assert.match(manualIpc, /IPC\.invoke\.manualOpen/);

  const protocol = readFileSync(join(repoRoot, "packages/shared/src/protocol.ts"), "utf8");
  assert.match(protocol, /manualOpen: "pi-desktop\/manual\/open"/);

  // The Info rows live in their own destination file since the D684 split; the
  // shell no longer holds any card of its own.
  const infoPage = readFileSync(
    join(desktopRoot, "src/features/settings/pages/AboutSettings.tsx"),
    "utf8",
  );
  assert.match(infoPage, /t\("settings\.manual"\)/, "the Info panel offers the handbook");
  assert.match(infoPage, /api\.openManual\(\)/, "the row opens it with the system viewer");

  const api = readFileSync(join(desktopRoot, "src/lib/api.ts"), "utf8");
  assert.match(api, /openManual: \(\) => invoke<\{ ok: boolean; path: string \}>\(IPC\.invoke\.manualOpen\)/);
});
