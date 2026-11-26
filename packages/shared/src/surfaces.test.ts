import { describe, expect, it } from "vitest";
import {
  DEFAULT_SURFACE_ID,
  SURFACE_IDS,
  isSurfaceId,
  resolveSurfaceId,
} from "./surfaces.js";

describe("surface ids", () => {
  it("keeps chat as the home surface", () => {
    expect(DEFAULT_SURFACE_ID).toBe("chat");
    expect(SURFACE_IDS).toContain(DEFAULT_SURFACE_ID);
  });

  it("names the surfaces this build ships", () => {
    expect(SURFACE_IDS).toEqual(["chat", "autotest"]);
  });

  it("accepts every declared id and nothing else", () => {
    for (const id of SURFACE_IDS) expect(isSurfaceId(id)).toBe(true);
    for (const value of ["", "chat ", "Chat", "settings", null, undefined, 7, {}]) {
      expect(isSurfaceId(value)).toBe(false);
    }
  });

  it("falls back to chat for a retired or malformed id", () => {
    expect(resolveSurfaceId("autotest")).toBe("autotest");
    expect(resolveSurfaceId("widgets")).toBe("chat");
    expect(resolveSurfaceId(undefined)).toBe("chat");
    expect(resolveSurfaceId(null)).toBe("chat");
  });
});
