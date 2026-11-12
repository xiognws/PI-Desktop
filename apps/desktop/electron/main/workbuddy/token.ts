/**
 * Acquiring the WorkBuddy access token from the running desktop app.
 *
 * The app seals its token in its own envelope, so the only supported way to
 * obtain one without re-implementing that crypto is to ask the app's live
 * renderer: attach to it over the Chrome DevTools Protocol, hook `fetch` /
 * `XMLHttpRequest` / storage, and read the `Authorization` header the app itself
 * sends. That is what the reference gateway does by hand; this module does it as
 * part of the entry's startup.
 *
 * Attaching needs a debugging port, and the app only opens one when it is
 * launched with the flag — so the flow is: attach if a port is already open,
 * otherwise restart the app with the port, harvest, then restart it again
 * *without* the port so no debugging surface outlives the harvest.
 *
 * Nothing here reads the app's encrypted files, and the token is never logged.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { workBuddyExecutables, type WorkBuddyEnvironment } from "./paths.ts";

/** DevTools port the app is asked to open. Loopback only. */
const DEFAULT_DEBUG_PORT = 9222;
/** Node inspector port for the app's main process; optional (fuses may disable it). */
const DEFAULT_INSPECT_PORT = 9229;
/** How long the app is given to expose its debugging port after a restart. */
const PORT_READY_TIMEOUT_MS = 30_000;
/** How long to watch the app's own traffic for an `Authorization` header. */
const DEFAULT_HARVEST_TIMEOUT_MS = 90_000;
/** Poll interval while watching. */
const POLL_INTERVAL_MS = 1_500;

export type CdpTarget = {
  type?: string;
  title?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
};

export type CdpConnection = {
  send: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  close: () => void;
};

export type TokenCandidate = { token: string; source: string };

export type AcquiredToken = {
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds, from the token's own `exp`. */
  expiresAt: number;
  /** Whether an already-open debugging port was reused. */
  source: "attach" | "launch";
};

export type TokenAcquisitionDeps = {
  environment: WorkBuddyEnvironment;
  /** Explicit executable (tests, or a non-standard install). */
  executable?: string;
  debugPort?: number;
  inspectPort?: number;
  harvestTimeoutMs?: number;
  /** How long the app is given to open its debugging port after a restart. */
  portReadyTimeoutMs?: number;
  log?: (event: Record<string, unknown>) => void;
  /** Injected I/O so the orchestration stays testable. */
  listTargets?: (port: number) => Promise<CdpTarget[]>;
  connect?: (webSocketDebuggerUrl: string) => Promise<CdpConnection>;
  spawnApp?: (executable: string, args: readonly string[], env: Record<string, string>) => void;
  killApp?: () => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  /** Leave the app running in debug mode (tests only; production restores it). */
  keepDebugInstance?: boolean;
};

/** Decoded JWT payload, or null when the string is not a JWT. */
export function parseJwtClaims(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const json = Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64")
      .toString("utf8");
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Split harvested strings into the access token and, when present, the refresh
 * token.
 *
 * WorkBuddy labels its JWTs by `typ`: `Bearer` is the access token,
 * `Offline` is the refresh token. When no label matches, the candidate with the
 * latest `exp` wins — an unlabelled token that outlives the others is the one
 * worth using.
 */
export function pickTokens(candidates: readonly TokenCandidate[]): {
  accessToken?: string;
  refreshToken?: string;
} {
  const decoded = candidates
    .filter((candidate) => typeof candidate.token === "string" && candidate.token.length >= 40)
    .map((candidate) => {
      const claims = parseJwtClaims(candidate.token);
      return {
        token: candidate.token,
        typ: typeof claims?.typ === "string" ? claims.typ : "",
        exp: typeof claims?.exp === "number" ? claims.exp : 0,
      };
    });
  const access =
    decoded
      .filter((entry) => entry.typ === "Bearer")
      .sort((left, right) => right.exp - left.exp)[0] ??
    decoded.slice().sort((left, right) => right.exp - left.exp)[0];
  const refresh = decoded.find((entry) => entry.typ === "Offline");
  return {
    ...(access ? { accessToken: access.token } : {}),
    ...(refresh ? { refreshToken: refresh.token } : {}),
  };
}

/** Every place the token can be found in the shell that ships with the app. */
const CANDIDATE_PATTERN = String.raw`eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}`;

/**
 * Renderer-side hook: collect JWTs already in storage and every `Authorization`
 * header the app attaches from now on. Idempotent.
 */
export function rendererHookExpression(): string {
  return String.raw`(() => {
  const pattern = /${CANDIDATE_PATTERN}/g;
  const push = (value) => {
    try {
      const text = String(value || '').replace(/^Bearer\s+/i, '');
      if (text.length > 40) (window.__piWbTokens = window.__piWbTokens || new Set()).add(text);
    } catch (error) {}
  };
  try {
    for (const store of [localStorage, sessionStorage]) {
      for (let i = 0; i < store.length; i++) {
        const value = store.getItem(store.key(i)) || '';
        const hits = value.match(pattern);
        if (hits) hits.forEach(push);
      }
    }
  } catch (error) {}
  try {
    if (!window.fetch.__piWbHooked) {
      const original = window.fetch;
      window.fetch = function (...args) {
        try {
          const headers = args[1] && args[1].headers;
          if (headers) {
            const get = (name) => (headers instanceof Headers ? headers.get(name) : (headers[name] !== undefined ? headers[name] : headers[String(name).toLowerCase()]));
            const value = get('authorization') || get('Authorization');
            if (value) push(value);
          }
        } catch (error) {}
        return original.apply(this, args);
      };
      window.fetch.__piWbHooked = 1;
    }
    if (!XMLHttpRequest.prototype.setRequestHeader.__piWbHooked) {
      const original = XMLHttpRequest.prototype.setRequestHeader;
      XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
        try { if (/^authorization$/i.test(name)) push(value); } catch (error) {}
        return original.apply(this, arguments);
      };
      XMLHttpRequest.prototype.setRequestHeader.__piWbHooked = 1;
    }
  } catch (error) {}
  return 'hooked';
})()`;
}

/** Read back what the renderer hook collected. */
export function rendererReadExpression(): string {
  return String.raw`(() => Array.from(window.__piWbTokens || []))()`;
}

/**
 * Ask the renderer's own preload bridge for the token, for the case where the
 * app makes no request while we are watching. Reads only what already exists on
 * `window`; a missing bridge is not an error.
 */
export function bridgeGetterExpression(): string {
  return String.raw`(async () => {
  const names = ['getAuth', 'getAuthState', 'getToken', 'getAccessToken', 'getSession', 'auth'];
  const out = [];
  const keys = Object.keys(window).filter((key) => /wb|buddy|electron|desktop|bridge|host|ipc|api/i.test(key));
  for (const key of keys) {
    let holder;
    try { holder = window[key]; } catch (error) { continue; }
    if (!holder || (typeof holder !== 'object' && typeof holder !== 'function')) continue;
    for (const name of names) {
      let fn;
      try { fn = holder[name]; } catch (error) { continue; }
      if (typeof fn !== 'function') continue;
      try {
        const value = await fn.call(holder);
        const text = typeof value === 'string' ? value : JSON.stringify(value || null);
        if (text) out.push(text);
      } catch (error) {}
    }
  }
  return out;
})()`;
}

/** Hook the main process's HTTPS client; Electron main is CommonJS. */
export function mainHookExpression(): string {
  return String.raw`(() => {
  try {
    globalThis.__piWbTokens = globalThis.__piWbTokens || new Set();
    const add = (value) => {
      try {
        const text = String(value || '').replace(/^Bearer\s+/i, '');
        if (text.length > 40) globalThis.__piWbTokens.add(text);
      } catch (error) {}
    };
    const https = require('https');
    for (const name of ['request', 'get']) {
      if (https[name].__piWbHooked) continue;
      const original = https[name];
      https[name] = function (...args) {
        try {
          const options = args[0] || {};
          const headers = options.headers || {};
          add(headers.Authorization || headers.authorization);
        } catch (error) {}
        return original.apply(this, args);
      };
      https[name].__piWbHooked = 1;
    }
    return 'hooked';
  } catch (error) {
    return 'unavailable: ' + error.message;
  }
})()`;
}

export function mainReadExpression(): string {
  return String.raw`(() => Array.from(globalThis.__piWbTokens || []))()`;
}

/**
 * First executable that exists, honoring an explicit override.
 *
 * An explicit `override` is taken as given — it is how a test, or a caller that
 * already resolved the path, states the answer — while the environment variable
 * and the discovered candidates must actually exist on disk.
 */
export function findWorkBuddyExecutable(
  environment: WorkBuddyEnvironment,
  override?: string,
): string | undefined {
  if (override) return override;
  const envOverride = process.env.WORKBUDDY_EXE;
  if (envOverride && existsSync(envOverride)) return envOverride;
  const candidates = environment.executables ?? workBuddyExecutables(environment);
  return candidates.find((candidate) => existsSync(candidate));
}

/** Debugging targets an Electron app exposes on a port. */
export async function listDebugTargets(port: number): Promise<CdpTarget[]> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
      signal: AbortSignal.timeout(1_500),
    });
    if (!response.ok) return [];
    const parsed = (await response.json()) as unknown;
    return Array.isArray(parsed) ? (parsed as CdpTarget[]) : [];
  } catch {
    return [];
  }
}

/** Minimal CDP client over the runtime's WebSocket. */
export async function connectCdp(webSocketDebuggerUrl: string): Promise<CdpConnection> {
  const socket = new WebSocket(webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () => reject(new Error("devtools connection failed"));
    setTimeout(() => reject(new Error("devtools connection timed out")), 5_000);
  });
  let nextId = 0;
  const pending = new Map<number, (message: Record<string, unknown>) => void>();
  socket.onmessage = (event: MessageEvent) => {
    try {
      const message = JSON.parse(String(event.data)) as Record<string, unknown>;
      const id = typeof message.id === "number" ? message.id : 0;
      const resolve = pending.get(id);
      if (resolve) {
        pending.delete(id);
        resolve(message);
      }
    } catch {
      // A frame we cannot parse is not worth failing the harvest over.
    }
  };
  return {
    send: (method, params = {}) =>
      new Promise((resolve) => {
        const id = ++nextId;
        pending.set(id, resolve);
        socket.send(JSON.stringify({ id, method, params }));
      }),
    close: () => {
      try {
        socket.close();
      } catch {
        // closing twice is fine
      }
    },
  };
}

/** Evaluate in a page (or main) context and return the value. */
async function evaluate(connection: CdpConnection, expression: string): Promise<unknown> {
  const reply = await connection.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
    timeout: 5_000,
  });
  const result = reply.result as
    | { result?: { value?: unknown }; exceptionDetails?: { text?: string } }
    | undefined;
  if (!result || result.exceptionDetails) return undefined;
  return result.result?.value;
}

/**
 * Restart the app behind a debugging port. The single-instance lock means a
 * second launch is a no-op, so the running instance has to go first.
 */
async function restartWithDebugPort(input: {
  executable: string;
  debugPort: number;
  inspectPort: number;
  portReadyTimeoutMs: number;
  env: WorkBuddyEnvironment;
  listTargets: (port: number) => Promise<CdpTarget[]>;
  killApp: () => Promise<boolean>;
  spawnApp: (executable: string, args: readonly string[], env: Record<string, string>) => void;
  sleep: (ms: number) => Promise<void>;
  log: (event: Record<string, unknown>) => void;
}): Promise<{ ready: boolean; wasRunning: boolean }> {
  const wasRunning = await input.killApp();
  input.log({ event: "workbuddy_restart", step: "kill", wasRunning });
  // A closed app is not a failure: there is simply nothing to stop.
  if (wasRunning) await input.sleep(2_500);
  input.spawnApp(input.executable, [
    `--remote-debugging-port=${input.debugPort}`,
    `--inspect=${input.inspectPort}`,
  ], {
    WORKBUDDY_REMOTE_DEBUGGING_PORT: String(input.debugPort),
    WORKBUDDY_DEBUG: "1",
  });
  const deadline = Date.now() + input.portReadyTimeoutMs;
  while (Date.now() < deadline) {
    await input.sleep(700);
    const targets = await input.listTargets(input.debugPort);
    if (targets.some((target) => target.webSocketDebuggerUrl)) {
      return { ready: true, wasRunning };
    }
  }
  input.log({ event: "workbuddy_restart", step: "port-timeout" });
  return { ready: false, wasRunning };
}

function killWorkBuddyProcess(): Promise<boolean> {
  return new Promise((resolve) => {
    if (process.platform !== "win32") {
      const killer = spawn("pkill", ["-f", "WorkBuddy"], { stdio: "ignore" });
      killer.on("exit", (code) => resolve(code === 0));
      killer.on("error", () => resolve(false));
      return;
    }
    const killer = spawn("taskkill", ["/IM", "WorkBuddy.exe", "/F"], { stdio: "ignore" });
    killer.on("exit", (code) => resolve(code === 0));
    killer.on("error", () => resolve(false));
  });
}

function spawnDetached(executable: string, args: readonly string[], env: Record<string, string>): void {
  const child = spawn(executable, [...args], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, ...env },
  });
  child.unref();
}

/**
 * Harvest the access token from the desktop app.
 *
 * Resolves with the token, or throws with a message that says which step failed —
 * "no debugging port", "no request observed", "no token in the store" are
 * different problems and only the middle one needs the user to use the app.
 */
export async function acquireWorkBuddyToken(
  deps: TokenAcquisitionDeps,
): Promise<AcquiredToken> {
  const log = deps.log ?? (() => {});
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const listTargets = deps.listTargets ?? listDebugTargets;
  const connect = deps.connect ?? connectCdp;
  const killApp = deps.killApp ?? killWorkBuddyProcess;
  const spawnApp = deps.spawnApp ?? spawnDetached;
  const debugPort = deps.debugPort ?? DEFAULT_DEBUG_PORT;
  const inspectPort = deps.inspectPort ?? DEFAULT_INSPECT_PORT;
  const harvestTimeoutMs = deps.harvestTimeoutMs ?? DEFAULT_HARVEST_TIMEOUT_MS;
  const portReadyTimeoutMs = deps.portReadyTimeoutMs ?? PORT_READY_TIMEOUT_MS;

  const executable = findWorkBuddyExecutable(deps.environment, deps.executable);
  if (!executable) throw new Error("WorkBuddy executable was not found on this machine");

  let source: AcquiredToken["source"] = "attach";
  /** True when the app was running before the harvest and must come back. */
  let relaunchAfterwards = false;
  let targets = await listTargets(debugPort);
  if (!targets.some((target) => target.webSocketDebuggerUrl)) {
    source = "launch";
    const restart = await restartWithDebugPort({
      executable,
      debugPort,
      inspectPort,
      portReadyTimeoutMs,
      env: deps.environment,
      listTargets,
      killApp,
      spawnApp,
      sleep,
      log,
    });
    if (!restart.ready) {
      throw new Error(
        "WorkBuddy did not expose a DevTools port; the app may be running with higher privileges",
      );
    }
    relaunchAfterwards = restart.wasRunning;
    targets = await listTargets(debugPort);
  }

  const found = new Map<string, string>();
  const connections: CdpConnection[] = [];
  const pageTargets = targets.filter(
    (target) => target.type === "page" && target.webSocketDebuggerUrl,
  );
  if (!pageTargets.length) throw new Error("WorkBuddy exposed no page target to attach to");

  for (const target of pageTargets) {
    try {
      const connection = await connect(target.webSocketDebuggerUrl as string);
      await connection.send("Runtime.enable");
      await evaluate(connection, rendererHookExpression());
      const existing = await evaluate(connection, rendererReadExpression());
      if (Array.isArray(existing)) {
        for (const token of existing) if (typeof token === "string") found.set(token, "renderer");
      }
      connections.push(connection);
    } catch (error) {
      log({ event: "workbuddy_cdp_page_failed", message: (error as Error).message });
    }
  }

  // The main process inspector is a bonus: it sees requests the renderer's
  // preload makes over Node's HTTPS client.
  let mainConnection: CdpConnection | null = null;
  try {
    const mainTargets = await listTargets(inspectPort);
    const mainTarget = mainTargets.find((target) => target.webSocketDebuggerUrl);
    if (mainTarget) {
      mainConnection = await connect(mainTarget.webSocketDebuggerUrl as string);
      await mainConnection.send("Runtime.enable");
      const hooked = await evaluate(mainConnection, mainHookExpression());
      log({ event: "workbuddy_main_hook", result: String(hooked) });
      connections.push(mainConnection);
    }
  } catch (error) {
    log({ event: "workbuddy_main_hook_failed", message: (error as Error).message });
  }

  const deadline = Date.now() + harvestTimeoutMs;
  let bridgeAsked = false;
  while (Date.now() < deadline) {
    for (const connection of connections) {
      const values = await evaluate(connection, rendererReadExpression()).catch(() => undefined);
      const mainValues = connection === mainConnection
        ? await evaluate(connection, mainReadExpression()).catch(() => undefined)
        : values;
      for (const list of [values, mainValues]) {
        if (!Array.isArray(list)) continue;
        for (const token of list) if (typeof token === "string") found.set(token, "traffic");
      }
    }
    if (found.size) break;
    if (!bridgeAsked) {
      // One shot at the app's own bridge: if it can hand over the token there is
      // no reason to wait for a request the user may never trigger.
      bridgeAsked = true;
      for (const connection of connections) {
        const values = await evaluate(connection, bridgeGetterExpression()).catch(() => undefined);
        if (!Array.isArray(values)) continue;
        for (const value of values) {
          for (const token of String(value).match(
            new RegExp(CANDIDATE_PATTERN, "g"),
          ) ?? []) {
            found.set(token, "bridge");
          }
        }
      }
      if (found.size) break;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  for (const connection of connections) connection.close();

  const candidates: TokenCandidate[] = [...found.entries()].map(([token, tokenSource]) => ({
    token,
    source: tokenSource,
  }));
  const picked = pickTokens(candidates);
  if (!picked.accessToken) {
    if (source === "launch" && !deps.keepDebugInstance) {
      await killApp();
      if (relaunchAfterwards) spawnApp(executable, [], {});
    }
    throw new Error("no WorkBuddy token was observed; use the app once and try again");
  }

  // Hand the app back exactly as it was found: no debugging port outlives the
  // harvest, because an open DevTools port is full control of the app.
  if (source === "launch" && !deps.keepDebugInstance) {
    await killApp();
    if (relaunchAfterwards) {
      await sleep(1_500);
      spawnApp(executable, [], {});
      log({ event: "workbuddy_restore", step: "relaunched" });
    } else {
      log({ event: "workbuddy_restore", step: "closed" });
    }
  }

  const claims = parseJwtClaims(picked.accessToken);
  const exp = typeof claims?.exp === "number" ? claims.exp * 1000 : Date.now() + 25 * 60 * 1000;
  log({
    event: "workbuddy_token_acquired",
    source,
    expiresAt: new Date(exp).toISOString(),
    hasRefresh: Boolean(picked.refreshToken),
  });
  return {
    accessToken: picked.accessToken,
    ...(picked.refreshToken ? { refreshToken: picked.refreshToken } : {}),
    expiresAt: exp,
    source,
  };
}
