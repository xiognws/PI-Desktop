import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  AgentSidecar as RuntimeAgentSidecar,
  type StderrHandler,
} from "@pi-workspace/host-runtime";
import { resolveAgentSidecarLaunch } from "./agent-sidecar-launch.ts";
import type { AgentSidecarRuntime } from "./agent-sidecar-launch.ts";
import { adaptKernelPrompt } from "./kernel/kernel-prompt.ts";
import {
  isKernelUnsupportedMethod,
  kernelUnsupportedMethodError,
} from "./kernel/kernel-methods.ts";
import { redactValue } from "./logger";
import { getModuleDirectory } from "./module-path";
import { localTimestamp } from "./log-timestamp.ts";

export type {
  LocalToolHandler,
  LocalToolResult,
  ProjectInstructionResolver,
  SidecarNotificationHandler,
  TrustedExtensionSidecarBridge,
  VendorAuthResolver,
} from "@pi-workspace/host-runtime";

function resolveSidecarEntry(): string {
  const candidates = [
    join(process.resourcesPath || "", "agent-runtime/sidecar.js"),
    join(
      getModuleDirectory(import.meta.url),
      "../../../agent-runtime/dist/sidecar.js",
    ),
    join(
      getModuleDirectory(import.meta.url),
      "../../../../packages/agent-runtime/dist/sidecar.js",
    ),
  ];
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return join(
    getModuleDirectory(import.meta.url),
    "../../../../packages/agent-runtime/dist/sidecar.js",
  );
}

function fallbackStderrLogger(text: string): void {
  console.error(
    `[agent/runtime] ${JSON.stringify({
      ts: localTimestamp(),
      level: "info",
      channel: "agent",
      category: "runtime",
      event: "child.process.stderr",
      message: "child process stderr",
      data: { output: redactValue(text.trimEnd()) },
    })}`,
  );
}

/**
 * The desktop's agent sidecar: the shared stdio transport from
 * `@pi-workspace/host-runtime`, over whichever implementation this build is
 * configured to run — the Node sidecar (its own executable with
 * `ELECTRON_RUN_AS_NODE`) or the Rust kernel, on the same protocol.
 *
 * The launch decision lives in `agent-sidecar-launch.ts`; this class only hands
 * it to the transport, so nothing above the transport knows the difference.
 */
export class AgentSidecar extends RuntimeAgentSidecar {
  /** Which implementation answers this transport; callers adapt by vocabulary. */
  readonly runtime: AgentSidecarRuntime;
  private readonly log: StderrHandler;
  /** Prompt parameters the kernel has no reader for, reported once per turn. */
  private reportedUnsupported = new Set<string>();

  constructor(onStderr?: StderrHandler) {
    const log = onStderr ?? fallbackStderrLogger;
    const launch = resolveAgentSidecarLaunch(
      {
        env: process.env,
        platform: process.platform,
        execPath: process.execPath,
        moduleDir: getModuleDirectory(import.meta.url),
        ...(process.resourcesPath ? { resourcesPath: process.resourcesPath } : {}),
      },
      { nodeEntry: resolveSidecarEntry() },
    );
    if (launch.fallbackReason) {
      // Never fatal: a build without the kernel binary still has to run an
      // agent, and the reason has to reach the log or the fallback is silent.
      log(`[agent/runtime] ${launch.fallbackReason}; started the Node sidecar
`);
    }
    super({ launch, onStderr: log });
    this.runtime = launch.runtime;
    this.log = log;
  }

  /**
   * The kernel's `agent.prompt` takes its own parameter set, not this app's
   * launch payload. Translating here — at the one place that knows which runtime
   * answered — keeps every call site unchanged and keeps the mapping testable.
   */
  override async call<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    if (this.runtime !== "rust") {
      return super.call<T>(method, params);
    }
    // A surface the kernel does not answer yet fails here, with a reason, instead
    // of a bare JSON-RPC `-32601` reaching the UI as an unknown error.
    if (isKernelUnsupportedMethod(method)) {
      throw kernelUnsupportedMethodError(method);
    }
    if (method !== "agent.prompt") {
      return super.call<T>(method, params);
    }
    let adapted: ReturnType<typeof adaptKernelPrompt>;
    try {
      adapted = adaptKernelPrompt(params);
    } catch (error) {
      // Classified like any other turn error so main records a failed turn
      // instead of a crashed request.
      const message = error instanceof Error ? error.message : String(error);
      throw Object.assign(new Error(message), { errorCode: "KERNEL_PROMPT_INVALID" });
    }
    this.reportUnsupported(adapted.unsupported);
    return super.call<T>(method, adapted.params);
  }

  /** One line per newly-dropped parameter: a parity gap has to be visible. */
  private reportUnsupported(keys: string[]): void {
    const fresh = keys.filter((key) => !this.reportedUnsupported.has(key));
    if (fresh.length === 0) return;
    for (const key of fresh) this.reportedUnsupported.add(key);
    this.log(
      `[agent/kernel] ${JSON.stringify({ event: "prompt.params.unsupported", params: fresh })}\n`,
    );
  }
}
