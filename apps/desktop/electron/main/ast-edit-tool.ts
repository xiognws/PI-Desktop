/**
 * `AstEdit` — structural rewrite in two steps: propose, then apply.
 *
 * `AstSearch` answers "where does this shape appear"; this rewrites every
 * occurrence of it in one pass instead of one `Edit` per site. The rewrite is
 * **staged**: the proposal holds the new text of each file plus the hash of the
 * text it was computed from, and nothing touches the disk until `AstEditApply`
 * runs on that proposal id. That is the property that makes a codemod safe — the
 * model (and the UI) can see exactly what would change and how much, and a file
 * edited in between makes the apply fail instead of overwriting the wrong text.
 *
 * Runs in Electron main for the same reason as `AstSearch`: the parser is a
 * native addon, and the filesystem-facing local tools already live here.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath, rename, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parse } from "@ast-grep/napi";
import {
  AST_SEARCH_MAX_LIMIT,
  AST_SEARCH_PATTERN_GRAMMARS,
  clampAstSearchLimit,
  isPathInsideRoots,
} from "@pi-workspace/shared";

import { collectParseableFiles } from "./ast-search-tool.ts";

/** Upper bound on the text one proposal may rewrite, so a stray pattern cannot fill memory. */
const MAX_PROPOSAL_BYTES = 4 * 1024 * 1024;
/** Characters of one proposal kept alive after it is staged. */
const PROPOSAL_TTL_MS = 15 * 60 * 1000;

export type AstEditFilePreview = {
  file: string;
  replacements: number;
  /** Compact `-`/`+` lines for the changed regions, capped. */
  preview: string;
};

export type AstEditProposalResult = {
  ok: boolean;
  isError?: boolean;
  /** Rendered for the model: what would change, how much, and the apply call to make. */
  content: string;
};

export type AstEditApplyResult = {
  ok: boolean;
  isError?: boolean;
  content: string;
};

type StagedFile = {
  path: string;
  beforeHash: string;
  after: string;
  replacements: number;
};

type StagedProposal = {
  sessionId: string;
  createdAt: number;
  files: StagedFile[];
};

/** Session-scoped staging area; keeping it in main means a renderer reload cannot apply a stale edit. */
export class AstEditStaging {
  private readonly proposals = new Map<string, StagedProposal>();

  put(sessionId: string, files: StagedFile[]): string {
    const id = randomUUID();
    this.prune();
    this.proposals.set(id, { sessionId, createdAt: Date.now(), files });
    return id;
  }

  take(sessionId: string, id: string): StagedProposal | undefined {
    const proposal = this.proposals.get(id);
    if (!proposal || proposal.sessionId !== sessionId) return undefined;
    this.proposals.delete(id);
    if (Date.now() - proposal.createdAt > PROPOSAL_TTL_MS) return undefined;
    return proposal;
  }

  private prune(): void {
    const now = Date.now();
    for (const [id, proposal] of this.proposals) {
      if (now - proposal.createdAt > PROPOSAL_TTL_MS) this.proposals.delete(id);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

const comparedPathCaseInsensitive = () => process.platform === "win32" || process.platform === "darwin";

/**
 * Replace `$VAR` / `$$$VARS` in the rewrite template with the capture of that
 * name. Unknown names stay literal so a typo shows up in the preview instead of
 * silently deleting text.
 */
function expandRewrite(template: string, captures: (name: string) => string | undefined): string {
  return template
    .replace(/\$\$\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, name: string) => captures(name) ?? `$$$${name}`)
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, name: string) => captures(name) ?? `$${name}`);
}

/**
 * A minimal line diff for the preview: equal-length prefix/suffix trimmed, the
 * middle shown as removed and added lines. It is a review aid, not a patch
 * format — the apply uses the staged text, never this rendering.
 */
function previewLines(before: string, after: string, budget = 40): string {
  const beforeLines = before.split(/\r?\n/);
  const afterLines = after.split(/\r?\n/);
  let start = 0;
  while (start < beforeLines.length && start < afterLines.length && beforeLines[start] === afterLines[start]) {
    start += 1;
  }
  let endBefore = beforeLines.length - 1;
  let endAfter = afterLines.length - 1;
  while (endBefore >= start && endAfter >= start && beforeLines[endBefore] === afterLines[endAfter]) {
    endBefore -= 1;
    endAfter -= 1;
  }
  const lines: string[] = [];
  for (let index = start; index <= endBefore && lines.length < budget; index += 1) {
    lines.push(`- ${beforeLines[index]}`);
  }
  for (let index = start; index <= endAfter && lines.length < budget; index += 1) {
    lines.push(`+ ${afterLines[index]}`);
  }
  if (lines.length === budget) lines.push("… (preview truncated)");
  return lines.join("\n");
}

/** How a proposal is shown to the model: countable, and with the call that applies it. */
function renderProposal(
  proposalId: string,
  files: readonly AstEditFilePreview[],
  totalReplacements: number,
  truncated: boolean,
): string {
  const lines: string[] = [
    `AstEdit staged ${totalReplacements} replacement(s) in ${files.length} file(s); nothing has been written.`,
    "",
  ];
  for (const file of files) {
    lines.push(`${file.file} — ${file.replacements} replacement(s)`);
    lines.push(file.preview);
    lines.push("");
  }
  if (truncated) lines.push("(stopped at the limit; raise `limit` or narrow `path` to cover the rest)");
  lines.push(`To write it: AstEditApply with proposalId \`${proposalId}\`.`);
  return lines.join("\n");
}

/** Resolve and validate the requested base directory, exactly as `AstSearch` does. */
async function resolveBase(
  roots: readonly string[],
  requested: string,
): Promise<{ base: string } | { error: string }> {
  const candidate = requested
    ? isAbsolute(requested)
      ? resolve(requested)
      : resolve(roots[0] as string, requested)
    : (roots[0] as string);
  let base: string;
  try {
    base = await realpath(candidate);
  } catch {
    return { error: `AstEdit: "${requested || candidate}" does not exist in this session.` };
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
    return { error: `AstEdit: "${requested || base}" is outside this session's project and scratch directories.` };
  }
  return { base };
}

export type AstEditToolOptions = {
  getRoots: (sessionId: string) => Promise<readonly string[]>;
  staging: AstEditStaging;
};

/** The slice of an ast-grep match this module needs. */
type SgHit = {
  text(): string;
  replace(replacement: string): unknown;
  getMatch?(name: string): { text(): string } | null;
};

/** Compute the replacement text for one match. */
function replacementFor(match: SgHit, rewrite: string): string | undefined {
  const captures = (name: string) => {
    const single = match.getMatch?.(name);
    return single ? String(single.text()) : undefined;
  };
  return expandRewrite(rewrite, captures);
}

export function createAstEditTool(options: AstEditToolOptions) {
  return async (input: { args: unknown; sessionId: string; signal: AbortSignal }): Promise<AstEditProposalResult> => {
    const empty = { files: [], totalReplacements: 0, truncated: false };
    const args = isRecord(input.args) ? input.args : {};
    const pattern = typeof args.pattern === "string" ? args.pattern.trim() : "";
    const rewrite = typeof args.rewrite === "string" ? args.rewrite : "";
    if (!pattern) return { ok: false, isError: true, content: "AstEdit: `pattern` is required." };
    if (!rewrite) return { ok: false, isError: true, content: "AstEdit: `rewrite` is required." };
    if (!AST_SEARCH_PATTERN_GRAMMARS.length) {
      return { ok: false, isError: true, content: "AstEdit: no grammar is available for structural rewrites." };
    }

    let roots: readonly string[];
    try {
      roots = await options.getRoots(input.sessionId);
    } catch (error) {
      return { ok: false, isError: true, content: `AstEdit: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (roots.length === 0)
      return { ok: false, isError: true, content: "AstEdit: this session has no project directory." };

    const requested = typeof args.path === "string" ? args.path.trim() : "";
    const resolved = await resolveBase(roots, requested);
    if ("error" in resolved) return { ok: false, isError: true, content: resolved.error };

    const limit = clampAstSearchLimit(args.limit ?? AST_SEARCH_MAX_LIMIT);
    const { files, truncated } = await collectParseableFiles(resolved.base, input.signal);

    const staged: StagedFile[] = [];
    const previews: AstEditFilePreview[] = [];
    let totalReplacements = 0;
    let bytes = 0;

    for (const entry of files) {
      if (input.signal.aborted) break;
      if (totalReplacements >= limit || bytes >= MAX_PROPOSAL_BYTES) break;
      let source: string;
      try {
        source = await readFile(entry.file, "utf8");
      } catch {
        continue;
      }
      let after: string;
      let replacements = 0;
      try {
        const root = parse(entry.language as Parameters<typeof parse>[0], source).root();
        const hits = root.findAll({ rule: { pattern } });
        if (hits.length === 0) continue;
        // One edit per hit, applied in one pass so the offsets all refer to the
        // original text.
        const edits = [];
        for (const hit of hits) {
          const replacement = replacementFor(hit, rewrite);
          if (replacement === undefined || replacement === hit.text()) continue;
          edits.push(hit.replace(replacement));
        }
        if (edits.length === 0) continue;
        replacements = edits.length;
        after = root.commitEdits(edits);
      } catch {
        // An unparsable file is skipped, not reported as a failed rewrite: the
        // walk already only offers files the grammar claims to handle.
        continue;
      }
      if (after === source) continue;
      const file = relative(resolved.base, entry.file).replace(/\\/g, "/") || basename(entry.file);
      staged.push({ path: entry.file, beforeHash: hash(source), after, replacements });
      previews.push({ file, replacements, preview: previewLines(source, after) });
      totalReplacements += replacements;
      bytes += after.length;
    }

    if (staged.length === 0) {
      return {
        ok: true,
        content: `AstEdit: the pattern \`${pattern}\` matched nothing that the rewrite would change${truncated ? " (the walk stopped at its file limit)" : ""}.`,
      };
    }
    const proposalId = options.staging.put(input.sessionId, staged);
    return {
      ok: true,
      content: renderProposal(proposalId, previews, totalReplacements, truncated || totalReplacements >= limit),
    };
  };
}

export function createAstEditApplyTool(options: AstEditToolOptions) {
  return async (input: { args: unknown; sessionId: string }): Promise<AstEditApplyResult> => {
    const args = isRecord(input.args) ? input.args : {};
    const proposalId = typeof args.proposalId === "string" ? args.proposalId.trim() : "";
    if (!proposalId) return { ok: false, isError: true, content: "AstEditApply: `proposalId` is required." };

    const proposal = options.staging.take(input.sessionId, proposalId);
    if (!proposal) {
      return {
        ok: false,
        isError: true,
        content:
          "AstEditApply: no such proposal for this session (it was already applied, expired, or belongs to another session). Run AstEdit again.",
      };
    }

    // Re-check every file before writing: a proposal is only valid against the
    // text it was computed from.
    const current: string[] = [];
    for (const file of proposal.files) {
      let text: string;
      try {
        text = await readFile(file.path, "utf8");
      } catch {
        return { ok: false, isError: true, content: `AstEditApply: ${file.path} disappeared after it was staged.` };
      }
      if (hash(text) !== file.beforeHash) {
        return {
          ok: false,
          isError: true,
          content: `AstEditApply: ${file.path} changed after the proposal was made. Run AstEdit again so the rewrite is computed from the current text.`,
        };
      }
      current.push(text);
    }

    const applied: { file: string; replacements: number }[] = [];
    for (const file of proposal.files) {
      // Write beside the target and rename, so an interrupted write cannot leave
      // half a file behind.
      const temporary = join(dirname(file.path), `.${basename(file.path)}.astedit-${randomUUID()}.tmp`);
      await writeFile(temporary, file.after, "utf8");
      await rename(temporary, file.path);
      applied.push({ file: file.path, replacements: file.replacements });
    }
    return {
      ok: true,
      content: `AstEditApply: wrote ${applied.length} file(s) — ${applied.map((entry) => `${entry.file} (${entry.replacements})`).join(", ")}.`,
    };
  };
}