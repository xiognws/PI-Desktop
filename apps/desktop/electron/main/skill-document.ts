import { dirname, join } from "node:path";
import { readdirSync } from "node:fs";

export type LoadedSkillDocument = {
  id: string;
  name: string;
  body: string;
  /** Absolute path of the loaded SKILL.md document. */
  location: string;
};

/**
 * The containers a skill may own beside its document (ADR 0388). The order is
 * the order the model should look at them: the notes it reads, then what a
 * procedure needs in order to run.
 */
const RESOURCE_ROOTS = ["references", "templates", "scripts", "assets"] as const;
/** A listing is a hint, not a payload: past this many files the model greps. */
const MAX_LISTED_RESOURCES = 50;

/**
 * Resource files that ship beside a `SKILL.md`.
 *
 * `skills.writeFile` accepts `<root>/<name>` under these four roots, so a flat,
 * sorted listing is the whole truth about what a skill carries beyond its
 * document. A missing directory or an unreadable one is "no resources": the load
 * itself already succeeded and must not fail over a listing.
 */
export function listSkillResources(location: string): string[] {
  const root = dirname(location);
  const listed: string[] = [];
  for (const container of RESOURCE_ROOTS) {
    let names: string[];
    try {
      names = readdirSync(join(root, container), { withFileTypes: true })
        // `references/` is markdown-only by the host's own rule; the other three
        // carry whatever the skill needs, so nothing is filtered there.
        .filter((entry) => entry.isFile())
        .filter(
          (entry) =>
            container !== "references" || entry.name.toLowerCase().endsWith(".md"),
        )
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b));
    } catch {
      continue;
    }
    for (const name of names) {
      if (listed.length >= MAX_LISTED_RESOURCES) return listed;
      listed.push(`${container}/${name}`);
    }
  }
  return listed;
}

/**
 * Add path metadata only when a skill is loaded, not to the catalog prompt.
 *
 * `resources` names each file so the model can `Read` the one the document
 * points at without first guessing a filename or globbing the directory.
 */
export function formatSkillToolContent(
  skill: LoadedSkillDocument,
  resources: readonly string[] = [],
): string {
  const lines = [
    `# Skill: ${skill.name} (${skill.id})`,
    `Location: ${skill.location}`,
    `References are relative to ${dirname(skill.location)}.`,
  ];
  if (resources.length) {
    lines.push(
      "",
      "Files this skill ships beside its document (read one with `Read` when it points at it; a script is a file to inspect, never something the host runs):",
      ...resources.map((resource) => `- ${resource}`),
    );
  }
  lines.push("", skill.body);
  return lines.join("\n");
}
