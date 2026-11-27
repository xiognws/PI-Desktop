/**
 * Which grammar a file gets in the file viewer.
 *
 * The viewer highlights through Shiki, and Shiki only resolves the id it is
 * given. A file whose extension is not in this table falls back to a plain
 * `<pre>`, which is why "open a .cpp and read it" used to depend on the
 * extension having been thought of. The ids here are Shiki's own (see
 * `shiki.ts`); anything Shiki does not bundle is deliberately left out rather
 * than mapped to a wrong grammar.
 */

/** Extension → Shiki language id. Keep in step with `LANGUAGE_DEFINITIONS`. */
const EXTENSION_LANGUAGE: Record<string, string> = {
  // C family
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  "c++": "cpp",
  hpp: "cpp",
  hh: "cpp",
  hxx: "cpp",
  ino: "cpp",
  cs: "csharp",
  csx: "csharp",
  // Systems and application languages
  rs: "rust",
  go: "go",
  py: "python",
  pyi: "python",
  pyw: "python",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  scala: "scala",
  sc: "scala",
  swift: "swift",
  dart: "dart",
  lua: "lua",
  rb: "ruby",
  rake: "ruby",
  gemspec: "ruby",
  php: "php",
  phtml: "php",
  groovy: "groovy",
  prisma: "prisma",
  proto: "proto",
  graphql: "graphql",
  gql: "graphql",
  // Web
  ts: "typescript",
  cts: "typescript",
  mts: "typescript",
  tsx: "tsx",
  js: "javascript",
  cjs: "javascript",
  mjs: "javascript",
  jsx: "jsx",
  vue: "vue",
  svelte: "svelte",
  astro: "astro",
  html: "html",
  htm: "html",
  css: "css",
  scss: "css",
  sass: "css",
  less: "css",
  xml: "xml",
  xsl: "xml",
  xsd: "xml",
  svg: "xml",
  plist: "xml",
  csproj: "xml",
  // Data and configuration
  json: "json",
  jsonc: "jsonc",
  json5: "jsonc",
  jsonl: "jsonl",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  ini: "ini",
  conf: "ini",
  cfg: "ini",
  properties: "ini",
  editorconfig: "ini",
  env: "dotenv",
  hcl: "hcl",
  tf: "terraform",
  tfvars: "terraform",
  nginx: "nginx",
  // Scripts, documents, tool output
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  ksh: "shellscript",
  fish: "shellscript",
  ps1: "powershell",
  psm1: "powershell",
  psd1: "powershell",
  ps: "powershell",
  bat: "bat",
  cmd: "bat",
  sql: "sql",
  md: "markdown",
  markdown: "markdown",
  mdx: "mdx",
  mmd: "mermaid",
  diff: "diff",
  patch: "diff",
};

/**
 * Whole-name matches for the files that carry no extension. Interpreter
 * directives and dotfiles are matched as names because that is all they have.
 */
const NAME_LANGUAGE: Record<string, string> = {
  dockerfile: "docker",
  containerfile: "docker",
  makefile: "make",
  gnumakefile: "make",
  ".gitignore": "dotenv",
  ".dockerignore": "dotenv",
  ".npmrc": "ini",
  ".editorconfig": "ini",
  ".env": "dotenv",
  ".env.local": "dotenv",
  ".env.example": "dotenv",
};

/**
 * The Shiki language id for a path, or `null` when Shiki bundles no grammar for
 * it — in which case the viewer shows the text unhighlighted, on purpose.
 */
export function languageForFilePath(path: string): string | null {
  const name = path.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (!name) return null;
  const byName = NAME_LANGUAGE[name];
  if (byName) return byName;
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return null;
  const extension = name.slice(dot + 1);
  return EXTENSION_LANGUAGE[extension] ?? null;
}

/** The extensions and names this table maps, for contract tests. */
export const FILE_LANGUAGE_KEYS = {
  extensions: Object.keys(EXTENSION_LANGUAGE).sort(),
  names: Object.keys(NAME_LANGUAGE).sort(),
};
