/**
 * Report errors that escape React's tree.
 *
 * A React error boundary only sees render failures; a rejected promise or a
 * throw inside an event handler otherwise leaves no trace at all. `console` is
 * the renderer's only output channel, and main mirrors warning/error console
 * messages into the diagnostics log (`electron/main/renderer-console.ts`), so
 * these lines reach a support log without adding a second IPC contract.
 */
const MAX_DETAIL_CHARS = 4_096;

function truncate(text: string): string {
  return text.length <= MAX_DETAIL_CHARS ? text : `${text.slice(0, MAX_DETAIL_CHARS)}…`;
}

function describe(value: unknown): string {
  if (value instanceof Error) {
    return truncate(value.stack ?? `${value.name}: ${value.message}`);
  }
  if (typeof value === "string") {
    return truncate(value);
  }
  try {
    return truncate(JSON.stringify(value) ?? String(value));
  } catch {
    return truncate(String(value));
  }
}

function report(kind: string, value: unknown): void {
  try {
    console.error(`[renderer] ${kind}: ${describe(value)}`);
  } catch {
    // A torn-down frame can make `console` itself throw; reporting must never
    // become the failure.
  }
}

export function installRendererErrorReporting(target: Window = window): () => void {
  const onError = (event: ErrorEvent) => {
    report("uncaught error", event.error ?? event.message);
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    report("unhandled rejection", event.reason);
  };
  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);
  return () => {
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onRejection);
  };
}
