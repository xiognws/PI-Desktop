/**
 * Platform guards for suites whose fixtures only exist on one OS.
 *
 * Both suites below are real coverage and stay in the tree: they run on macOS and
 * on POSIX CI. What they cannot do is run on a Windows developer machine, where
 * the fixture they spawn does not exist — a fake `ssh` binary is a shebang script
 * (`spawn` answers ENOENT), and the release lane drives `codesign`, `hdiutil`,
 * and `notarytool`.
 *
 * Use the exported options as the second argument of `test(...)` so the skip
 * reason lands in the TAP output instead of the suite silently losing coverage.
 */

/** Fake `ssh`, installer, and wrapper binaries written as POSIX shell scripts. */
export const posixOnly =
  process.platform === "win32"
    ? { skip: "fixture is a POSIX shell script; Windows cannot spawn it" }
    : false;

/** Notarization, stapling, and signing identity checks that need Apple tooling. */
export const darwinOnly =
  process.platform !== "darwin"
    ? { skip: "macOS release lane; needs codesign, hdiutil, and notarytool" }
    : false;
