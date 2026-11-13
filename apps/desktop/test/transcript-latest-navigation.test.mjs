import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createTranscriptLatestNavigation } = await import("../src/lib/transcript-latest-navigation.ts");

function fixture(reduced = false) {
  const box = { scrollTop: 80, scrollHeight: 8000, clientHeight: 600 };
  const frames = new Map();
  const positions = [];
  let now = 0;
  let id = 0;
  let arrivals = 0;
  const navigation = createTranscriptLatestNavigation({
    geometry: () => box,
    move: top => { box.scrollTop = top; positions.push(top); },
    request: callback => { frames.set(++id, callback); return id; },
    cancel: id => frames.delete(id),
    now: () => now,
    reducedMotion: () => reduced,
  });
  const advance = () => {
    now += 16;
    const batch = [...frames.values()];
    frames.clear();
    for (const frame of batch) frame(now);
  };
  const moving = () => navigation.phase() === "moving";
  const finish = () => { for (let n = 0; moving() && n < 60; n++) advance(); };
  return { box, navigation, positions, frames, advance, finish, moving,
    start: () => navigation.start(() => arrivals++), arrivals: () => arrivals,
    reveal: () => navigation.start(), resumed: () => arrivals };
}

test("latest moves continuously to bottom before committing the new view", () => {
  const f = fixture();
  f.start();
  assert.equal(f.box.scrollTop, 80);
  f.advance();
  assert(f.box.scrollTop > 80 && f.box.scrollTop < 7400);
  assert.equal(f.arrivals(), 0);
  f.finish();
  assert(f.positions.length >= 8);
  assert(f.positions.every((top, i) => i === 0 || top >= f.positions[i - 1]));
  assert.equal(f.box.scrollTop, 7400);
  assert.equal(f.arrivals(), 1);
  assert.equal(f.frames.size, 0);
});

test("late stream growth retargets the trip without reversing or losing bottom", () => {
  const f = fixture();
  f.start(); f.advance();
  f.box.scrollHeight += 800;
  f.finish();
  assert(f.positions.every((top, i) => i === 0 || top >= f.positions[i - 1]));
  assert.equal(f.box.scrollTop, 8200);
  assert.equal(f.arrivals(), 1);
});

test("reader interruption retires every queued frame without committing latest", () => {
  const f = fixture();
  f.start(); f.advance();
  const top = f.box.scrollTop;
  f.navigation.cancel(); f.advance();
  assert.equal(f.box.scrollTop, top);
  assert.equal(f.arrivals(), 0);
  assert.equal(f.moving(), false);
  assert.equal(f.frames.size, 0);
});

test("pane hide commits accepted latest intent once without finishing an invisible animation", () => {
  const f = fixture();
  f.start(); f.advance(); f.navigation.cancel(true); f.navigation.cancel(true); f.advance();
  assert.equal(f.arrivals(), 1);
  assert.equal(f.frames.size, 0);
});

test("repeated navigation cannot commit an obsolete trip", () => {
  const f = fixture();
  f.start(); f.advance(); f.start(); f.finish();
  assert.equal(f.arrivals(), 1);
});

test("reduced motion reaches bottom synchronously", () => {
  const f = fixture(true);
  f.start();
  assert.equal(f.box.scrollTop, 7400);
  assert.equal(f.arrivals(), 1);
  assert.equal(f.frames.size, 0);
});

test("a hide while in flight carries the accepted latest in one step", () => {
  const f = fixture();
  f.start(); f.advance();
  assert.equal(f.navigation.landed(), true);
  // No frame runs inside a hidden box, so the intent is carried out where the
  // trip was travelling: the reader lands on the newest turn, not on the
  // offset the animation happened to stop at.
  assert.equal(f.box.scrollTop, 7400);
  assert.equal(f.arrivals(), 1);
  assert.equal(f.frames.size, 0);
  assert.equal(f.navigation.phase(), "done");
  // The committed intent is retired, so a second hide carries nothing.
  f.navigation.landed();
  f.navigation.cancel(true);
  assert.equal(f.arrivals(), 1);
});

test("a trip that already reached bottom still commits when the pane hides", () => {
  const f = fixture();
  f.start(); f.finish();
  // The hide lands one layout after the final frame, so nothing is in flight,
  // yet the accepted latest intent must still be carried out.
  f.navigation.cancel(true); f.navigation.cancel(true); f.advance();
  assert.equal(f.arrivals(), 1);
  assert.equal(f.box.scrollTop, 7400);
  assert.equal(f.frames.size, 0);
  // A committed trip is retired, not left claiming the viewport.
  assert.equal(f.navigation.phase(), "idle");
});

test("a landed done trip parks without moving or committing again", () => {
  const f = fixture();
  f.start(); f.finish();
  const settled = f.box.scrollTop;
  // A trip that already arrived owns no intent, so a hide must not run its
  // arrival a second time. The pane keeps the page the reader can still read.
  assert.equal(f.navigation.landed(), false);
  assert.equal(f.box.scrollTop, settled);
  assert.equal(f.arrivals(), 1);
  assert.equal(f.frames.size, 0);
});

test("a reveal after a hidden trip needs no second trip", () => {
  const f = fixture();
  f.start(); f.advance();
  assert.equal(f.navigation.landed(), true);
  // The hide already committed, so the reveal has nothing to revive: it must
  // not start a trip of its own, and the viewport stays on the newest turn.
  f.reveal(); f.finish();
  assert.equal(f.resumed(), 1);
  assert.equal(f.box.scrollTop, 7400);
  assert.equal(f.navigation.phase(), "done");
});

test("an explicit latest after a committed hide commits once for itself", () => {
  const f = fixture();
  f.start(); f.advance();
  f.navigation.landed();
  let explicit = 0;
  f.navigation.start(() => { explicit++; });
  f.finish();
  // The hide already committed, so this trip owes its own arrival and must not
  // revive the retired one.
  assert.equal(explicit, 1);
  assert.equal(f.arrivals(), 1);
  assert.equal(f.navigation.phase(), "done");
});

test("a reader takeover after a hide starts a clean trip", () => {
  const f = fixture();
  f.start(); f.advance();
  f.navigation.landed();
  f.navigation.cancel();
  f.reveal(); f.finish();
  // The hide committed once; the takeover retires everything else, so the
  // reveal's own trip carries no arrival of its own.
  assert.equal(f.resumed(), 1);
  assert.equal(f.box.scrollTop, 7400);
});

test("a landed trip stops blocking the follow scroll", () => {
  const f = fixture();
  f.start(); f.finish();
  assert.equal(f.navigation.phase(), "done");
  assert.equal(f.navigation.landed(), false);
  assert.equal(f.arrivals(), 1);
});
