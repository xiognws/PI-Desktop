import { execFile } from "node:child_process";
import { lstatSync, readlinkSync, statSync } from "node:fs";
import type { symlink } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

/**
 * `dir /A:L` prints one line per reparse point, tagged `<JUNCTION>` (what
 * `mklink /J` writes), `<SYMLINKD>` (a link the file system marks as pointing
 * at a directory) or `<SYMLINK>`. Those tags stay ASCII in every console
 * language, which is why the listing is parsed instead of `Get-Item`'s
 * `LinkType`: that probe was a PowerShell script fed over stdin, and endpoint
 * protection that scores process behaviour reads "unsigned application runs an
 * inline script" as malware. Running a storage migration was enough to get
 * this product reported as a trojan.
 */
const DIRECTORY_LINK = /<(JUNCTION|SYMLINKD|SYMLINK)>\s+(.+?)\s+\[/g;

/**
 * Classify each path as a junction, a directory symlink, or a file symlink,
 * reading the reparse point — not its target — so dangling links classify
 * too. A directory attribute alone cannot tell these apart (#1686): a
 * directory symlink carries it just like a junction does, which used to
 * rewrite every `mklink /D` link into a junction and wedged the migration on
 * UNC-targeted links that junctions cannot point at.
 *
 * The tag comes from `dir /A:L` — a System32 binary invoked with arguments,
 * without a shell and without any script text. The PowerShell probe this
 * replaces — an inline script fed over stdin — reads as malware behaviour to
 * endpoint protection that scores process activity, and running a storage
 * migration was enough to get the product flagged as a trojan on hosts
 * running such a product.
 */
export async function storageLinkTypes(paths: string[]): Promise<Array<symlink.Type | undefined>> {
  if (process.platform !== "win32") return paths.map(() => undefined);
  if (!paths.length) return [];
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot) throw new Error("Windows system directory is unavailable.");
  const comspec = process.env.ComSpec || join(systemRoot, "System32", "cmd.exe");
  // One listing covers every link in a directory, and a migration carries its
  // links inside a handful of them.
  const listings = new Map<string, Map<string, symlink.Type>>();
  const types: Array<symlink.Type | undefined> = [];
  for (const path of paths) {
    const directory = dirname(path);
    let links = listings.get(directory);
    if (!links) {
      links = await listReparsePoints(comspec, directory);
      listings.set(directory, links);
    }
    types.push(classifyStorageLink(path, links.get(basename(path).toLowerCase())));
  }
  return types;
}

/**
 * The reparse point decides what a link is; its target decides `dir` vs `file`
 * while that target can be read, because `fs.symlink(..., "file")` may
 * legitimately point at a directory and the caller rebuilds the link with this
 * answer. A link whose target cannot be read — a dangling one, or a UNC target
 * that is not reachable right now — keeps what the reparse point recorded.
 */
function classifyStorageLink(path: string, link: symlink.Type | undefined): symlink.Type {
  const stats = lstatSync(path);
  if (!stats.isSymbolicLink()) {
    // A plain directory is rebuilt as a junction, as before: doing so needs no
    // symlink privilege.
    return stats.isDirectory() ? "junction" : "file";
  }
  if (link === "junction") return "junction";
  return linkTargetKind(path) ?? link ?? "file";
}

/** `undefined` while the target cannot be read, so the reparse point decides. */
function linkTargetKind(path: string): symlink.Type | undefined {
  try {
    const target = readlinkSync(path);
    const absolute = isAbsolute(target) ? target : resolve(dirname(path), target);
    return statSync(absolute).isDirectory() ? "dir" : "file";
  } catch {
    return undefined;
  }
}

/** Empty when `dir` cannot answer; the caller then falls back to the target. */
function listReparsePoints(comspec: string, directory: string): Promise<Map<string, symlink.Type>> {
  return new Promise((settle) => {
    execFile(comspec, ["/d", "/s", "/c", "dir", "/A:L", directory], {
      windowsHide: true,
      maxBuffer: 64 * 1024,
      encoding: "buffer",
    }, (error, stdout) => {
      const links = new Map<string, symlink.Type>();
      if (!error) {
        for (const text of decodeListing(stdout)) {
          for (const [, tag, name] of text.matchAll(DIRECTORY_LINK)) {
            links.set(name.trim().toLowerCase(),
              tag === "JUNCTION" ? "junction" : tag === "SYMLINKD" ? "dir" : "file");
          }
        }
      }
      settle(links);
    });
  });
}

/**
 * `dir` writes names in the console code page, so a non-ASCII name arrives as
 * GBK on a Chinese Windows console and as UTF-8 when the console was switched
 * to 65001. Decode both and let the caller match either; a name that matches
 * neither reports an unreadable reparse point rather than a wrong kind.
 */
function decodeListing(buffer: Buffer): string[] {
  const decoded: string[] = [];
  for (const encoding of ["gbk", "utf-8"]) {
    try {
      decoded.push(new TextDecoder(encoding).decode(buffer));
    } catch {
      // The runtime ships without this encoding; the other one still applies.
    }
  }
  return decoded;
}
