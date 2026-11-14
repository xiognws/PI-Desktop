/**
 * Which extension `notify` calls reach the renderer toast stack.
 *
 * Two adjustments are deliberate, and both come from real behaviour of the
 * bundled Diff view plugin:
 *
 * 1. The extension label is prefixed at most once. Extensions that already name
 *    themselves in the message (Diff view sends "Diff view: …") used to render
 *    as "Diff view: Diff view: …".
 *
 * 2. Diff view's snapshot-capture degradation notice is not relayed. The notice
 *    fires when the plugin's capture bridge cannot resolve the session workspace
 *    (a project directory that was deleted, moved, or checked out into a
 *    worktree that no longer exists), yet it advises the user to "check file
 *    permissions, disk space and actions.jsonl" — advice that sends them to the
 *    wrong place. The same condition is already recorded twice where it can be
 *    read: the run is persisted as `incomplete` and shown in the Diff view panel,
 *    and the plugin writes a `capture-<stage>` audit entry. A global banner adds
 *    no information, only noise on every turn of such a session.
 *
 * Nothing else is suppressed: prompts, errors, and every other extension toast
 * pass through unchanged.
 */

/** Diff view's own wording for a turn whose snapshots could not be captured. */
const SNAPSHOT_DEGRADED = /快照采集降级|snapshot capture degrad/i;

/** True when `message` already opens with the extension's own label. */
function alreadyLabelled(label: string, message: string): boolean {
  if (!label) return true;
  const head = message.slice(0, label.length + 1);
  if (head.slice(0, label.length).toLowerCase() !== label.toLowerCase()) return false;
  const separator = message.charAt(label.length);
  return separator === ":" || separator === "：" || message.length === label.length;
}

/**
 * Text to show in the toast stack, or `null` when this notification must not
 * reach the renderer at all.
 */
export function extensionToastText(label: string, message: string): string | null {
  const text = message.trim();
  if (!text) return null;
  if (SNAPSHOT_DEGRADED.test(text)) return null;
  if (alreadyLabelled(label, text)) return text;
  return `${label}: ${text}`;
}
