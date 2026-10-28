import { app } from "electron";
import { APP_ID, APP_NAME } from "@pi-desktop/shared";
import { applyDevelopmentUserData, desktopDataDir } from "./data-paths";
import { applyReleaseDataRoot } from "./data-root";
import { ignoreBrokenStdio } from "./logger";
import { installMainProcessErrorHandlers } from "./main-process-errors";

// Complete identity and locking synchronously, before the ready promise or any writer.
ignoreBrokenStdio();
installMainProcessErrorHandlers();
export const isDevelopmentBuild = process.env.PI_DESKTOP_DEV === "1" || !app.isPackaged;
app.setName(APP_NAME);
// Only an explicit override opts out of the single-instance lock; the data root
// this build claims for itself must not look like one.
const dataDirWasExplicit = Boolean(process.env.PI_DESKTOP_DATA_DIR?.trim());
// A shipped build keeps everything it writes on a non-system drive; a checkout
// keeps its own development profile. Must run before any writer resolves a path.
const dataRoot = applyReleaseDataRoot(isDevelopmentBuild);
// Only when this machine has no data drive does a development build fall back
// to the app-data profile it has always used.
if (!dataRoot) applyDevelopmentUserData(app, isDevelopmentBuild);
if (process.platform === "win32") app.setAppUserModelId(APP_ID);

// A managed restart inherits the root published for children, not an explicit profile override.
if (process.argv.includes("--pi-managed-storage")) delete process.env.PI_DESKTOP_DATA_DIR;
export const singleInstanceRequired = !dataDirWasExplicit;
export const hasSingleInstanceLock = singleInstanceRequired ? app.requestSingleInstanceLock() : true;
export const defaultDataDir = desktopDataDir(isDevelopmentBuild);
if (!hasSingleInstanceLock) app.quit();

// Preserve the existing Chromium accessibility crash workaround before ready.
app.commandLine.appendSwitch("disable-renderer-accessibility");
