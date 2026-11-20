import assert from "node:assert/strict";
import test from "node:test";

const { LspServerPool } = await import("../main/lsp/pool.ts");

/*
 * Language servers are long-lived processes that index a workspace.
 *
 * ADR 0401 keeps one per language per session and reuses it across turns; what
 * it did not bound was how long it survives its last query. The pool adds an
 * idle reclaim and a ceiling without ever taking a server out from under a call
 * that is in flight.
 */

function fakeServer(id) {
  return {
    id,
    closed: false,
    shutdowns: 0,
    get isClosed() {
      return this.closed;
    },
    async shutdown() {
      this.shutdowns += 1;
      this.closed = true;
    },
  };
}

function harness(options = {}) {
  const clock = { now: 0 };
  const created = [];
  const pool = new LspServerPool({
    idleMs: 1_000,
    maxLive: 4,
    sweepIntervalMs: 0,
    now: () => clock.now,
    ...options,
  });
  const acquire = async (key) => {
    const server = await pool.acquire(key, async () => {
      const next = fakeServer(`${key}#${created.length + 1}`);
      created.push(next);
      return next;
    });
    return server;
  };
  return { pool, clock, created, acquire };
}

test("reuses one server per key across calls", async () => {
  const { pool, created, acquire } = harness();
  const key = "s1::/repo::typescript";
  const first = await acquire(key);
  const second = await acquire(key);
  assert.equal(first, second);
  assert.equal(created.length, 1, "a second call must not start a second server");
  assert.equal(pool.stats().live, 1);
});

test("reclaims a server that sat idle past the window", async () => {
  const { pool, clock, acquire } = harness();
  const key = "s1::/repo::typescript";
  const server = await acquire(key);

  clock.now = 1_500;
  assert.deepEqual(await pool.sweep(), [key]);
  assert.equal(server.shutdowns, 1);
  assert.equal(pool.stats().live, 0);
});

test("keeps a server that still has a call in flight", async () => {
  const { pool, clock, acquire } = harness();
  const key = "s1::/repo::typescript";
  const server = await acquire(key);

  pool.begin(key);
  clock.now = 60_000;
  assert.deepEqual(await pool.sweep(), [], "a busy server is not idle");
  assert.equal(server.shutdowns, 0);

  pool.end(key);
  clock.now = 90_000;
  assert.deepEqual(await pool.sweep(), [key], "idle time restarts when the call ends");
});

test("a call's own duration does not count as idle time", async () => {
  const { pool, acquire } = harness();
  const key = "s1::/repo::typescript";
  await acquire(key);

  pool.begin(key);
  pool.end(key);
  assert.deepEqual(await pool.sweep(), [], "the just-finished call refreshed the clock");
});

test("holds the ceiling by reclaiming the least recently used idle server", async () => {
  const { pool, clock, acquire } = harness({ maxLive: 2 });
  const first = await acquire("k1");
  clock.now = 10;
  const second = await acquire("k2");
  clock.now = 20;
  const third = await acquire("k3");

  assert.equal(first.shutdowns, 1, "the oldest idle server gave up its slot");
  assert.equal(second.shutdowns, 0);
  assert.equal(third.shutdowns, 0);
  assert.deepEqual(pool.stats().keys, ["k2", "k3"]);
});

test("the ceiling yields instead of killing a server that is serving a call", async () => {
  const { pool, clock, acquire } = harness({ maxLive: 2 });
  await acquire("k1");
  clock.now = 10;
  await acquire("k2");

  pool.begin("k1");
  pool.begin("k2");
  clock.now = 20;
  await acquire("k3");

  assert.equal(pool.stats().live, 3, "an unbounded live count is better than a failed call");
  assert.equal(pool.stats().busy, 2);
});

test("shuts down only the servers of the session that ended", async () => {
  const { pool, acquire } = harness();
  const a = await acquire("s1::/repo::typescript");
  const b = await acquire("s2::/repo::typescript");

  await pool.shutdownSession("s1");
  assert.equal(a.shutdowns, 1);
  assert.equal(b.shutdowns, 0);
  assert.deepEqual(pool.stats().keys, ["s2::/repo::typescript"]);
});

test("replaces a server that closed on its own instead of handing it out", async () => {
  const { pool, created, acquire } = harness();
  const key = "s1::/repo::typescript";
  const first = await acquire(key);
  first.closed = true; // the server crashed / exited

  const second = await acquire(key);
  assert.notEqual(second, first);
  assert.equal(created.length, 2);
  assert.equal(pool.stats().live, 1);
});

test("dispose shuts every server down", async () => {
  const { pool, clock, acquire } = harness({ sweepIntervalMs: 60_000 });
  const a = await acquire("s1::/repo::typescript");
  clock.now = 10;
  const b = await acquire("s2::/repo::python");

  await pool.dispose();
  assert.equal(a.shutdowns, 1);
  assert.equal(b.shutdowns, 1);
  assert.equal(pool.stats().live, 0);
});
