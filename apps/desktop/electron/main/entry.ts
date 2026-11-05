import { app, BrowserWindow } from "electron";
import { defaultDataDir, hasSingleInstanceLock, singleInstanceRequired } from "./installation";
import { prepareStorage } from "./storage/bootstrap";
import { recordExitReason, setRunMarkerDirectory } from "./run-marker.js";

// Do not top-level-await Electron readiness: module evaluation gates the ready event.
// The full composition root is imported only after offline maintenance has finished.
if (hasSingleInstanceLock) {
  let booted = false;
  app.on("second-instance", () => {
    if (booted) return;
    const window = BrowserWindow.getAllWindows()[0];
    window?.show();
    window?.focus();
  });
  // The marker lives in the data directory, and the exit paths below run before
  // the composition root does, so point it there first.
  setRunMarkerDirectory(defaultDataDir);
  void prepareStorage(defaultDataDir, !singleInstanceRequired)
    .then(() => {
      booted = true;
      return import("./index");
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Storage startup failed", message);
      recordExitReason("storage startup failed: " + message);
      app.exit(1);
    });
}
