/**
 * The `skill_manage` tool: the agent writes its own skill library.
 *
 * The same shape as the `memory` tool, one level up. The model names an action
 * and the text to act on; the app's skill store performs it. Nothing here
 * touches the filesystem — every action is a `skills.*` RPC, so the runtime, the
 * UI and the background review all write through one implementation and one path
 * rule (`<root>/<name>` under references/, templates/, scripts/ or assets/,
 * validated host-side).
 *
 * `patch` reads the document here and applies the replacement locally rather
 * than asking the host to match on a string: "which occurrence did the model
 * mean" is exactly the kind of rule that must exist once, and it must be the one
 * the tests cover. The host still owns the write, so a patch cannot race a
 * review pass into a lost update any more than two RPCs can.
 *
 * A refused edit is reported as ordinary text, not a tool failure: the model
 * can fix its own argument and retry in the same turn (same convention as
 * `memory`).
 */

import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

import type { RuntimeHost } from "./host-client.js";
import { SKILL_AUTHORING_GUIDE } from "./skill-authoring.js";

/** Host surface this tool needs: read, create, patch, and resource writes. */
export type SkillManageHost = Pick<RuntimeHost, "call">;

type SkillRecord = { id: string; name: string; path?: string };

const SKILL_MANAGE_DESCRIPTION = [
  "Read and edit your durable skill library: the SKILL.md documents that load into later sessions.",
  "",
  "Use it the moment a turn teaches you something reusable — a procedure, a pitfall, a decision rule, a command sequence that worked. Capture the rule, not the afternoon: name the class of problem, never the single issue.",
  "",
  "Actions:",
  "- `create` starts a new skill. Give `name` (lowercase-hyphenated) and `description` (one sentence: when to use it); `body` is the document. A name that already exists is refused — patch that skill instead.",
  "- `patch` replaces ONE span inside an existing skill's document. `old_string` must occur exactly once; copy it verbatim. This is the usual way to extend a skill you already have.",
  "- `write_file` adds one file beside the skill's SKILL.md. `references/<topic>.md` is the usual choice (prose the model reads); `templates/`, `scripts/` and `assets/` hold what a procedure needs to run — a fill-in file, a program, a data file. Prefer this over a whole-document rewrite: it is a small write and cannot damage the document.",
  "- `remove_file` deletes one such file that is wrong or superseded.",
  "- `delete` removes a whole skill. Only when its content now lives somewhere better.",
  "- `absorb` merges one skill into another: its resource files move under the umbrella (existing files are kept as the umbrella's) and it leaves the catalog. Nothing is deleted, so this is the right move when two skills turned out to be one topic — pass the redundant skill as `name` and the umbrella as `into`. Patch the umbrella first so its body describes what it now covers.",
  "",
  "Never create a near-duplicate of a skill you already have: patch it, or add a reference to it.",
  "",
  SKILL_AUTHORING_GUIDE,
].join("\n");

const SKILL_MANAGE_PARAMETERS = Type.Object(
  {
    action: Type.Union(
      [
        Type.Literal("create"),
        Type.Literal("patch"),
        Type.Literal("write_file"),
        Type.Literal("remove_file"),
        Type.Literal("delete"),
        Type.Literal("absorb"),
      ],
      { description: "What to do with the library." },
    ),
    name: Type.String({
      description:
        "Skill id, exactly as listed in your Skills section. For `create`, the new skill's name.",
    }),
    description: Type.Optional(
      Type.String({
        description:
          "create only. ONE sentence, <=60 characters, `Use when <trigger>. <behavior>.` It is what later sessions index on.",
      }),
    ),
    body: Type.Optional(
      Type.String({ description: "create only. The SKILL.md document, without frontmatter." }),
    ),
    old_string: Type.Optional(
      Type.String({
        description: "patch only. Text copied verbatim from the skill document; must occur exactly once.",
      }),
    ),
    new_string: Type.Optional(
      Type.String({ description: "patch only. The replacement for old_string." }),
    ),
    file_path: Type.Optional(
      Type.String({
        description:
          "write_file / remove_file. `<root>/<name>` with root `references` (markdown only), `templates`, `scripts` or `assets`.",
      }),
    ),
    content: Type.Optional(
      Type.String({ description: "write_file only. Markdown for the reference file." }),
    ),
    into: Type.Optional(
      Type.String({
        description: "absorb only. Skill id of the umbrella that keeps the content.",
      }),
    ),
  },
  { additionalProperties: false },
);

type RawParams = {
  action?: string;
  name?: string;
  description?: string;
  body?: string;
  old_string?: string;
  new_string?: string;
  file_path?: string;
  content?: string;
  into?: string;
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

/** A refusal the model can fix itself: report as text so it retries in-turn. */
function refused(message: string, errorCode: string) {
  return text(message, { errorCode });
}

async function createSkill(host: SkillManageHost, params: RawParams) {
  const name = params.name?.trim();
  if (!name) return refused("`name` is required to create a skill.", "SKILL_MISSING_NAME");
  try {
    const result = await host.call<{ skill?: SkillRecord }>("skills.create", {
      skill: {
        name,
        // The pass may only retire what the agent wrote (ADR 0394), so the
        // marker travels with the create. `patch` does not resend it: an origin
        // is recorded once, not re-claimed on every edit.
        createdBy: "agent",
        ...(params.description ? { description: params.description } : {}),
        ...(params.body ? { body: params.body } : {}),
      },
    });
    const id = result?.skill?.id ?? name;
    return text(
      `Created skill \`${id}\`. It is listed in your Skills section from the next session; patch it now to keep refining it.`,
      { id, action: "create" },
    );
  } catch (error) {
    const detail = String((error as { message?: string })?.message ?? error);
    // A duplicate name is the model's to resolve (patch it instead).
    if (/already exists/i.test(detail)) {
      return refused(`${detail} Patch that skill instead of creating a second one.`, "SKILL_EXISTS");
    }
    return text(`The skill was not created: ${detail}`, { errorCode: "SKILL_CREATE_FAILED" }, true);
  }
}

async function patchSkill(host: SkillManageHost, params: RawParams) {
  const id = params.name?.trim();
  const oldString = params.old_string;
  const newString = params.new_string;
  if (!id) return refused("`name` is required to patch a skill.", "SKILL_MISSING_NAME");
  if (!oldString) return refused("`old_string` is required to patch a skill.", "SKILL_MISSING_OLD_STRING");
  if (newString === undefined) {
    return refused("`new_string` is required to patch a skill (pass an empty string to delete).", "SKILL_MISSING_NEW_STRING");
  }
  const read = await host.call<{ skill?: SkillRecord | null; body?: string | null }>("skills.read", {
    id,
  });
  const body = read?.body ?? null;
  if (read?.skill == null || body == null) {
    return refused(`No skill with id \`${id}\` in the library. Use \`create\` for a new one.`, "SKILL_NOT_FOUND");
  }
  const occurrences = body.split(oldString).length - 1;
  if (occurrences === 0) {
    return refused(
      `\`old_string\` does not occur in \`${id}\`. Read the skill and copy an exact span from it.`,
      "SKILL_NO_MATCH",
    );
  }
  if (occurrences > 1) {
    return refused(
      `\`old_string\` occurs ${occurrences} times in \`${id}\`; it must select exactly one span. Include more surrounding text.`,
      "SKILL_AMBIGUOUS_MATCH",
    );
  }
  try {
    await host.call("skills.update", { id, skill: { body: body.replace(oldString, newString) } });
    return text(`Patched skill \`${id}\`.`, { id, action: "patch" });
  } catch (error) {
    const detail = String((error as { message?: string })?.message ?? error);
    return text(`The patch was not saved: ${detail}`, { errorCode: "SKILL_UPDATE_FAILED" }, true);
  }
}

/** The scope fields a resource RPC needs to reach a project skill. */
function scopeOf(options: SkillManageOptions): { level?: string; projectPath?: string } {
  const projectPath = options.projectPath?.trim();
  return projectPath ? { level: "project", projectPath } : {};
}

async function writeResource(
  host: SkillManageHost,
  params: RawParams,
  options: SkillManageOptions,
) {
  const id = params.name?.trim();
  const path = params.file_path?.trim();
  if (!id) return refused("`name` is required to write a reference file.", "SKILL_MISSING_NAME");
  if (!path) {
    return refused(
      "`file_path` is required; it must look like `references/<topic>.md`, `templates/<name>`, `scripts/<name>` or `assets/<name>`.",
      "SKILL_MISSING_PATH",
    );
  }
  if (params.content === undefined) {
    return refused("`content` is required to write a reference file.", "SKILL_MISSING_CONTENT");
  }
  try {
    const result = await host.call<{ path?: string }>("skills.writeFile", {
      id,
      path,
      content: params.content,
      ...scopeOf(options),
    });
    return text(`Wrote \`${result?.path ?? path}\` into skill \`${id}\`.`, {
      id,
      action: "write_file",
    });
  } catch (error) {
    const detail = String((error as { message?: string })?.message ?? error);
    // Path rule violations come back from the host and are the model's to fix.
    if (/SKILL_INVALID/.test(detail)) return refused(detail, "SKILL_INVALID_PATH");
    return text(`The reference file was not written: ${detail}`, { errorCode: "SKILL_WRITE_FAILED" }, true);
  }
}

async function removeResource(
  host: SkillManageHost,
  params: RawParams,
  options: SkillManageOptions,
) {
  const id = params.name?.trim();
  const path = params.file_path?.trim();
  if (!id) return refused("`name` is required to remove a reference file.", "SKILL_MISSING_NAME");
  if (!path) {
    return refused(
      "`file_path` is required; it must look like `references/<topic>.md`, `templates/<name>`, `scripts/<name>` or `assets/<name>`.",
      "SKILL_MISSING_PATH",
    );
  }
  try {
    await host.call("skills.removeFile", { id, path, ...scopeOf(options) });
    return text(`Removed \`${path}\` from skill \`${id}\`.`, { id, action: "remove_file" });
  } catch (error) {
    const detail = String((error as { message?: string })?.message ?? error);
    if (/SKILL_INVALID/.test(detail)) return refused(detail, "SKILL_INVALID_PATH");
    return text(`The reference file was not removed: ${detail}`, { errorCode: "SKILL_REMOVE_FAILED" }, true);
  }
}

async function absorbSkill(
  host: SkillManageHost,
  params: RawParams,
  options: SkillManageOptions,
) {
  const id = params.name?.trim();
  const into = params.into?.trim();
  if (!id) return refused("`name` is required: the skill that should be absorbed.", "SKILL_MISSING_NAME");
  if (!into) {
    return refused(
      "`into` is required: the umbrella skill that keeps the content.",
      "SKILL_MISSING_INTO",
    );
  }
  if (id === into) {
    return refused("A skill cannot absorb itself.", "SKILL_INVALID_ACTION");
  }
  try {
    const result = await host.call<{
      copied?: string[];
      skipped?: string[];
      absorbed?: { name?: string; absorbedInto?: string };
    }>("skills.absorb", { id, into, ...scopeOf(options) });
    const copied = result?.copied ?? [];
    const skipped = result?.skipped ?? [];
    const parts = [
      `Merged \`${id}\` into \`${into}\`.`,
      copied.length ? `Moved ${copied.length} file(s): ${copied.join(", ")}.` : "No files needed moving.",
      skipped.length
        ? `Kept the umbrella's own copy of: ${skipped.join(", ")}.`
        : "",
      "The absorbed skill is out of the catalog; its document is still on disk, so a person can re-enable it.",
    ].filter(Boolean);
    return text(parts.join(" "), { id, into, action: "absorb", copied, skipped });
  } catch (error) {
    const detail = String((error as { message?: string })?.message ?? error);
    if (/SKILL_INVALID/.test(detail)) return refused(detail, "SKILL_INVALID_PATH");
    return text(`The merge did not happen: ${detail}`, { errorCode: "SKILL_ABSORB_FAILED" }, true);
  }
}

async function deleteSkill(host: SkillManageHost, params: RawParams) {
  const id = params.name?.trim();
  if (!id) return refused("`name` is required to delete a skill.", "SKILL_MISSING_NAME");
  try {
    const result = await host.call<{ ok?: boolean }>("skills.remove", { id });
    if (!result?.ok) return refused(`No skill with id \`${id}\` in the library.`, "SKILL_NOT_FOUND");
    return text(`Deleted skill \`${id}\`.`, { id, action: "delete" });
  } catch (error) {
    const detail = String((error as { message?: string })?.message ?? error);
    return text(`The skill was not deleted: ${detail}`, { errorCode: "SKILL_DELETE_FAILED" }, true);
  }
}

/**
 * Build the `skill_manage` tool bound to one runtime host.
 *
 * One action per call, `create` first: the model is told to open the library
 * with `create` and refine it with `patch`, never to re-send a whole document
 * it could not see (the Skills section is a snapshot, like memory).
 */
/** Where the session is scoped, so a project skill can be addressed by id. */
export type SkillManageOptions = { projectPath?: string };

export function createSkillManageTool(
  host: SkillManageHost,
  options: SkillManageOptions = {},
): AgentTool {
  return {
    name: "skill_manage",
    label: "Skill",
    description: SKILL_MANAGE_DESCRIPTION,
    parameters: SKILL_MANAGE_PARAMETERS,
    executionMode: "sequential",
    execute: async (_toolCallId, rawParams) => {
      const params = (rawParams ?? {}) as RawParams;
      switch (params.action) {
        case "create":
          return createSkill(host, params);
        case "patch":
          return patchSkill(host, params);
        case "write_file":
          return writeResource(host, params, options);
        case "remove_file":
          return removeResource(host, params, options);
        case "delete":
          return deleteSkill(host, params);
        case "absorb":
          return absorbSkill(host, params, options);
        default:
          return refused(
            "`action` must be one of create, patch, write_file, remove_file, delete, absorb.",
            "SKILL_INVALID_ACTION",
          );
      }
    },
  };
}
