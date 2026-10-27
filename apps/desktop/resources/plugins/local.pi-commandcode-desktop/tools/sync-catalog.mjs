/**
 * Regenerate lib/catalog-data.js.
 *
 * Two inputs are merged:
 *
 *   1. the live Command Code catalog
 *      https://api.commandcode.ai/provider/v1/models
 *      -> model ids, display names, context windows, supported endpoints
 *
 *   2. a capability snapshot for image input, reasoning flags, effort levels and
 *      output limits. The Provider API does not publish these, and the Command
 *      Code CLI no longer ships them as a static table (it resolves them at
 *      runtime), so they are taken from the community provider package
 *      `pi-commandcode-provider`, which tracks the CLI catalog and is the same
 *      source this plugin was ported from.
 *
 * Usage:
 *   node tools/sync-catalog.mjs                     # fetch the published provider package
 *   node tools/sync-catalog.mjs --from <dir>        # use a local checkout
 *   node tools/sync-catalog.mjs --dry-run           # report without writing
 *
 * The snapshot is read as **data**, never executed. See readTable().
 */

import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const outFile = join(root, "lib", "catalog-data.js")
const MODELS_URL =
  process.env.COMMANDCODE_MODELS_URL ?? "https://api.commandcode.ai/provider/v1/models"
const SNAPSHOT_PACKAGE = process.env.COMMAND_CODE_SNAPSHOT_PACKAGE ?? "pi-commandcode-provider@latest"

const args = process.argv.slice(2)
const dryRun = args.includes("--dry-run")
const fromIndex = args.indexOf("--from")
const DEFAULT_MAX_OUTPUT = 32_000

/** Character codes used below, so this file needs no escape sequences. */
const CODE = {
  newline: 10,
  carriageReturn: 13,
  space: 32,
  tab: 9,
  comma: 44,
  underscore: 95,
  openBrace: 123,
  closeBrace: 125,
  openBracket: 91,
  closeBracket: 93,
  quote: 34,
  backslash: 92,
  zero: 48,
  nine: 57,
}

function isWhitespaceCode(code) {
  return code === CODE.space || code === CODE.newline || code === CODE.tab || code === CODE.carriageReturn
}

function isDigitCode(code) {
  return code >= CODE.zero && code <= CODE.nine
}

/** Locate the capability snapshot module inside a package or checkout. */
function findSnapshot(dir) {
  const candidates = [
    "src/commandcode-catalog.ts",
    "src/commandcode-catalog.js",
    "dist/commandcode-catalog.js",
    "commandcode-catalog.js",
  ]
  const found = candidates.map((rel) => join(dir, rel)).find((p) => existsSync(p))
  if (!found) {
    throw new Error(
      `no commandcode-catalog module under ${dir}; pass --from <dir> pointing at a pi-commandcode-provider checkout`,
    )
  }
  return found
}

/** Index just past the `=` of `export const <name> ... =`, or -1. */
function findDeclarationValueStart(source, name) {
  const prefix = `export const ${name}`
  let offset = 0
  for (const line of source.split(String.fromCharCode(CODE.newline))) {
    const trimmed = line.trim()
    if (trimmed.startsWith(prefix)) {
      const following = trimmed.charAt(prefix.length)
      // Guard against a longer sibling name that merely starts with this one.
      const isIdentifierChar = /[A-Za-z0-9_]/.test(following)
      if (!isIdentifierChar) {
        const equals = line.indexOf("=")
        if (equals >= 0) return offset + equals + 1
      }
    }
    offset += line.length + 1
  }
  return -1
}

/**
 * Extract a balanced `{...}` literal starting at or after `from`.
 *
 * String-aware, so a brace inside a quoted key cannot unbalance the scan.
 */
function extractObjectLiteral(source, from) {
  const open = source.indexOf("{", from)
  if (open < 0) return undefined
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = open; index < source.length; index++) {
    const code = source.charCodeAt(index)
    if (inString) {
      if (escaped) escaped = false
      else if (code === CODE.backslash) escaped = true
      else if (code === CODE.quote) inString = false
      continue
    }
    if (code === CODE.quote) inString = true
    else if (code === CODE.openBrace) depth += 1
    else if (code === CODE.closeBrace) {
      depth -= 1
      if (depth === 0) return source.slice(open, index + 1)
    }
  }
  return undefined
}

/**
 * Turn the generator's JavaScript literal into strict JSON text.
 *
 * Only two JavaScript-only spellings appear in the snapshot: numeric separators
 * (1_000) and trailing commas. Both are removed by scanning characters, so no
 * regular expression escaping is involved.
 */
function toJsonText(literal) {
  const withoutSeparators = []
  for (let index = 0; index < literal.length; index++) {
    const code = literal.charCodeAt(index)
    if (code === CODE.underscore) {
      const before = literal.charCodeAt(index - 1)
      const after = literal.charCodeAt(index + 1)
      if (isDigitCode(before) && isDigitCode(after)) continue
    }
    withoutSeparators.push(literal[index])
  }

  const text = withoutSeparators.join("")
  const output = []
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (code === CODE.comma) {
      let lookahead = index + 1
      while (lookahead < text.length && isWhitespaceCode(text.charCodeAt(lookahead))) lookahead += 1
      const next = text.charCodeAt(lookahead)
      if (next === CODE.closeBrace || next === CODE.closeBracket) continue
    }
    output.push(text[index])
  }
  return output.join("")
}

/**
 * Read one `export const NAME ... = {...}` table out of the snapshot file.
 *
 * The snapshot is generated, so its values are pure data: objects, arrays,
 * strings, numbers and booleans. That means the literal can be **parsed**
 * instead of executed. An earlier version built a function object out of the
 * file text, which would have run whatever code a compromised or malformed
 * snapshot contained - a real injection surface for a tool that reads text
 * fetched from npm. This version never evaluates anything: it normalises the two
 * JavaScript-only spellings above, then hands the result to `JSON.parse`, which
 * accepts no expressions at all.
 */
function readTable(source, name, file) {
  const start = findDeclarationValueStart(source, name)
  if (start < 0) throw new Error(`${file} has no ${name} declaration`)

  const literal = extractObjectLiteral(source, start)
  if (!literal) throw new Error(`${file}: ${name} is not a balanced object literal`)

  try {
    return JSON.parse(toJsonText(literal))
  } catch (error) {
    // A parse failure means the snapshot uses a construct this tool does not
    // understand. Failing loudly is the point: silently executing it is exactly
    // what is being removed here.
    throw new Error(
      `${file}: ${name} is not a data-only literal (${error.message}); refusing to evaluate it`,
    )
  }
}

/**
 * Read the snapshot's data tables.
 *
 * The module is TypeScript with `export const X: Readonly<Record<...>> = {...}`
 * declarations; the type annotations are skipped and each object literal is
 * parsed as data.
 */
function readSnapshot(dir) {
  const file = findSnapshot(dir)
  const source = readFileSync(file, "utf8")
  const versionStart = findDeclarationValueStart(source, "COMMAND_CODE_CLI_VERSION")
  let version = "unknown"
  if (versionStart >= 0) {
    const quoted = source.indexOf(String.fromCharCode(CODE.quote), versionStart)
    const closing = source.indexOf(String.fromCharCode(CODE.quote), quoted + 1)
    if (quoted >= 0 && closing > quoted) version = source.slice(quoted + 1, closing)
  }

  const value = {
    version,
    inputModalities: readTable(source, "MODEL_INPUT_MODALITIES", file),
    reasoning: readTable(source, "MODEL_REASONING", file),
    efforts: readTable(source, "MODEL_EFFORTS", file),
    maxOutputTokens: readTable(source, "MODEL_MAX_OUTPUT_TOKENS", file),
  }

  if (!value.inputModalities || !value.reasoning) {
    throw new Error(`${file} did not expose the expected capability tables`)
  }
  return value
}

function fetchSnapshotPackage() {
  const dir = mkdtempSync(join(tmpdir(), "cc-snapshot-"))
  console.log(`fetching ${SNAPSHOT_PACKAGE} …`)
  execFileSync("npm", ["pack", SNAPSHOT_PACKAGE, "--silent"], {
    cwd: dir,
    stdio: "inherit",
    shell: process.platform === "win32",
  })
  const tarball = readdirSync(dir).find((name) => name.endsWith(".tgz"))
  if (!tarball) throw new Error("npm pack did not produce a tarball")
  execFileSync("tar", ["-xzf", tarball], { cwd: dir, stdio: "inherit" })
  return join(dir, "package")
}

async function readLiveCatalog() {
  const response = await fetch(MODELS_URL, { headers: { accept: "application/json" } })
  if (!response.ok) throw new Error(`catalog request failed: ${response.status}`)
  const payload = await response.json()
  const data = Array.isArray(payload?.data) ? payload.data : undefined
  if (!data) throw new Error("the catalog response had no data array")
  return data
}

function build(live, snapshot) {
  const models = []
  const skipped = []

  for (const entry of live) {
    if (!entry || typeof entry.id !== "string" || !entry.id.trim()) {
      skipped.push(entry)
      continue
    }
    const id = entry.id
    const contextWindow =
      Number.isInteger(entry.context_length) && entry.context_length > 0
        ? entry.context_length
        : 128_000
    const endpoints = Array.isArray(entry.supported_endpoints) ? entry.supported_endpoints : []
    const modalities = snapshot.inputModalities[id]
    const maxTokens = Math.min(
      contextWindow,
      snapshot.maxOutputTokens?.[id] ?? DEFAULT_MAX_OUTPUT,
    )

    models.push({
      id,
      name: typeof entry.name === "string" && entry.name.trim() ? entry.name : id,
      contextWindow,
      maxTokens,
      image: Array.isArray(modalities) && modalities.includes("image"),
      reasoning: snapshot.reasoning[id] === true,
      efforts: Array.isArray(snapshot.efforts?.[id]) ? snapshot.efforts[id] : [],
      endpoints,
    })
  }

  models.sort((a, b) => a.id.localeCompare(b.id))
  return { models, skipped }
}

function render(snapshotVersion, models) {
  return `/**
 * Generated capability snapshot for Command Code (catalog ${snapshotVersion}).
 *
 * Sources:
 *   - ids, display names, context windows, endpoints: ${MODELS_URL}
 *   - image input, reasoning flags, effort levels, output limits: ${SNAPSHOT_PACKAGE} (${snapshotVersion})
 *
 * Regenerate with: npm run sync:catalog
 * Do not edit by hand.
 */

const CATALOG_CLI_VERSION = ${JSON.stringify(snapshotVersion)}

const CATALOG = ${JSON.stringify(models, null, 2)}

module.exports = { CATALOG_CLI_VERSION, CATALOG }
`
}

const snapshotDir = fromIndex >= 0 && args[fromIndex + 1] ? args[fromIndex + 1] : fetchSnapshotPackage()
const snapshot = readSnapshot(snapshotDir)
const live = await readLiveCatalog()
const { models, skipped } = build(live, snapshot)

const missing = models.filter((m) => !snapshot.inputModalities[m.id] && !snapshot.reasoning[m.id])
const chat = models.filter((m) => m.endpoints.includes("/chat/completions"))
const claude = models.filter((m) => !m.endpoints.includes("/chat/completions"))

console.log(`snapshot:      ${snapshot.version}`)
console.log(`models:        ${models.length}${skipped.length ? ` (${skipped.length} skipped)` : ""}`)
console.log(`vision-capable:${String(models.filter((m) => m.image).length).padStart(4)}`)
console.log(`reasoning:     ${String(models.filter((m) => m.reasoning).length).padStart(4)}`)
console.log(`with efforts:  ${String(models.filter((m) => m.efforts.length > 0).length).padStart(4)}`)
console.log(`endpoints:     ${chat.length} chat/completions, ${claude.length} messages-only`)

if (missing.length > 0) {
  console.log("")
  console.log(
    `note: ${missing.length} model(s) have no capability metadata and default to text-only:`,
  )
  for (const model of missing) console.log(`  ${model.id}`)
}

if (dryRun) {
  console.log("")
  console.log("--dry-run: nothing written")
} else {
  writeFileSync(outFile, render(snapshot.version, models), "utf8")
  console.log("")
  console.log(`wrote ${outFile}`)
}
