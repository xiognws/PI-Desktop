import { describe, expect, it } from "vitest";

import { findPosition, stepFindIndex } from "./transcript-find.js";

describe("stepFindIndex", () => {
  it("starts at the first match when nothing is active and the step goes forward", () => {
    expect(stepFindIndex(-1, 5, 1)).toBe(0);
  });

  it("starts at the last match when nothing is active and the step goes back", () => {
    expect(stepFindIndex(-1, 5, -1)).toBe(4);
  });

  it("wraps forward past the last match", () => {
    expect(stepFindIndex(4, 5, 1)).toBe(0);
  });

  it("wraps backward past the first match", () => {
    expect(stepFindIndex(0, 5, -1)).toBe(4);
  });

  it("advances by more than one step", () => {
    expect(stepFindIndex(1, 5, 3)).toBe(4);
  });

  it("has no position when the query matches nothing", () => {
    expect(stepFindIndex(3, 0, 1)).toBe(-1);
    expect(stepFindIndex(-1, 0, -1)).toBe(-1);
  });
});

describe("findPosition", () => {
  it("reports a 1-based position", () => {
    expect(findPosition(0, 17)).toEqual({ current: 1, total: 17 });
    expect(findPosition(16, 17)).toEqual({ current: 17, total: 17 });
  });

  it("reports zero of zero for an empty result set", () => {
    expect(findPosition(-1, 0)).toEqual({ current: 0, total: 0 });
  });

  it("clamps an index that outlived the match list", () => {
    expect(findPosition(9, 3)).toEqual({ current: 3, total: 3 });
    expect(findPosition(-4, 3)).toEqual({ current: 1, total: 3 });
  });
});
