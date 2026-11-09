import { describe, expect, it } from "vitest";
import * as Value from "typebox/value";

import { createSkillTool, SKILL_TOOL_PARAMETERS } from "./skill-tool.js";
import type { PluginSkillDef } from "./plugin-skills-prompt.js";

const skills: PluginSkillDef[] = [
  { id: "demo/two", name: "Two", description: "Second." },
  { id: "demo/one", name: "One", description: "First." },
];

function toolWith(load: ReturnType<typeof createSkillTool>["execute"]) {
  return createSkillTool({ skills, load });
}

describe("the Skill tool's parameters", () => {
  it("accepts a call with no id, so listing is a legal call", () => {
    expect(Value.Check(SKILL_TOOL_PARAMETERS, {})).toBe(true);
    expect(Value.Check(SKILL_TOOL_PARAMETERS, { id: "demo/one" })).toBe(true);
  });

  it("still refuses an unknown key", () => {
    expect(Value.Check(SKILL_TOOL_PARAMETERS, { id: "demo/one", body: "x" })).toBe(false);
  });
});

describe("createSkillTool", () => {
  it("lists the catalog itself when no id was passed", async () => {
    let loaded = 0;
    const tool = toolWith(async () => {
      loaded += 1;
      return { content: [{ type: "text" as const, text: "document" }], details: {} };
    });
    const result = await tool.execute("call-1", {});
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(loaded).toBe(0);
    expect(text).toContain("# Skill library (2 skills)");
    expect(text).toContain("- `demo/one` — One: First.");
    expect(result.details).toMatchObject({ listing: true, count: 2 });
  });

  it("treats a blank id as a listing, not as a lookup", async () => {
    let loaded = 0;
    const tool = toolWith(async () => {
      loaded += 1;
      return { content: [{ type: "text" as const, text: "document" }], details: {} };
    });
    const result = await tool.execute("call-2", { id: "   " });
    expect(loaded).toBe(0);
    expect((result.content as Array<{ text: string }>)[0]?.text).toContain("# Skill library (2 skills)");
  });

  it("hands an id straight to the host loader", async () => {
    const seen: unknown[] = [];
    const tool = toolWith(async (toolCallId, args) => {
      seen.push([toolCallId, args]);
      return { content: [{ type: "text" as const, text: "loaded demo/one" }], details: {} };
    });
    const result = await tool.execute("call-3", { id: " demo/one " });
    expect(seen).toEqual([["call-3", { id: " demo/one " }]]);
    expect((result.content as Array<{ text: string }>)[0]?.text).toBe("loaded demo/one");
  });

  it("says the library is empty when the session has no catalog", async () => {
    const tool = createSkillTool({ skills: [], load: async () => ({ content: [], details: {} }) });
    const result = await tool.execute("call-4", {});
    expect((result.content as Array<{ text: string }>)[0]?.text).toContain("library is empty");
  });
});
