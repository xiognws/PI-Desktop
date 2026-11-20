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
  "agent.stop": {
    surface: "stop the turn at the next completed assistant boundary (graceful stop)",
    pending: "kernel: graceful stop shares the cancel path with agent.abort",
  },
  "agent.stopSubagents": {
    surface: "cancel running delegates without ending the parent turn",
    pending: "kernel: needs the delegation registry surfaced over RPC",
  },
  "agent.executeApprovedPlan": {
    surface: "run a plan the user approved",
    pending: "kernel: plan execution entry point",
  },
  "agent.modeTurnNotice": {
    surface: "mode-run turn notices (plan/goal stage boundaries)",
    pending: "kernel: mode stage events",
  },
  "widget.invoke": {
    surface: "run a widget package action from the Tools page",
    pending: "kernel: widget runner (host-core owns discovery/trust already)",
  },
  "widget.list": {
    surface: "list widget package actions",
    pending: "kernel: widget runner",
  },
  "widget.logs": {
    surface: "read a widget package's log",
    pending: "kernel: widget runner",
  },
  "widget.sync": {
    surface: "reconcile widget packages with the host",
    pending: "kernel: widget runner",
  },
  "widget.clear": {
    surface: "drop a widget package's cached state",
    pending: "kernel: widget runner",
  },
  "extensions.command.run": {
    surface: "run a trusted extension's command",
    pending: "kernel: extension hooks",
  },
  "native.session.list": {
    surface: "list sessions stored in the legacy pi JSONL format",
    pending: "kernel: the kernel keeps no pi-format session store; this surface retires with it",
  },
  "native.session.search": {
    surface: "search the legacy pi JSONL sessions",
    pending: "kernel: the kernel keeps no pi-format session store",
  },
  "native.session.get": {
    surface: "open one legacy pi JSONL session",
    pending: "kernel: the kernel keeps no pi-format session store",
  },
  "native.session.fork": {
    surface: "fork a legacy pi JSONL session",
    pending: "kernel: the kernel keeps no pi-format session store",
  },
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
