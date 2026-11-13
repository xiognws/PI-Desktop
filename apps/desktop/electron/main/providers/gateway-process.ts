/**
 * Process wiring for in-app gateways.
 *
 * The supervisor in `./in-app-providers.ts` never touches Electron: it takes a
 * `startGateway` function, so its behaviour can be exercised without spawning
 * anything. This module is the real implementation — an Electron
 * `utilityProcess`, falling back to `child_process.fork` when the running
 * Electron version has no `utilityProcess` — plus the loopback key the gateway
 * is started with.
 */
import { fork } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { StartGateway, StartGatewayInput, SupervisorLogger } from "./in-app-providers.ts";
import type { InAppProvider } from "./types.ts";

/**
 * Where the bridge keeps its own state (local API key, saved catalog).
 *
 * `home.cjs` in the vendored gateway resolves the same directory from the same
 * variable, so the key written here is the key the gateway requires.
 */
export function inAppProviderDataDir(): string {
  const override = process.env.PI_WORKBUDDY_HOME;
  return override && override.trim() !== "" ? override : join(homedir(), ".pi-workbuddy-connect");
}

/**
 * Read the local API key, generating one on first use.
 *
 * The gateway refuses a key shorter than 32 characters, and rotating this file
 * would lock the stored provider secret out, so it is written once and reused.
 */
export async function readOrCreateApiKey(
  provider: InAppProvider,
  dataDir: string = inAppProviderDataDir(),
): Promise<string> {
  const path = join(dataDir, "local-api-key");
  try {
    const stored = (await readFile(path, "utf8")).trim();
    if (stored.length >= 32) return stored;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const key = randomBytes(32).toString("hex");
  await mkdir(dataDir, { recursive: true });
  await writeFile(path, `${key}\n`, { mode: 0o600 });
  return key;
}

type GatewayMessage = { type?: unknown; message?: unknown; port?: unknown };

/**
 * What the supervisor sends down to a gateway child. A type alias, not an
 * interface: `child.send` takes Node's `Serializable`, and only an alias carries
 * the implicit index signature that makes this assignable to it.
 */
type GatewayOutbound = { type: string; port?: number; key?: string };

/** What the starter needs from either process flavour. */
type GatewayChild = {
  post(message: GatewayOutbound): void;
  kill(): void;
  onMessage(handler: (message: GatewayMessage) => void): void;
  onExit(handler: (code: number | null) => void): void;
};

type PipedChild = {
  stdout?: NodeJS.ReadableStream | null;
  stderr?: NodeJS.ReadableStream | null;
};

function watchOutput(child: PipedChild, log: SupervisorLogger): void {
  child.stdout?.on("data", (chunk: unknown) => log("info", String(chunk).trimEnd()));
  child.stderr?.on("data", (chunk: unknown) => log("warn", String(chunk).trimEnd()));
}

async function spawnUtilityProcess(
  entry: string,
  provider: InAppProvider,
  log: SupervisorLogger,
): Promise<GatewayChild | null> {
  const electron = await import("electron").catch(() => undefined);
  const utilityProcess = electron?.utilityProcess;
  if (!utilityProcess) return null;
  const child = utilityProcess.fork(entry, [], {
    serviceName: `pi-in-app-${provider.id.replace(/[^a-zA-Z0-9._-]/g, "_")}`,
    stdio: "pipe",
  });
  watchOutput(child, log);
  return {
    post: (message) => child.postMessage(message),
    kill: () => child.kill(),
    onMessage: (handler) => {
      child.on("message", (message: unknown) => handler({ ...(message as GatewayMessage) }));
    },
    onExit: (handler) => {
      child.on("exit", (code: number) => handler(code));
    },
  };
}

function spawnForkedChild(entry: string, log: SupervisorLogger): GatewayChild {
  const child = fork(entry, [], { stdio: "pipe" });
  watchOutput(child, log);
  return {
    post: (message) => {
      child.send(message);
    },
    kill: () => child.kill(),
    onMessage: (handler) => {
      child.on("message", (message: unknown) => handler({ ...(message as GatewayMessage) }));
    },
    onExit: (handler) => {
      child.on("exit", (code: number | null) => handler(code));
    },
  };
}

/**
 * Start one gateway and resolve once it reports `ready`.
 *
 * A gateway that never reports back rejects, so the supervisor's health probe
 * and this handshake are two independent guards against a silently dead
 * process.
 */
export function createGatewayStarter(options: {
  entry: string;
  log: SupervisorLogger;
  readyTimeoutMs?: number;
}): StartGateway {
  const readyTimeoutMs = options.readyTimeoutMs ?? 15_000;
  return async (input: StartGatewayInput) => {
    const child =
      (await spawnUtilityProcess(options.entry, input.provider, options.log)) ??
      spawnForkedChild(options.entry, options.log);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("in-app gateway did not report ready"));
      }, readyTimeoutMs);
      child.onMessage((message) => {
        if (message.type === "ready") {
          clearTimeout(timer);
          resolve();
        } else if (message.type === "error") {
          clearTimeout(timer);
          reject(new Error(String(message.message ?? "in-app gateway failed to start")));
        }
      });
      child.onExit((code) => {
        clearTimeout(timer);
        reject(new Error(`in-app gateway exited during start (${String(code)})`));
      });
      child.post({ type: "start", port: input.port, key: input.apiKey });
    });
    return {
      stop: async () => {
        try {
          child.post({ type: "stop" });
        } catch {
          // Already gone.
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
        try {
          child.kill();
        } catch {
          // Already exited.
        }
      },
    };
  };
}
