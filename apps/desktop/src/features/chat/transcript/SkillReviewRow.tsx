import { Fragment, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { AgentActivity } from "@pi-workspace/shared";

import type { TranscriptEntry } from "../../../lib/assistant-turns";
import { useAppStore } from "../../../stores/app-store";
import type { SkillReviewNotice } from "../../../stores/app-state";
import { TranscriptHistory, TranscriptTail } from "./AssistantTurn";
import { skillReviewLines, skillReviewReports, skillReviewText } from "./skill-review-text";

/**
 * One quiet line under a finished turn reporting the self-improvement review.
 *
 * The review runs after the turn on a fork the transcript never shows, so without
 * this row a review that wrote a skill would be indistinguishable from one that
 * never ran. That is the whole scope of the row: Hermes announces a review only
 * when it landed something (or broke), so a pass that found nothing and a gate
 * that never opened stay in the log rather than in the conversation.
 *
 * Hermes prints its summary into the output stream the moment the review
 * finishes, which puts it between that turn and the next one and lets later turns
 * push it up into history. This row lands in the same place by anchor rather than
 * by being pinned to the end of the list.
 */
export function SkillReviewRow({ notice }: { notice: SkillReviewNotice }) {
  const { t } = useTranslation();
  // The switch hides the row, never the review: a user who turned the report off
  // still gets the skill library updated, they just do not want the line.
  const visible = useAppStore((state) => state.settings?.skillReviewVisible !== false);
  if (!visible) return null;
  if (!skillReviewReports(notice)) return null;
  // One line per write, glyph first — the shape Hermes uses for a review's memory
  // and skill operations. A single "N updates" sentence told the reader that
  // something happened but not what, which is the part they act on.
  const lines = skillReviewLines(notice);
  return (
    <div className="skill-review-row" data-outcome={notice.outcome} role="status">
      {lines.length > 0 ? (
        <ul className="skill-review-lines">
          {lines.map((line) => (
            <li key={line} className="skill-review-line">
              {line}
            </li>
          ))}
        </ul>
      ) : (
        <span className="skill-review-text">{skillReviewText(notice, t)}</span>
      )}
    </div>
  );
}

/** A review row has no message of its own, so a slice is keyed by the row above it. */
function entryKey(entry: TranscriptEntry): string {
  if (entry.kind === "compaction") return `compaction:${entry.mark.id}`;
  if (entry.kind === "assistant-turn") return `turn:${entry.id}`;
  return `message:${entry.message.id}`;
}

/**
 * Whether a rendered row draws this message. A turn is keyed by its first message
 * and holds all the later ones, so the anchor is resolved by containment rather
 * than by comparing row ids: the newest message of a turn is almost never the id
 * its row is keyed by.
 */
function entryDrawsMessage(entry: TranscriptEntry, messageId: string): boolean {
  if (entry.kind === "message") return entry.message.id === messageId;
  if (entry.kind === "compaction") {
    return entry.mark.id === messageId || entry.mark.throughMessageId === messageId;
  }
  if (entry.id === messageId || entry.anchorId === messageId) return true;
  for (const part of entry.parts) {
    if (part.kind === "message") {
      if (part.message.id === messageId) return true;
      continue;
    }
    for (const item of part.items) {
      if (item.message.id === messageId) return true;
      if (item.kind !== "tool" || !item.delegate) continue;
      for (const run of item.delegate.items) {
        if (run.message.id === messageId) return true;
      }
    }
  }
  return false;
}

export type SkillReviewLayout = {
  /**
   * History slices in order, each followed by the reviews anchored to its last
   * row. A slice runs to the row its review reports on, so that review is drawn
   * before whatever the turn was followed by.
   */
  segments: { key: string; entries: TranscriptEntry[]; notices: SkillReviewNotice[] }[];
  /**
   * Reviews with no row in view — the session was reloaded, the anchor sits
   * outside the mounted window, or the notice landed before any transcript
   * existed. They stay at the end of the list: dropping them would lose the only
   * report of a write, and drawing them at the top would report a review before
   * the turn it reviewed.
   */
  afterTail: SkillReviewNotice[];
};

/**
 * Place each review row directly under the turn it reports on.
 *
 * The notice carries the id of the newest message at the moment it landed, so the
 * placement survives later turns: once the next turn renders, the earlier one
 * moves into the history list and its review moves with it, instead of ending up
 * below the newest reply.
 */
export function layoutSkillReviews(
  entries: TranscriptEntry[],
  tailEntry: TranscriptEntry | undefined,
  notices: readonly SkillReviewNotice[] | undefined,
): SkillReviewLayout {
  const afterEntry = new Map<number, SkillReviewNotice[]>();
  const afterTail: SkillReviewNotice[] = [];
  if (!notices || notices.length === 0) {
    const last = entries[entries.length - 1];
    return {
      segments: [{ key: last ? entryKey(last) : "start", entries, notices: [] }],
      afterTail,
    };
  }
  for (const notice of notices) {
    const anchor = notice.afterMessageId;
    if (anchor && tailEntry && entryDrawsMessage(tailEntry, anchor)) {
      // The turn it reports on is still the tail, so the row is drawn under it and
      // keeps that place once later turns push the turn into the history list.
      afterTail.push(notice);
      continue;
    }
    // Newest first: a message belongs to the last row that draws it.
    let index = -1;
    if (anchor) {
      for (let candidate = entries.length - 1; candidate >= 0; candidate -= 1) {
        if (!entryDrawsMessage(entries[candidate], anchor)) continue;
        index = candidate;
        break;
      }
    }
    if (index < 0) {
      afterTail.push(notice);
      continue;
    }
    const attached = afterEntry.get(index);
    if (attached) attached.push(notice);
    else afterEntry.set(index, [notice]);
  }

  const segments: SkillReviewLayout["segments"] = [];
  let start = 0;
  entries.forEach((entry, index) => {
    const attached = afterEntry.get(index);
    if (!attached) return;
    segments.push({
      key: entryKey(entry),
      entries: entries.slice(start, index + 1),
      notices: attached,
    });
    start = index + 1;
  });
  if (start < entries.length || segments.length === 0) {
    // When nothing was spliced in, hand `TranscriptHistory` the pane's own array
    // so its identity check still short-circuits a tail-only update, exactly as
    // before these rows existed.
    const rest = start === 0 ? entries : entries.slice(start);
    const last = rest[rest.length - 1];
    segments.push({ key: last ? entryKey(last) : "start", entries: rest, notices: [] });
  }
  return { segments, afterTail };
}

/**
 * The transcript in order: history slices with their review rows spliced in, the
 * live tail, then any review that had no row to sit under.
 *
 * The message rows still come from `TranscriptHistory` — one instance per slice,
 * so the settled rows keep the memo bail-out that keeps streaming out of them —
 * and the review rows are plain siblings of the message rows, which is what lets
 * the styling attach them to the turn above.
 */
export function SkillReviewAnnotatedHistory({
  entries,
  tailEntry,
  notices,
  isRunning,
  tailActive,
  runtimeActivity,
  liveDelegations,
  liveTurnId,
}: {
  entries: TranscriptEntry[];
  tailEntry?: TranscriptEntry;
  notices?: readonly SkillReviewNotice[];
  isRunning: boolean;
  /** Whether the tail row is the running turn; the history list resolves its own. */
  tailActive?: boolean;
  runtimeActivity?: AgentActivity;
  liveDelegations?: ReadonlyMap<string, true>;
  liveTurnId?: string;
}) {
  const layout = useMemo(
    () => layoutSkillReviews(entries, tailEntry, notices),
    [entries, tailEntry, notices],
  );
  return (
    <>
      {layout.segments.map((segment) => (
        <Fragment key={segment.key}>
          {segment.entries.length > 0 ? (
            <TranscriptHistory
              entries={segment.entries}
              isRunning={isRunning}
              liveDelegations={liveDelegations}
              liveTurnId={liveTurnId}
            />
          ) : null}
          {segment.notices.map((notice) => (
            <SkillReviewRow key={notice.id} notice={notice} />
          ))}
        </Fragment>
      ))}
      {tailEntry ? (
        <TranscriptTail
          entry={tailEntry}
          isRunning={isRunning}
          isActive={tailActive === true}
          runtimeActivity={runtimeActivity}
        />
      ) : null}
      {layout.afterTail.map((notice) => (
        <SkillReviewRow key={notice.id} notice={notice} />
      ))}
    </>
  );
}