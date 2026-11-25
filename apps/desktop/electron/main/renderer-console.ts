/**
 * Renderer console → diagnostics log.
 *
 * The renderer has no logger of its own: React error boundaries and the global
 * error hooks report through `console`, and this listener is the only thing that
 * turns that stream into a durable record. `info`/`debug` are dropped on
 * purpose — the renderer logs plenty of ordinary progress, and a support log is
 * read by a person looking for a failure.
 *
 * Every surface that runs the renderer bundle needs its own subscription: the
 * main window, a docked plugin view and a detached plugin panel are distinct
 * web contents, and a listener on one hears nothing from the others.
 */
import type { WebContents } from "electron";
import type { Logger } from "./logger";

export type RendererConsoleEvent = {
  message: string;
  level: "info" | "warning" | "error" | "debug";
  lineNumber: number;
  sourceId: string;
};

/** Long enough for a stack head, short enough not to drown one log line. */
const MAX_MESSAGE_CHARS = 2_048;

export function shouldRecordRendererConsole(level: string): boolean {
  return level === "warning" || level === "error";
}

export function rendererConsoleRecord(
  event: RendererConsoleEvent,
  surface?: string,
): {
  level: "warn" | "error";
  fields: {
    event: string;
    data: { message: string; level: string; source: string; surface?: string };
  };
} {
  return {
    level: event.level === "error" ? "error" : "warn",
    fields: {
      event: "rendererConsole",
      data: {
        message: truncate(event.message, MAX_MESSAGE_CHARS),
        level: event.level,
        source: event.sourceId ? `${event.sourceId}:${event.lineNumber}` : "",
        ...(surface ? { surface } : {}),
      },
    },
  };
}

/**
 * Mirror one web contents' console into the diagnostics log.
 *
 * Returns a detach function so a host that closes its surface can stop the
 * listener instead of leaving it attached to a destroyed page.
 */
export function attachRendererConsoleLogging(
  contents: WebContents,
  logger: Pick<Logger, "app">,
  surface: string,
): () => void {
  const listener = (details: RendererConsoleEvent) => {
    if (!shouldRecordRendererConsole(details.level)) return;
    const record = rendererConsoleRecord(details, surface);
    logger.app("diagnostics", record.level, "renderer console", record.fields);
  };
  contents.on("console-message", listener);
  return () => {
    if (!contents.isDestroyed()) {
      contents.removeListener("console-message", listener);
    }
  };
}

/**
 * Same filter as the diagnostics log, for a surface that exists before the file
 * logger does.
 *
 * Storage maintenance runs before any application writer is created — the data
 * directory is still being moved, so the logger has nowhere safe to write. This
 * window is a static page during that job; anything it reports goes to stderr,
 * which the launching terminal or supervisor receives. A packaged GUI launch has
 * no stderr to read, so the job's own failures continue to use the exit-reason
 * record instead.
 */
export function attachRendererConsoleToStderr(contents: WebContents, surface: string): () => void {
  const listener = (details: RendererConsoleEvent) => {
    if (!shouldRecordRendererConsole(details.level)) return;
    const record = rendererConsoleRecord(details, surface);
    process.stderr.write(
      `${record.level} ${record.fields.event} ${JSON.stringify(record.fields.data)}\n`,
    );
  };
  contents.on("console-message", listener);
  return () => {
    if (!contents.isDestroyed()) {
      contents.removeListener("console-message", listener);
    }
  };
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}
