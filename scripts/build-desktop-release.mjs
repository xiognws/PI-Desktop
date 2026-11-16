import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const forwardedArgs = process.argv.slice(2);

// Our own switch, not electron-builder's: strip it before forwarding.
const skipPythonExtras = forwardedArgs.includes("--skip-python-extras");
if (skipPythonExtras) forwardedArgs.splice(forwardedArgs.indexOf("--skip-python-extras"), 1);

const hostTarget =
  process.platform === "win32"
    ? "win"
    : process.platform === "darwin"
      ? "mac"
      : "linux";
const requestedTarget = ["linux", "mac", "win"].includes(forwardedArgs[0])
  ? forwardedArgs.shift()
  : undefined;
const target = requestedTarget ?? hostTarget;

if (!["linux", "mac", "win"].includes(target)) {
  throw new Error(`Unsupported desktop release target: ${target}`);
}

const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function runBuilder(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(pnpmCommand, ["exec", "electron-builder", ...args], {
      // Windows exposes pnpm as a .cmd shim. Launch it through the shell so
      // Node can start the shim consistently on the hosted Windows runner.
      shell: process.platform === "win32",
      stdio: "inherit",
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `electron-builder ${target} target failed with ${
            code === null ? `signal ${signal ?? "unknown"}` : `exit code ${code}`
          }`,
        ),
      );
    });
  });
}

/** Run a Node script of this repository, inheriting stdio. */
function runNode(args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, args, { stdio: "inherit", cwd: REPO });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${args[0]} failed with ${code === null ? `signal ${signal}` : `exit code ${code}`}`));
    });
  });
}

if (target === "win") {
  await runBuilder([
    "--win",
    "nsis",
    "--publish",
    "never",
    ...forwardedArgs,
    "-c.extraMetadata.piDistribution=installed",
  ]);
  await runBuilder([
    "--win",
    "zip",
    "--publish",
    "never",
    ...forwardedArgs,
    "-c.extraMetadata.piDistribution=zip",
  ]);
  await runBuilder([
    "--win",
    "portable",
    "--publish",
    "never",
    ...forwardedArgs,
    "-c.extraMetadata.piDistribution=portable",
  ]);

  // The optional Python libraries are assembled **after** electron-builder so
  // they land beside the image (`win-unpacked/python-extras`) instead of inside
  // every installer: ~400 MB of scipy/scikit-learn/botocore would otherwise be
  // paid by every user, including the ones who never run Python. The folder is
  // what `python-runtime.ts` appends to `PYTHONPATH`.
  const unpacked = join(REPO, "apps", "desktop", "release", "win-unpacked");
  if (!skipPythonExtras && existsSync(unpacked)) {
    await runNode([join(REPO, "scripts", "bundle-python-extras.mjs"), "--out", join(unpacked, "python-extras")]);
  }
} else {
  await runBuilder([
    `--${target}`,
    "--publish",
    "never",
    ...forwardedArgs,
  ]);
}
