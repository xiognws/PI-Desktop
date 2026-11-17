import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

const { discoverServer, KNOWN_SERVERS } = await import("../main/lsp/servers.ts");

/*
 * Scope is this project only: TypeScript and JavaScript through
 * typescript-language-server. The properties that matter:
 *
 *  - a project-local server wins over a global one, so answers come from the compiler
 *    the project actually builds with;
 *  - `.tsx`/`.jsx` reach the react language ids, or the server parses JSX as an error;
 *  - a language we do not support is refused with a reason instead of guessed at;
 *  - "not installed" lists where it looked, because otherwise the reader cannot tell a
 *    missing binary from a broken PATH.
 */

function withProject(run) {
  const root = mkdtempSync(join(tmpdir(), "lsp-servers-"));
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const shim = () => (process.platform === "win32" ? "typescript-language-server.cmd" : "typescript-language-server");

describe("discoverServer", () => {
  it("only knows the languages this project uses", () => {
    const extensions = KNOWN_SERVERS.flatMap((spec) => spec.extensions).sort();
    assert.deepEqual(extensions, [".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);
    // No half-supported languages: an entry whose binary is never installed is worse
    // than no entry, because its error message is the same one a real failure gives.
    assert.ok(KNOWN_SERVERS.every((spec) => spec.command === "typescript-language-server"));
  });

  it("prefers the project-local binary over the one on PATH", () => {
    withProject((root) => {
      const bin = join(root, "node_modules", ".bin");
      mkdirSync(bin, { recursive: true });
      const local = join(bin, shim());
      writeFileSync(local, "");

      const found = discoverServer(join(root, "src", "main.ts"), root, "");
      assert.equal(found.ok, true);
      if (!found.ok) return;
      assert.equal(found.executable, local);
      assert.equal(found.spec.languageId, "typescript");
    });
  });

  it("falls back to PATH when the project has none", () => {
    withProject((root) => {
      const bin = join(root, "global-bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, shim()), "");

      const found = discoverServer(join(root, "src", "main.mjs"), root, bin);
      assert.equal(found.ok, true);
      if (!found.ok) return;
      assert.equal(found.spec.languageId, "javascript");
    });
  });

  it("maps tsx and jsx to the react language ids", () => {
    withProject((root) => {
      const bin = join(root, "node_modules", ".bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, shim()), "");
      const tsx = discoverServer(join(root, "App.tsx"), root, "");
      const jsx = discoverServer(join(root, "Panel.jsx"), root, "");
      assert.equal(tsx.ok && tsx.spec.languageId, "typescriptreact");
      assert.equal(jsx.ok && jsx.spec.languageId, "javascriptreact");
    });
  });

  it("refuses an unsupported language instead of guessing", () => {
    withProject((root) => {
      const rust = discoverServer(join(root, "main.rs"), root, "");
      const python = discoverServer(join(root, "tool.py"), root, "");
      assert.equal(rust.ok, false);
      assert.equal(python.ok, false);
      if (rust.ok || python.ok) return;
      assert.match(rust.reason, /no language server is configured/);
    });
  });

  it("says where it looked when the binary is missing", () => {
    withProject((root) => {
      const found = discoverServer(join(root, "main.ts"), root, "");
      assert.equal(found.ok, false);
      if (found.ok) return;
      assert.match(found.reason, /typescript-language-server is not installed/);
      assert.ok(found.lookedFor.some((entry) => entry.includes("node_modules")));
    });
  });
});
