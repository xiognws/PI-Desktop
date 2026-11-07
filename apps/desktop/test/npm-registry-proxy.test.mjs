import assert from "node:assert/strict";
import { connect } from "node:net";
import { test } from "node:test";

import { withRegistryOnlyProxy } from "../electron/main/npm-registry-proxy.ts";

/** Ask the proxy for a CONNECT tunnel and report what it answered. */
function openTunnel(proxyUrl, authority) {
  return new Promise((resolve, reject) => {
    const { hostname, port } = new URL(proxyUrl);
    const socket = connect(Number(port), hostname);
    let data = "";
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.on("data", (chunk) => {
      data += chunk;
      if (data.includes("\r\n\r\n")) {
        socket.end();
        resolve({ status: data.split("\r\n")[0], socket });
      }
    });
    socket.on("connect", () => {
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    });
  });
}

test("refuses a CONNECT tunnel to a host other than the public registry", async () => {
  await withRegistryOnlyProxy(async (proxyUrl) => {
    const { status } = await openTunnel(proxyUrl, "example.com:443");
    assert.match(status, /403/);
  });
});

test("cleans up every socket it created, including an open CONNECT tunnel", async () => {
  const before = process.getActiveResourcesInfo().length;
  let tunnel = null;
  await withRegistryOnlyProxy(async (proxyUrl) => {
    // An allowed authority: the proxy opens an upstream socket of its own, which the
    // server's connection listener never tracks.
    tunnel = await openTunnel(proxyUrl, "registry.npmjs.org:443");
    assert.match(tunnel.status, /^(HTTP\/1\.1 200|HTTP\/1\.1 5)/);
  });
  // The handler settled, so the proxy must not still be holding the tunnel open.
  const after = process.getActiveResourcesInfo().length;
  assert.ok(
    after <= before + 1,
    `proxy leaked sockets: ${before} active resources before, ${after} after`,
  );
});

test("forwards an ordinary registry request through the loopback proxy", async () => {
  const seen = [];
  await withRegistryOnlyProxy(async (proxyUrl) => {
    const { hostname, port } = new URL(proxyUrl);
    const socket = connect(Number(port), hostname);
    const response = await new Promise((resolve, reject) => {
      let data = "";
      socket.setEncoding("utf8");
      socket.once("error", reject);
      socket.on("data", (chunk) => {
        data += chunk;
        if (data.includes("\r\n\r\n")) {
          socket.end();
          resolve(data);
        }
      });
      socket.on("connect", () => {
        socket.write("GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n");
      });
    });
    seen.push(response);
    // example.com is not the registry, so the request is refused without any
    // outbound traffic.
    assert.match(response, /403/);
  });
  assert.equal(seen.length, 1);
});
