#!/usr/bin/env node
/**
 * Gate: product code writes its temporary files under `<dataDir>/tmp`.
 *
 * The rule and its reasoning live in `AGENTS.md` §8 ("Runtime temporary files
 * live under the data directory"). This check keeps the rule mechanical: it
 * looks for the two platform entry points a product file must not call —
 * `std::env::temp_dir()` in Rust and `tmpdir()` in TypeScript — outside the
 * helpers that own the sanctioned path and outside test code, where a platform
 * temp directory is exactly right because a test run cleans up after itself.
 *
 * Usage: node scripts/check-runtime-temp-paths.mjs [--json]
 */
import { readFileSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/** Directories that hold product code the rule applies to. */
const ROOTS = [
  "crates/host-core/src",
  "apps/desktop/electron",
  "packages/shared/src",
  "packages/agent-runtime/src",
  "packages/host-runtime/src",
  "packages/plugin-sdk/src",
  "packages/racp/src",
  "packages/computer-use/src",
  "packages/agent-host/src",
  "packages/plugin-devkit/src",
  "packages/i18n/src",
];

/** The helpers that own the sanctioned path; they may name the platform API. */
const ALLOWED = new Set([
  "crates/host-core/src/runtime_tmp.rs",
  "apps/desktop/electron/main/runtime-tmp.ts",
]);

/** Test code may use the platform temp directory. */
function isTestPath(rel) {
  const normalized = rel.split(sep).join("/");
  return (
    /(^|\/)tests?\//.test(normalized) ||
    /_tests?\.rs$/.test(normalized) ||
    /(^|\/)tests?\.rs$/.test(normalized) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(normalized) ||
    /(^|\/)test\//.test(normalized)
  );
}

const PATTERNS = [
  { name: "std::env::temp_dir", re: /std::env::temp_dir\s*\(/g, language: "rust" },
  { name: "env::temp_dir", re: /(^|[^:\w])env::temp_dir\s*\(/g, language: "rust" },
  { name: "tmpdir()", re: /\btmpdir\s*\(\s*\)/g, language: "ts" },
];

async function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "dist-bundle") {
      continue;
    }
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walk(path)));
    } else if (/\.(rs|ts|tsx|mts|cts)$/.test(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

export async function findViolations(root = repoRoot) {
  const violations = [];
  for (const rel of ROOTS) {
    const absolute = join(root, rel);
    try {
      statSync(absolute);
    } catch {
      continue;
    }
    for (const file of await walk(absolute)) {
      const fileRel = relative(root, file);
      if (ALLOWED.has(fileRel.split(sep).join("/")) || isTestPath(fileRel)) continue;
      const source = readFileSync(file, "utf8");
      const lines = source.split("\n");
      // Rust keeps its unit tests at the end of the file behind `#[cfg(test)]`;
      // everything after that line is test code, which may use the platform
      // temp directory.
      const testModuleAt = fileRel.endsWith(".rs")
        ? lines.findIndex((line) => /^\s*#\[cfg\(test\)\]/.test(line))
        : -1;
      for (const pattern of PATTERNS) {
        for (let i = 0; i < lines.length; i += 1) {
          if (testModuleAt !== -1 && i >= testModuleAt) break;
          pattern.re.lastIndex = 0;
          if (!pattern.re.test(lines[i])) continue;
          if (lines[i].trimStart().startsWith("//")) continue;
          // An explicit, reviewed exception; the reason must be on the line.
          if (lines[i].includes("runtime-temp-allow:")) continue;
          violations.push({
            file: fileRel.split(sep).join("/"),
            line: i + 1,
            call: pattern.name,
            text: lines[i].trim().slice(0, 120),
          });
        }
      }
    }
  }
  return violations;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const violations = await findViolations();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(violations, null, 2));
  } else if (violations.length === 0) {
    console.log("runtime temp paths: product code uses the data-directory helper only");
  } else {
    for (const v of violations) {
      console.error(`${v.file}:${v.line}  ${v.call}  ${v.text}`);
    }
    console.error(
      `\n${violations.length} product-code temp path(s) outside <dataDir>/tmp; use runtime_tmp_dir / runtimeTmpDir (AGENTS.md §8).`,
    );
    process.exitCode = 1;
  }
}
