/**
 * Where a test puts the files it stages and then deletes.
 *
 * Not the platform temp directory: on a managed Windows host the endpoint agent
 * blocks writes into `%LOCALAPPDATA%\Temp`, and esbuild then fails with
 * "Access is denied" while staging a bundle - a red test that says nothing about
 * the code under test. AGENTS.md allows tests to use the platform temp directory
 * because a run leaves nothing behind, but it cannot when the platform refuses
 * the write, so the repository provides the root instead.
 *
 * The directory sits at the repository root, is gitignored, and every caller
 * still removes what it created. Creation is lazy and idempotent so parallel test
 * files can race on it.
 */
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/**
 * Inside the checkout, because that is the only place measured to accept a
 * spawned `esbuild`'s output on a managed Windows host: the same build fails with
 * "Access is denied" in `%TEMP%`, in a sibling of the repo and on another drive,
 * while it succeeds here.
 */
/** `<repo>/.pi-test-tmp`, created on first use. */
const ROOT = join(REPO_ROOT, ".pi-test-tmp");

export function testTempRoot(): string {
  mkdirSync(ROOT, { recursive: true });
  return ROOT;
}

/** A path inside the test temp root, for tests that name their own directory. */
export function testTempPath(...segments: string[]): string {
  return join(testTempRoot(), ...segments);
}
