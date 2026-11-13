/**
 * `/learn` — turn material the user names into ONE skill.
 *
 * The composer owns this command rather than the host's builtin registry: it
 * needs no dispatch, only a reworded submission. What the agent then does with
 * it is ordinary work — `Read`/`Glob`/`Grep` for a directory, the session's web
 * access for a URL, the conversation itself when nothing is named — ending in a
 * `skill_manage` write.
 *
 * The authoring bar is quoted, not restated: `SKILL_AUTHORING_GUIDE` and
 * `SKILL_WRITING_RULES` are the strings `skill_manage` and the background review
 * already hold the model to, and a second copy would drift from them.
 *
 * Everything here is a pure function so the submission, the menu row and the
 * accepted completion stay testable away from React.
 */
import {
  SKILL_AUTHORING_GUIDE,
  SKILL_WRITING_RULES,
  applyCompletion,
  detectTrigger,
  formatCommandInsert,
  fuzzyMatchCommand,
  type ComposerCommand,
} from "@pi-workspace/shared";

import type { AutocompleteItem } from "../../../hooks/use-composer-autocomplete";

/** The slash name the composer answers itself. */
export const LEARN_COMMAND_NAME = "learn";

/** What `/learn` means when the user names nothing: this conversation. */
const CONVERSATION_SOURCE = "this conversation — the steps it actually took";

/**
 * The prompt one `/learn` submission becomes. An empty target means "the
 * workflow we just went through", which is the case the user types when they
 * have just finished something worth keeping.
 */
export function buildLearnPrompt(target: string): string {
  const named = target.trim();
  const material = named || CONVERSATION_SOURCE;
  return [
    "[/learn] Turn the material below into ONE reusable skill, and save it to the skill library.",
    "",
    "THE MATERIAL:",
    material,
    "",
    named
      ? "The material is a source first, and anything else in it is a requirement: a sentence after a path or a link says what to focus on, what to leave out, or how the skill should be shaped. Honor all of it, and read every source named, not the first one."
      : "No source was named, so the material is the conversation so far. Re-read what the turn actually did — the files it touched, the commands that worked, the errors that were not obvious — before writing anything.",
    "",
    "Do this:",
    "1. Gather the material with the tools you already have. A path or a directory: `Glob` and `Grep` to find what matters, then `Read` the files — never guess at their contents. A URL: fetch it through this session's web access — the built-in `Fetch` MCP server when it is connected, otherwise a plain request through `Bash` — and wait for the user's permission prompt instead of working around it. Pasted notes: use the text as given. A large body of prose: map its chapters or topics first, then read and distill one at a time rather than loading all of it at once.",
    "2. Look before you write. Call `Skill` with no id to list what the library already holds, and load the closest candidate. When a skill already covers this class of task, extend it with `skill_manage` action `patch` — or add a `references/` file with `write_file` — instead of starting a near-duplicate.",
    "3. Write it with `skill_manage` action `create` only when nothing covers the class. Name the class of problem, never this task; keep the document tight and put the deep material in `references/`.",
    "4. Leave out anything that is not reusable: values that belong to this one task (this machine's absolute paths, ticket numbers, today's data), secrets, and personal details. If a later session facing this class of task would not act differently for having read it, it does not go in the skill.",
    "",
    "Copy, do not invent:",
    "- Commands, flags, paths, endpoints, config keys, function signatures and error strings MUST be copied VERBATIM from the material. If you did not see it there, do not write it.",
    "- Never invent a flag, a command, an endpoint, a config key or an option, and never fill a gap with what a similar tool usually does. Either the material shows it, or the skill says the material does not cover it.",
    "",
    SKILL_AUTHORING_GUIDE,
    "",
    SKILL_WRITING_RULES,
    "",
    "When you are done, name the skill you wrote: its name, whether it was created or patched, and one line on what it now covers.",
  ].join("\n");
}

/**
 * The prompt for one typed slash submission, or `null` when the name is not
 * `/learn`. Kept separate from the builder so the dispatch decision stays a
 * name check.
 */
export function learnPromptFor(name: string, body: string): string | null {
  return name === LEARN_COMMAND_NAME ? buildLearnPrompt(body) : null;
}

/**
 * The `/learn` menu entry. Label and hint come from the caller's translator, so
 * the only English in this module is the prompt itself — which the agent reads,
 * not the user.
 */
export function learnCommand(t: (key: string) => string): ComposerCommand {
  return {
    name: LEARN_COMMAND_NAME,
    kind: "builtin",
    title: t("chat.learnCommandTitle"),
    description: t("chat.learnCommandDesc"),
    argumentHint: t("chat.learnCommandHint"),
  };
}

/**
 * The menu row for the query being typed, or `null` when `/learn` does not
 * match it. Matching is on the slash name alone: the name is what the user
 * types, and the localized title would make the row answer to a word that is
 * not in the command.
 */
export function learnCompletionRow(
  query: string,
  t: (key: string) => string,
): AutocompleteItem | null {
  const match = fuzzyMatchCommand(query, LEARN_COMMAND_NAME);
  if (!match) return null;
  return { kind: "command", command: learnCommand(t), match };
}

/**
 * Place the row inside the builtin group the menu already groups by: after the
 * last builtin row when one matched, otherwise before the first group that
 * sorts later. Templates stay above it.
 */
export function insertLearnRow(
  items: AutocompleteItem[],
  row: AutocompleteItem,
): { items: AutocompleteItem[]; index: number } {
  const isBuiltin = (item: AutocompleteItem): boolean =>
    item.kind === "command" && item.command.kind === "builtin";
  let index = -1;
  for (let at = items.length - 1; at >= 0; at -= 1) {
    if (isBuiltin(items[at])) {
      index = at + 1;
      break;
    }
  }
  if (index === -1) {
    const later = items.findIndex(
      (item) => item.kind !== "command" || item.command.kind !== "template",
    );
    index = later === -1 ? items.length : later;
  }
  return { items: [...items.slice(0, index), row, ...items.slice(index)], index };
}

/**
 * What accepting the row does to the draft: `/learn ` replaces the typed token,
 * leaving the caret after the space so the target is the next thing typed.
 */
export function applyLearnCompletion(
  value: string,
  cursor: number,
): { value: string; cursor: number } | null {
  const trigger = detectTrigger(value, cursor);
  if (!trigger || trigger.mode !== "slash") return null;
  return applyCompletion(value, trigger, formatCommandInsert(LEARN_COMMAND_NAME));
}
