import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

import {
  buildLearningMap,
  edgesTouching,
  learningEdgeKey,
  learningNodeDetail,
  nextLearningNodeId,
  overlap,
  parseLearningNodeId,
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

test("a drawn node id resolves back to the record behind it", () => {
  assert.deepEqual(parseLearningNodeId("skill:windows-lock"), {
    kind: "skill",
    id: "windows-lock",
  });
  // Only the first separator splits, so an id that contains one still resolves.
  assert.deepEqual(parseLearningNodeId("memory:2026:11"), { kind: "memory", id: "2026:11" });
  // Nothing else is a node: a third store must not be guessed at.
  assert.equal(parseLearningNodeId("session:abc"), null);
  assert.equal(parseLearningNodeId("skill:"), null);
  assert.equal(parseLearningNodeId("windows-lock"), null);
  assert.equal(parseLearningNodeId(""), null);
});

test("a click highlights the edges of the node it landed on, and only those", () => {
  const map = buildLearningMap(
    [
      { id: "a", name: "windows file lock", description: "rename a locked directory" },
      { id: "b", name: "postgres migration", description: "rollback a failed migration" },
    ],
    [{ id: "m1", text: "windows file lock blocks rename on windows" }],
  );
  const touching = edgesTouching(map, "skill:a").map(learningEdgeKey);
  assert.equal(touching.length, 1);
  assert.ok(touching[0] === "skill:a->memory:m1" || touching[0] === "memory:m1->skill:a");
  // A node with no overlap, no node at all, and an id that is not drawn all
  // light nothing.
  assert.deepEqual(edgesTouching(map, "skill:b"), []);
  assert.deepEqual(edgesTouching(map, null), []);
  assert.deepEqual(edgesTouching(map, "memory:gone"), []);
  assert.equal(learningEdgeKey({ from: "a", to: "b", weight: 1 }), "a->b");
});

test("arrow keys walk the drawing order and wrap at both ends", () => {
  const map = buildLearningMap(
    [{ id: "z", name: "zeta" }, { id: "a", name: "alpha" }],
    [{ id: "m1", text: "one" }],
  );
  const order = map.nodes.map((node) => node.id);
  assert.deepEqual(order, ["skill:a", "skill:z", "memory:m1"]);
  // No selection steps in at the start (forwards) or the end (backwards).
  assert.equal(nextLearningNodeId(map, null, 1), order[0]);
  assert.equal(nextLearningNodeId(map, null, -1), order[2]);
  assert.equal(nextLearningNodeId(map, order[2], 1), order[0]);
  assert.equal(nextLearningNodeId(map, order[0], -1), order[2]);
  assert.equal(nextLearningNodeId(map, order[0], 1), order[1]);
  // A stale id restarts at the top rather than going nowhere.
  assert.equal(nextLearningNodeId(map, "skill:gone", 1), order[0]);
  assert.equal(nextLearningNodeId(buildLearningMap([], []), null, 1), null);
});

test("a skill node opens with everything the row shows", () => {
  const skills = [
    {
      id: "windows-lock",
      name: "  Windows file lock  ",
      description: " rename a locked directory ",
      enabled: true,
      useCount: 4,
      level: "project",
      pinned: true,
    },
  ];
  const detail = learningNodeDetail("skill:windows-lock", skills, []);
  assert.deepEqual(detail, {
    kind: "skill",
    id: "windows-lock",
    name: "Windows file lock",
    description: "rename a locked directory",
    level: "project",
    useCount: 4,
    pinned: true,
    enabled: true,
  });
  // The map only draws enabled skills, but a card read from the same records
  // still has to say what state the record is in.
  const off = learningNodeDetail("skill:windows-lock", [{ ...skills[0], enabled: false, pinned: undefined }], []);
  assert.equal(off.enabled, false);
  assert.equal(off.pinned, false);
  assert.equal(off.level, "project");
  assert.equal(off.useCount, 4);
  // No record, no card: a node deleted under an open panel must not be described.
  assert.equal(learningNodeDetail("skill:windows-lock", [], []), null);
  assert.equal(learningNodeDetail("session:x", skills, []), null);
});

test("a memory node opens with its kind, title and body", () => {
  const memories = [
    {
      id: "m1",
      text: "Prefers terse Chinese: 回答尽量短",
      title: "Prefers terse Chinese",
      body: "回答尽量短",
      kind: "preference",
      target: "user",
      useCount: 2,
    },
  ];
  assert.deepEqual(learningNodeDetail("memory:m1", [], memories), {
    kind: "memory",
    id: "m1",
    title: "Prefers terse Chinese",
    body: "回答尽量短",
    memoryKind: "preference",
    target: "user",
    useCount: 2,
  });
  // A record with only the joined text still opens: the first line is the title.
  const plain = learningNodeDetail("memory:m2", [], [{ id: "m2", text: "first line\nsecond" }]);
  assert.equal(plain.title, "first line");
  assert.equal(plain.body, "");
  assert.equal(plain.target, "memory");
  assert.equal(plain.memoryKind, undefined);
  assert.equal(learningNodeDetail("memory:gone", [], memories), null);
});

/* ------------------------------------------------------------------------- *
 * The drawn component
 *
 * Server-rendered, because what matters here is the markup a screen reader and
 * the keyboard contract read: roles, names, tab stops and which lines stay lit.
 * ------------------------------------------------------------------------- */

const mapLabels = {
  skills: "Skills",
  memories: "Memory",
  edge: (weight) => `overlap ${weight}`,
  node: (name) => `Show details for ${name}`,
};

const panelLabels = {
  close: "Close details",
  skill: "Skill",
  memory: "Memory",
  user: "User profile",
  level: "Level",
  global: "Global",
  project: "Project",
  disabled: "Switched off",
  pinned: "Pinned",
  used: (count) => `Used ${count} times`,
  neverUsed: "Never used",
  removeSkill: "Delete skill",
  removeMemory: "Delete memory",
  confirm: "Click again to delete",
  cancel: "Cancel",
  skillHint: "Deletes the skill's document from its library.",
  memoryHint: "Removes the entry from the memory store.",
  memoryKind: (kind) => `kind:${kind}`,
};

const counts = { skills: 0, memories: 0, skillsHidden: 0, memoriesHidden: 0 };

/** Two skills and one memory, with one edge on each side of the pair. */
const threeNodeMap = {
  nodes: [
    { id: "skill:a", kind: "skill", label: "alpha", useCount: 3, x: 100, y: 100 },
    { id: "skill:b", kind: "skill", label: "beta", idle: true, x: 150, y: 100 },
    { id: "memory:c", kind: "memory", label: "gamma", target: "memory", x: 200, y: 100 },
  ],
  edges: [
    { from: "skill:a", to: "skill:b", weight: 0.5 },
    { from: "skill:b", to: "memory:c", weight: 0.4 },
  ],
  counts: { skills: 2, memories: 1, skillsHidden: 0, memoriesHidden: 0 },
};

test("the drawn map opens its nodes by pointer or keyboard, and describes what it opens", async () => {
  const server = await viteServer();
  try {
    const { LearningMapCanvas, LearningNodePanel } = await server.ssrLoadModule(
      "/src/components/settings/LearningMapCanvas.tsx",
    );

    /* --- the canvas ---------------------------------------------------- */

    const renderMap = (map, extra = {}) =>
      renderToStaticMarkup(
        createElement(LearningMapCanvas, {
          map,
          labels: mapLabels,
          onSelect: () => {},
          ...extra,
        }),
      );

    // Zero nodes: still a labelled canvas, and nothing pretending to be a button.
    const empty = renderMap({ nodes: [], edges: [], counts });
    assert.match(empty, /class="learning-map-canvas"/);
    assert.match(empty, /role="group"/);
    assert.match(empty, /aria-label="Skills \/ Memory"/);
    assert.doesNotMatch(empty, /learning-map-node/);

    // One node: focusable, named, and activatable by keyboard.
    const one = renderMap({
      nodes: [{ id: "skill:solo", kind: "skill", label: "solo", x: 150, y: 150 }],
      edges: [],
      counts: { ...counts, skills: 1 },
    });
    assert.match(one, /role="button"/);
    assert.match(one, /tabindex="0"/);
    assert.match(one, /aria-label="Show details for solo"/);
    assert.match(one, /aria-expanded="false"/);
    // The mark is tiny, so a transparent hit shape carries the pointer target.
    assert.match(one, /class="learning-map-hit"/);

    // A static render (no onSelect) stays a picture with no tab stops, so the
    // convenience wrapper cannot trap a keyboard user on a decorative map.
    const staticMap = renderToStaticMarkup(
      createElement(LearningMapCanvas, { map: threeNodeMap, labels: mapLabels }),
    );
    assert.match(staticMap, /role="img"/);
    assert.doesNotMatch(staticMap, /tabindex="0"/);

    // A selected node says it is open, points at the card, and lights only its
    // own edges; the rest of the web steps back.
    const selected = renderMap(threeNodeMap, {
      selectedId: "skill:a",
      detailId: "learning-map-detail",
    });
    assert.match(selected, /aria-expanded="true"/);
    assert.match(selected, /aria-controls="learning-map-detail"/);
    assert.match(selected, /class="learning-map-skill learning-map-node is-active is-selected"/);
    assert.match(selected, /class="learning-map-edge is-active"/);
    assert.match(selected, /class="learning-map-edge is-dim"/);

    /* --- the card ------------------------------------------------------ */

    const renderPanel = (detail, extra = {}) =>
      renderToStaticMarkup(
        createElement(LearningNodePanel, {
          detail,
          labels: panelLabels,
          id: "learning-map-detail",
          onClose: () => {},
          onRemove: () => {},
          ...extra,
        }),
      );

    const skillPanel = renderPanel({
      kind: "skill",
      id: "windows-lock",
      name: "Windows file lock",
      description: "rename a locked directory",
      level: "project",
      useCount: 4,
      pinned: true,
      enabled: true,
    });
    assert.match(skillPanel, /id="learning-map-detail"/);
    assert.match(skillPanel, /role="group"/);
    assert.match(skillPanel, /aria-label="Windows file lock"/);
    assert.match(skillPanel, /tabindex="-1"/);
    assert.match(skillPanel, /Windows file lock<\/h4>/);
    assert.match(skillPanel, /rename a locked directory/);
    assert.match(skillPanel, /Level: Project/);
    assert.match(skillPanel, /Used 4 times/);
    assert.match(skillPanel, /Pinned/);
    assert.match(skillPanel, /Delete skill/);
    assert.match(skillPanel, /aria-label="Close details"/);
    // Switched while the write is in flight, but still announcing what it does.
    const busy = renderPanel(
      { kind: "skill", id: "s", name: "s", description: "", pinned: false, enabled: false },
      { busy: true },
    );
    assert.match(busy, /aria-busy="true"/);
    assert.match(busy, /disabled=""/);
    assert.match(busy, /Switched off/);
    assert.match(busy, /Never used/);

    const memory = {
      kind: "memory",
      id: "m1",
      title: "Prefers terse Chinese",
      body: "回答尽量短",
      memoryKind: "preference",
      target: "user",
      useCount: 2,
    };
    const memoryPanel = renderPanel(memory);
    assert.match(memoryPanel, /kind:preference/);
    assert.match(memoryPanel, /Prefers terse Chinese/);
    assert.match(memoryPanel, /回答尽量短/);
    assert.match(memoryPanel, /User profile/);
    assert.match(memoryPanel, /Used 2 times/);
    assert.match(memoryPanel, /Delete memory/);
    assert.doesNotMatch(memoryPanel, /Level:/);

    // A caller with no safe removal call gets a readable card, not a button that
    // would fail if pressed.
    const readOnly = renderToStaticMarkup(
      createElement(LearningNodePanel, {
        detail: memory,
        labels: panelLabels,
        onClose: () => {},
      }),
    );
    assert.match(readOnly, /Delete memory/);
    assert.match(readOnly, /disabled=""/);
  } finally {
    await server.close();
  }
});

/** A Vite dev server in SSR mode, so a .tsx file can be rendered without a DOM. */
async function viteServer() {
  return createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
}
