import { useSyncExternalStore } from "react";

/**
 * A one-shot "find inside this conversation" request from the shell's keyboard
 * dispatch to the transcript.
 *
 * The shortcut is registry-owned (`findInTranscript`, Mod+F), but the bar lives
 * with the rows: the transcript is the only component that knows which DOM text
 * is on screen. A request module keeps that handoff out of the app store, which
 * holds session and panel state rather than transient keys.
 */
let sequence = 0;
const listeners = new Set<() => void>();

export function requestTranscriptFind(): void {
  sequence += 1;
  for (const listener of listeners) listener();
}

/** How many times a find has been requested; stable between requests. */
export function transcriptFindSequence(): number {
  return sequence;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Re-renders the caller whenever a find is requested. */
export function useTranscriptFindRequest(): number {
  return useSyncExternalStore(subscribe, transcriptFindSequence, transcriptFindSequence);
}
