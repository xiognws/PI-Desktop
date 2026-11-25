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
