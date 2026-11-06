import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { installDroppedLibraries, LIBRARY_WORKER, resolvePythonRuntime } from "../electron/main/python-runtime.ts";

/**
 * The offline library installer answers "I remembered one more library and this
 * machine has no index to fetch it from". Two properties decide whether it is
 * usable rather than merely present:
 *
 *  - it names the exact libraries still missing, with the requirement text that
 *    asked for them, because on an offline machine "missing dependencies" is a
 *    dead end;
 *  - it never leaves a wheel sitting in the drop folder pretending it will
 *    install next time.
 */

const status = resolvePythonRuntime();
const available = status.state === "present";

function scratch() {
  const dir = mkdtempSync(join(import.meta.dirname, ".python-libs-probe-"));
  return {
    dir,
    drop: join(dir, "drop"),
    site: join(dir, "site"),
    clean: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * Build a wheel from one dist-info directory of the shipped bundle.
 *
 * Zip archives are written by Python rather than by hand: a hand-built archive
 * that is subtly wrong would test the fixture instead of the installer. This is
 * the same `METADATA` a customer's wheel would carry.
 */
function buildWheel(distInfoName, target) {
  const sitePackages = join(status.runtime.root, "site-packages");
  const distInfo = join(sitePackages, distInfoName);
  const metadata = readFileSync(join(distInfo, "METADATA"), "utf8");
  const name = /^Name: (.+)$/m.exec(metadata)[1].trim();
  const version = /^Version: (.+)$/m.exec(metadata)[1].trim();
  const wheel = join(target, `${name.replace(/-/g, "_")}-${version}-py3-none-any.whl`);
  execFileSync(
    status.runtime.executable,
    [
      "-c",
      [
        "import sys, zipfile",
        "path, member, body = sys.argv[1], sys.argv[2], sys.argv[3]",
        "with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as archive:",
        "    archive.writestr(member, open(body, encoding='utf-8').read())",
      ].join("\n"),
      wheel,
      `${distInfoName}/METADATA`,
      join(distInfo, "METADATA"),
    ],
    { env: { ...process.env, PYTHONNOUSERSITE: "1" }, timeout: 60_000 },
  );
  return { name: name, version: version, path: wheel };
}

test("the installer ships next to the interpreter", () => {
  if (!available) return;
  assert.ok(existsSync(join(status.runtime.root, "tools", LIBRARY_WORKER)));
});

test("an empty drop folder is idle and costs no install", async () => {
  if (!available) return;
  const { drop, site, clean } = scratch();
  try {
    mkdirSync(drop, { recursive: true });
    assert.equal((await installDroppedLibraries(status.runtime, drop, site)).state, "idle");
  } finally {
    clean();
  }
});

test("a wheel with missing dependencies is refused by name, with the requirement", async () => {
  if (!available) return;
  const { dir, drop, site, clean } = scratch();
  try {
    mkdirSync(drop, { recursive: true });
    const wheel = buildWheel("python_docx-1.2.0.dist-info", dir);
    writeFileSync(join(drop, "python_docx-1.2.0-py3-none-any.whl"), readFileSync(wheel.path));

    const result = await installDroppedLibraries(status.runtime, drop, site);
    assert.equal(result.state, "refused");
    if (result.state !== "refused") return;
    assert.equal(result.code, "DEPENDENCIES_MISSING");
    assert.deepEqual(result.missing.map((item) => item.name).sort(), ["lxml", "typing-extensions"]);
    // The requirement text is what turns a refusal into a shopping list.
    const lxml = result.missing.find((item) => item.name === "lxml");
    assert.ok(lxml.reasons.some((reason) => reason.includes("lxml")), "the specifier is reported");
  } finally {
    clean();
  }
});

test("a refused wheel moves out of the drop folder and leaves a readable note", async () => {
  if (!available) return;
  const { dir, drop, site, clean } = scratch();
  try {
    mkdirSync(drop, { recursive: true });
    const wheel = buildWheel("python_docx-1.2.0.dist-info", dir);
    const name = "python_docx-1.2.0-py3-none-any.whl";
    writeFileSync(join(drop, name), readFileSync(wheel.path));
    await installDroppedLibraries(status.runtime, drop, site);
    // Nothing may stay behind: a wheel that will never install is a trap.
    assert.equal(existsSync(join(drop, name)), false);
    const note = readFileSync(join(drop, "failed", `${name}.txt`), "utf8");
    assert.match(note, /lxml/);
    assert.match(note, /typing-extensions/);
  } finally {
    clean();
  }
});
