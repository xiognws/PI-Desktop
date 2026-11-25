import assert from "node:assert/strict";
import test from "node:test";

const { proxyInUse, systemProxyRelayIfNeeded } = await import(
  "../electron/main/network-proxy-gate.ts"
);

/*
 * The relay exists so host-core's children can use Electron's proxy resolution.
 * Starting it when the machine resolves DIRECT buys nothing and costs a loopback
 * listener plus a "configure the children's proxy" call at boot - the shape
 * behavioural AV engines score as a hijack.
 */

test("a DIRECT answer needs no relay", () => {
  assert.equal(proxyInUse("DIRECT", {}), false);
  assert.equal(proxyInUse(" direct ; ", {}), false);
  assert.equal(proxyInUse("", {}), false);
});

test("any routed answer needs the relay", () => {
  assert.equal(proxyInUse("PROXY 10.0.0.1:8080", {}), true);
  assert.equal(proxyInUse("DIRECT; PROXY corp-proxy:3128", {}), true);
  assert.equal(proxyInUse("SOCKS5 127.0.0.1:1080", {}), true);
});

test("proxy environment variables count even when the system answer is DIRECT", () => {
  assert.equal(proxyInUse("DIRECT", { HTTPS_PROXY: "http://proxy:8080" }), true);
  assert.equal(proxyInUse("DIRECT", { all_proxy: "socks5://127.0.0.1:1080" }), true);
  assert.equal(proxyInUse("DIRECT", { HTTPS_PROXY: "   " }), false);
});

test("the relay starts only for a machine that routes through a proxy", async () => {
  let started = 0;
  const start = async () => {
    started += 1;
    return "http://127.0.0.1:9/relay";
  };

  const direct = await systemProxyRelayIfNeeded(async () => "DIRECT", start, {});
  assert.equal(direct, "");
  assert.equal(started, 0, "no listener at boot when the answer is DIRECT");

  const routed = await systemProxyRelayIfNeeded(async () => "PROXY p:1", start, {});
  assert.equal(routed, "http://127.0.0.1:9/relay");
  assert.equal(started, 1);
});

test("an unresolvable proxy answer keeps proxy support instead of dropping it", async () => {
  let started = 0;
  const url = await systemProxyRelayIfNeeded(
    async () => {
      throw new Error("resolveProxy is not ready");
    },
    async () => {
      started += 1;
      return "http://127.0.0.1:9/relay";
    },
    {},
  );
  assert.equal(url, "http://127.0.0.1:9/relay");
  assert.equal(started, 1);
});

test("boot stops waiting for a slow route and applies the relay when it lands", async () => {
  // The field case: Chromium asks the OS, a WPAD/PAC machine takes seconds to
  // answer, and the window plus host-core sat behind 7 s of it.
  let started = 0;
  const late = [];
  const startedAt = Date.now();
  const url = await systemProxyRelayIfNeeded(
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      return "PROXY corporate:8080";
    },
    async () => {
      started += 1;
      return "http://127.0.0.1:9/relay";
    },
    {},
    { timeoutMs: 20, onLate: (relayUrl) => late.push(relayUrl) },
  );
  const waited = Date.now() - startedAt;
  assert.equal(url, "", "boot must carry on without a relay");
  assert.ok(waited < 100, `boot waited ${waited} ms for the route`);
  assert.equal(started, 0, "nothing is started while the answer is still out");

  // The answer arrives after boot: the relay starts then, and the caller is told
  // so host-core can hand it to the children it spawns.
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(started, 1);
  assert.deepEqual(late, ["http://127.0.0.1:9/relay"]);
});

test("a deadline that lands on DIRECT starts nothing late", async () => {
  let started = 0;
  const late = [];
  const url = await systemProxyRelayIfNeeded(
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return "DIRECT";
    },
    async () => {
      started += 1;
      return "http://127.0.0.1:9/relay";
    },
    {},
    { timeoutMs: 10, onLate: (relayUrl) => late.push(relayUrl) },
  );
  assert.equal(url, "");
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(started, 0);
  assert.deepEqual(late, []);
});
