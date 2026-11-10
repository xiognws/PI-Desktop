#!/usr/bin/env node
/**
 * Stage the shipped user handbook into `apps/desktop/resources/manual`.
 *
 * electron-builder copies `apps/desktop/resources/manual` to
 * `<resources>/manual` in every packaged form (NSIS installed, ZIP, portable),
 * so the handbook ships with the app and the About panel can open it from
 * there. The staged copy is generated output: `docs/handbook` stays the single
 * source of truth, and this script mirrors it on every release build.
 *
 * Usage:
 *   node scripts/stage-desktop-manual.mjs            # stage the latest handbook
 *   node scripts/stage-desktop-manual.mjs --check    # verify the staged copy is current
 *
 * The handbook file name carries the app version. Rather than pinning a name
 * here, the newest `Pi-Workspace-*-手册.md` / `Pi-Workspace-*-handbook.md`
 * matches, and its version suffix is checked against `apps/desktop/package.json`
 * so a version bump cannot ship last release's manual.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const handbookDir = path.join(root, "docs", "handbook");
const shotsDir = path.join(handbookDir, "shots");
const targetDir = path.join(root, "apps", "desktop", "resources", "manual");
const desktopPackage = JSON.parse(
  readFileSync(path.join(root, "apps", "desktop", "package.json"), "utf8"),
);
const appVersion = desktopPackage.version;
const checkOnly = process.argv.includes("--check");

const failures = [];
const fail = (message) => failures.push(message);

/** Pick the handbook whose version suffix matches this app version. */
function resolveHandbook() {
  if (!existsSync(handbookDir)) {
    fail("docs/handbook: missing");
    return null;
  }
  const candidates = readdirSync(handbookDir)
    .filter((name) => name.endsWith(".md"))
    .filter((name) => /^Pi-Workspace-\d+\.\d+\.\d+.*\.md$/.test(name));
  if (candidates.length === 0) {
    fail("docs/handbook: no Pi-Workspace-<version>*.md handbook");
    return null;
  }
  const matching = candidates.filter((name) =>
    name.startsWith(`Pi-Workspace-${appVersion}`),
  );
  if (matching.length === 0) {
    fail(
      `docs/handbook: no handbook for app version ${appVersion} (found ${candidates.join(", ")}). ` +
        "Rename or add the handbook for this release before packaging.",
    );
    return null;
  }
  if (matching.length > 1) {
    fail(`docs/handbook: several handbooks match ${appVersion}: ${matching.join(", ")}`);
    return null;
  }
  return matching[0];
}

/** Every `shots/<file>.png` the handbook links must exist next to it. */
function missingShotLinks(handbookPath) {
  const text = readFileSync(handbookPath, "utf8");
  const links = new Set();
  for (const match of text.matchAll(/!?\[[^\]]*\]\((shots\/[^)\s]+\.(?:png|jpg|jpeg|webp))\)/g)) {
    links.add(match[1]);
  }
  return [...links].filter((link) => !existsSync(path.join(handbookDir, link)));
}

const handbook = resolveHandbook();
let shotCount = 0;
if (handbook) {
  const missing = missingShotLinks(path.join(handbookDir, handbook));
  if (missing.length > 0) {
    fail(`docs/handbook/${handbook}: broken image links: ${missing.join(", ")}`);
  } else {
    shotCount = readdirSync(shotsDir).filter((name) => /\.(png|jpg|jpeg|webp)$/.test(name)).length;
    if (shotCount === 0) fail("docs/handbook/shots: no screenshots to stage");
  }
}

if (checkOnly) {
  if (failures.length > 0) {
    for (const failure of failures) console.error(`check failed: ${failure}`);
    process.exit(1);
  }
  const stagedHandbook = path.join(targetDir, handbook);
  if (!existsSync(stagedHandbook)) {
    console.error(`check failed: ${path.relative(root, stagedHandbook)} is not staged. Run \`pnpm stage:manual\`.`);
    process.exit(1);
  }
  const source = readFileSync(path.join(handbookDir, handbook));
  const staged = readFileSync(stagedHandbook);
  if (!source.equals(staged)) {
    console.error(
      `check failed: ${path.relative(root, stagedHandbook)} is stale. Run \`pnpm stage:manual\`.`,
    );
    process.exit(1);
  }
  const stagedShots = existsSync(path.join(targetDir, "shots"))
    ? readdirSync(path.join(targetDir, "shots")).filter((name) => /\.(png|jpg|jpeg|webp)$/.test(name)).length
    : 0;
  if (stagedShots !== shotCount) {
    console.error(
      `check failed: staged shots are ${stagedShots}, handbook links ${shotCount}. Run \`pnpm stage:manual\`.`,
    );
    process.exit(1);
  }
  console.log(`manual staging is current (${handbook}, ${shotCount} screenshots)`);
  process.exit(0);
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`stage failed: ${failure}`);
  process.exit(1);
}

// The staged tree is generated output: replace it whole so a removed
// screenshot cannot linger into the package.
rmSync(targetDir, { recursive: true, force: true });
mkdirSync(targetDir, { recursive: true });
cpSync(path.join(handbookDir, handbook), path.join(targetDir, handbook));
cpSync(shotsDir, path.join(targetDir, "shots"), {
  recursive: true,
  filter: (source) => statSync(source).isDirectory() || /\.(png|jpg|jpeg|webp)$/.test(source),
});
console.log(`staged ${path.relative(root, path.join(targetDir, handbook))} + ${shotCount} screenshots`);
