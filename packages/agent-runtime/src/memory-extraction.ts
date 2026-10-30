/**
 * Automatic memory extraction (ADR 0376).
 *
 * A finished turn is reviewed once, off the turn's critical path, for anything
 * worth remembering later. The model's answer is only a *proposal*: the host
 * stores it in `memory_proposals` and a person decides, so nothing here needs to
 * be trusted — it needs to be strict about shape and bounded in cost.
 *
 * Everything in this module is pure: prompt text, transcript shaping, and a
 * parser that tolerates what models actually emit (fenced blocks, prose around
 * the JSON, an object instead of an array) while refusing anything unusable.
 */

/** Never ask for, or accept, more than this from one turn. */
export const MAX_EXTRACTION_CANDIDATES = 5;
/** The transcript window extraction may look at, in characters. */
export const MAX_EXTRACTION_TRANSCRIPT_CHARS = 6_000;
/** A candidate longer than this is not a memory, it is a summary. */
const MAX_TITLE_CHARS = 120;
const MAX_BODY_CHARS = 1_200;

export const MEMORY_KINDS = [
  "fact",
  "preference",
  "decision",
  "pitfall",
  "procedure",
] as const;

export type MemoryExtractionKind = (typeof MEMORY_KINDS)[number];

export type MemoryExtractionCandidate = {
  kind: MemoryExtractionKind;
  title: string;
  body: string;
  tags: string[];
};

export const EXTRACTION_SYSTEM_PROMPT = [
  "You review one finished assistant turn and report only what is worth remembering in a later session.",
  "",
  "Answer with a JSON array and nothing else. Each item is:",
  '{"kind":"fact|preference|decision|pitfall|procedure","title":"short noun phrase","body":"one or two sentences","tags":["optional","labels"]}',
  "",
  "Rules:",
  "- A durable fact about the project, the environment, or the user's setup is a `fact`.",
  "- How the user wants things done is a `preference`.",
  "- A choice that was made and why is a `decision`.",
  "- Something that failed and what to do instead is a `pitfall`.",
  "- A sequence that will be repeated is a `procedure`.",
  "- Never restate what the code already says, and never report a one-off detail of this turn.",
  "- If nothing is worth keeping, answer [].",
].join("\n");

/** The turns extraction reads: role plus text, already flattened by the caller. */
export type ExtractionTurn = { role: "user" | "assistant"; content: string };

/**
 * The transcript window, oldest dropped first. Extraction reads the tail because
 * that is where the conclusion of a turn lives.
 */
export function buildExtractionTranscript(turns: ExtractionTurn[]): string {
  const parts: string[] = [];
  for (const turn of turns) {
    const text = turn.content.trim();
    if (!text) continue;
    parts.push(turn.role === "assistant" ? `### Assistant\n${text}` : `### User\n${text}`);
  }
  const joined = parts.join("\n\n");
  return joined.length > MAX_EXTRACTION_TRANSCRIPT_CHARS
    ? joined.slice(joined.length - MAX_EXTRACTION_TRANSCRIPT_CHARS)
    : joined;
}

function coerceTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((tag): tag is string => typeof tag === "string")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0 && tag.length <= 40)
    .slice(0, 8);
}

/**
 * Pull candidates out of whatever the model produced.
 *
 * Tolerances are deliberate and narrow: a fenced code block is unwrapped, an
 * object with a single array field is read, prose before the array is skipped.
 * Anything else — an unknown kind, a missing title, a body that is really a
 * paragraph — is dropped rather than guessed at, because a wrong memory is
 * recalled for every later turn.
 */
export function parseExtractionCandidates(text: string): MemoryExtractionCandidate[] {
  const raw = String(text ?? "").trim();
  if (!raw) return [];

  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  let payload: unknown;
  if (start >= 0 && end > start) {
    payload = safeParse(raw.slice(start, end + 1));
  }
  if (payload === undefined) {
    // A model that answers `{"memories": [...]}` is still answering.
    const object = safeParse(raw);
    if (object && typeof object === "object" && !Array.isArray(object)) {
      const arrayField = Object.values(object as Record<string, unknown>).find(Array.isArray);
      payload = arrayField;
    }
  }
  if (!Array.isArray(payload)) return [];

  const kinds = new Set<string>(MEMORY_KINDS);
  const seen = new Set<string>();
  const out: MemoryExtractionCandidate[] = [];
  for (const entry of payload) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const kind = typeof record.kind === "string" ? record.kind.trim().toLowerCase() : "";
    if (!kinds.has(kind)) continue;
    const title = typeof record.title === "string" ? record.title.trim() : "";
    const body = typeof record.body === "string" ? record.body.trim() : "";
    if (!title || !body) continue;
    if (title.length > MAX_TITLE_CHARS || body.length > MAX_BODY_CHARS) continue;
    const key = `${title.toLowerCase()}\n${body.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: kind as MemoryExtractionKind, title, body, tags: coerceTags(record.tags) });
    if (out.length >= MAX_EXTRACTION_CANDIDATES) break;
  }
  return out;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
