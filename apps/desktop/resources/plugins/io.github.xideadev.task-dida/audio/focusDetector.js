"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isAppFocused = isAppFocused;
const node_child_process_1 = require("node:child_process");
/**
 * Checks whether the PI-Desktop window/process is currently in the foreground (focused).
 * Returns true if the window is currently focused, false if blurred/in background.
 * In case of permission errors or platform unsupported, returns false (fail-safe).
 */
async function isAppFocused() {
    // Host-provided focus state first: it needs no child process at all, so it cannot be
    // mistaken for a foreground-window probe by behavioural AV engines.
    try {
        if (typeof pi !== "undefined" && pi && pi.app && typeof pi.app.isFocused === "function") {
            return (await pi.app.isFocused()) === true;
        }
    }
    catch (error) {
        // fall through to the platform probe below
    }
    const platform = process.platform;
    return new Promise((resolve) => {
        try {
            if (platform === 'darwin') {
                // macOS AppleScript check (runs in < 40ms)
                const script = 'tell application "System Events" to get frontmost of process "PI-Desktop"';
                (0, node_child_process_1.execFile)('osascript', ['-e', script], { timeout: 800 }, (err, stdout) => {
                    if (err || !stdout) {
                        resolve(false);
                        return;
                    }
                    resolve(stdout.trim().toLowerCase() === 'true');
                });
            }
            else if (platform === 'win32') {
                // No child process is spawned here: reading the foreground window requires an
                // unsigned PowerShell Add-Type probe, whose shape is indistinguishable from a keylogger
                // to behavioural AV engines. Report "not focused" and let the caller notify anyway.
                resolve(false);
            }
            else {
                // Linux / other platforms: default to false
                resolve(false);
            }
        }
        catch {
            resolve(false);
        }
    });
}
