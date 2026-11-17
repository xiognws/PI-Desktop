/**
 * Which language server to run for a file, and what to say when there is none.
 *
 * Discovery is deliberately dumb: look for a known binary on PATH, or a project-local
 * install (`node_modules/.bin`, a venv). Nothing is downloaded at runtime and nothing
 * is guessed — a missing server is a normal state, and the tool reports which binary
 * it looked for and where, because "no definition found" from a client that never
 * started a server is indistinguishable from a real answer.
 */
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

export type ServerSpec = {
  /** Language id sent in `textDocument` params. */
  languageId: string;
  /** Human label for errors and logs. */
  label: string;
  command: string;
  args: string[];
  /** Files that make this server the right one. */
  extensions: string[];
};

/**
 * The servers this client knows how to start.
 *
 * Ordered most-specific first: `.ts` must reach the TypeScript server rather than a
 * generic JS one, and `.tsx` maps to `typescriptreact` because the server picks its
 * grammar from the language id.
 */
export const KNOWN_SERVERS: ServerSpec[] = [
  {
    languageId: "rust",
    label: "rust-analyzer",
    command: "rust-analyzer",
    args: [],
    extensions: [".rs"],
  },
  {
    languageId: "python",
    label: "pyright",
    command: "pyright-langserver",
    args: ["--stdio"],
    extensions: [".py", ".pyi"],
  },
  {
    languageId: "typescript",
    label: "typescript-language-server",
    command: "typescript-language-server",
    args: ["--stdio"],
    extensions: [".ts", ".mts", ".cts"],
  },
  {
    languageId: "typescriptreact",
    label: "typescript-language-server",
    command: "typescript-language-server",
    args: ["--stdio"],
    extensions: [".tsx"],
  },
  {
    languageId: "go",
    label: "gopls",
    command: "gopls",
    args: [],
    extensions: [".go"],
  },
];

export type Discovery =
  | { ok: true; spec: ServerSpec; executable: string }
  | { ok: false; reason: string; lookedFor: string[] };

/**
 * Resolve the server for a path.
 *
 * `projectRoot` is searched as well as PATH: a project that pins
 * `typescript-language-server` in its own `node_modules/.bin` should use that version
 * rather than whatever the user has globally, or answers come from a different
 * compiler than the one the project builds with.
 */
export function discoverServer(
  filePath: string,
  projectRoot: string,
  searchPath: string = process.env.PATH ?? "",
): Discovery {
  const lower = filePath.toLowerCase();
  const spec = KNOWN_SERVERS.find((candidate) =>
    candidate.extensions.some((extension) => lower.endsWith(extension)),
  );
  if (!spec) {
    return {
      ok: false,
      reason: `no language server is configured for ${filePath}`,
      lookedFor: KNOWN_SERVERS.map((candidate) => candidate.extensions.join("/")),
    };
  }
  const directories = [
    join(projectRoot, "node_modules", ".bin"),
    join(projectRoot, ".venv", "Scripts"),
    join(projectRoot, ".venv", "bin"),
    join(projectRoot, "venv", "Scripts"),
    ...searchPath.split(delimiter).filter(Boolean),
  ];
  const names = process.platform === "win32"
    ? [`${spec.command}.cmd`, `${spec.command}.exe`, spec.command]
    : [spec.command];
  for (const directory of directories) {
    for (const name of names) {
      const candidate = join(directory, name);
      if (existsSync(candidate)) return { ok: true, spec, executable: candidate };
    }
  }
  return {
    ok: false,
    reason: `${spec.label} is not installed`,
    // The list of directories is the actionable part: "not installed" alone leaves
    // the reader guessing whether it is on PATH at all.
    lookedFor: directories.map((directory) => join(directory, spec.command)),
  };
}
