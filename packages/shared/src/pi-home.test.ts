import { describe, expect, it } from "vitest";

import {
  PI_HOME_DIR_NAME,
  PI_HOME_ENV,
  piHomeSubdirectory,
  resolveAgentDataHome,
  resolveAgentsHome,
  resolvePiHome,
} from "./pi-home.js";

describe("resolvePiHome", () => {
  it("prefers the root the app published", () => {
    expect(resolvePiHome({ env: { [PI_HOME_ENV]: "D:\\PiWorkspace" }, platform: "win32" })).toBe(
      "D:\\PiWorkspace",
    );
  });

  it("defaults to a fixed data-drive folder on Windows", () => {
    expect(resolvePiHome({ env: {}, platform: "win32" })).toBe(`D:\\${PI_HOME_DIR_NAME}`);
  });

  it("keeps a hidden home directory elsewhere", () => {
    expect(resolvePiHome({ env: {}, platform: "linux", homeDir: "/home/me" })).toBe(
      "/home/me/.piworkspace",
    );
  });

  it("ignores a blank publication", () => {
    expect(resolvePiHome({ env: { [PI_HOME_ENV]: "   " }, platform: "win32" })).toBe(
      `D:\\${PI_HOME_DIR_NAME}`,
    );
  });
});

describe("skills and prompt roots", () => {
  it("move under the published root", () => {
    const env = { [PI_HOME_ENV]: "D:\\PiWorkspace" };
    expect(resolveAgentsHome({ env, platform: "win32" })).toBe("D:\\PiWorkspace\\agents");
    expect(resolveAgentDataHome({ env, platform: "win32" })).toBe("D:\\PiWorkspace\\pi");
  });

  it("keep the historical home layout when nothing is published", () => {
    const homeDir = "C:\\Users\\me";
    expect(resolveAgentsHome({ env: {}, platform: "win32", homeDir })).toBe(
      "C:\\Users\\me/.agents",
    );
    expect(resolveAgentDataHome({ env: {}, platform: "win32", homeDir })).toBe(
      "C:\\Users\\me/.pi",
    );
  });

  it("builds subdirectory paths with the root's own separator", () => {
    expect(piHomeSubdirectory("data", { env: { [PI_HOME_ENV]: "D:\\PiWorkspace" } })).toBe(
      "D:\\PiWorkspace\\data",
    );
    expect(piHomeSubdirectory("data", { env: { [PI_HOME_ENV]: "/opt/pi" } })).toBe("/opt/pi/data");
    expect(piHomeSubdirectory("data", { env: { [PI_HOME_ENV]: "D:\\PiWorkspace\\" } })).toBe(
      "D:\\PiWorkspace\\data",
    );
  });
});
