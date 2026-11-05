import { app } from "electron";
import { homedir } from "node:os";
import { APP_ID, APP_NAME } from "@pi-workspace/shared";
import { adoptLegacyHomeProfile, applyDevelopmentUserData, desktopDataDir } from "./data-paths";
import { applyReleaseDataRoot } from "./data-root";
import { ignoreBrokenStdio } from "./logger";
import { installMainProcessErrorHandlers } from "./main-process-errors";

// Complete identity and locking synchronously, before the ready promise or any writer.
ignoreBrokenStdio();
installMainProcessErrorHandlers();
export const isDevelopmentBuild = process.env.PI_DESKTOP_DEV === "1" || !app.isPackaged;
app.setName(APP_NAME);
// A managed restart inherits the root published for children, not an explicit
// profile override. Dropped before anything reads the override below.
if (process.argv.includes("--pi-managed-storage")) delete process.env.PI_DESKTOP_DATA_DIR;
// Only an explicit override opts out of the single-instance lock, and it has to
// be read before the data root below is published into the environment — that
// root belongs to the build, not to the caller.
const dataDirWasExplicit = Boolean(process.env.PI_DESKTOP_DATA_DIR?.trim());
// A shipped build keeps everything it writes on a non-system drive; a checkout
// keeps its own development profile. Must run before any writer resolves a path.
const dataRoot = applyReleaseDataRoot(isDevelopmentBuild);
// Only when this machine has no data drive does a development build fall back
// to the app-data profile it has always used — and there the profile name is
// the only thing that ever moved, so a profile from before the rename is
// adopted instead of being silently recreated empty.
if (!dataRoot) {
  if (!process.env.PI_DESKTOP_DATA_DIR?.trim()) {
    adoptLegacyHomeProfile(homedir(), isDevelopmentBuild);
  }
  applyDevelopmentUserData(app, isDevelopmentBuild);
}
if (process.platform === "win32") app.setAppUserModelId(APP_ID);

export const singleInstanceRequired = !dataDirWasExplicit;
export const hasSingleInstanceLock = singleInstanceRequired ? app.requestSingleInstanceLock() : true;
export const defaultDataDir = desktopDataDir(isDevelopmentBuild);
if (!hasSingleInstanceLock) app.quit();

// Preserve the existing Chromium accessibility crash workaround before ready.
app.commandLine.appendSwitch("disable-renderer-accessibility");
