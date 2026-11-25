/**
 * Decide whether the loopback system-proxy relay is worth starting.
 *
 * The relay exists so host-core's children - and the provider fetch that avoids a
 * client certificate - can use Chromium's proxy resolution, which only Electron
 * can answer. On a machine that resolves `DIRECT`, starting it buys nothing and
 * costs a resident loopback listener plus a boot-time rewrite of the children's
 * proxy: an application that is not configured to use a proxy installing a local
 * one is exactly the shape a behavioural endpoint engine scores as a hijack.
 *
 * The decision is a pure function of the resolution answer and the environment so
 * it can be tested without Electron, and so the relay is the only thing that has
 * to know about `session`.
 */

/** Proxy variables Chromium, curl and Node all honour, upper and lower case. */
const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
] as const;

/** `DIRECT` is the only token that means "no proxy"; everything else routes. */
const DIRECT_TOKEN = "DIRECT";

/**
 * Does this machine route through a proxy?
 *
 * `resolved` is what `session.resolveProxy` answers: a PAC-style list such as
 * `DIRECT`, `PROXY host:port`, `SOCKS5 host:port` or `DIRECT; PROXY host:port`.
 * Only an empty list or one that contains nothing but `DIRECT` means the traffic
 * leaves unproxied, so any other token anywhere in the list keeps the relay.
 *
 * A proxy variable counts on its own: a user who exported `HTTPS_PROXY` is asking
 * for that route even when the operating system's proxy settings say `DIRECT`,
 * and blank values (`HTTPS_PROXY="   "`) mean "unset", not "proxied to nothing".
 */
export function proxyInUse(
  resolved: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  for (const key of PROXY_ENV_KEYS) {
    const value = env[key];
    if (typeof value === "string" && value.trim() !== "") return true;
  }
  const tokens = resolved
    .split(";")
    .map((token) => token.trim())
    .filter((token) => token !== "");
  return tokens.some((token) => {
    const [kind] = token.split(/\s+/);
    return kind.toUpperCase() !== DIRECT_TOKEN;
  });
}

/**
 * Start the relay only when the machine routes somewhere.
 *
 * `resolve` is passed in rather than imported so the caller owns the Electron
 * dependency, and `start` is the only side effect in this module. An answer that
 * cannot be obtained is treated as "assume a proxy": losing proxy support is a
 * harder failure than one loopback listener, and the relay itself falls back to a
 * direct tunnel per URL when the resolution fails later.
 *
 * Returns the relay URL, or `""` when no relay was started - callers must treat
 * that as "no system proxy route" and not as an error.
 */
export type ProxyGateOptions = {
  /**
   * How long a caller may wait for the route before it carries on without one.
   *
   * Chromium answers `resolveProxy` from the OS configuration, and a machine with
   * WPAD or a PAC script configured can sit there for seconds — DHCP and DNS
   * probes — before it answers at all. `0` (the default) waits, which is right for
   * a caller that has nothing else to do; boot is not such a caller.
   */
  timeoutMs?: number;
  /** Called when a late answer turns out to need the relay after all. */
  onLate?: (relayUrl: string) => void;
};

/**
 * The route answer, or `"timeout"` when the caller's deadline wins.
 *
 * The losing promise is not cancelled: `resolveProxy` has no cancellation, and the
 * caller decides what to do with an answer that arrives late.
 */
async function resolveWithin(
  resolve: () => Promise<string>,
  timeoutMs: number,
): Promise<{ ok: true; value: string } | { ok: false } | "timeout"> {
  if (timeoutMs <= 0) {
    try {
      return { ok: true, value: await resolve() };
    } catch {
      return { ok: false };
    }
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((settle) => {
    timer = setTimeout(() => settle("timeout"), timeoutMs);
    // Never keep the process alive for a probe nobody is waiting on.
    timer.unref?.();
  });
  const answer = resolve().then(
    (value) => ({ ok: true as const, value }),
    () => ({ ok: false as const }),
  );
  try {
    return await Promise.race([answer, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function systemProxyRelayIfNeeded(
  resolve: () => Promise<string>,
  start: () => Promise<string>,
  env: Record<string, string | undefined> = process.env,
  options: ProxyGateOptions = {},
): Promise<string> {
  const timeoutMs = Math.max(0, options.timeoutMs ?? 0);
  if (timeoutMs > 0) {
    const answer = await resolveWithin(resolve, timeoutMs);
    if (answer === "timeout") {
      // Boot carries on without a relay and the relay is applied when the route
      // does answer: a machine that really routes keeps proxy support, and one
      // that does not pays nothing for the probe.
      void resolve()
        .then(async (resolved) => (proxyInUse(resolved, env) ? await start() : ""))
        .then((relayUrl) => {
          if (relayUrl) options.onLate?.(relayUrl);
        })
        .catch(() => undefined);
      return "";
    }
    if (!answer.ok) return start();
    if (!proxyInUse(answer.value, env)) return "";
    return start();
  }
  const answer = await resolveWithin(resolve, 0);
  if (answer === "timeout" || !answer.ok) return start();
  if (!proxyInUse(answer.value, env)) return "";
  return start();
}
