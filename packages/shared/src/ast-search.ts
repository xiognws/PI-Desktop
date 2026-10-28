/**
 * Structural (AST) search: the pure half.
 *
 * The desktop runs `ast_search` in Electron main with `@ast-grep/napi`; the
 * parts that decide *what* to search and *how to report it* live here so they
 * can be unit-tested without a native addon and without touching the disk.
 *
 * Nothing in this module performs I/O or imports the parser.
 */

/** Extensions we can parse, mapped to the ast-grep grammar name. */
export const AST_SEARCH_LANGUAGES: Readonly<Record<string, string>> = {
  ".ts": "TypeScript",
  ".mts": "TypeScript",
  ".cts": "TypeScript",
  ".tsx": "Tsx",
  ".js": "JavaScript",
  ".mjs": "JavaScript",
  ".cjs": "JavaScript",
  ".jsx": "Tsx",
  ".html": "Html",
  ".css": "Css",
};

/**
 * Grammars `@ast-grep/napi` ships without an extra dynamic language: everything
 * outside this list (Rust, Python, Go, …) would need a per-language binary and
 * is therefore not searched rather than silently mis-parsed.
 */
export const AST_SEARCH_GRAMMARS: readonly string[] = [
  "TypeScript",
  "Tsx",
  "JavaScript",
  "Html",
  "Css",
];

/**
 * Grammars a *pattern* is validated against. Html is excluded on purpose: it
 * accepts almost any text without an error node, so validating against it would
 * let `greet(` through as "valid" and then match nothing.
 */
export const AST_SEARCH_PATTERN_GRAMMARS: readonly string[] = [
  "TypeScript",
  "Tsx",
  "JavaScript",
  "Css",
];

/** Directories a structural search never walks into. */
export const AST_SEARCH_SKIPPED_DIRECTORIES: readonly string[] = [
  ".git",
  "node_modules",
  "dist",
  "dist-bundle",
  "out",
  "build",
  "target",
  "__pycache__",
  ".venv",
  "venv",
  ".next",
  ".turbo",
];

export const AST_SEARCH_DEFAULT_LIMIT = 20;
export const AST_SEARCH_MAX_LIMIT = 100;
/** Upper bound on files opened by one call, so a repo-wide pattern stays cheap. */
export const AST_SEARCH_MAX_FILES = 3000;
/** Upper bound on the rendered result, in characters. */
export const AST_SEARCH_MAX_CHARS = 12_000;
/** Line length kept per match; the rest is trimmed with an ellipsis. */
export const AST_SEARCH_MAX_LINE_CHARS = 200;

/** ast-grep grammar for a file path, or undefined when the type is unsupported. */
export function astSearchLanguageForPath(filePath: string): string | undefined {
  const lower = filePath.trim().toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot <= 0 || dot === lower.length - 1) return undefined;
  return AST_SEARCH_LANGUAGES[lower.slice(dot)];
}

/** Clamp a caller's limit into the accepted range; absent means the default. */
export function clampAstSearchLimit(limit: unknown): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return AST_SEARCH_DEFAULT_LIMIT;
  const rounded = Math.floor(limit);
  if (rounded < 1) return 1;
  return Math.min(rounded, AST_SEARCH_MAX_LIMIT);
}

/** One structural match, already positioned for the transcript. */
export type AstSearchMatch = {
  /** Path relative to the searched root, using `/`. */
  file: string;
  /** 1-based line of the match start. */
  line: number;
  /** 1-based column of the match start. */
  column: number;
  /** Matched source text, first line only, bounded. */
  text: string;
};

function oneLine(text: string): string {
  const first = text.split(/\r?\n/, 1)[0] ?? "";
  const trimmed = first.trim();
  return trimmed.length > AST_SEARCH_MAX_LINE_CHARS
    ? `${trimmed.slice(0, AST_SEARCH_MAX_LINE_CHARS)}…`
    : trimmed;
}

/**
 * Render matches as `path:line:column: text` rows for the model, bounded by
 * `limit` rows and `AST_SEARCH_MAX_CHARS` characters. A bounded result always
 * says what it left out, so the model can narrow the pattern instead of
 * assuming the file list is complete.
 */
export function formatAstSearchMatches(
  matches: readonly AstSearchMatch[],
  options: { limit: number; truncated?: boolean; filesScanned?: number; maxChars?: number } = {
    limit: AST_SEARCH_DEFAULT_LIMIT,
  },
): string {
  const limit = clampAstSearchLimit(options.limit);
  const maxChars = options.maxChars ?? AST_SEARCH_MAX_CHARS;
  const shown = matches.slice(0, limit).map((match) => {
    const text = oneLine(match.text);
    return text ? `${match.file}:${match.line}:${match.column}: ${text}` : `${match.file}:${match.line}:${match.column}`;
  });
  const lines: string[] = [];
  let used = 0;
  let rendered = 0;
  for (const line of shown) {
    if (used + line.length + 1 > maxChars) break;
    lines.push(line);
    used += line.length + 1;
    rendered += 1;
  }
  const omitted = matches.length - rendered;
  const notes: string[] = [];
  if (omitted > 0) {
    notes.push(`${omitted} more match${omitted === 1 ? "" : "es"} not shown; narrow the pattern or path.`);
  }
  if (options.truncated) {
    notes.push(
      `Stopped after ${options.filesScanned ?? AST_SEARCH_MAX_FILES} files; narrow the path to search the rest.`,
    );
  }
  if (lines.length === 0) {
    return notes.length > 0 ? `No structural matches.\n${notes.join("\n")}` : "No structural matches.";
  }
  return [...lines, ...notes].join("\n");
}

/**
 * Accept only a path that stays inside one of the session roots. Mirrors the
 * containment rule the other local tools use: a resolved absolute path must be
 * the root itself or sit below it.
 */
export function isPathInsideRoots(
  candidate: string,
  roots: readonly string[],
  options: { caseInsensitive?: boolean } = {},
): boolean {
  const normalize = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "");
  const fold = (value: string) => (options.caseInsensitive ? value.toLowerCase() : value);
  const target = fold(normalize(candidate));
  // A relative `..` segment means the caller did not resolve the path first;
  // refuse it rather than comparing a string that points somewhere else.
  if (!target || target.split("/").includes("..")) return false;
  return roots.some((root) => {
    const base = fold(normalize(root));
    if (!base) return false;
    return target === base || target.startsWith(`${base}/`);
  });
}
