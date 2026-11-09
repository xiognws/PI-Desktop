/**
 * The learning map: what the agent taught itself, as one graph.
 *
 * Two stores grow in the same direction and nothing showed them together. A skill
 * and a memory entry are both "something a past session decided was worth
 * keeping"; they differ in shape (a document the model loads vs a line always in
 * context), not in kind. The map draws both, and an edge only when the words
 * genuinely overlap — a line between every pair would say nothing.
 *
 * Everything here is pure: tokenising, the overlap test, the deterministic
 * layout, and the caps. The component renders what this returns, so the rules are
 * testable without a DOM.
 */

/** One node of the map. */
export type LearningNode = {
  id: string;
  kind: "skill" | "memory";
  label: string;
  /** Skills only: how many times the model loaded it. */
  useCount?: number;
  /** Skills only: switched off, but still on disk. */
  idle?: boolean;
  /** Memory only: which store the entry lives in. */
  target?: "memory" | "user";
  x: number;
  y: number;
};

/** A relation between two nodes that share enough vocabulary to be worth drawing. */
export type LearningEdge = { from: string; to: string; weight: number };

export type LearningMap = {
  nodes: LearningNode[];
  edges: LearningEdge[];
  /** Totals the caller shows as a caption; they count what was drawn, not the library. */
  counts: { skills: number; memories: number; skillsHidden: number; memoriesHidden: number };
};

/** What the map needs from a skill record; kept narrow so tests stay small. */
export type LearningSkill = {
  id: string;
  name?: string;
  description?: string;
  enabled?: boolean;
};

/** What the map needs from a memory record. */
export type LearningMemory = {
  id: string;
  text: string;
  target?: "memory" | "user";
};

export type LearningMapOptions = {
  /** Maximum nodes drawn. The map is a summary, not a dump. */
  maxSkills?: number;
  maxMemories?: number;
  /** Minimum overlap (0..1) before an edge is drawn. */
  minWeight?: number;
  /** Maximum edges drawn, strongest first. */
  maxEdges?: number;
  /** Radius of the skill ring and the memory ring, in SVG units. */
  innerRadius?: number;
  outerRadius?: number;
  center?: number;
};

const DEFAULTS = {
  maxSkills: 18,
  maxMemories: 24,
  minWeight: 0.2,
  maxEdges: 40,
  innerRadius: 74,
  outerRadius: 132,
  center: 150,
};

/** Words that carry no topic: they connect everything and mean nothing. */
const STOP_WORDS = new Set([
  "the", "and", "for", "with", "use", "used", "using", "when", "this", "that", "your",
  "you", "from", "into", "not", "but", "are", "was", "were", "has", "have", "had",
  "can", "will", "would", "should", "must", "may", "one", "two", "all", "any", "its",
  "skill", "skills", "memory", "memories", "user", "users", "agent", "note", "notes",
  "prefer", "prefers", "preference", "preferences", "always", "never",
]);

/**
 * The words a text is about.
 *
 * Latin words of three letters or more, lowercased; CJK runs split into two- and
 * three-character shingles, because a Chinese sentence has no spaces and a single
 * character is too coarse to mean a topic.
 */
export function topicTokens(text: string): string[] {
  const tokens = new Set<string>();
  const lower = (text ?? "").toLowerCase();
  for (const match of lower.matchAll(/[a-z][a-z0-9_-]{2,}/g)) {
    const word = match[0];
    if (!STOP_WORDS.has(word)) tokens.add(word);
  }
  for (const match of lower.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
    const run = match[0];
    for (let i = 0; i < run.length - 1; i += 1) tokens.add(run.slice(i, i + 2));
    for (let i = 0; i < run.length - 2; i += 1) tokens.add(run.slice(i, i + 3));
  }
  return [...tokens];
}

/** Jaccard overlap of two token sets: 0 when they share nothing, 1 when identical. */
export function overlap(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 || right.length === 0) return 0;
  const rightSet = new Set(right);
  let shared = 0;
  for (const token of new Set(left)) if (rightSet.has(token)) shared += 1;
  const union = new Set([...left, ...right]).size;
  return union === 0 ? 0 : shared / union;
}

/** Place `count` nodes on a circle, clockwise from the top. */
function ring(count: number, radius: number, center: number) {
  return Array.from({ length: count }, (_, index) => {
    const angle = (index / Math.max(count, 1)) * Math.PI * 2 - Math.PI / 2;
    return {
      x: Number((center + Math.cos(angle) * radius).toFixed(2)),
      y: Number((center + Math.sin(angle) * radius).toFixed(2)),
    };
  });
}

/** Trim a label to what fits beside a node. */
function shortLabel(text: string, limit = 22): string {
  const clean = (text ?? "").trim().replace(/\s+/g, " ");
  return clean.length <= limit ? clean : `${clean.slice(0, limit - 1)}…`;
}

/**
 * Build the map.
 *
 * Skills go on the inner ring (they are the thing the agent acts on), memories on
 * the outer ring, both ordered by id so the picture is stable across reloads — a
 * graph that reshuffles itself every time the page opens cannot be compared with
 * the one you looked at yesterday.
 */
export function buildLearningMap(
  skills: readonly LearningSkill[],
  memories: readonly LearningMemory[],
  options: LearningMapOptions = {},
): LearningMap {
  const settings = { ...DEFAULTS, ...options };
  const sortedSkills = [...skills].sort((left, right) => left.id.localeCompare(right.id));
  const sortedMemories = [...memories].sort(
    (left, right) =>
      (left.target ?? "memory").localeCompare(right.target ?? "memory") ||
      left.id.localeCompare(right.id),
  );
  const drawnSkills = sortedSkills.slice(0, settings.maxSkills);
  const drawnMemories = sortedMemories.slice(0, settings.maxMemories);

  const inner = ring(drawnSkills.length, settings.innerRadius, settings.center);
  const outer = ring(drawnMemories.length, settings.outerRadius, settings.center);

  const nodes: LearningNode[] = [
    ...drawnSkills.map((skill, index) => ({
      id: `skill:${skill.id}`,
      kind: "skill" as const,
      label: shortLabel(skill.name || skill.id),
      useCount: (skill as { useCount?: number }).useCount,
      idle: skill.enabled === false,
      ...inner[index],
    })),
    ...drawnMemories.map((memory, index) => ({
      id: `memory:${memory.id}`,
      kind: "memory" as const,
      label: shortLabel(memory.text),
      target: memory.target ?? "memory",
      ...outer[index],
    })),
  ];

  const tokens = new Map<string, string[]>();
  for (const skill of drawnSkills) {
    tokens.set(`skill:${skill.id}`, topicTokens(`${skill.name ?? ""} ${skill.description ?? ""}`));
  }
  for (const memory of drawnMemories) {
    tokens.set(`memory:${memory.id}`, topicTokens(memory.text));
  }

  const edges: LearningEdge[] = [];
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const weight = overlap(tokens.get(nodes[i].id) ?? [], tokens.get(nodes[j].id) ?? []);
      if (weight >= settings.minWeight) {
        edges.push({ from: nodes[i].id, to: nodes[j].id, weight: Number(weight.toFixed(3)) });
      }
    }
  }
  edges.sort((left, right) => right.weight - left.weight);

  return {
    nodes,
    edges: edges.slice(0, settings.maxEdges),
    counts: {
      skills: drawnSkills.length,
      memories: drawnMemories.length,
      skillsHidden: Math.max(sortedSkills.length - drawnSkills.length, 0),
      memoriesHidden: Math.max(sortedMemories.length - drawnMemories.length, 0),
    },
  };
}
