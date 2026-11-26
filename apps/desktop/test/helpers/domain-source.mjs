import { readdir, readFile } from "node:fs/promises";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Assertions spell multi-line snippets with `\n`; a CRLF checkout would silently
 * fail every such needle, so sources are normalized on the way in.
 */
const normalize = (text) => text.replace(/\r\n/g, "\n");

const desktopSourceRoot = fileURLToPath(new URL("../../src/", import.meta.url));

/**
 * The path a fixture chunk is introduced by. Always POSIX: the tests search for
 * `/* features/settings/pages/X.tsx *\/` markers, while `path.relative` uses
 * backslashes on Windows — the marker has to read the same on every platform.
 */
function markerPath(path) {
  return relative(desktopSourceRoot, path).split(sep).join("/");
}

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(async (entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) return sourceFiles(path);
        return entry.isFile() && /\.(ts|tsx)$/.test(path) ? [path] : [];
      }),
  );
  return nested.flat();
}

async function readDomainFiles(domainRelativePath) {
  const domainRoot = join(desktopSourceRoot, domainRelativePath);
  const paths = await sourceFiles(domainRoot);
  const chunks = await Promise.all(
    paths.map(async (path) => {
      const source = normalize(await readFile(path, "utf8"));
      return `\n/* ${markerPath(path)} */\n${source}`;
    }),
  );
  return chunks.join("\n");
}

function readDomainFilesSync(domainRelativePath) {
  const domainRoot = join(desktopSourceRoot, domainRelativePath);
  return sourceFilesSync(domainRoot)
    .map((path) => `\n/* ${markerPath(path)} */\n${normalize(readFileSync(path, "utf8"))}`)
    .join("\n");
}

async function readDomainSource(facadeRelativePath, domainRelativePath) {
  const facade = join(desktopSourceRoot, facadeRelativePath);
  const domainRoot = join(desktopSourceRoot, domainRelativePath);
  const paths = [facade, ...(await sourceFiles(domainRoot))];
  const chunks = await Promise.all(
    paths.map(async (path) => {
      const source = normalize(await readFile(path, "utf8"));
      return `\n/* ${markerPath(path)} */\n${source}`;
    }),
  );
  return chunks.join("\n");
}

function sourceFilesSync(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return sourceFilesSync(path);
      return entry.isFile() && /\.(ts|tsx)$/.test(path) ? [path] : [];
    });
}

function readDomainSourceSync(facadeRelativePath, domainRelativePath) {
  const facade = join(desktopSourceRoot, facadeRelativePath);
  const domainRoot = join(desktopSourceRoot, domainRelativePath);
  return [facade, ...sourceFilesSync(domainRoot)]
    .map((path) => `\n/* ${markerPath(path)} */\n${normalize(readFileSync(path, "utf8"))}`)
    .join("\n");
}

/** Read App.tsx and the shell/runtime modules as one renderer contract surface.
 *
 * The window's interfaces live under `features/surfaces/` since the surface split
 * (ADR 0410): the chat shell, the rail that switches between surfaces and the
 * AutoTest surface. They are part of the same shell contract, so
 * `readAppSource()` returns them together — a test that asserts on the chat
 * sidebar or the work panel should not have to know which file it moved to.
 */
export async function readAppSource() {
  const [app, surfaces] = await Promise.all([
    readDomainSource("App.tsx", "features/app"),
    readDomainFiles("features/surfaces"),
  ]);
  return `${app}\n${surfaces}`;
}

export function readAppSourceSync() {
  return `${readDomainSourceSync("App.tsx", "features/app")}\n${readDomainFilesSync("features/surfaces")}`;
}

/** Read the stable SettingsPage facade and all settings sections together. */
export function readSettingsSource() {
  return readDomainSource("pages/SettingsPage.tsx", "features/settings");
}

export function readSettingsSourceSync() {
  return readDomainSourceSync("pages/SettingsPage.tsx", "features/settings");
}

/** Read the stable PluginsPage facade and all plugin domain modules together. */
export function readPluginsSource() {
  return readDomainSource("pages/PluginsPage.tsx", "features/plugins");
}

export function readPluginsSourceSync() {
  return readDomainSourceSync("pages/PluginsPage.tsx", "features/plugins");
}
