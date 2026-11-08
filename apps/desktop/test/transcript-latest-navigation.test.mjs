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
    start: () => navigation.start(() => arrivals++), arrivals: () => arrivals };
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

test("a trip still in flight can be landed before a pane reveal bottoms", () => {
  const f = fixture();
  f.start(); f.advance();
  const parked = f.box.scrollTop;
  assert.equal(f.navigation.landed(), true);
  // Landing frees the viewport without moving the reader: the pane reveal
  // that follows is the only thing allowed to choose the position.
  assert.equal(f.box.scrollTop, parked);
  assert.equal(f.arrivals(), 0);
  assert.equal(f.moving(), false);
  assert.equal(f.frames.size, 0);
  // Landing twice must not touch an already retired trip.
  assert.equal(f.navigation.landed(), false);
  assert.equal(f.arrivals(), 0);
});

test("a landed trip stops blocking the follow scroll", () => {
  const f = fixture();
  f.start(); f.finish();
  assert.equal(f.navigation.phase(), "done");
  assert.equal(f.navigation.landed(), false);
  assert.equal(f.arrivals(), 1);
});
