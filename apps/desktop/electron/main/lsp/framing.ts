/**
 * LSP wire framing (ADR 0401, stage 3).
 *
 * The protocol puts JSON-RPC on a stream as `Content-Length: N\r\n\r\n<N bytes>`
 * frames. A codec that is subtly wrong is invisible until a real server
 * desynchronizes halfway through a session, after which every response answers the
 * wrong request — so it lives here, alone, with no I/O, and the failure cases have
 * tests instead of being discovered in the field.
 *
 * This is the TypeScript port of the Rust prototype in
 * `crates/host-core/src/tools/lsp/framing.rs`: same design, same cases, kept where
 * the agent tools actually run.
 */

export type DecodeResult =
  | { kind: "frame"; payload: string; consumed: number }
  /** The header block is not complete yet: keep reading. */
  | { kind: "incomplete" }
  /** A header block with no usable `Content-Length`: more bytes will not help. */
  | { kind: "error"; message: string };

const HEADER_TERMINATOR = "\r\n\r\n";

/** Encode one payload as a frame, headers included. */
export function encodeFrame(payload: string): Buffer {
  // `Buffer.byteLength`, not `payload.length`: a payload carrying a Windows path
  // such as `D:\代码` has fewer characters than bytes, and a server cutting at the
  // character count would truncate the JSON.
  const body = Buffer.from(payload, "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]);
}

/**
 * Read one frame off the front of `buffer`.
 *
 * Returns how many bytes the frame consumed so the caller can drain and loop: a
 * single read can carry several frames, and dropping the remainder loses a response
 * the caller is waiting for.
 */
export function decodeFrame(buffer: Buffer): DecodeResult {
  const headerEnd = buffer.indexOf(HEADER_TERMINATOR, 0, "ascii");
  if (headerEnd < 0) return { kind: "incomplete" };
  const headers = buffer.subarray(0, headerEnd).toString("ascii");
  let declared: number | undefined;
  for (const line of headers.split("\r\n")) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    if (line.slice(0, separator).trim().toLowerCase() !== "content-length") continue;
    const raw = line.slice(separator + 1).trim();
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || String(parsed) !== raw) {
      return { kind: "error", message: `Content-Length is not a number: ${JSON.stringify(raw)}` };
    }
    declared = parsed;
    break;
  }
  if (declared === undefined) {
    return { kind: "error", message: "frame is missing Content-Length" };
  }
  const bodyStart = headerEnd + HEADER_TERMINATOR.length;
  const available = buffer.length - bodyStart;
  if (available < declared) return { kind: "incomplete" };
  return {
    kind: "frame",
    payload: buffer.subarray(bodyStart, bodyStart + declared).toString("utf8"),
    consumed: bodyStart + declared,
  };
}
