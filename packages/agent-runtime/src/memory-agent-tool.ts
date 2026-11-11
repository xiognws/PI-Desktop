/**
 * The `memory` tool (ADR 0380), modelled on Hermes' `tools/memory_tool.py`.
 *
 * The model edits memory the way a person edits a note file: it sees the entries
 * (they are in the system prompt), and it names an action plus enough text to
 * locate what it means. It never re-emits the whole document, because
 * re-emission is where content silently disappears.
 *
 * The edit semantics live in `memory-store.ts` and run **here**, in the runtime,
 * not in host-core: the host owns durable storage (one atomic whole-list write
 * per call), this side owns matching and editing. Keeping one implementation
 * means the tested semantics and the running one cannot drift.
 *
 * The result always echoes the new entry list. The system prompt holds a frozen
 * snapshot taken at session start, so without the echo the model would be
 * editing a document it can no longer see.
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

import type { RuntimeHost } from "./host-client.js";
import {
  applyMemoryBatch,
  applyMemoryOperation,
  ENTRY_DELIMITER,
  MEMORY_CHAR_LIMIT,
  memoryCharCount,
  USER_CHAR_LIMIT,
  type MemoryOperation,
  type MemoryResult,
  type MemorySuccess,
  type MemoryTarget,
} from "./memory-store.js";
import { scrubSecretsInBatch } from "@pi-workspace/shared";

import { duplicateOfSkill, type SkillSummary } from "./memory-skill-overlap.js";

/** Appended to a result whose content had a credential masked out of it. */
const MEMORY_SCRUB_NOTE =
  "\n\nA credential-shaped string in this content was replaced with ***REDACTED*** before saving: memory is re-sent to the model on every later turn.";

/** How many characters of the store the tool result may echo back. */
const MAX_ECHO_CHARS = 4000;

const MEMORY_TOOL_DESCRIPTION = [
  "Read and edit your durable memory: a flat list of entries kept across sessions.",
  "",
  "Two targets. `memory` holds your own notes: how this project works, what failed and why, decisions and their reasons. `user` holds who the user is: their preferences, language, role, and standing instructions. Both enter your system prompt as a snapshot taken when the session started, so a write now is saved for the NEXT session and will not appear in the prompt you are reading.",
  "",
  "Actions:",
  "- `add` appends one entry. Adding an entry that already exists is a no-op.",
  "- `patch` replaces ONE span inside an entry and keeps the rest verbatim. This is the usual way to correct or extend a note. `old_text` must occur exactly once in the matched entry.",
  "- `replace` swaps a WHOLE entry. Use it when the entry is wrong from the start.",
  "- `remove` deletes a whole entry. Use it to drop stale or superseded notes.",
  "- `batch` applies several operations atomically against the final size limit, so one call can remove stale entries and add new ones in the same turn. Put `target` on an operation to edit a store other than the call's own `target`.",
  "",
  "A procedure — two or more steps that will still be true next month — belongs in a skill, not here. This tool refuses an entry that repeats a procedure a skill already carries (`MEMORY_COVERED_BY_SKILL`): patch that skill instead, and use memory for the one-line fact or quirk a person would forget.",
  "",
  "`old_text` only LOCATES an entry; it does not have to be the whole entry, but it must select exactly one. Copy it from the entry as written. If nothing matches, the result lists the closest entries — copy from one of those and retry in this turn.",
  "",
  "Record what stays true after this conversation: a stated preference, a decision with its reason, a pitfall you actually hit, a procedure that worked. Do not record task progress, file contents you can re-read, secrets, or anything the user asked you to forget. Say what you learned, not what you did.",
  "",
  "Write every entry in the language the user writes in. An entry is read back to the user and reused in later sessions with them; translating it into English makes it harder for them to check and harder for you to match their wording later.",
  "",
  `Each target has a character budget (${MEMORY_CHAR_LIMIT} for memory, ${USER_CHAR_LIMIT} for user). When it is full, remove or shorten stale entries in the same batch as the write.`,
].join("\n");

const operationSchema = Type.Object(
  {
    action: Type.Union(
      [Type.Literal("add"), Type.Literal("replace"), Type.Literal("patch"), Type.Literal("remove")],
      { description: "What to do with the matched entry." },
    ),
    target: Type.Optional(
      Type.Union([Type.Literal("memory"), Type.Literal("user")], {
        description:
          "Which store this operation edits. Defaults to the call's `target`; set it to mix both stores in one batch.",
      }),
    ),
    content: Type.Optional(
      Type.String({
        description:
          "The new text. Required for add (the entry), replace (the whole entry) and patch (the replacement for old_text).",
      }),
    ),
    old_text: Type.Optional(
      Type.String({
        description:
          "Text copied from the entry this operation targets. Required for replace, patch and remove; must select exactly one entry.",
      }),
    ),
  },
  { additionalProperties: false },
);

const MEMORY_TOOL_PARAMETERS = Type.Object(
  {
    target: Type.Union([Type.Literal("memory"), Type.Literal("user")], {
      description: "`memory` for your own notes, `user` for who the user is.",
    }),
    action: Type.Optional(
      Type.Union(
        [
          Type.Literal("add"),
          Type.Literal("replace"),
          Type.Literal("patch"),
          Type.Literal("remove"),
          Type.Literal("batch"),
        ],
        { description: "One action, or `batch` with `operations`." },
      ),
    ),
    content: Type.Optional(
      Type.String({
        description:
          "New text for add / replace (the whole entry) / patch (the replacement for old_text).",
      }),
    ),
    old_text: Type.Optional(
      Type.String({
        description:
          "Text copied from the entry to edit. Required for replace, patch and remove; must select exactly one entry.",
      }),
    ),
    operations: Type.Optional(
      Type.Array(operationSchema, {
        description: "Several operations applied atomically against the final size limit.",
      }),
    ),
  },
  { additionalProperties: false },
);

type RawMemoryParams = {
  target?: unknown;
  action?: unknown;
  content?: unknown;
  old_text?: unknown;
  operations?: unknown;
};

function asTarget(value: unknown): MemoryTarget | undefined {
  return value === "memory" || value === "user" ? value : undefined;
}

function asText(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Turn the model's arguments into the operation list the store applies.
 *
 * Returns a message instead of a list when the call cannot be understood. The
 * messages name the fix, because a model that is told only "invalid" retries the
 * same call.
 */
export function readMemoryOperations(
  raw: RawMemoryParams,
): { operations: MemoryOperation[] } | { error: string } {
  const batch = raw.operations;
  if (Array.isArray(batch)) {
    if (batch.length === 0) return { error: "operations cannot be empty." };
    if (raw.action !== undefined) {
      return {
        error:
          "Pass either a single `action` or an `operations` list, not both. Use `operations` for several edits in one turn.",
      };
    }
    const operations: MemoryOperation[] = [];
    for (const [index, item] of batch.entries()) {
      const position = `operation ${index + 1}`;
      if (typeof item !== "object" || item === null) {
        return { error: `${position}: must be an object with action, content and old_text.` };
      }
      const entry = item as Record<string, unknown>;
      const action = entry.action;
      const content = asText(entry.content);
      const oldText = asText(entry.old_text);
      // An operation may name its own store. Silently dropping the key - which is
      // what happened before this check - made a batch that meant "this belongs to
      // the user, that belongs to the project" land wholly in the outer target and
      // report success, so the model never learned it had written the wrong list.
      if (entry.target !== undefined && asTarget(entry.target) === undefined) {
        return {
          error: `${position}: target must be "memory" or "user", not ${JSON.stringify(entry.target)}.`,
        };
      }
      // Carry the per-operation store through normalisation; dropping it here is
      // what made the key look accepted while the write went to the outer target.
      const ownTarget = entry.target === undefined ? {} : { target: asTarget(entry.target) as MemoryTarget };
      if (action === "add") {
        if (!content?.trim()) return { error: `${position}: content is required for add.` };
        operations.push({ action: "add", content, ...ownTarget });
        continue;
      }
      if (action === "replace" || action === "patch") {
        if (!oldText?.trim()) return { error: `${position}: old_text is required for ${action}.` };
        if (!content?.trim()) return { error: `${position}: content is required for ${action}.` };
        operations.push({ action, old_text: oldText, content, ...ownTarget });
        continue;
      }
      if (action === "remove") {
        if (!oldText?.trim()) return { error: `${position}: old_text is required for remove.` };
        operations.push({ action: "remove", old_text: oldText, ...ownTarget });
        continue;
      }
      return {
        error: `${position}: unknown action. Use add, replace, patch, or remove.`,
      };
    }
    return { operations };
  }

  const action = raw.action;
  const content = asText(raw.content);
  const oldText = asText(raw.old_text);
  if (action === "add") {
    if (!content?.trim()) return { error: "content is required for add." };
    return { operations: [{ action: "add", content }] };
  }
  if (action === "replace" || action === "patch") {
    if (!oldText?.trim()) return { error: `old_text is required for ${action}.` };
    if (!content?.trim()) return { error: `content is required for ${action}.` };
    return { operations: [{ action, old_text: oldText, content }] };
  }
  if (action === "remove") {
    if (!oldText?.trim()) return { error: "old_text is required for remove." };
    return { operations: [{ action: "remove", old_text: oldText }] };
  }
  if (action === "batch") {
    return { error: "`batch` needs an `operations` list." };
  }
  if (action === undefined) {
    return {
      error:
        "action is required. Use add, replace, patch, remove, or batch with an operations list.",
    };
  }
  return { error: `unknown action '${String(action)}'. Use add, replace, patch, remove, or batch.` };
}

/**
 * Render the store back to the model.
 *
 * The whole list is echoed because the prompt snapshot is frozen: this result is
 * the only place the model can see the effect of its own write.
 */
export function renderMemoryResult(target: MemoryTarget, result: MemoryResult): string {
  if (!result.success) {
    const parts = [result.error];
    if (result.closestEntries?.length) {
      parts.push("", "closest_entries:", ...result.closestEntries.map((entry) => `- ${entry}`));
    }
    if (result.currentEntries) {
      parts.push("", "current_entries:", ...result.currentEntries.map((entry) => `- ${entry}`));
    }
    return parts.join("\n");
  }
  const stored = result.entries.join(ENTRY_DELIMITER);
  const usage = `${memoryCharCount(result.entries)}/${target === "user" ? USER_CHAR_LIMIT : MEMORY_CHAR_LIMIT}`;
  const echoed =
    stored.length > MAX_ECHO_CHARS
      ? `${stored.slice(0, MAX_ECHO_CHARS)}… (truncated)`
      : stored;
  return [
    result.message,
    `Now ${result.entries.length} entr${result.entries.length === 1 ? "y" : "ies"}, ${usage} chars.`,
    "",
    echoed,
  ].join("\n");
}

/** Host surface the tool needs: read and write one target's entry list. */
export type MemoryToolHost = Pick<RuntimeHost, "call">;

/**
 * Build the `memory` tool bound to one runtime host.
 *
 * A read-modify-write per call is deliberate. The alternative — sending the
 * operation to the host and editing there — would need the matching rules twice,
 * and two implementations of "which entry did the model mean" diverge silently.
 */
/** What the memory tool needs to know about the library it shares a lesson with. */
export type MemoryToolOptions = {
  /** The skill catalogue, read at write time rather than at construction. */
  skills?: () => readonly SkillSummary[];
};

export function createMemoryTool(host: MemoryToolHost, options: MemoryToolOptions = {}): AgentTool {
  return {
    name: "memory",
    label: "Memory",
    description: MEMORY_TOOL_DESCRIPTION,
    parameters: MEMORY_TOOL_PARAMETERS,
    executionMode: "sequential",
    execute: async (_toolCallId, rawParams) => {
      const target = asTarget((rawParams as RawMemoryParams).target);
      if (!target) {
        return {
          content: [
            {
              type: "text",
              text: "target is required: use `memory` for your own notes or `user` for who the user is.",
            },
          ],
          details: { errorCode: "MEMORY_INVALID_TARGET" },
          isError: true,
        };
      }
      const parsed = readMemoryOperations(rawParams as RawMemoryParams);
      if ("error" in parsed) {
        return {
          content: [{ type: "text", text: parsed.error }],
          details: { errorCode: "MEMORY_INVALID_ARGUMENT" },
          isError: true,
        };
      }
      const readEntries = async (store: MemoryTarget): Promise<string[]> => {
        const read = await host.call<{ entries?: string[] }>("memory.entries", { target: store });
        return Array.isArray(read.entries) ? read.entries : [];
      };
      // Group the operations by the store each one addresses. A batch that only
      // names the outer target is the single-group case and behaves exactly as
      // before, including the all-or-nothing budget check over the final result.
      const groups = new Map<MemoryTarget, MemoryOperation[]>();
      for (const operation of parsed.operations) {
        const store = operation.target ?? target;
        const bucket = groups.get(store);
        if (bucket) bucket.push(operation);
        else groups.set(store, [operation]);
      }
      const stores = [...groups.keys()];
      const currentByStore = new Map<MemoryTarget, string[]>();
      for (const store of stores) currentByStore.set(store, await readEntries(store));

      // Every store is validated before anything is written, so a batch that
      // fails on its second store cannot leave the first one half-applied.
      const staged = new Map<MemoryTarget, MemorySuccess>();
      for (const store of stores) {
        const operations = groups.get(store) ?? [];
        const current = currentByStore.get(store) ?? [];
        const result =
          operations.length === 1
            ? applyMemoryOperation(store, current, operations[0])
            : applyMemoryBatch(store, current, operations);
        if (!result.success) {
          // A refused edit is the model's to fix, not a tool failure: report it as
          // text so the model can retry in the same turn.
          return {
            content: [{ type: "text", text: renderMemoryResult(store, result) }],
            details: { errorCode: `MEMORY_${result.failureClass.toUpperCase()}` },
          };
        }
        staged.set(store, result);
      }
      const entriesByStore = new Map<MemoryTarget, string[]>(
        stores.map((store) => [store, staged.get(store)?.entries ?? currentByStore.get(store) ?? []]),
      );
      // Memory becomes prompt content, so it is re-sent to the provider on every later
      // turn. Credential-shaped text is masked on the way in, with the same vocabulary
      // the log redactor uses, in the other direction: what leaves the process rather
      // than what is written to a local file. A token caught anywhere in the batch is
      // masked everywhere in it, because the model often states a key once with its
      // label and then repeats it bare in the next entry. Masking runs over the whole
      // batch first so one store cannot keep a token the other one stripped.
      const scrubbed = new Map<MemoryTarget, { entries: string[]; masked: boolean }>();
      for (const store of stores) {
        const entries = entriesByStore.get(store) ?? [];
        const safe = scrubSecretsInBatch(entries);
        scrubbed.set(store, {
          entries: safe,
          masked: safe.some((entry, index) => entry !== entries[index]),
        });
      }
      // One lesson, one place. The prompt says a procedure belongs in the skill;
      // measured, the same four-step procedure still landed in the library *and*
      // in memory, because the main turn and the review fork do not see each
      // other's writes. Refusing here is the only place both are visible.
      const skills = options.skills?.() ?? [];
      if (skills.length > 0) {
        for (const store of stores) {
          const current = currentByStore.get(store) ?? [];
          const duplicate = duplicateOfSkill(entriesByStore.get(store) ?? [], current, skills);
          if (duplicate) {
            return {
              content: [
                {
                  type: "text",
                  text: `Not saved: that is the same procedure skill \`${duplicate.skillId}\` already carries. A procedure lives in the skill and nowhere else — patch that skill (\`skill_manage\` action \`patch\`, or add a \`references/\` file) and keep memory for facts, preferences and one-line quirks. If this really is a fact rather than the procedure, state it as the fact alone.`,
                },
              ],
              details: { errorCode: "MEMORY_COVERED_BY_SKILL", skillId: duplicate.skillId },
              isError: true,
            };
          }
        }
      }
      const masked = [...scrubbed.values()].some((entry) => entry.masked);
      try {
        for (const store of stores) {
          await host.call("memory.writeEntries", {
            target: store,
            entries: scrubbed.get(store)?.entries ?? [],
          });
        }
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Memory was not saved: ${String((error as { message?: string })?.message ?? error)}`,
            },
          ],
          details: { errorCode: "MEMORY_WRITE_FAILED" },
          isError: true,
        };
      }
      const rendered = stores.map((store) => {
        const result = staged.get(store);
        const entries = scrubbed.get(store)?.entries ?? [];
        return renderMemoryResult(store, result ? { ...result, entries } : {
          success: true,
          message: "Entry added.",
          entries,
        });
      });
      const details: Record<string, unknown> = {
        entries: (entriesByStore.get(target) ?? []).length,
        target,
      };
      if (stores.length > 1) details.targets = stores;
      if (masked) details.masked = true;
      return {
        content: [
          {
            type: "text",
            text: rendered.join("\n\n") + (masked ? MEMORY_SCRUB_NOTE : ""),
          },
        ],
        details,
      };
    },
  };
}
