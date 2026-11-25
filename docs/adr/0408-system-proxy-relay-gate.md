# ADR 0408: The system proxy relay starts only when the machine routes

- **Status:** Accepted
- **Date:** 2026-11-25
- **Related:** 0177 (network proxy ownership, D340), 0406 (Windows runs commands in Git Bash by default), 0407 (bundled plugins stay plugins)

## Context

Chromium's proxy resolution is only reachable from Electron, so host-core's
children cannot ask the machine how to reach the network. The relay exists to
answer for them: a loopback SOCKS5 listener in the main process resolves each URL
through `session.resolveProxy` and tunnels accordingly, and host-core is told
about it once at boot through `network.configureSystemProxyRelay`.

That is the right mechanism when the machine actually uses a proxy. On a machine
that resolves `DIRECT` it bought nothing, and it cost three things on every
launch: a resident loopback listener, a boot-time rewrite of the children's proxy
configuration, and a process tree that an endpoint behaviour engine reads as an
application installing a local proxy for other processes. In this deployment the
product's binaries have already been quarantined once under
`PDM:Trojan.Win32.Generic`, and the work that followed removed exactly this class
of shape: a self-copied tool runner, inline PowerShell, a stdin-reading
interpreter, a detached proxy daemon shipped as a plugin.

## Decision

`apps/desktop/electron/main/network-proxy-gate.ts` decides whether to start the
relay, as a pure function of two inputs:

- the answer `session.resolveProxy` gives for a probe URL - only an empty answer
  or one containing nothing but `DIRECT` means unproxied, so any `PROXY`,
  `SOCKS5` or `HTTPS` token anywhere in the list keeps the relay;
- the proxy environment (`HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`, either case).
  A non-blank value counts on its own, because a user who exported one asked for
  that route even when the operating system says `DIRECT`.

`ensureSystemProxyRelay()` consults the gate and answers `""` when no relay was
started. `runtime/host.ts` then **skips** `network.configureSystemProxyRelay`
rather than sending an empty URL, because host-core rejects one - sending it would
fail the handshake and abort host startup.

Two deliberate exceptions:

- `ensureSystemProxyRelay({ force: true })` starts the relay regardless. The
  provider-metadata retry borrows it to avoid a client-certificate prompt and has
  no fallback without it.
- A resolution that throws counts as "assume a proxy". Losing proxy support is a
  worse failure than one listener, and the relay already degrades to a direct
  tunnel per URL when a later resolution fails.

## Consequences

- A machine that routes `DIRECT` - the common case for a desktop app on a home or
  small-office network - starts no listener and rewrites no child proxy
  configuration. A machine behind a proxy behaves exactly as before: the relay
  resolves per request, so PAC rules and bypass lists keep working once it runs.
- The gate probes **one** URL at boot (`https://example.com/`) to decide. A PAC
  script that routes that host differently from the hosts the agent actually
  talks to could skip a relay it would have wanted. This is accepted for now: a
  PAC that distinguishes hosts is the unusual case, any proxy environment
  variable overrides the decision, and the forced path exists for the one caller
  that cannot work without a relay. A future change can probe with the configured
  provider base URL once that value is available at boot.
- The decision is testable without Electron, which is why it lives in its own
  module rather than inside `network-proxy.ts` (`network-proxy-gate.test.mjs`
  pins the DIRECT, routed, environment and failing-resolution cases).
- `currentSystemProxyRelayUrl()` keeps answering `null` until a relay exists, so
  the sidecar's reported state stays honest instead of advertising a URL that was
  never bound.
