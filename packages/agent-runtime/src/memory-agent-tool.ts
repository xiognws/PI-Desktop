/**
 * The `memory` tool (ADR 0393): structured retain and recall.
 *
 * Memory is one structured store (`memories` in host-core), not a document the
 * agent edits. The model retains a memory — a title, a body, a kind, optional
 * tags, a scope — and later retrieves the relevant ones by query. Nothing here
 * renders the store into the system prompt: the prompt carries only what a
 * per-turn recall finds relevant (`memory-context.ts`), so the cost of
 * remembering does not grow with the store and capacity stops being a reason to
 * delete a useful note.
 *
 * Every write is one host RPC (`memory.remember` / `memory.update` /
 * `memory.forget`) and every read is `memory.recall`, so the runtime, the
 * settings page and the background review share one implementation of dedupe,
 * supersession and scope filtering. What stays here is only what the store
 * cannot tell a model: which argument is missing, which memory an answer refers
 * to, and the one rule a search cannot express — a procedure belongs in a skill.
 *
 * A refused edit is reported as ordinary text, not a hard failure: the model can
 * fix its own argument and retry in the same turn (same convention as
 * `skill_manage`).
 */

import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

import { scrubSecretsInBatch } from "@pi-workspace/shared";

import type { RuntimeHost } from "./host-client.js";
import { procedureNeedingASkill, type SkillSummary } from "./memory-skill-overlap.js";

/** Appended to a result whose content had a credential masked out of it. */
const MEMORY_SCRUB_NOTE =
  "\n\nA credential-shaped string in this content was replaced with ***REDACTED*** before saving: memory is recalled into later prompts.";

/** Characters of a recalled body shown per hit; the whole text is one `search` away. */
const MAX_HIT_BODY_CHARS = 400;

/** Hits a `search` asks the host for when the model does not say. */
const DEFAULT_SEARCH_LIMIT = 8;

/** Host-core caps recall here, so asking for more would be silently ignored. */
const MAX_SEARCH_LIMIT = 50;

const MEMORY_KINDS = ["fact", "preference", "decision", "pitfall", "procedure"] as const;
const MEMORY_SCOPES = ["global", "project", "session"] as const;

type MemoryKindName = (typeof MEMORY_KINDS)[number];
type MemoryScopeName = (typeof MEMORY_SCOPES)[number];

const MEMORY_TOOL_DESCRIPTION = [
  "Store and recall durable memory: one structured list of memories that stays with you across sessions.",
  "",
  "Memory holds what stays true after this conversation, one memory per thing learned: a preference the user stated, a decision and its reason, a pitfall you actually hit, a constraint of this repository or machine. Each memory has a short `title`, a `body`, a `kind`, optional `tags` and a `scope`. Nothing here enters your system prompt in full — the memories relevant to a turn are recalled alongside the user's message, so the store can grow without costing context and there is no size budget to manage.",
  "",
  "Actions:",
  "- `remember` stores one memory. Required: `title` (a few words naming what it is about) and `body` (the memory itself). Optional: `kind` — `fact` (default), `preference`, `decision`, `pitfall`; `tags`; `scope` — `global` (default, true everywhere), `project` (this project only), `session` (this conversation only); `pinned` (recalled every turn). Writing the same title and body again refreshes the existing memory instead of duplicating it.",
  "- `update` changes a memory you already hold, by `id`: any of `title`, `body`, `tags`, `pinned`, `confidence`. Use it when the fact changed, rather than storing a contradicting second copy.",
  "- `forget` deletes one memory by `id`. Use it for what turned out wrong, or that the user asked you to drop.",
  "- `search` runs a keyword query over the store and returns the closest memories with their ids, best first. Search before `remember` when you may already know this, and before `update` or `forget` when you do not have the id. Query with the words the memory would contain, not with a question.",
  "",
  "A procedure — two or more steps that will still be true next month — belongs in a skill, not here: write it with `skill_manage`. This tool refuses a body that reads like steps (`MEMORY_PROCEDURE_NEEDS_SKILL`) and names the skill to patch when one already covers it. Facts, preferences and one-line quirks are exactly what memory is for.",
  "",
  "Record what you learned, not the task you ran: not progress, not file contents you can re-read, not secrets. Write in the language the user writes in — a memory is read back to them, and matched against their words, in a later session.",
].join("\n");

const MEMORY_TOOL_PARAMETERS = Type.Object(
  {
    action: Type.Union(
      [
        Type.Literal("remember"),
        Type.Literal("update"),
        Type.Literal("forget"),
        Type.Literal("search"),
      ],
      { description: "What to do with the store." },
    ),
    title: Type.Optional(
      Type.String({
        description: "remember / update. A few words naming the thing this memory is about.",
      }),
    ),
    body: Type.Optional(
      Type.String({
        description:
          "remember / update. The memory itself: one fact, preference, decision or pitfall.",
      }),
    ),
    kind: Type.Optional(
      Type.Union(MEMORY_KINDS.map((kind) => Type.Literal(kind)), {
        description: "remember only. Defaults to `fact`.",
      }),
    ),
    tags: Type.Optional(
      Type.Array(Type.String(), {
        description: "remember / update. Short labels that make this memory findable later.",
      }),
    ),
    scope: Type.Optional(
      Type.Union(MEMORY_SCOPES.map((scope) => Type.Literal(scope)), {
        description: "remember only. Defaults to `global`.",
      }),
    ),
    pinned: Type.Optional(
      Type.Boolean({
        description: "remember / update. Recalled on every turn; for standing instructions only.",
      }),
    ),
    confidence: Type.Optional(
      Type.Number({
        description: "update only. 0..1, how sure this memory is; it is written as 0.7.",
      }),
    ),
    id: Type.Optional(
      Type.String({
        description: "update / forget. The id a `remember` or `search` result gave you.",
      }),
    ),
    query: Type.Optional(Type.String({ description: "search. Words the memory would contain." })),
    limit: Type.Optional(
      Type.Number({ description: "search. How many hits at most. Defaults to 8, capped at 50." }),
    ),
  },
  { additionalProperties: false },
);

/**
 * The record shape host-core answers with. Every field is optional here because
 * the tool renders whatever the host sent rather than trusting its own copy: a
 * field added host-side then shows up in the result without a runtime change.
 */
type MemoryRecord = {
  id?: string;
  scope?: string;
  kind?: string;
  title?: string;
  body?: string;
  tags?: readonly string[];
  confidence?: number;
  pinned?: boolean;
};

type RememberReply = { memory?: MemoryRecord; deduped?: boolean };
type UpdateReply = { memory?: MemoryRecord };
type ForgetReply = { removed?: number };
type RecallHit = { memory?: MemoryRecord; score?: number };
type RecallReply = { memories?: RecallHit[] };

/** Host surface the tool needs: the structured memory RPCs. */
export type MemoryToolHost = Pick<RuntimeHost, "call">;

/** What the memory tool needs to know about the session it writes for. */
export type MemoryToolOptions = {
  /**
   * The skill catalogue, read at write time rather than at construction — and it
   * may need to read skill documents, so it is allowed to be async.
   */
  skills?: () => readonly SkillSummary[] | Promise<readonly SkillSummary[]>;
  /** The open project, needed to store and find `project`-scoped memories. */
  projectPath?: string;
  /** This conversation, needed for `session`-scoped memories. */
  sessionId?: string;
};

function text(
  message: string,
  details: Record<string, unknown> = {},
  isError?: boolean,
): AgentToolResult<Record<string, unknown>> {
  return {
    content: [{ type: "text" as const, text: message }],
    details,
    ...(isError ? { isError: true } : {}),
  };
}

/** The host's own words for a rejected call; `String(error)` on a transport is noise. */
function hostMessage(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === "string" && message.trim() ? message : String(error);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function trimmed(value: unknown): string | undefined {
  const candidate = asString(value)?.trim();
  return candidate ? candidate : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return undefined;
    if (item.trim()) out.push(item.trim());
  }
  return out;
}

function asEnum<T extends string>(values: readonly T[], value: unknown): T | undefined {
  return values.find((candidate) => candidate === value);
}

/** `[fact] Title (tags: a, b) — id m1`: one line that names the memory. */
function describeMemory(record: MemoryRecord | undefined): string {
  const title = record?.title?.trim();
  const kind = record?.kind?.trim();
  const tags = (record?.tags ?? []).filter((tag) => tag.trim().length > 0);
  const parts = [[kind ? `[${kind}]` : "", title ?? "(untitled)"].filter(Boolean).join(" ")];
  if (tags.length > 0) parts.push(`(tags: ${tags.join(", ")})`);
  if (record?.id) parts.push(`— id ${record.id}`);
  return parts.join(" ");
}

/** A body shortened for a hit line, so one long memory cannot crowd out the rest. */
function trimBody(body: string | undefined): string {
  const value = (body ?? "").trim();
  if (!value) return "";
  return value.length > MAX_HIT_BODY_CHARS ? `${value.slice(0, MAX_HIT_BODY_CHARS)}…` : value;
}

/** Mask credential-shaped text in one memory's fields, keeping the batch property. */
function scrubFields(fields: readonly string[]): { safe: string[]; masked: boolean } {
  const safe = scrubSecretsInBatch(fields);
  return { safe, masked: safe.some((value, index) => value !== fields[index]) };
}

export function createMemoryTool(host: MemoryToolHost, options: MemoryToolOptions = {}): AgentTool {
  /** Retain: validate, gate, mask, then one host call. */
  const remember = async (
    raw: Record<string, unknown>,
  ): Promise<AgentToolResult<Record<string, unknown>>> => {
    const title = trimmed(raw.title);
    if (!title) {
      return text(
        "title is required for remember: a few words naming the thing this memory is about.",
        { errorCode: "MEMORY_INVALID_ARGUMENT" },
        true,
      );
    }
    const body = trimmed(raw.body);
    if (!body) {
      return text(
        "body is required for remember: the fact, preference, decision or pitfall itself.",
        { errorCode: "MEMORY_INVALID_ARGUMENT" },
        true,
      );
    }
    const rawKind = raw.kind;
    const kind: MemoryKindName | undefined =
      rawKind === undefined ? "fact" : asEnum(MEMORY_KINDS, rawKind);
    if (!kind) {
      return text(`kind must be one of ${MEMORY_KINDS.join(", ")}.`, {
        errorCode: "MEMORY_INVALID_ARGUMENT",
      }, true);
    }
    const rawScope = raw.scope;
    const scope: MemoryScopeName | undefined =
      rawScope === undefined ? "global" : asEnum(MEMORY_SCOPES, rawScope);
    if (!scope) {
      return text(`scope must be one of ${MEMORY_SCOPES.join(", ")}.`, {
        errorCode: "MEMORY_INVALID_ARGUMENT",
      }, true);
    }
    // A scope names a column the host validates: a project memory without a project
    // path is refused host-side, and saying so here turns a failed call into a fix.
    if (scope === "project" && !options.projectPath) {
      return text(
        "scope `project` needs an open project, and this session has none. Use `global` for what is true anywhere, or `session` for this conversation only.",
        { errorCode: "MEMORY_INVALID_ARGUMENT" },
        true,
      );
    }
    if (scope === "session" && !options.sessionId) {
      return text(
        "scope `session` needs a conversation id, which this session does not have. Use `global` instead.",
        { errorCode: "MEMORY_INVALID_ARGUMENT" },
        true,
      );
    }
    const rawTags = raw.tags;
    const tags = rawTags === undefined ? [] : asStringArray(rawTags);
    if (!tags) {
      return text("tags must be an array of strings.", { errorCode: "MEMORY_INVALID_ARGUMENT" }, true);
    }
    const pinned = raw.pinned;
    if (pinned !== undefined && typeof pinned !== "boolean") {
      return text("pinned must be true or false.", { errorCode: "MEMORY_INVALID_ARGUMENT" }, true);
    }
    // One lesson, one place. A procedure belongs in a skill *whether or not* one
    // exists yet, and the check is the shape of the sentence — steps or a fact —
    // because a catalogue's one line of English cannot be compared against a
    // dictated Chinese procedure. A fact that merely mentions the same subsystem
    // ("this machine blocks TCP 22" beside a publish skill) is what memory is for.
    const skills = (await options.skills?.()) ?? [];
    const procedure = procedureNeedingASkill([body], [], skills);
    if (procedure) {
      const where = procedure.skillId
        ? `skill \`${procedure.skillId}\` covers this class of task`
        : "it belongs in a skill";
      return text(
        `Not saved: this is a procedure (steps), not a fact — ${where}. Write it with \`skill_manage\` (action \`create\`, or \`patch\` the skill above and add a \`references/\` file), and keep memory for facts, preferences and one-line quirks. If what you actually learned is a single fact, state the fact alone and it will be stored.`,
        {
          errorCode: "MEMORY_PROCEDURE_NEEDS_SKILL",
          ...(procedure.skillId ? { skillId: procedure.skillId } : {}),
        },
        true,
      );
    }
    // Memory is recalled into later prompts, so credential-shaped text is masked on
    // the way in — the log redactor's vocabulary, in the other direction. The batch
    // runs over every field at once because a token stated once with its label is
    // often repeated bare beside it.
    const originals = [title, body, ...tags];
    const scrubbed = scrubFields(originals);
    const [safeTitle, safeBody, ...safeTags] = scrubbed.safe;
    const params: Record<string, unknown> = { scope, kind, title: safeTitle, body: safeBody };
    if (safeTags.length > 0) params.tags = safeTags;
    if (typeof pinned === "boolean") params.pinned = pinned;
    // Global memory must not carry either column; the host refuses it if it does.
    if (scope === "project" && options.projectPath) params.projectPath = options.projectPath;
    if (scope === "session" && options.sessionId) params.sessionId = options.sessionId;
    let reply: RememberReply;
    try {
      reply = await host.call<RememberReply>("memory.remember", params);
    } catch (error) {
      return text(`Memory was not saved: ${hostMessage(error)}`, {
        errorCode: "MEMORY_WRITE_FAILED",
      }, true);
    }
    const line = reply.deduped
      ? `Already stored — refreshed ${describeMemory(reply.memory)}.`
      : `Saved ${describeMemory(reply.memory)} (scope ${scope}).`;
    return text(scrubbed.masked ? `${line}${MEMORY_SCRUB_NOTE}` : line, {
      action: "remember",
      scope,
      kind,
      ...(reply.memory?.id ? { id: reply.memory.id } : {}),
      ...(reply.deduped ? { deduped: true } : {}),
      ...(scrubbed.masked ? { masked: true } : {}),
    });
  };

  /** Patch one memory: any subset of the editable fields, one host call. */
  const update = async (
    raw: Record<string, unknown>,
  ): Promise<AgentToolResult<Record<string, unknown>>> => {
    const id = trimmed(raw.id);
    if (!id) {
      return text("id is required for update: `search` first if you do not have it.", {
        errorCode: "MEMORY_INVALID_ARGUMENT",
      }, true);
    }
    const title = trimmed(raw.title);
    const body = trimmed(raw.body);
    const rawTags = raw.tags;
    const tags = rawTags === undefined ? undefined : asStringArray(rawTags);
    if (rawTags !== undefined && !tags) {
      return text("tags must be an array of strings.", { errorCode: "MEMORY_INVALID_ARGUMENT" }, true);
    }
    const pinned = raw.pinned;
    if (pinned !== undefined && typeof pinned !== "boolean") {
      return text("pinned must be true or false.", { errorCode: "MEMORY_INVALID_ARGUMENT" }, true);
    }
    const confidence = raw.confidence;
    if (
      confidence !== undefined &&
      (typeof confidence !== "number" ||
        !Number.isFinite(confidence) ||
        confidence < 0 ||
        confidence > 1)
    ) {
      return text("confidence must be a number between 0 and 1.", {
        errorCode: "MEMORY_INVALID_ARGUMENT",
      }, true);
    }
    const fields: Record<string, unknown> = {};
    if (title !== undefined || body !== undefined) {
      // Same masking as `remember`: a rewritten field must not become the one place
      // a credential survives.
      const scrubbed = scrubFields([title ?? "", body ?? ""]);
      if (title !== undefined) fields.title = scrubbed.safe[0];
      if (body !== undefined) fields.body = scrubbed.safe[1];
    }
    if (tags !== undefined) fields.tags = tags;
    if (typeof pinned === "boolean") fields.pinned = pinned;
    if (typeof confidence === "number") fields.confidence = confidence;
    if (Object.keys(fields).length === 0) {
      return text("nothing to update: pass at least one of title, body, tags, pinned, confidence.", {
        errorCode: "MEMORY_INVALID_ARGUMENT",
      }, true);
    }
    let reply: UpdateReply;
    try {
      reply = await host.call<UpdateReply>("memory.update", { id, ...fields });
    } catch (error) {
      const message = hostMessage(error);
      if (/not found/i.test(message)) {
        return text(
          `No memory with id ${id}. Use \`search\` to find the id, or \`remember\` to store it again.`,
          { errorCode: "MEMORY_NOT_FOUND" },
          true,
        );
      }
      return text(`Memory ${id} was not updated: ${message}`, {
        errorCode: "MEMORY_WRITE_FAILED",
      }, true);
    }
    return text(`Updated ${describeMemory(reply.memory ?? { id })}.`, {
      action: "update",
      id,
      fields: Object.keys(fields),
    });
  };

  /** Forget one memory by id, and say plainly when nothing was there. */
  const forget = async (
    raw: Record<string, unknown>,
  ): Promise<AgentToolResult<Record<string, unknown>>> => {
    const id = trimmed(raw.id);
    if (!id) {
      return text("id is required for forget: `search` first if you do not have it.", {
        errorCode: "MEMORY_INVALID_ARGUMENT",
      }, true);
    }
    let reply: ForgetReply;
    try {
      reply = await host.call<ForgetReply>("memory.forget", { id });
    } catch (error) {
      return text(`Memory ${id} was not removed: ${hostMessage(error)}`, {
        errorCode: "MEMORY_WRITE_FAILED",
      }, true);
    }
    const removed = reply.removed ?? 0;
    if (removed === 0) {
      return text(`No memory with id ${id} was stored, so nothing was removed.`, {
        action: "forget",
        id,
        removed: 0,
      });
    }
    return text(`Forgot memory ${id}.`, { action: "forget", id, removed });
  };

  /** Retrieve: the host ranks, this side only renders. */
  const search = async (
    raw: Record<string, unknown>,
  ): Promise<AgentToolResult<Record<string, unknown>>> => {
    const query = trimmed(raw.query);
    if (!query) {
      return text("query is required for search: the words the memory would contain.", {
        errorCode: "MEMORY_INVALID_ARGUMENT",
      }, true);
    }
    const rawLimit = raw.limit;
    const requested =
      typeof rawLimit === "number" && Number.isFinite(rawLimit)
        ? Math.floor(rawLimit)
        : DEFAULT_SEARCH_LIMIT;
    const limit = Math.min(Math.max(requested, 1), MAX_SEARCH_LIMIT);
    const params: Record<string, unknown> = { query, limit };
    // Narrowing is the host's: a project's memories are visible only with the project
    // path, its session's only with the session id (and global ones always).
    if (options.projectPath) params.projectPath = options.projectPath;
    if (options.sessionId) params.sessionId = options.sessionId;
    let reply: RecallReply;
    try {
      reply = await host.call<RecallReply>("memory.recall", params);
    } catch (error) {
      return text(`Memory could not be searched: ${hostMessage(error)}`, {
        errorCode: "MEMORY_SEARCH_FAILED",
      }, true);
    }
    // Host order is the ranking; re-sorting here would throw the ranking away.
    const hits: { memory: MemoryRecord; score?: number }[] = [];
    for (const hit of Array.isArray(reply.memories) ? reply.memories : []) {
      const memory = hit?.memory;
      if (!memory) continue;
      if (!memory.title?.trim() && !memory.body?.trim()) continue;
      hits.push({ memory, score: hit.score });
    }
    if (hits.length === 0) {
      return text(
        `No memory matched '${query}'. Try the words the memory would contain, or \`remember\` it if you have not stored it yet.`,
        { action: "search", query, hits: 0 },
      );
    }
    const lines = hits.map((hit, index) => {
      const score = typeof hit.score === "number" ? ` (score ${hit.score.toFixed(3)})` : "";
      const body = trimBody(hit.memory.body);
      return [
        `${index + 1}. ${describeMemory(hit.memory)}${score}`,
        ...(body ? [`   ${body}`] : []),
      ].join("\n");
    });
    return text(
      [
        `${hits.length} memor${hits.length === 1 ? "y" : "ies"} matched '${query}', best first:`,
        "",
        ...lines,
        "",
        "`update` and `forget` take one of these ids.",
      ].join("\n"),
      { action: "search", query, hits: hits.length },
    );
  };

  return {
    name: "memory",
    label: "Memory",
    description: MEMORY_TOOL_DESCRIPTION,
    parameters: MEMORY_TOOL_PARAMETERS,
    executionMode: "sequential",
    execute: async (_toolCallId, rawParams) => {
      const raw = (rawParams ?? {}) as Record<string, unknown>;
      switch (raw.action) {
        case "remember":
          return remember(raw);
        case "update":
          return update(raw);
        case "forget":
          return forget(raw);
        case "search":
          return search(raw);
        default:
          return text(
            "action is required: `remember` to store one memory, `update` or `forget` by id, or `search` to find what is already stored.",
            { errorCode: "MEMORY_INVALID_ACTION" },
            true,
          );
      }
    },
  };
}
