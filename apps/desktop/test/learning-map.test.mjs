import assert from "node:assert/strict";
import test from "node:test";

import {
  buildLearningMap,
  overlap,
  topicTokens,
} from "../src/lib/learning-map.ts";

test("tokens keep the topic and drop the filler", () => {
  const tokens = topicTokens("Use when the Windows file lock blocks a rename. Always check handle holders.");
  assert.ok(tokens.includes("windows"));
  assert.ok(tokens.includes("rename"));
  assert.ok(tokens.includes("lock"));
  // "use", "when", "always", "the" carry no topic: an edge drawn on them is noise.
  assert.ok(!tokens.includes("when"));
  assert.ok(!tokens.includes("always"));
  assert.ok(!tokens.includes("the"));
});

test("a Chinese sentence becomes shingles, because it has no spaces", () => {
  const tokens = topicTokens("合并两个技能时不要删除文件");
  assert.ok(tokens.includes("合并"));
  assert.ok(tokens.includes("技能"));
  // Two-character shingles for meaning, three for a phrase.
  assert.ok(tokens.includes("删除"));
  assert.ok(tokens.includes("不要删"));
});

test("overlap is Jaccard, so a shared single word cannot connect two unrelated texts", () => {
  const left = topicTokens("windows file lock rename");
  const right = topicTokens("postgres migration rollback");
  assert.equal(overlap(left, right), 0);
  assert.equal(overlap(topicTokens("windows lock"), topicTokens("windows lock")), 1);
  assert.equal(overlap([], left), 0);
});

test("the map draws both stores, and only edges with real overlap", () => {
  const map = buildLearningMap(
    [
      { id: "b-skill", name: "Windows file lock", description: "rename a locked directory on windows" },
      { id: "a-skill", name: "Postgres migration", description: "rollback a failed migration" },
    ],
    [
      { id: "m1", text: "windows file lock blocks rename on windows", target: "memory" },
      { id: "m2", text: "prefers terse Chinese replies", target: "user" },
    ],
  );
  assert.equal(map.nodes.length, 4);
  assert.equal(map.counts.skills, 2);
  assert.equal(map.counts.memories, 2);

  const skill = map.nodes.find((node) => node.id === "skill:b-skill");
  const memory = map.nodes.find((node) => node.id === "memory:m1");
  assert.ok(skill && memory);
  const linked = map.edges.some(
    (edge) =>
      (edge.from === skill.id && edge.to === memory.id) ||
      (edge.from === memory.id && edge.to === skill.id),
  );
  assert.ok(linked, "a memory about windows file locks belongs next to that skill");

  const unrelated = map.edges.some(
    (edge) => edge.from === "memory:m2" || edge.to === "memory:m2",
  );
  assert.equal(unrelated, false, "\"prefers terse replies\" overlaps nothing here");
});

test("the picture is stable: same input, same coordinates", () => {
  const skills = [
    { id: "z", name: "zeta", description: "one" },
    { id: "a", name: "alpha", description: "two" },
    { id: "m", name: "mu", description: "three" },
  ];
  const first = buildLearningMap(skills, []);
  const second = buildLearningMap([...skills].reverse(), []);
  assert.deepEqual(
    first.nodes.map((node) => [node.id, node.x, node.y]),
    second.nodes.map((node) => [node.id, node.x, node.y]),
  );
  // Inner ring, so the skill nodes sit on a circle rather than a line.
  assert.equal(new Set(first.nodes.map((node) => node.x)).size, 3);
});

test("caps are reported, not silently dropped", () => {
  const skills = Array.from({ length: 5 }, (_, index) => ({
    id: `s${index}`,
    name: `skill ${index}`,
    description: "shared words about windows locks",
  }));
  const map = buildLearningMap(skills, [], { maxSkills: 2, maxEdges: 1 });
  assert.equal(map.nodes.length, 2);
  assert.equal(map.counts.skillsHidden, 3);
  assert.equal(map.edges.length, 1);
});

test("an empty library is an empty map, not a crash", () => {
  const map = buildLearningMap([], []);
  assert.deepEqual(map.nodes, []);
  assert.deepEqual(map.edges, []);
  assert.deepEqual(map.counts, { skills: 0, memories: 0, skillsHidden: 0, memoriesHidden: 0 });
});
