/**
 * A unified diff as the transcript draws it.
 *
 * Assistant replies, review cards and tool rows all show changed lines, and the
 * line is the unit every one of them colours: added, removed, context, a hunk
 * header, or file metadata (`diff --git`, `+++ b/…`, mode lines). Keeping the
 * classification pure and shared is what lets a fence pasted into chat look the
 * same as a host-recorded change.
 */

export type DiffLineType = "add" | "del" | "context" | "hunk" | "meta";

export type DiffLine = { type: DiffLineType; text: string };

/** Fence languages that are a diff rather than source code. */
const DIFF_LANGUAGES = new Set(["diff", "patch", "udiff"]);

export function isDiffFenceLanguage(lang: string): boolean {
  return DIFF_LANGUAGES.has(lang.trim().toLowerCase());
}

/** Lines that carry diff bookkeeping, never content. */
const META_PREFIXES = [
  "diff --git ",
  "diff --cc ",
  "diff --combined ",
  "index ",
  "new file mode ",
  "deleted file mode ",
  "old mode ",
  "new mode ",
  "similarity index ",
  "dissimilarity index ",
  "rename from ",
  "rename to ",
  "copy from ",
  "copy to ",
  "Binary files ",
  "GIT binary patch",
  "\\ No newline at end of file",
];

function isMetaLine(line: string): boolean {
  // `--- a/x` and `+++ b/x` are the file headers, not a removal and an addition.
  if (line.startsWith("--- ") || line.startsWith("+++ ")) return true;
  return META_PREFIXES.some((prefix) => line.startsWith(prefix));
}

export function classifyDiffLine(line: string): DiffLineType {
  if (line.startsWith("@@")) return "hunk";
  if (isMetaLine(line)) return "meta";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "context";
}

/**
 * Split a fenced diff into classified lines. The fence body has already lost
 * its trailing newline, so no empty last line is invented here.
 */
export function parseDiffLines(source: string): DiffLine[] {
  return source
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((text) => ({ type: classifyDiffLine(text), text }));
}

/** The sign drawn in the gutter; metadata and hunk headers have none. */
export function diffLineSign(type: DiffLineType): string {
  if (type === "add") return "+";
  if (type === "del") return "−";
  return "";
}
