import { describe, expect, it } from "vitest";
import {
  astSearchLanguageForPath,
  AST_SEARCH_DEFAULT_LIMIT,
  AST_SEARCH_MAX_CHARS,
  AST_SEARCH_MAX_LIMIT,
  clampAstSearchLimit,
  formatAstSearchMatches,
  isPathInsideRoots,
  type AstSearchMatch,
} from "./ast-search.js";

const match = (file: string, line: number, column: number, text: string): AstSearchMatch => ({
  file,
  line,
  column,
  text,
});

describe("astSearchLanguageForPath", () => {
  it("maps supported extensions to a grammar", () => {
    expect(astSearchLanguageForPath("src/a.ts")).toBe("TypeScript");
    expect(astSearchLanguageForPath("src/a.tsx")).toBe("Tsx");
    expect(astSearchLanguageForPath("src/a.mjs")).toBe("JavaScript");
    expect(astSearchLanguageForPath("page/index.html")).toBe("Html");
    expect(astSearchLanguageForPath("styles/app.css")).toBe("Css");
  });

  it("ignores case and rejects unsupported or extension-less paths", () => {
    expect(astSearchLanguageForPath("SRC/A.TS")).toBe("TypeScript");
    expect(astSearchLanguageForPath("notes.md")).toBeUndefined();
    // Grammars without a bundled binary are not searched at all.
    expect(astSearchLanguageForPath("host/main.rs")).toBeUndefined();
    expect(astSearchLanguageForPath("pkg/mod.py")).toBeUndefined();
    expect(astSearchLanguageForPath("Makefile")).toBeUndefined();
    expect(astSearchLanguageForPath("trailing.")).toBeUndefined();
    expect(astSearchLanguageForPath(".ts")).toBeUndefined();
  });
});

describe("clampAstSearchLimit", () => {
  it("defaults, floors, and caps", () => {
    expect(clampAstSearchLimit(undefined)).toBe(AST_SEARCH_DEFAULT_LIMIT);
    expect(clampAstSearchLimit("30")).toBe(AST_SEARCH_DEFAULT_LIMIT);
    expect(clampAstSearchLimit(Number.NaN)).toBe(AST_SEARCH_DEFAULT_LIMIT);
    expect(clampAstSearchLimit(0)).toBe(1);
    expect(clampAstSearchLimit(-5)).toBe(1);
    expect(clampAstSearchLimit(7.8)).toBe(7);
    expect(clampAstSearchLimit(5000)).toBe(AST_SEARCH_MAX_LIMIT);
  });
});

describe("formatAstSearchMatches", () => {
  it("renders path:line:column rows", () => {
    const text = formatAstSearchMatches(
      [match("src/a.ts", 3, 5, "greet(name)"), match("src/b.ts", 1, 1, "greet('x')")],
      { limit: 10 },
    );
    expect(text.split("\n")).toEqual(["src/a.ts:3:5: greet(name)", "src/b.ts:1:1: greet('x')"]);
  });

  it("keeps only the first line of a multi-line match", () => {
    const text = formatAstSearchMatches([match("a.ts", 2, 1, "function f() {\n  return 1;\n}")], {
      limit: 5,
    });
    expect(text).toBe("a.ts:2:1: function f() {");
  });

  it("trims a long line", () => {
    const text = formatAstSearchMatches([match("a.ts", 1, 1, "x".repeat(500))], { limit: 5 });
    expect(text.length).toBeLessThan(260);
    expect(text).toContain("…");
  });

  it("bounds the row count and says what it omitted", () => {
    const matches = Array.from({ length: 6 }, (_, index) => match(`f${index}.ts`, 1, 1, "call()"));
    const text = formatAstSearchMatches(matches, { limit: 2 });
    expect(text.split("\n").filter((line) => line.includes("call()"))).toHaveLength(2);
    expect(text).toContain("4 more matches not shown");
  });

  it("bounds the character budget", () => {
    const matches = Array.from({ length: 40 }, (_, index) =>
      match(`dir/file-with-a-long-name-${index}.ts`, 1, 1, "call()"),
    );
    const text = formatAstSearchMatches(matches, { limit: 40, maxChars: 200 });
    expect(text.length).toBeLessThanOrEqual(280);
    expect(text).toContain("more matches not shown");

    const unbounded = formatAstSearchMatches(matches, { limit: 40 });
    expect(unbounded.length).toBeLessThanOrEqual(AST_SEARCH_MAX_CHARS);
    expect(unbounded).not.toContain("not shown");
  });

  it("explains a file-scan stop even with no matches", () => {
    expect(formatAstSearchMatches([], { limit: 5, truncated: true, filesScanned: 10 })).toBe(
      "No structural matches.\nStopped after 10 files; narrow the path to search the rest.",
    );
  });

  it("returns a plain message when nothing matched", () => {
    expect(formatAstSearchMatches([], { limit: 5 })).toBe("No structural matches.");
  });
});

describe("isPathInsideRoots", () => {
  const roots = ["C:\\work\\project", "/tmp/scratch"];

  it("accepts the root and anything below it", () => {
    expect(isPathInsideRoots("C:\\work\\project", roots, { caseInsensitive: true })).toBe(true);
    expect(isPathInsideRoots("C:\\work\\project\\src\\a.ts", roots, { caseInsensitive: true })).toBe(true);
    expect(isPathInsideRoots("/tmp/scratch/a/b.ts", roots)).toBe(true);
  });

  it("rejects a sibling path that shares a prefix", () => {
    expect(isPathInsideRoots("C:\\work\\project-other\\a.ts", roots, { caseInsensitive: true })).toBe(false);
    expect(isPathInsideRoots("/tmp/scratch2/a.ts", roots)).toBe(false);
  });

  it("rejects traversal targets and empty input", () => {
    expect(isPathInsideRoots("C:\\work\\project\\..\\secrets.txt", roots, { caseInsensitive: true })).toBe(
      false,
    );
    expect(isPathInsideRoots("", roots)).toBe(false);
  });
});
