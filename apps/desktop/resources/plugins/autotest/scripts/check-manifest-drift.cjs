#!/usr/bin/env node
/**
 * Guard against schema drift between manifest.json and the TOOLS array in main.js.
 *
 * The plugin ships its tool schemas twice: once in the manifest (what the host
 * reads to build the agent tool surface) and once in main.js (what the plugin
 * actually registers with pi.agent.registerTool). Nothing in the test suite
 * compares the two, so a parameter can silently exist on one side only — the
 * model then calls a documented field the handler never reads, or the host
 * advertises a required field the plugin never accepts.
 *
 * main.js is parsed as text on purpose: requiring it executes plugin code and
 * expects a host-injected 'pi' global, so the module cannot be loaded here.
 *
 * Exit codes: 0 = no drift, 1 = drift, 2 = could not parse either side.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PLUGIN_DIR = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(PLUGIN_DIR, 'manifest.json');
const MAIN_PATH = path.join(PLUGIN_DIR, 'main.js');

/** Strip a trailing comma from a slice of source. */
function trimTrailingComma(text) {
  return text.replace(/,\s*$/, '').trim();
}

/** Split a brace/bracket body on top-level commas, respecting nesting and quotes. */
function splitTopLevel(body) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let current = '';
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (quote) {
      current += ch;
      if (ch === '\\') {
        current += body[i + 1] ?? '';
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '{' || ch === '[' || ch === '(') depth += 1;
    if (ch === '}' || ch === ']' || ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

/**
 * Read the balanced {...} or [...] block that starts at 'open' in source.
 *
 * Comments are skipped along with strings. They have to be: a `//` line that
 * mentions an unbalanced quote — an apostrophe in prose is enough — otherwise
 * opens a string the scanner never closes, and the error surfaces as
 * "unbalanced { starting at <a perfectly balanced object>" pointing at code
 * that is fine. This checker parses source with a scanner, so it owes the same
 * respect to comments that it already pays to strings.
 */
function readBalanced(source, open) {
  const opener = source[open];
  const closer = opener === '{' ? '}' : ']';
  let depth = 0;
  let quote = null;
  let lineComment = false;
  let blockComment = false;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];
    if (lineComment) {
      if (ch === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === '*' && next === '/') {
        blockComment = false;
        i += 1;
      }
      continue;
    }
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '/' && next === '/') {
      lineComment = true;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      blockComment = true;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === opener) depth += 1;
    else if (ch === closer) {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error('unbalanced ' + opener + ' starting at offset ' + open);
}

/**
 * Find 'key:' at nesting depth 0 in an unwrapped body. Callers pass a slice
 * that still carries its own outer braces, so the scanner skips a leading '{'
 * (or '[') and treats a closing '}' at depth 0 as the end of the body.
 */
function findTopLevelKey(rawBody, key) {
  const needle = key + ':';
  const trimmed = rawBody.trim();
  const unwrapped =
    (trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))
      ? trimmed.slice(1, -1)
      : trimmed;
  return scanTopLevelKey(unwrapped, needle);
}

/** Depth-0 key scan over a body whose outer delimiters were already removed. */
function scanTopLevelKey(body, needle) {
  let depth = 0;
  let quote = null;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '{' || ch === '[' || ch === '(') depth += 1;
    else if (ch === '}' || ch === ']' || ch === ')') depth -= 1;
    else if (depth === 0 && body.startsWith(needle, i)) {
      const before = i === 0 ? '' : body[i - 1];
      if (before === '' || /[\s,]/.test(before)) return i + needle.length;
    }
  }
  return -1;
}

/**
 * Read 'key: <value>' at top level of a body. The value ends at the first
 * top-level comma or at the closing delimiter of the body itself; both the
 * raw (braced) and unwrapped forms are accepted.
 */
function readTopLevelValue(rawBody, key) {
  const trimmed = rawBody.trim();
  const wrapped =
    (trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'));
  // Scan the raw body so the offset from findTopLevelKey stays meaningful; a
  // body wrapped in its own braces is entered at depth 1 and unwrapped as we go.
  const body = wrapped ? trimmed.slice(1, -1) : trimmed;
  const rawStart = wrapped ? scanTopLevelKey(body, key + ':') : findTopLevelKey(body, key);
  if (rawStart < 0) return undefined;
  const start = wrapped ? rawStart : rawStart;
  let depth = 0;
  let quote = null;
  for (let i = start; i < body.length; i += 1) {
    const ch = body[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '{' || ch === '[' || ch === '(') {
      depth += 1;
      continue;
    }
    if (ch === '}' || ch === ']' || ch === ')') {
      depth -= 1;
      continue;
    }
    if (depth === 0 && (ch === ',' || i === body.length - 1)) {
      return trimTrailingComma(body.slice(start, i === body.length - 1 ? undefined : i));
    }
  }
  return trimTrailingComma(body.slice(start));
}

/** Parse a JS string literal (single or double quoted, no interpolation). */
function parseStringLiteral(text) {
  const trimmed = text.trim();
  const quote = trimmed[0];
  if (quote !== "'" && quote !== '"') return undefined;
  if (trimmed[trimmed.length - 1] !== quote) return undefined;
  return trimmed
    .slice(1, -1)
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

/** Collect the shared schema constants (PLAN_ID, TEST_CASE_IDS, ...) from main.js. */
function parseConstants(source) {
  const constants = {};
  const re = /^const\s+([A-Z][A-Z0-9_]*)\s*=\s*\{/gm;
  let match;
  while ((match = re.exec(source)) !== null) {
    const body = readBalanced(source, match.index + match[0].length - 1);
    constants[match[1]] = body;
  }
  return constants;
}

/** Unwrap one '{ ... }' slice into its body text, tolerating a bare constant name. */
function unwrapObject(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed.slice(1, -1);
  return trimmed;
}

/**
 * Resolve one property slice from a properties body into a comparable shape.
 * Handles the three spellings main.js uses: an inline object literal, a bare
 * shared-constant reference ('planId: PLAN_ID'), and a spread with an override
 * ('{ ...TEST_CASE_IDS, description: ... }').
 */
function parsePropertySlice(slice, constants) {
  const text = slice.trim();

  // A bare reference such as 'planId: PLAN_ID' reuses a shared constant verbatim.
  const bare = text.match(/^([A-Z][A-Z0-9_]*)$/);
  if (bare) {
    const base = constants[bare[1]];
    if (base === undefined) throw new Error('unknown schema constant ' + bare[1]);
    return parsePropertySlice(base, constants);
  }

  const body = unwrapObject(text);
  const shape = {};

  // Spread form: seed from the referenced constant, then apply the inline override.
  const spreadHead = body.match(/^\s*\.\.\.\s*([A-Z][A-Z0-9_]*)/);
  if (spreadHead) {
    const base = constants[spreadHead[1]];
    if (base === undefined) throw new Error('unknown schema constant ' + spreadHead[1]);
    Object.assign(shape, parsePropertySlice(base, constants));
  }

  const type = readTopLevelValue(body, 'type');
  if (type !== undefined) shape.type = parseStringLiteral(type) ?? type;
  const enumValue = readTopLevelValue(body, 'enum');
  if (enumValue !== undefined) {
    const enumBody = readBalanced(enumValue, enumValue.indexOf('['));
    shape.enum = splitTopLevel(enumBody).map((entry) => parseStringLiteral(entry) ?? entry);
  }
  const items = readTopLevelValue(body, 'items');
  if (items !== undefined) {
    if (items.trim().startsWith('{')) {
      const inner = {};
      const itemType = readTopLevelValue(items, 'type');
      if (itemType !== undefined) inner.type = parseStringLiteral(itemType) ?? itemType;
      shape.items = inner;
    } else {
      shape.items = { ref: items.trim() };
    }
  }
  const desc = readTopLevelValue(body, 'description');
  if (desc !== undefined) shape.description = parseStringLiteral(desc) ?? desc;
  return shape;
}

/**
 * Properties the manifest may declare on top of main.js without that being
 * drift. 'autotest_run.maxOutput' is the one live case: lib/runner.js honours
 * it (runner.js:141 falls back to DEFAULT_MAX_OUTPUT 4096), but the tool schema
 * in main.js does not advertise it yet, so the manifest is deliberately ahead.
 */
const MANIFEST_ONLY_PROPERTIES = {
  autotest_run: ['maxOutput'],
};

/** Parse the per-tool blocks out of the TOOLS array in main.js source. */
function parseTools(source) {
  const constants = parseConstants(source);
  const anchor = source.indexOf('const TOOLS = [');
  if (anchor < 0) throw new Error('could not find "const TOOLS = [" in main.js');
  const arrayBody = readBalanced(source, anchor + 'const TOOLS = '.length);
  const tools = [];
  for (const entry of splitTopLevel(arrayBody)) {
    if (!entry.startsWith('{')) continue;
    const body = readBalanced(entry, 0);
    const name = parseStringLiteral(readTopLevelValue(body, 'name') ?? '');
    if (!name) throw new Error('a TOOLS entry has no readable name');
    const tool = { name, risk: undefined, description: undefined, properties: {}, required: [] };

    const risk = readTopLevelValue(body, 'risk');
    if (risk !== undefined) tool.risk = parseStringLiteral(risk) ?? risk;

    const description = readTopLevelValue(body, 'description');
    if (description !== undefined) tool.description = parseStringLiteral(description) ?? description;

    const schema = readTopLevelValue(body, 'schema');
    if (schema === undefined) throw new Error('tool ' + name + ' has no schema');
    const schemaBody = readBalanced(schema, schema.indexOf('{'));

    const properties = readTopLevelValue(schemaBody, 'properties');
    if (properties !== undefined) {
      const propsBody = readBalanced(properties, properties.indexOf('{'));
      for (const prop of splitTopLevel(propsBody)) {
        const sep = prop.indexOf(':');
        if (sep < 0) continue;
        const key = prop.slice(0, sep).trim();
        if (!/^[A-Za-z_$][\w$]*$/.test(key)) continue;
        tool.properties[key] = parsePropertySlice(prop.slice(sep + 1), constants);
      }
    }

    const required = readTopLevelValue(schemaBody, 'required');
    if (required !== undefined) {
      const reqBody = readBalanced(required, required.indexOf('['));
      tool.required = splitTopLevel(reqBody).map((entry) => parseStringLiteral(entry) ?? entry);
    }
    tools.push(tool);
  }
  return tools;
}

/** Normalise a manifest agentTool entry into the same comparable shape. */
function manifestToolShape(entry) {
  const schema = entry.schema ?? {};
  const shape = {
    name: entry.name,
    risk: entry.risk,
    description: entry.description,
    properties: {},
    required: Array.isArray(schema.required) ? schema.required.slice() : [],
  };
  for (const [key, value] of Object.entries(schema.properties ?? {})) {
    const prop = {};
    if (value.type !== undefined) prop.type = value.type;
    if (value.enum !== undefined) prop.enum = value.enum.slice();
    if (value.items !== undefined) prop.items = { type: value.items.type };
    if (value.description !== undefined) prop.description = value.description;
    shape.properties[key] = prop;
  }
  return shape;
}

/** Compare one property map and push readable differences. */
function diffProperties(label, expected, actual, out) {
  const expectedKeys = Object.keys(expected.properties).sort();
  const actualKeys = Object.keys(actual.properties).sort();
  for (const key of expectedKeys) {
    if (!actualKeys.includes(key)) {
      out.push(label + ': missing property "' + key + '" (main.js declares it, manifest does not)');
      continue;
    }
    const a = expected.properties[key];
    const b = actual.properties[key];
    if (JSON.stringify(a.type) !== JSON.stringify(b.type)) {
      out.push(label + '.' + key + ': type drift — main.js ' + JSON.stringify(a.type) + ' vs manifest ' + JSON.stringify(b.type));
    }
    if (a.enum && b.enum && JSON.stringify(a.enum) !== JSON.stringify(b.enum)) {
      out.push(label + '.' + key + ': enum drift — main.js ' + JSON.stringify(a.enum) + ' vs manifest ' + JSON.stringify(b.enum));
    } else if (a.enum && !b.enum) {
      out.push(label + '.' + key + ': manifest drops the enum ' + JSON.stringify(a.enum));
    } else if (!a.enum && b.enum) {
      out.push(label + '.' + key + ': manifest invents an enum ' + JSON.stringify(b.enum));
    }
    if (a.items && b.items && JSON.stringify(a.items.type) !== JSON.stringify(b.items.type)) {
      out.push(label + '.' + key + ': items.type drift — main.js ' + JSON.stringify(a.items.type) + ' vs manifest ' + JSON.stringify(b.items.type));
    }
  }
  const allowed = MANIFEST_ONLY_PROPERTIES[actual.name] ?? [];
  for (const key of actualKeys) {
    if (!expectedKeys.includes(key) && !allowed.includes(key)) {
      out.push(label + ': extra property "' + key + '" (manifest declares it, main.js does not)');
    }
  }
}

function main() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const source = fs.readFileSync(MAIN_PATH, 'utf8');
  const tools = parseTools(source);
  const declared = manifest.contributes?.agentTools ?? [];

  const problems = [];
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const declaredByName = new Map(declared.map((tool) => [tool.name, tool]));

  for (const name of byName.keys()) {
    if (!declaredByName.has(name)) {
      problems.push('tool "' + name + '" is registered in main.js but missing from manifest.contributes.agentTools');
    }
  }
  for (const name of declaredByName.keys()) {
    if (!byName.has(name)) {
      problems.push('tool "' + name + '" is declared in the manifest but absent from main.js TOOLS');
    }
  }

  for (const tool of tools) {
    const entry = declaredByName.get(tool.name);
    if (!entry) continue;
    const shape = manifestToolShape(entry);
    diffProperties(tool.name, tool, shape, problems);
    if (JSON.stringify(tool.required) !== JSON.stringify(shape.required)) {
      problems.push(tool.name + ': required drift — main.js ' + JSON.stringify(tool.required) + ' vs manifest ' + JSON.stringify(shape.required));
    }
    if (tool.risk !== shape.risk) {
      problems.push(tool.name + ': risk drift — main.js ' + JSON.stringify(tool.risk) + ' vs manifest ' + JSON.stringify(shape.risk));
    }
    if (tool.description !== shape.description) {
      problems.push(tool.name + ': description drift (informational) — main.js and manifest copy differ');
    }
  }

  // activationEvents / commands cross-check against the register call in main.js.
  const registered = [...source.matchAll(/id:\s*'([a-z][\w.-]*\.[\w.-]+)'/g)].map((match) => match[1]);
  for (const event of manifest.activationEvents ?? []) {
    if (!event.startsWith('onCommand:')) continue;
    const command = event.slice('onCommand:'.length);
    if (!registered.includes(command)) {
      problems.push('activationEvents names "' + command + '" but main.js has no matching register call');
    }
  }
  for (const command of registered) {
    if (!(manifest.activationEvents ?? []).includes('onCommand:' + command)) {
      problems.push('main.js registers "' + command + '" but activationEvents has no onCommand entry for it');
    }
  }
  const declaredCommands = (manifest.contributes?.commands ?? []).map((command) => command.id);
  for (const command of registered) {
    if (!declaredCommands.includes(command)) {
      problems.push('main.js registers "' + command + '" but contributes.commands does not declare it');
    }
  }
  for (const command of declaredCommands) {
    if (!registered.includes(command)) {
      problems.push('contributes.commands declares "' + command + '" but main.js never registers it');
    }
  }

  if (problems.length) {
    console.error('manifest/main.js drift detected (' + problems.length + '):');
    for (const problem of problems) console.error('  - ' + problem);
    process.exit(1);
  }
  console.log('no manifest/main.js drift: ' + tools.length + ' tools, ' + registered.length + ' commands checked');
}

try {
  main();
} catch (error) {
  console.error('check-manifest-drift could not run: ' + (error && error.message));
  process.exit(2);
}
