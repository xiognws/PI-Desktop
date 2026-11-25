import { execFile } from 'node:child_process';

/**
 * Checks whether the PI-Desktop window/process is currently in the foreground (focused).
 * Returns true if the window is currently focused, false if blurred/in background.
 * In case of permission errors or platform unsupported, returns false (fail-safe).
 *
 * Keep this in step with the shipped `audio/focusDetector.js`. The Windows path used to
 * spawn `powershell -Command` with an embedded `Add-Type` P/Invoke for
 * `GetForegroundWindow`, i.e. an unsigned interpreter carrying an inline payload plus
 * cross-process window probing — the shape behaviour-based AV engines score as a
 * keylogger. The host answers this directly (`pi.app.isFocused`), so the compiled module
 * asks the host and spawns nothing on Windows; the source has to match, or the next
 * rebuild reintroduces the probe.
 */
export async function isAppFocused(): Promise<boolean> {
  // Host-provided focus state first: it needs no child process at all.
  try {
    const hostApi = (globalThis as { pi?: { app?: { isFocused?: () => Promise<boolean> } } }).pi;
    if (hostApi?.app && typeof hostApi.app.isFocused === 'function') {
      return (await hostApi.app.isFocused()) === true;
    }
  } catch {
    // fall through to the platform probe below
  }

  const platform = process.platform;

  return new Promise((resolve) => {
    try {
      if (platform === 'darwin') {
        // macOS AppleScript check (runs in < 40ms)
        const script = 'tell application "System Events" to get frontmost of process "PI-Desktop"';
        execFile('osascript', ['-e', script], { timeout: 800 }, (err, stdout) => {
          if (err || !stdout) {
            resolve(false);
            return;
          }
          resolve(stdout.trim().toLowerCase() === 'true');
        });
      } else if (platform === 'win32') {
        // No child process: report "not focused" and let the caller notify anyway.
        resolve(false);
      } else {
        // Linux / other platforms: default to false
        resolve(false);
      }
    } catch {
      resolve(false);
    }
  });
}
