import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  AgentSidecar as RuntimeAgentSidecar,
  type StderrHandler,
} from "@pi-workspace/host-runtime";
import { resolveAgentSidecarLaunch } from "./agent-sidecar-launch.ts";
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
  }
}
