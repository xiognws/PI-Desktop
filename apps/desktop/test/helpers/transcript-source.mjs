import { readdir, readFile } from "node:fs/promises";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Assertions spell multi-line snippets with `\n`; a CRLF checkout would silently
 * fail every such needle, so sources are normalized on the way in.
 */
const normalize = (text) => text.replace(/\r\n/g, "\n");

const desktopSourceRoot = fileURLToPath(new URL("../../src/", import.meta.url));
const transcriptRoot = join(desktopSourceRoot, "features/chat/transcript");

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

/** Read the legacy facade and all transcript domain modules together. */
export async function readTranscriptSource() {
  const facade = join(desktopSourceRoot, "components/ChatTranscript.tsx");
  const paths = [facade, ...(await sourceFiles(transcriptRoot))];
  const chunks = await Promise.all(
    paths.map(async (path) => {
      const source = normalize(await readFile(path, "utf8"));
      return `\n/* ${relative(desktopSourceRoot, path)} */\n${source}`;
    }),
  );
  return chunks.join("\n");
}

export async function readTranscriptModule(relativePath) {
  return normalize(await readFile(join(transcriptRoot, relativePath), "utf8"));
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

export function readTranscriptSourceSync() {
  const facade = join(desktopSourceRoot, "components/ChatTranscript.tsx");
  return [facade, ...sourceFilesSync(transcriptRoot)]
    .map((path) => `\n/* ${relative(desktopSourceRoot, path)} */\n${normalize(readFileSync(path, "utf8"))}`)
    .join("\n");
}

export function readTranscriptModuleSync(relativePath) {
  return normalize(readFileSync(join(transcriptRoot, relativePath), "utf8"));
}
