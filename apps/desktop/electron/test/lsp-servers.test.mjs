import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

const { discoverServer } = await import("../main/lsp/servers.ts");

/*
 * Discovery decides whether the agent gets a real answer or a lie. The properties
 * that matter:
 *
 *  - a project-local server wins over a global one, so the answers come from the
 *     compiler the project actually builds with;
 *  - a file type with no configured server is refused with a reason, not guessed at;
 *  - "not installed" lists where it looked, because otherwise the reader cannot tell
 *    a missing binary from a broken PATH.
 */

function withProject(run) {
  const root = mkdtempSync(join(tmpdir(), "lsp-servers-"));
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("discoverServer", () => {
  it("prefers the project-local binary over the one on PATH", () => {
    withProject((root) => {
      const bin = join(root, "node_modules", ".bin");
      mkdirSync(bin, { recursive: true });
      const local = join(bin, process.platform === "win32" ? "typescript-language-server.cmd" : "typescript-language-server");
      writeFileSync(local, "");

      const found = discoverServer(join(root, "src", "main.ts"), root, "");
      assert.equal(found.ok, true);
      if (!found.ok) return;
      assert.equal(found.executable, local);
      assert.equal(found.spec.languageId, "typescript");
    });
  });

  it("finds a server on PATH when the project has none", () => {
    withProject((root) => {
      const bin = join(root, "global-bin");
      mkdirSync(bin, { recursive: true });
      const name = process.platform === "win32" ? "gopls.cmd" : "gopls";
      writeFileSync(join(bin, name), "");

      const found = discoverServer(join(root, "cmd", "x.go"), root, bin);
      assert.equal(found.ok, true);
      if (!found.ok) return;
      assert.equal(found.spec.languageId, "go");
    });
  });

  it("maps tsx to typescriptreact so the server picks the right grammar", () => {
    withProject((root) => {
      const bin = join(root, "node_modules", ".bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, process.platform === "win32" ? "typescript-language-server.cmd" : "typescript-language-server"), "");
      const found = discoverServer(join(root, "App.tsx"), root, "");
      assert.equal(found.ok, true);
      if (!found.ok) return;
      assert.equal(found.spec.languageId, "typescriptreact");
    });
  });

  it("refuses an unknown file type instead of guessing", () => {
    withProject((root) => {
      const found = discoverServer(join(root, "notes.md"), root, "");
      assert.equal(found.ok, false);
      if (found.ok) return;
      assert.match(found.reason, /no language server is configured/);
    });
  });

  it("says where it looked when the binary is missing", () => {
    withProject((root) => {
      const found = discoverServer(join(root, "main.rs"), root, "");
      assert.equal(found.ok, false);
      if (found.ok) return;
      assert.match(found.reason, /rust-analyzer is not installed/);
      // The directories are the actionable part of the message.
      assert.ok(found.lookedFor.length >= 2);
      assert.ok(found.lookedFor.some((entry) => entry.includes("node_modules")));
    });
  });
});
