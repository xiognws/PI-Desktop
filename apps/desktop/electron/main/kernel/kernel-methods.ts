/**
 * Which sidecar methods each runtime answers.
 *
 * The Node sidecar and the Rust kernel are the same protocol, not the same
 * surface. Main calls a fixed set of methods, and a method the kernel does not
 * implement must fail with a reason a person can act on — not with a bare
 * JSON-RPC `-32601` that reaches the UI as an unknown error.
 *
 * This module is the single table for that difference. Closing a gap means
 * deleting the method from `KERNEL_UNSUPPORTED_METHODS` in the same change that
 * teaches the kernel the method, so the table can only shrink honestly.
 */
import { ErrorCodes } from "@pi-workspace/shared";

export type KernelMethodGap = {
  /** What the surface is for, in one line, so the log line explains itself. */
  surface: string;
  /** Where the gap is being closed, so the message points somewhere. */
  pending: string;
};

/**
 * Methods the Rust kernel does not answer yet.
 *
 * Keyed by the exact method name main calls. A method that is absent from this
 * table is expected to be answered by the kernel; if it is not, the kernel's own
 * `-32601` surfaces as before, which is the signal that the table is stale.
 */
export const KERNEL_UNSUPPORTED_METHODS: Readonly<Record<string, KernelMethodGap>> = {
  // Deliberately empty, and each entry that used to be here left for the same
  // reason: the surface belongs to a host that can answer it, not to the kernel.
  //
  // `extensions.command.run` and `widget.*` are JavaScript — an extension
  // command (`agent-extensions.ts`), and a widget package's load/run
  // (`widget-commands.ts`). The kernel has no JS runner and should not grow one,
  // so when it is the runtime main runs these itself, from the same trusted set
  // and the same registry the Node sidecar uses.
  //
  // `native.session.list|search|get|fork` serve the *legacy pi JSONL store*,
  // which is a Node-side file format the kernel will never own. Main answers
  // them in-process from that store (`native-sessions.ts`) instead of reporting
  // the user's existing conversations as an unsupported surface.
};

/**
 * The error a caller gets for a method the kernel does not answer.
 *
 * `UNSUPPORTED` is the app's existing code for "this surface is not available
 * here", and the message names both the surface and where it is being closed, so
 * a user report and the log line agree.
 */
export function kernelUnsupportedMethodError(method: string): Error & { errorCode: string } {
  const gap = KERNEL_UNSUPPORTED_METHODS[method];
  const message = gap
    ? `${method} is not available on the Rust agent kernel yet (${gap.surface}); ${gap.pending}`
    : `${method} is not answered by the Rust agent kernel`;
  return Object.assign(new Error(message), { errorCode: ErrorCodes.UNSUPPORTED });
}

/** True when this method is a known kernel gap rather than a kernel bug. */
export function isKernelUnsupportedMethod(method: string): boolean {
  return method in KERNEL_UNSUPPORTED_METHODS;
}
