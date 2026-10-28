/**
 * `AstSearch` — structural (AST) search over the session's project files.
 *
 * Runs in Electron main because the parser is a native addon
 * (`@ast-grep/napi`), and main is where the other filesystem-facing local tools
 * already run. The pure decisions (which files, which grammar, how to render)
 * live in `@pi-desktop/shared`; this module owns the walk and the parse.
 *
 * Safety: only files inside the session's own roots are opened, the walk skips
 * build output and dependency directories, and both the file count and the
 * rendered result are bounded so one call cannot read a whole disk.
 */
import type { Dirent } from "node:fs";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parse } from "@ast-grep/napi";
import {
  AST_SEARCH_MAX_FILES,
  AST_SEARCH_MAX_LIMIT,
  AST_SEARCH_PATTERN_GRAMMARS,
  astSearchLanguageForPath,
  AST_SEARCH_SKIPPED_DIRECTORIES,
  clampAstSearchLimit,
  formatAstSearchMatches,
  isPathInsideRoots,
  type AstSearchMatch,
} from "@pi-desktop/shared";

export type AstSearchResult = {
  ok: boolean;
  isError?: boolean;
  content: string;
};

export type AstSearchOptions = {
  /** Session roots the walk is confined to (project workspace, scratch). */
  getRoots: (sessionId: string) => Promise<readonly string[]>;
};

/** Skip a file this large; a minified bundle is not worth a parse. */
const MAX_FILE_BYTES = 512 * 1024;
/** A pattern is a query, not a payload. */
const MAX_PATTERN_CHARS = 300;
/** Collect this many matches at most, then stop walking. */
const MAX_COLLECTED_MATCHES = AST_SEARCH_MAX_LIMIT * 2;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failure(message: string): AstSearchResult {
  return { ok: true, isError: true, content: message };
}

function comparedPathCaseInsensitive(): boolean {
  return process.platform === "win32" || process.platform === "darwin";
}

/**
 * A pattern is code, not text: it must parse as a syntax tree in at least one
 * supported grammar. A half-written pattern such as `greet(` would otherwise
 * parse into an error node and match nothing, which reads like "no results".
 */
function grammarThatParsesPattern(pattern: string): string | undefined {
  for (const grammar of AST_SEARCH_PATTERN_GRAMMARS) {
    try {
      const root = parse(grammar, pattern).root();
      if (root.findAll({ rule: { kind: "ERROR" } }).length === 0) return grammar;
    } catch {
      // A grammar this build does not ship: try the next one.
    }
  }
  return undefined;
}

type WalkHit = { file: string; language: string; text: string };

/** Depth-first walk bounded by `AST_SEARCH_MAX_FILES`, in name order. */
async function collectParseableFiles(base: string, signal: AbortSignal): Promise<{
  files: WalkHit[];
  truncated: boolean;
}> {
  const files: WalkHit[] = [];
  let truncated = false;
  const pending: string[] = [base];
  while (pending.length > 0) {
    if (signal.aborted) break;
    if (files.length >= AST_SEARCH_MAX_FILES) {
      truncated = true;
      break;
    }
    const directory = pending.pop() as string;
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (AST_SEARCH_SKIPPED_DIRECTORIES.includes(entry.name)) continue;
        pending.push(path);
        continue;
      }
      if (!entry.isFile()) continue;
      const language = astSearchLanguageForPath(entry.name);
      if (!language) continue;
      try {
        const info = await stat(path);
        if (!info.isFile() || info.size > MAX_FILE_BYTES) continue;
      } catch {
        continue;
      }
      files.push({ file: path, language, text: "" });
      if (files.length >= AST_SEARCH_MAX_FILES) {
        truncated = true;
        break;
      }
    }
  }
  return { files, truncated };
}

/**
 * The local-tool handler. `args` is model input: every field is validated here,
 * and a bad call returns a readable tool error instead of throwing.
 */
export function createAstSearchTool(options: AstSearchOptions) {
  return async (input: {
    args: unknown;
    sessionId: string;
    signal: AbortSignal;
  }): Promise<AstSearchResult> => {
    const args = isRecord(input.args) ? input.args : {};
    const pattern = typeof args.pattern === "string" ? args.pattern.trim() : "";
    if (!pattern) return failure("AstSearch: `pattern` is required.");
    if (pattern.length > MAX_PATTERN_CHARS) {
      return failure(`AstSearch: \`pattern\` must be at most ${MAX_PATTERN_CHARS} characters.`);
    }
    if (!grammarThatParsesPattern(pattern)) {
      return failure(
        `AstSearch: the pattern is not valid code in any supported grammar (${AST_SEARCH_PATTERN_GRAMMARS.join(", ")}). Write ast-grep pattern syntax, for example \`name($ARG)\` or \`class $C { $M($$$) }\`.`,
      );
    }
    const limit = clampAstSearchLimit(args.limit);

    let roots: readonly string[];
    try {
      roots = await options.getRoots(input.sessionId);
    } catch (error) {
      return failure(`AstSearch: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (roots.length === 0) return failure("AstSearch: this session has no project directory.");

    const requested = typeof args.path === "string" ? args.path.trim() : "";
    const candidate = requested
      ? isAbsolute(requested)
        ? resolve(requested)
        : resolve(roots[0] as string, requested)
      : (roots[0] as string);
    let base: string;
    try {
      base = await realpath(candidate);
    } catch {
      return failure(`AstSearch: "${requested || candidate}" does not exist in this session.`);
    }
    const resolvedRoots = await Promise.all(
      roots.map(async (root) => {
        try {
          return await realpath(root);
        } catch {
          return root;
        }
      }),
    );
    if (!isPathInsideRoots(base, resolvedRoots, { caseInsensitive: comparedPathCaseInsensitive() })) {
      return failure(
        `AstSearch: "${requested || base}" is outside this session's project and scratch directories.`,
      );
    }

    const { files, truncated } = await collectParseableFiles(base, input.signal);
    const matches: AstSearchMatch[] = [];
    let matchedFiles = 0;
    for (const entry of files) {
      if (input.signal.aborted) break;
      if (matches.length >= MAX_COLLECTED_MATCHES) break;
      let source: string;
      try {
        source = await readFile(entry.file, "utf8");
      } catch {
        continue;
      }
      let found: AstSearchMatch[] = [];
      try {
        const root = parse(entry.language, source).root();
        const hits = root.findAll({ rule: { pattern } });
        if (hits.length > 0) {
          const file = relative(base, entry.file).replace(/\\/g, "/") || entry.file;
          found = hits.map((hit) => {
            const range = hit.range().start;
            return { file, line: range.line + 1, column: range.column + 1, text: hit.text() };
          });
        }
      } catch {
        // A file that this grammar cannot parse contributes no matches; the
        // pattern itself was validated before the walk started.
        continue;
      }
      if (found.length > 0) {
        matchedFiles += 1;
        matches.push(...found);
      }
    }

    if (input.signal.aborted) return failure("AstSearch: the call was cancelled.");
    if (files.length === 0) {
      return {
        ok: true,
        content: `No files in this session use a supported grammar (${AST_SEARCH_GRAMMARS_TEXT}).`,
      };
    }
    const rows = formatAstSearchMatches(matches, { limit, truncated, filesScanned: files.length });
    const scope = relative(resolvedRoots[0] ?? base, base).replace(/\\/g, "/");
    const header = [
      `${matches.length} match${matches.length === 1 ? "" : "es"} in ${matchedFiles} of ${files.length} files`,
      scope ? `searched: ${scope}` : undefined,
    ]
      .filter(Boolean)
      .join(" · ");
    return { ok: true, content: `${header}\n${rows}` };
  };
}

const AST_SEARCH_GRAMMARS_TEXT = "TypeScript, Tsx, JavaScript, Html, Css";
