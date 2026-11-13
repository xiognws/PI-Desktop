/**
 * The learning map, drawn.
 *
 * A static SVG rather than a force simulation: this page is opened to see the
 * shape of what the agent has taught itself, and a layout that settles differently
 * every time makes two visits incomparable. Positions come from
 * `buildLearningMap`, so the rules live in a tested module and this file only
 * paints.
 *
 * The picture is also the index into the two stores: a node can be activated by
 * pointer or keyboard, and the card beside it says what that node actually is.
 * Selection is a prop (`selectedId` + `onSelect`), never local state, because the
 * card's destructive action belongs to the page that already owns the write.
 */

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import {
  buildLearningMap,
  edgesTouching,
  learningEdgeKey,
  nextLearningNodeId,
  type LearningMap,
  type LearningMemory,
  type LearningNode,
  type LearningNodeDetail,
  type LearningSkill,
} from "../../lib/learning-map";
import { useArmedDelete } from "../../hooks/use-armed-delete";
import { IconClose } from "../icons";
import "./learning-map.css";

/** Words the canvas and the card need; the caller resolves them through i18n. */
export type LearningMapLabels = {
  skills: string;
  memories: string;
  edge: (weight: string) => string;
  /** Accessible name of one node: what it is, and that activating it opens it. */
  node: (name: string) => string;
};

/** Every string the detail card shows, so the card itself stays presentational. */
export type LearningNodePanelLabels = {
  close: string;
  skill: string;
  memory: string;
  user: string;
  level: string;
  global: string;
  project: string;
  disabled: string;
  pinned: string;
  used: (count: number) => string;
  neverUsed: string;
  removeSkill: string;
  removeMemory: string;
  confirm: string;
  cancel: string;
  skillHint: string;
  memoryHint: string;
  memoryKind: (kind: string) => string;
};

/** A node's drawn radius: how often the model loaded it, capped so the ring holds. */
function nodeRadius(node: LearningNode): number {
  return node.useCount ? Math.min(4 + Math.sqrt(node.useCount) * 2, 9) : 5;
}

type LearningMapCanvasProps = {
  map: LearningMap;
  labels: LearningMapLabels;
  size?: number;
  /** The node whose detail card is open, if any. */
  selectedId?: string | null;
  /**
   * A node was activated, or the selection was dismissed (`null`). Without it
   * the map stays a picture: no roles, no tab stops, no pointer affordance.
   */
  onSelect?: (nodeId: string | null) => void;
  /** The id of the card a node controls, so the node can point at it. */
  detailId?: string;
};

export function LearningMapCanvas({
  map,
  labels,
  size = 300,
  selectedId = null,
  onSelect,
  detailId,
}: LearningMapCanvasProps) {
  const byId = new Map(map.nodes.map((node) => [node.id, node]));
  const interactive = typeof onSelect === "function";
  // Hover and keyboard focus both light a node up without selecting it: moving
  // the pointer across the map should not open anything.
  const [activeId, setActiveId] = useState<string | null>(null);
  const nodeRefs = useRef(new Map<string, SVGGElement | null>());
  const previouslySelected = useRef<string | null>(null);

  const lit = new Set([activeId, selectedId].filter((id): id is string => Boolean(id)));
  const highlighted = new Set(
    [...lit].flatMap((id) => edgesTouching(map, id).map(learningEdgeKey)),
  );

  // Dismissing the card unmounts the element that held focus. Only step in when
  // focus actually fell back to the document, so a click elsewhere on the page
  // is never yanked back into the map.
  useEffect(() => {
    const previous = previouslySelected.current;
    previouslySelected.current = selectedId;
    if (!previous || selectedId !== null) return;
    if (typeof document === "undefined" || document.activeElement !== document.body) return;
    nodeRefs.current.get(previous)?.focus();
  }, [selectedId]);

  const focusNode = (nodeId: string | null) => {
    if (!nodeId) return;
    nodeRefs.current.get(nodeId)?.focus();
  };

  const activate = (nodeId: string) => {
    if (!onSelect) return;
    onSelect(nodeId === selectedId ? null : nodeId);
  };

  const onNodeKeyDown = (event: ReactKeyboardEvent<SVGGElement>, nodeId: string) => {
    if (!onSelect) return;
    const { key } = event;
    if (key === "Enter" || key === " " || key === "Spacebar") {
      event.preventDefault();
      activate(nodeId);
      return;
    }
    if (key === "Escape") {
      if (!selectedId) return;
      event.preventDefault();
      onSelect(null);
      return;
    }
    if (key === "ArrowRight" || key === "ArrowDown") {
      event.preventDefault();
      focusNode(nextLearningNodeId(map, nodeId, 1));
      return;
    }
    if (key === "ArrowLeft" || key === "ArrowUp") {
      event.preventDefault();
      focusNode(nextLearningNodeId(map, nodeId, -1));
    }
  };

  /** The props every node shares; a static map hands back an empty object. */
  const nodeHandlers = (node: LearningNode) => {
    if (!interactive) return {};
    return {
      role: "button",
      tabIndex: 0,
      "aria-label": labels.node(node.label),
      "aria-expanded": node.id === selectedId,
      "aria-controls": node.id === selectedId ? detailId : undefined,
      onClick: () => activate(node.id),
      onKeyDown: (event: ReactKeyboardEvent<SVGGElement>) => onNodeKeyDown(event, node.id),
      onMouseEnter: () => setActiveId(node.id),
      onMouseLeave: () => setActiveId((current) => (current === node.id ? null : current)),
      onFocus: () => setActiveId(node.id),
      onBlur: () => setActiveId((current) => (current === node.id ? null : current)),
    };
  };

  const stateClass = (node: LearningNode): string => {
    const classes = ["learning-map-node"];
    if (lit.has(node.id)) classes.push("is-active");
    if (node.id === selectedId) classes.push("is-selected");
    return classes.join(" ");
  };

  return (
    <svg
      className="learning-map-canvas"
      viewBox="0 0 300 300"
      width={size}
      height={size}
      role={interactive ? "group" : "img"}
      aria-label={`${labels.skills} / ${labels.memories}`}
    >
      {map.edges.map((edge) => {
        const from = byId.get(edge.from);
        const to = byId.get(edge.to);
        if (!from || !to) return null;
        const touched = highlighted.has(learningEdgeKey(edge));
        // With something lit, the rest of the web steps back rather than
        // competing with the pair the reader is looking at.
        const dimmed = lit.size > 0 && !touched;
        return (
          <line
            key={learningEdgeKey(edge)}
            x1={from.x}
            y1={from.y}
            x2={to.x}
            y2={to.y}
            className={[
              "learning-map-edge",
              touched ? "is-active" : "",
              dimmed ? "is-dim" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            // Stronger overlap, stronger line: the picture says which pairs are
            // really the same topic.
            strokeOpacity={Math.min(0.15 + edge.weight, 0.75).toFixed(2)}
            strokeWidth={1 + edge.weight * 2}
          >
            <title>{labels.edge(edge.weight.toFixed(2))}</title>
          </line>
        );
      })}
      {map.nodes.map((node) => {
        const name = node.label;
        const useLabel = node.useCount === undefined ? "" : ` · ${node.useCount}×`;
        return node.kind === "skill" ? (
          <g
            key={node.id}
            ref={(element) => {
              nodeRefs.current.set(node.id, element);
            }}
            className={`learning-map-skill ${stateClass(node)}`}
            {...nodeHandlers(node)}
          >
            {/* The mark is five SVG units across; the hit circle is what a
                pointer can actually land on. */}
            <circle className="learning-map-hit" cx={node.x} cy={node.y} r={12} />
            <circle
              className={`learning-map-node-mark${node.idle ? " is-idle" : ""}`}
              cx={node.x}
              cy={node.y}
              r={nodeRadius(node)}
            />
            <title>{`${name}${useLabel}`}</title>
          </g>
        ) : (
          <g
            key={node.id}
            ref={(element) => {
              nodeRefs.current.set(node.id, element);
            }}
            className={`learning-map-memory is-${node.target ?? "memory"} ${stateClass(node)}`}
            {...nodeHandlers(node)}
          >
            <rect
              className="learning-map-hit"
              x={node.x - 10}
              y={node.y - 10}
              width={20}
              height={20}
              rx={4}
            />
            <rect
              className="learning-map-node-mark"
              x={node.x - 3.2}
              y={node.y - 3.2}
              width={6.4}
              height={6.4}
              rx={1.4}
            />
            <title>{name}</title>
          </g>
        );
      })}
    </svg>
  );
}

/**
 * What a node is, in a card beside the map.
 *
 * Read-mostly on purpose, exactly like the two lists below it: the card may
 * remove one record — through the same call the owning page already exposes —
 * and nothing else. A removal arms first and says what the second click will do,
 * the two-click rule every destructive row on this page follows.
 */
export function LearningNodePanel({
  detail,
  labels,
  id,
  busy,
  onRemove,
  onClose,
}: {
  detail: LearningNodeDetail;
  labels: LearningNodePanelLabels;
  id?: string;
  busy?: boolean;
  /** Absent when the caller has no safe removal path for this node kind. */
  onRemove?: (detail: LearningNodeDetail) => void;
  onClose: () => void;
}) {
  const { armed, setArmed } = useArmedDelete();
  const heading = detail.kind === "skill" ? detail.name : detail.title;
  const text = detail.kind === "skill" ? detail.description : detail.body;
  const canRemove = typeof onRemove === "function" && !busy;
  const removeLabel = detail.kind === "skill" ? labels.removeSkill : labels.removeMemory;

  const activateRemove = () => {
    if (!onRemove || busy) return;
    // First click arms and relabels; the second one is the delete. The arm
    // expires on its own, so the card never sits one stray click from a write.
    if (armed !== "remove") {
      setArmed("remove");
      return;
    }
    setArmed(null);
    onRemove(detail);
  };

  return (
    <aside
      id={id}
      className="learning-map-detail"
      role="group"
      aria-label={heading}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        onClose();
      }}
    >
      <div className="learning-map-detail-head">
        <span className="learning-map-detail-kind">
          {detail.kind === "skill"
            ? labels.skill
            : detail.memoryKind
              ? labels.memoryKind(detail.memoryKind)
              : labels.memory}
        </span>
        <button
          type="button"
          className="settings-icon-button"
          aria-label={labels.close}
          title={labels.close}
          onClick={onClose}
        >
          <IconClose size={14} />
        </button>
      </div>
      <h4 className="learning-map-detail-name">{heading}</h4>
      {text ? <p className="learning-map-detail-text">{text}</p> : null}
      <div className="learning-map-detail-meta">
        {detail.kind === "skill" && detail.level ? (
          <span className="learning-map-detail-chip">
            {labels.level}: {detail.level === "project" ? labels.project : labels.global}
          </span>
        ) : null}
        {detail.kind === "memory" ? (
          <span className="learning-map-detail-chip">
            {detail.target === "user" ? labels.user : labels.memory}
          </span>
        ) : null}
        <span className="learning-map-detail-chip">
          {detail.useCount ? labels.used(detail.useCount) : labels.neverUsed}
        </span>
        {detail.kind === "skill" && detail.pinned ? (
          <span className="learning-map-detail-chip">{labels.pinned}</span>
        ) : null}
        {detail.kind === "skill" && !detail.enabled ? (
          <span className="learning-map-detail-chip">{labels.disabled}</span>
        ) : null}
      </div>
      <p className="learning-map-detail-hint">
        {detail.kind === "skill" ? labels.skillHint : labels.memoryHint}
      </p>
      <div className="learning-map-detail-actions">
        {armed === "remove" ? (
          <button type="button" className="btn btn-secondary" onClick={() => setArmed(null)}>
            {labels.cancel}
          </button>
        ) : null}
        <button
          type="button"
          className={`btn btn-secondary learning-map-detail-remove${
            armed === "remove" ? " is-armed" : ""
          }`}
          disabled={!canRemove}
          aria-busy={busy || undefined}
          aria-label={armed === "remove" ? labels.confirm : removeLabel}
          onClick={activateRemove}
        >
          {armed === "remove" ? labels.confirm : removeLabel}
        </button>
      </div>
    </aside>
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
  labels: LearningMapLabels;
}) {
  const map = buildLearningMap(skills, memories);
  return <LearningMapCanvas map={map} labels={labels} />;
}
