import assert from "node:assert/strict";
import test from "node:test";
import {
  FILE_LANGUAGE_KEYS,
  languageForFilePath,
} from "../src/lib/file-language.ts";

/*
 * The file viewer highlights with Shiki, which only resolves an id it is given.
 * A path whose language this table misses is drawn as plain text — so the table
 * is the feature. These cases pin the languages a desktop project is made of,
 * including the config files that carry no useful extension at all.
 */

const EXPECTED = [
  // C / C++ family — the whole family, not only `.c` and `.cpp`.
  ["src/units/qemu/QemuUnit.cpp", "cpp"],
  ["src/units/qemu/QemuUnit.c", "c"],
  ["include/QemuUnit.hpp", "cpp"],
  ["include/qemu.h", "c"],
  ["src/gate.cc", "cpp"],
  ["src/gate.cxx", "cpp"],
  ["src/gate.hh", "cpp"],
  ["src/gate.hxx", "cpp"],
  ["firmware/sketch.ino", "cpp"],
  // Other common languages
  ["tools/ci_gate.py", "python"],
  ["crates/host-core/src/db.rs", "rust"],
  ["cmd/serve/main.go", "go"],
  ["src/Main.java", "java"],
  ["src/App.kt", "kotlin"],
  ["scripts/deploy.ps1", "powershell"],
  ["scripts/build.sh", "shellscript"],
  ["schema/init.sql", "sql"],
  // Configuration
  ["config/app.yaml", "yaml"],
  ["config/app.yml", "yaml"],
  ["Cargo.toml", "toml"],
  ["config/app.ini", "ini"],
  ["config/app.conf", "ini"],
  ["config/app.cfg", "ini"],
  [".editorconfig", "ini"],
  ["config/pip.properties", "ini"],
  [".env", "dotenv"],
  ["deploy/.env.local", "dotenv"],
  ["package.json", "json"],
  ["docs/README.md", "markdown"],
  ["docs/guide.mdx", "mdx"],
  ["patches/fix.diff", "diff"],
  // No extension, resolved by name
  ["Dockerfile", "docker"],
  ["docker/Containerfile", "docker"],
  ["Makefile", "make"],
  // Nothing bundled for these: text, not a wrong grammar
  ["Cargo.lock", null],
  ["go.mod", null],
  ["CMakeLists.txt", null],
  ["data.bin", null],
  ["", null],
  ["noextension", null],
];

test("common languages, config files and dotfiles resolve to a grammar", () => {
  for (const [path, expected] of EXPECTED) {
    assert.equal(languageForFilePath(path), expected, path);
  }
});

test("lookup is case-insensitive and ignores the directory part", () => {
  assert.equal(languageForFilePath("C:\\CODE\\PI\\SRC\\MAIN.CPP"), "cpp");
  assert.equal(languageForFilePath("a/b/c/README.MD"), "markdown");
  assert.equal(languageForFilePath("MAKEFILE"), "make");
});

test("the table stays inside Shiki's bundled ids", () => {
  // `shiki.ts` defines these; an id outside the list resolves to null at runtime
  // and the file silently loses its colour.
  const bundled = new Set([
    "astro", "bat", "c", "cpp", "csharp", "css", "dart", "diff", "docker", "dotenv",
    "go", "graphql", "groovy", "hcl", "html", "ini", "java", "javascript", "json",
    "jsonc", "jsonl", "jsx", "kotlin", "lua", "make", "markdown", "mdx", "mermaid",
    "nginx", "php", "powershell", "prisma", "proto", "python", "ruby", "rust",
    "scala", "shellscript", "sql", "svelte", "swift", "terraform", "toml", "tsx",
    "typescript", "vue", "xml", "yaml",
  ]);
  const probes = [
    ...FILE_LANGUAGE_KEYS.extensions.map((ext) => `x.${ext}`),
    ...FILE_LANGUAGE_KEYS.names,
  ];
  for (const probe of probes) {
    const id = languageForFilePath(probe);
    assert.ok(id, `${probe} maps to nothing`);
    assert.ok(bundled.has(id), `${probe} maps to unbundled id ${id}`);
  }
});
