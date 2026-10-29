import { describe, expect, it } from "vitest";
import { HostProcess } from "./host-process.js";

/**
 * A transport that has spawned but not yet answered the handshake, built the
 * way the request-limit test builds one: the prototype without the constructor,
 * so no child process is started.
 */
function bootingHost() {
  const host = Object.assign(Object.create(HostProcess.prototype), {
    closed: false,
    available: true,
    disposed: false,
    handlers: new Set(),
    exitHandlers: new Set(),
    pending: new Map(),
    stdoutReader: undefined,
    lastStderr: "",
    handshakeSettled: false,
    releaseHandshakeGate: null,
    handshakeGate: null,
    child: {
      exitCode: null,
      killed: false,
      stdin: { writable: true, destroyed: false, write() {} },
    },
  }) as HostProcess;
  (host as any).handshakeGate = new Promise<void>((resolve: () => void) => {
    (host as any).releaseHandshakeGate = resolve;
  });
  return host;
}

describe("host handshake gate", () => {
  it("makes a boot-time request wait for the handshake instead of refusing it", async () => {
    const host = bootingHost();
    const reached: string[] = [];
    (host as any).callOnce = async (method: string) => {
      reached.push(method);
      return { ok: true };
    };

    const pending = host.call("session.list");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reached).toEqual([]);

    (host as any).settleHandshakeGate();
    await expect(pending).resolves.toEqual({ ok: true });
    expect(reached).toEqual(["session.list"]);
  });

  it("never gates the handshake itself, which would deadlock every caller", async () => {
    const host = bootingHost();
    const reached: string[] = [];
    (host as any).callOnce = async (method: string) => {
      reached.push(method);
      return { ok: true };
    };

    await expect(host.call("app.handshake", { protocolVersion: 11 })).resolves.toEqual({
      ok: true,
    });
    expect(reached).toEqual(["app.handshake"]);
  });

  it("releases the queued request with the transport error when the host dies first", async () => {
    const host = bootingHost();
    const pending = host.call("session.list");

    (host as any).closeTransport(
      Object.assign(new Error("host-core exited"), { errorCode: "HOST_UNAVAILABLE" }),
    );

    await expect(pending).rejects.toThrow("host-core is unavailable");
  });

  it("settles once, so a later release cannot reopen a gate that already opened", () => {
    const host = bootingHost();
    (host as any).settleHandshakeGate();
    const release = (host as any).releaseHandshakeGate;
    (host as any).settleHandshakeGate();
    expect(release).toBeNull();
    expect((host as any).handshakeSettled).toBe(true);
  });
});
