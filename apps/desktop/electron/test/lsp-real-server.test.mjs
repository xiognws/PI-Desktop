import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const { LspClient } = await import("../main/lsp/client.ts");
const { discoverServer } = await import("../main/lsp/servers.ts");

/*
 * The real-server test, opt-in.
 *
 * The fixture test proves the client against a child process it fully controls. This
 * one talks to an actual `typescript-language-server` about this repository, which is
 * the only way the Windows details stay honest: the server installs as a `.cmd` shim,
 * Node refuses to spawn those directly, and `cmd /s` strips the first and last quote of
 * a command line - all of that is invisible to a Node-script fixture.
 *
 * It is skipped unless `LSP_E2E=1`, because it needs a globally installed server and
 * takes seconds rather than milliseconds.
 */
const enabled = process.env.LSP_E2E === "1";
// test -> electron -> desktop: the package root, not the monorepo root.
const desktopRoot = join(import.meta.dirname, "..", "..");

describe("real typescript-language-server", { skip: enabled ? false : "set LSP_E2E=1 to run" }, () => {
  it("answers a definition through the shipped client", async () => {
    const file = join(desktopRoot, "electron", "main", "lsp", "tools.ts");
    const source = readFileSync(file, "utf8");
    const lines = source.split(/\r?\n/);
    const lineIndex = lines.findIndex((line) => line.includes("discoverServer(filePath"));
    assert.ok(lineIndex > 0, "the call site the test navigates from still exists");
    const column = lines[lineIndex].indexOf("discoverServer(filePath") + 1;

    const discovery = discoverServer(file, desktopRoot, process.env.PATH ?? "");
    assert.equal(discovery.ok, true, discovery.ok ? "" : discovery.reason);
    if (!discovery.ok) return;

    const client = await LspClient.start(
      { command: discovery.executable, args: discovery.spec.args, label: discovery.spec.label },
      desktopRoot,
      { initializeMs: 120_000, requestMs: 60_000, shutdownMs: 5_000 },
    );
    try {
      const uri = `file:///${file.replace(/\\/g, "/")}`;
      client.notify("textDocument/didOpen", {
        textDocument: { uri, languageId: "typescript", version: 1, text: source },
      });
      // A cold server builds its program before it can answer; there is no event to wait
      // for, so give it a moment rather than racing it.
      await new Promise((done) => setTimeout(done, 4_000));
      const result = await client.request(
        "textDocument/definition",
        { textDocument: { uri }, position: { line: lineIndex, character: column - 1 } },
        60_000,
      );
      const locations = Array.isArray(result) ? result : result ? [result] : [];
      assert.ok(locations.length > 0, "a definition came back");
      // A symbol reached through an import resolves to the import binding first; that is
      // TypeScript's behaviour, and the assertion is about the round trip, not the hop.
      const target = decodeURIComponent(locations[0].uri ?? "");
      assert.ok(target.endsWith("tools.ts"), `unexpected location: ${target}`);
      assert.equal(typeof locations[0].range?.start?.line, "number");
    } finally {
      await client.shutdown();
    }
  });
});
