import { execFile, type ExecFileException } from "node:child_process";
import { basename, join, posix, win32 } from "node:path";
import { realpath, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/**
 * The clipboard entry a file list arrives in.
 *
 * Electron 44 replaced the synchronous clipboard module with a W3C-style async
 * one: `readBuffer(format)` and a synchronous `availableFormats()` are gone, and
 * a paste is read as `read()` + `getType(mime)`. The old call did not fail at
 * import time — it threw `readBuffer is not a function` on the first macOS or
 * Linux file paste, which is why this type names the API that actually exists.
 */
type NativeClipboardItem = {
  /** MIME types the platform currently offers for this entry. */
  types?: readonly string[];
  /** Resolves with the payload; a `Blob` for every type this module reads. */
  getType(type: string): Promise<unknown>;
};

type NativeClipboard = {
  read(): Promise<readonly NativeClipboardItem[]>;
};

/**
 * Types that carry a pasted file list, in the order worth trying.
 *
 * `text/uri-list` is the documented shape on every platform; `public.file-url`
 * is what some macOS copies expose instead, and `x-special/gnome-copied-files`
 * is the Linux file-manager spelling.
 */
const URI_LIST_TYPES = [
  "text/uri-list",
  "public.file-url",
  "x-special/gnome-copied-files",
] as const;

/** Read the pasted URI list, or an empty string when the clipboard holds none. */
async function clipboardUriList(clipboard: NativeClipboard): Promise<string> {
  const items = await clipboard.read();
  for (const type of URI_LIST_TYPES) {
    const item = items.find((candidate) => (candidate.types ?? []).includes(type));
    if (!item) continue;
    const payload = await item.getType(type);
    const text = typeof (payload as { text?: () => Promise<string> }).text === "function"
      ? await (payload as Blob).text()
      : "";
    if (!text) continue;
    // The bound is on the bytes we are about to parse, not on the clipboard:
    // a 100 MB copy must be refused before it becomes a string.
    if (Buffer.byteLength(text, "utf8") > MAX_METADATA_BYTES) {
      throw new Error("clipboard file metadata is too large");
    }
    return text;
  }
  return "";
}

const MAX_ITEMS = 20;
const MAX_METADATA_BYTES = 1024 * 1024;

/** Exported so a regression can exercise a real child process boundary. */
export async function execFileAsync(
  command: string,
  args: string[],
  options: { timeout?: number; maxBuffer?: number; [key: string]: unknown },
  input?: Buffer,
): Promise<Buffer> {
  // execFile defaults to utf8 strings; pin the buffer encoding so stdout stays binary
  // no matter which caller reads a clipboard, and normalize anything that still
  // arrives as a string instead of throwing inside the stream handler.
  const child = execFile(command, args, { encoding: "buffer", ...options });
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    child.stdout?.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    // Stream errors must reject the promise; an unhandled handler would crash Main.
    child.stdout?.on("error", fail);
    child.stdin?.on("error", fail);
    child.on("error", (error: ExecFileException) => {
      fail(new Error(error.message || "clipboard file list read failed"));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error("clipboard file list read failed"));
    });
    child.stdin?.end(input);
  });
}

async function windowsClipboardPaths(): Promise<string[]> {
  // CF_HDROP is a built-in format, not the custom format named "CF_HDROP".
  const command = "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); Add-Type -AssemblyName System.Windows.Forms; ConvertTo-Json -Compress -InputObject @([System.Windows.Forms.Clipboard]::GetFileDropList())";
  const executable = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const value: unknown = JSON.parse(
    (
      await execFileAsync(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-Command", command], {
        windowsHide: true, timeout: 10000, maxBuffer: MAX_METADATA_BYTES,
      })
    ).toString("utf8"),
  );
  if (!Array.isArray(value) || !value.every(path => typeof path === "string")) throw new Error("invalid clipboard file list");
  return value;
}

/** Read native file metadata only during an explicit Composer paste. */
export async function nativeClipboardPaths(
  clipboard: NativeClipboard,
  platform: NodeJS.Platform = process.platform,
  readWindowsPaths: () => Promise<string[]> = windowsClipboardPaths,
): Promise<string[]> {
  let paths: string[] = [];
  if (platform === "win32") {
    // Windows hands over a real file-drop list, which is more precise than any
    // URI spelling, so it keeps its own native reader.
    paths = await readWindowsPaths();
  } else {
    // macOS and Linux both publish the selection as a URI list. The macOS
    // `NSFilenamesPboardType` plist this used to decode is no longer readable:
    // the API that returned it synchronously is gone.
    const uris = await clipboardUriList(clipboard);
    paths = uris
      .split(/[\r\n\0]+/)
      .filter(line => line.startsWith("file:"))
      .map(uri => fileURLToPath(uri, { windows: false }));
  }
  paths = [...new Set(paths)];
  if (paths.length > MAX_ITEMS) throw new Error(`too many pasted items (maximum ${MAX_ITEMS})`);
  const absolute = platform === "win32" ? win32.isAbsolute : posix.isAbsolute;
  if (paths.some(path => !absolute(path) || path.includes("\0"))) throw new Error("invalid clipboard file path");
  return paths;
}

/** Capture native paths without reading file contents. */
export async function readComposerClipboardDirectories(
  clipboard: NativeClipboard,
  rememberFiles: (paths: string[]) => string,
  capturePaths: () => Promise<string[]> = async () => nativeClipboardPaths(clipboard),
): Promise<{
  items: Array<{ kind: "directory"; path: string; name: string } | { kind: "file"; name: string }>;
  token: string | null;
} | null> {
  // Capture before yielding so later clipboard changes cannot replace this selection.
  const paths = await capturePaths();
  const entries = await Promise.all(paths.map(async path => {
    const canonical = await realpath(path);
    const metadata = await stat(canonical);
    if (!metadata.isDirectory() && !metadata.isFile()) throw new Error("clipboard item is not a file or directory");
    return { path: canonical, name: basename(path) || path, directory: metadata.isDirectory() };
  }));
  if (!entries.length) return null;
  const files = entries.filter(entry => !entry.directory).map(entry => entry.path);
  return {
    items: entries.map(entry => entry.directory
      ? { kind: "directory", path: entry.path, name: entry.name }
      : { kind: "file", name: entry.name }),
    token: files.length ? rememberFiles(files) : null,
  };
}
