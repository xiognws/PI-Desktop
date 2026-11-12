/**
 * The `Skill` read tool, in one place.
 *
 * Two call sites publish it: the session's own tool list (with whatever catalog
 * the launch found) and the background review fork (which may run against a
 * session that has none). They used to carry two hand-written copies of the same
 * schema, and the review prompt meanwhile told the model to "call `Skill` with no
 * arguments to list what exists" — a call the schema refused, because `id` was
 * required. One factory, one contract: `id` is optional, and omitting it lists
 * the live library the runtime already holds.
 *
 * The listing is answered here rather than by the host: `pluginSkills` is the
 * catalog this session was launched with, and a round trip to main would have to
 * rebuild it (built-ins, plugins, the user's own library, activation scope) to
 * answer the same question.
 */

import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

import { formatSkillLibrary, SKILL_TOOL_NAME, type PluginSkillDef } from "./plugin-skills-prompt.js";

export const SKILL_TOOL_DESCRIPTION = [
  "Load one skill's full instructions from the library listed in the Skills section of your system prompt.",
  "",
  "Call it with no `id` to list the library as it stands now (id, name, description): the Skills section is a snapshot taken at session start, so a skill created since then is only visible here. Call it with an `id` to get that skill's document, its location, and its reference files.",
  "",
  "The library is host-owned: this listing is the whole of it. Do not search the filesystem for skill directories to find out what exists.",
  "",
  "When a task matches a skill's description, load the skill first and follow it; do not guess at its content. Load each skill at most once per task.",
].join("\n");

export const SKILL_TOOL_PARAMETERS = Type.Object(
  {
    id: Type.Optional(
      Type.String({
        description:
          "Skill id exactly as listed in the Skills section. Omit the id entirely to list the library.",
      }),
    ),
  },
  { additionalProperties: false },
);

/** What main's local `Skill` handler does for one document id. */
export type SkillLoad = AgentTool["execute"];

function text(message: string, details: Record<string, unknown> = {}): AgentToolResult<Record<string, unknown>> {
  return { content: [{ type: "text" as const, text: message }], details };
}

/**
 * Build the `Skill` tool against a catalog and a loader.
 *
 * `load` is main's local handler: it resolves built-in, then user, then plugin
 * documents and returns the rendered document. A session with no library passes
 * an empty catalog, so a listing says so instead of promising a document.
 */
export function createSkillTool(options: {
  skills: readonly PluginSkillDef[];
  load: SkillLoad;
}): AgentTool {
  return {
    name: SKILL_TOOL_NAME,
    label: "Skill",
    description: SKILL_TOOL_DESCRIPTION,
    parameters: SKILL_TOOL_PARAMETERS,
    execute: async (toolCallId, params) => {
      const id = typeof (params as { id?: unknown } | undefined)?.id === "string"
        ? ((params as { id?: string }).id ?? "").trim()
        : "";
      if (id) return options.load(toolCallId, params);
      return text(formatSkillLibrary(options.skills), {
        listing: true,
        count: options.skills.length,
      });
    },
  };
}
