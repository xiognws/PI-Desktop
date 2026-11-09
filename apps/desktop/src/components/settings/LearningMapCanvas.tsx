/**
 * The learning map, drawn.
 *
 * A static SVG rather than a force simulation: this page is opened to see the
 * shape of what the agent has taught itself, and a layout that settles differently
 * every time makes two visits incomparable. Positions come from
 * `buildLearningMap`, so the rules live in a tested module and this file only
 * paints.
 */

import {
  buildLearningMap,
  type LearningMap,
  type LearningMemory,
  type LearningSkill,
} from "../../lib/learning-map";

type LearningMapCanvasProps = {
  map: LearningMap;
  labels: {
    skills: string;
    memories: string;
    edge: (weight: string) => string;
  };
  size?: number;
};

export function LearningMapCanvas({ map, labels, size = 300 }: LearningMapCanvasProps) {
  const byId = new Map(map.nodes.map((node) => [node.id, node]));
  return (
    <svg
      className="learning-map-canvas"
      viewBox="0 0 300 300"
      width={size}
      height={size}
      role="img"
      aria-label={`${labels.skills} / ${labels.memories}`}
    >
      {map.edges.map((edge) => {
        const from = byId.get(edge.from);
        const to = byId.get(edge.to);
        if (!from || !to) return null;
        return (
          <line
            key={`${edge.from}->${edge.to}`}
            x1={from.x}
            y1={from.y}
            x2={to.x}
            y2={to.y}
            className="learning-map-edge"
            // Stronger overlap, stronger line: the picture says which pairs are
            // really the same topic.
            strokeOpacity={Math.min(0.15 + edge.weight, 0.75).toFixed(2)}
            strokeWidth={1 + edge.weight * 2}
          >
            <title>{labels.edge(edge.weight.toFixed(2))}</title>
          </line>
        );
      })}
      {map.nodes.map((node) =>
        node.kind === "skill" ? (
          <g key={node.id} className="learning-map-skill">
            <circle
              cx={node.x}
              cy={node.y}
              r={node.useCount ? Math.min(4 + Math.sqrt(node.useCount) * 2, 9) : 5}
              className={node.idle ? "is-idle" : undefined}
            />
            <title>
              {node.label}
              {node.useCount === undefined ? "" : ` · ${node.useCount}×`}
            </title>
          </g>
        ) : (
          <g key={node.id} className={`learning-map-memory is-${node.target ?? "memory"}`}>
            <rect
              x={node.x - 3.2}
              y={node.y - 3.2}
              width={6.4}
              height={6.4}
              rx={1.4}
            />
            <title>{node.label}</title>
          </g>
        ),
      )}
    </svg>
  );
}

/** Convenience wrapper so a caller with raw records does not import the builder. */
export function LearningMapFromRecords({
  skills,
  memories,
  labels,
}: {
  skills: readonly LearningSkill[];
  memories: readonly LearningMemory[];
  labels: { skills: string; memories: string; edge: (weight: string) => string };
}) {
  const map = buildLearningMap(skills, memories);
  return <LearningMapCanvas map={map} labels={labels} />;
}
