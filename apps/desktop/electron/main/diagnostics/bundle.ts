/**
 * A diagnostics bundle: the few facts a support conversation needs, zipped without a
 * dependency.
 *
 * Two rules decide what goes in. Redaction is not optional - a log line can contain a
 * token, a path under the user's home directory, or a URL with credentials in it, and
 * the bundle is meant to be sent to someone else. And session content never goes in:
 * the bundle reports *counts* of rows, never message text, because the point is to
 * diagnose the app, not to read the user's conversations.
 *
 * The zip writer is store-only (no compression) and written here rather than adding a
 * dependency for one button: a diagnostics bundle is a handful of small text files, and
 * every zip tool reads stored entries.
 */

/** Redact values that must never leave the machine in a bundle. */
export function redact(text: string): string {
  return (
    text
      // A bearer token or api key in a log line.
      .replace(/(bearer\s+)[A-Za-z0-9._-]{8,}/gi, "$1[redacted]")
      .replace(/\b(sk|pk|api[_-]?key|token|secret|password)[=:\s"]+[A-Za-z0-9._\-]{6,}/gi, "$1=[redacted]")
      // A home directory identifies the user; keep the shape, drop the name.
      .replace(/\b([A-Za-z]:\\Users\\)[^\\\s"]+/g, "$1[user]")
      .replace(/\/(home|Users)\/[^/\s"]+/g, "/$1/[user]")
      // Credentials embedded in a URL.
      .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, "$1[credentials]@")
  );
}

export type BundleFile = { name: string; content: string };

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Build a store-only zip. Entry order is preserved, which keeps the bytes stable. */
export function buildZip(files: readonly BundleFile[], timestamp = new Date(1980, 1, 1)): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  // A fixed timestamp keeps two bundles of identical input byte-identical, so a test
  // can compare them and a support thread can tell "same facts" from "new facts".
  const dosTime =
    (timestamp.getHours() << 11) | (timestamp.getMinutes() << 5) | Math.floor(timestamp.getSeconds() / 2);
  const dosDate =
    ((timestamp.getFullYear() - 1980) << 9) | ((timestamp.getMonth() + 1) << 5) | timestamp.getDate();

  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const body = Buffer.from(file.content, "utf8");
    const checksum = crc32(body);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // utf-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + body.length;
  }

  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, ...centrals, end]);
}

export type DiagnosticsInput = {
  appVersion: string;
  platform: string;
  dataDir: string;
  /** Recent log lines, newest last. */
  logLines: readonly string[];
  /** Crash dump file names, newest first. */
  crashDumps: readonly string[];
  /** Row counts per table, and nothing from inside them. */
  tableCounts: Record<string, number>;
  /** Anything the caller already knows is worth stating. */
  notes?: readonly string[];
};

/**
 * Assemble the bundle files from what the caller collected.
 *
 * Deliberately takes everything as input: gathering logs, dumps and counts needs live
 * app state, and keeping that out of here is what makes the bundle's shape testable.
 */
export function bundleFiles(input: DiagnosticsInput, now = new Date()): BundleFile[] {
  const summary = [
    `app version: ${input.appVersion}`,
    `platform: ${input.platform}`,
    `generated: ${now.toISOString()}`,
    `data dir: ${redact(input.dataDir)}`,
    "",
    "row counts (counts only; no message content is included):",
    ...Object.entries(input.tableCounts)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([table, count]) => `  ${table}: ${count}`),
    "",
    `crash dumps found: ${input.crashDumps.length}`,
    ...input.crashDumps.map((name) => `  ${name}`),
  ];
  if (input.notes?.length) summary.push("", ...input.notes);

  const files: BundleFile[] = [{ name: "summary.txt", content: `${summary.join("\n")}\n` }];
  if (input.logLines.length) {
    files.push({
      name: "app.log.tail",
      // Redaction happens here, once, rather than at each log site: a log line is
      // written for the developer reading it locally, and only this path leaves the
      // machine.
      content: `${input.logLines.map(redact).join("\n")}\n`,
    });
  }
  return files;
}

