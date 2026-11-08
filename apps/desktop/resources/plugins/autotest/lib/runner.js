'use strict';
/**
 * Script execution. Spawn only, with an argument array and no shell, so a test
 * case title can never become shell syntax. Output is captured with a hard cap
 * because plugin.call and the artifact files both have limited budget.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_MAX_OUTPUT = 64 * 1024;
/**
 * The environment gate runs one probe before any model call, and the whole tool
 * call has a 110s budget on the host side (plugin-runtime.ts:690-691). A probe
 * is a single synchronous `node -e` write; waiting the full script budget for it
 * means a hostile environment reports "exceeded 120000ms" *after* the host has
 * already given up, which is exactly how the requirement stage died once.
 */
const PROBE_TIMEOUT_MS = 10000;

function tail(text, limit) {
  const value = String(text == null ? '' : text);
  if (value.length <= limit) return { text: value, truncated: false };
  return { text: value.slice(value.length - limit), truncated: true };
}

/** Split a configured command line into argv without invoking a shell. */
function splitCommand(command) {
  const text = String(command || '').trim();
  if (!text) return [];
  const parts = [];
  let current = '';
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        parts.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current) parts.push(current);
  return parts;
}

function extensionFor(language) {
  switch (String(language || '').toLowerCase()) {
    case 'javascript':
    case 'js':
    case 'mjs':
      // CommonJS contract: the author prompt requires require()-style scripts,
      // and a bare Node run has no package.json to opt a directory into ESM.
      return '.cjs';
    case 'typescript':
    case 'ts':
      return '.ts';
    case 'python':
    case 'py':
      return '.py';
    case 'bash':
    case 'sh':
      return '.sh';
    case 'powershell':
    case 'ps1':
      return '.ps1';
    default:
      return '.txt';
  }
}

/** Write the script text next to the plan so a reviewer can read exactly what ran. */
function writeScript(scriptDir, script) {
  fs.mkdirSync(scriptDir, { recursive: true });
  const ext = extensionFor(script.language);
  const safe = String(script.testCaseId || 'script').replace(/[^A-Za-z0-9_-]+/g, '-');
  const file = path.join(scriptDir, safe + '-' + String(script.revision || 1) + ext);
  fs.writeFileSync(file, String(script.body || ''), 'utf8');
  return file;
}

/**
 * Resolve argv for one script.
 * A configured project command wins. Otherwise the script is run with the
 * current Node binary, or reported as skipped with the reason - never as passed.
 */
function resolveInvocation(script, file, options) {
  const configured = splitCommand(script.command);
  if (configured.length > 0) {
    const hasPlaceholder = configured.some(function (part) {
      return part.indexOf('{script}') !== -1;
    });
    const argv = configured.map(function (part) {
      return part.replace(/\{script\}/g, file);
    });
    if (!hasPlaceholder) argv.push(file);
    return { argv: argv, reason: null };
  }
  const language = String(script.language || '').toLowerCase();
  if (language === 'javascript' || language === 'js' || language === 'mjs') {
    // process.execPath is electron.exe inside the host, and running a .cjs with
    // it as a plain node requires ELECTRON_RUN_AS_NODE plus an extra browser
    // bootstrap on every start. The scripts the author stage writes are
    // ordinary CommonJS, so prefer a real node: an explicit
    // settings.runnerCommand, then PI_NODE_PATH, then `node` on PATH, and only
    // then this process. When the caller has not run resolveInterpreter(), the
    // PATH entry is still right on any machine that has node installed.
    return { argv: [(options && options.nodeCommand) || defaultNodeCommand(), file], reason: null };
  }
  return {
    argv: null,
    reason:
      'no runner command configured for language "' +
      String(script.language || 'unknown') +
      '"; set a run command before this script can execute',
  };
}

/**
 * Run one script.
 * Resolves with a run record; a skipped script carries status "skipped" and a
 * non-null reason so the report can distinguish "not run" from "passed".
 */
function runScript(options) {
  const opts = options || {};
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const maxOutput = Number(opts.maxOutput) > 0 ? Number(opts.maxOutput) : DEFAULT_MAX_OUTPUT;
  const cwd = opts.cwd && fs.existsSync(opts.cwd) ? opts.cwd : os.tmpdir();
  let file = null;
  let invocation;
  try {
    if (Array.isArray(opts.argv) && opts.argv.length) {
      // Caller-supplied argument array: never split, never touch a shell.
      invocation = { argv: opts.argv.slice(), reason: null };
    } else {
      file = writeScript(opts.scriptDir || path.join(os.tmpdir(), 'autotest-scripts'), opts.script);
      invocation = resolveInvocation(opts.script, file, { nodeCommand: opts.nodeCommand });
    }
  } catch (error) {
    return Promise.resolve({
      status: 'errored',
      reason: 'could not prepare script: ' + error.message,
      exitCode: null,
      stdout: '',
      stderr: '',
      durationMs: 0,
      file: file,
      cwd: cwd,
      truncated: false,
    });
  }
  if (!invocation.argv) {
    return Promise.resolve({
      status: 'skipped',
      reason: invocation.reason,
      exitCode: null,
      stdout: '',
      stderr: '',
      durationMs: 0,
      file: file,
      cwd: cwd,
      truncated: false,
    });
  }

  const started = Date.now();
  return new Promise(function (resolve) {
    let settled = false;
    let stdoutBuf = '';
    let stderrBuf = '';
    let timer = null;
    let child;
    const finish = function (record) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (opts.signal && typeof opts.signal.removeEventListener === 'function') {
        opts.signal.removeEventListener('abort', onAbort);
      }
      const out = tail(stdoutBuf, maxOutput);
      const err = tail(stderrBuf, maxOutput);
      resolve(
        Object.assign(
          {
            file: file,
            cwd: cwd,
            durationMs: Date.now() - started,
            stdout: out.text,
            stderr: err.text,
            truncated: out.truncated || err.truncated,
          },
          record,
        ),
      );
    };
    const onAbort = function () {
      if (child && !child.killed) child.kill();
      finish({ status: 'errored', reason: 'cancelled by user', exitCode: null });
    };
    try {
      child = spawn(invocation.argv[0], invocation.argv.slice(1), {
        cwd: cwd,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        // Scripts execute with process.execPath, which inside the Electron
        // plugin host is electron.exe: the same trap the environment probe hits.
        // ELECTRON_RUN_AS_NODE=1 makes it behave as Node for the child; a plain
        // Node host ignores the variable.
        env: opts.env || Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }),
      });
    } catch (error) {
      finish({ status: 'errored', reason: 'spawn failed: ' + error.message, exitCode: null });
      return;
    }
    if (opts.signal) {
      if (opts.signal.aborted) {
        onAbort();
        return;
      }
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    timer = setTimeout(function () {
      if (child && !child.killed) child.kill();
      finish({ status: 'timeout', reason: 'exceeded ' + timeoutMs + 'ms', exitCode: null });
    }, timeoutMs);
    child.stdout.on('data', function (chunk) {
      stdoutBuf += chunk.toString();
      if (stdoutBuf.length > maxOutput * 4) stdoutBuf = stdoutBuf.slice(-maxOutput * 2);
    });
    child.stderr.on('data', function (chunk) {
      stderrBuf += chunk.toString();
      if (stderrBuf.length > maxOutput * 4) stderrBuf = stderrBuf.slice(-maxOutput * 2);
    });
    child.on('error', function (error) {
      finish({ status: 'errored', reason: 'spawn failed: ' + error.message, exitCode: null });
    });
    child.on('close', function (code, signal) {
      finish({
        status: code === 0 ? 'passed' : 'failed',
        reason: code === 0 ? null : 'exit code ' + String(code) + (signal ? ' (signal ' + signal + ')' : ''),
        exitCode: code,
      });
    });
  });
}

/** Run an approval-gated batch, stopping early only when the caller cancels. */
async function runBatch(options) {
  const opts = options || {};
  const scripts = Array.isArray(opts.scripts) ? opts.scripts : [];
  const results = [];
  for (let i = 0; i < scripts.length; i += 1) {
    if (opts.signal && opts.signal.aborted) {
      results.push({ testCaseId: scripts[i].testCaseId, status: 'errored', reason: 'cancelled before start' });
      continue;
    }
    const record = await runScript({
      script: scripts[i],
      scriptDir: opts.scriptDir,
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs,
      maxOutput: opts.maxOutput,
      signal: opts.signal,
    });
    results.push(Object.assign({ testCaseId: scripts[i].testCaseId, title: scripts[i].title }, record));
    if (opts.onProgress) opts.onProgress(results.length, scripts.length, results[results.length - 1]);
  }
  return results;
}

/**
 * Prove the runtime that will execute a script actually exists before any
 * script is authored. A missing interpreter is an environment failure, and
 * finding it here keeps it out of the failure analysis loop.
 */
/**
 * The interpreter a generated script should run under when the author stage did
 * not pin one. Kept separate from resolveInterpreter() because this path cannot
 * await: it only names the candidate, the probe is what verifies it.
 */
function defaultNodeCommand() {
  if (process.env.PI_NODE_PATH) return String(process.env.PI_NODE_PATH);
  return 'node';
}

/**
 * Find a Node interpreter that is not this process.
 *
 * The plugin host runs inside Electron, so process.execPath is electron.exe.
 * Asking electron.exe to behave like Node with ELECTRON_RUN_AS_NODE=1 is not
 * free: the browser binary still initialises enough of itself first, and in a
 * loaded host that exceeded the 10s probe budget on every call
 * (2026-11-08: 'probe failed node=v24.20.0 platform=win32 detail=exceeded
 * 10000ms' twice in a row), which turned an environment check into a hard
 * ENVIRONMENT_UNAVAILABLE before the plan was even created. A real node
 * binary answers in ~60ms.
 *
 * Order: an explicit setting, then PI_NODE_PATH, then `node` on PATH, then the
 * electron fallback so a host without any node install still progresses.
 */
async function resolveInterpreter(options) {
  const opts = options || {};
  const settings = opts.settings || {};
  const candidates = [];
  if (settings.runnerCommand) candidates.push({ argv: [String(settings.runnerCommand)], source: 'settings.runnerCommand' });
  if (process.env.PI_NODE_PATH) candidates.push({ argv: [String(process.env.PI_NODE_PATH)], source: 'PI_NODE_PATH' });
  candidates.push({ argv: ['node'], source: 'PATH' });
  candidates.push({
    argv: [process.execPath],
    source: 'process.execPath',
    env: { ELECTRON_RUN_AS_NODE: '1' },
  });
  for (let i = 0; i < candidates.length; i += 1) {
    const entry = candidates[i];
    // A plain node must not inherit ELECTRON_RUN_AS_NODE from the host: it is
    // harmless there, but leaving it lets a broken host environment leak into
    // every script run. Only the electron fallback sets it.
    const env = Object.assign({}, process.env, entry.env || {});
    if (!entry.env) delete env.ELECTRON_RUN_AS_NODE;
    const probe = await runScript({
      argv: entry.argv.concat(['-e', 'process.stdout.write(process.version)']),
      cwd: opts.cwd || process.cwd(),
      timeoutMs: opts.timeoutMs || PROBE_TIMEOUT_MS,
      maxOutput: 4096,
      env: env,
    });
    if (probe.status === 'passed') {
      return { ok: true, argv: entry.argv, source: entry.source, version: String(probe.stdout || '').trim(), detail: 'node -e probe passed' };
    }
    // Only the last candidate is reported: the earlier misses are expected
    // (no node on PATH is a normal Windows install), so a failure names the
    // interpreter that was actually tried last.
    if (i === candidates.length - 1) {
      return { ok: false, argv: entry.argv, source: entry.source, version: process.version, detail: probe.reason || 'node -e probe failed' };
    }
  }
  return { ok: false, argv: [process.execPath], source: 'process.execPath', version: process.version, detail: 'no interpreter probed' };
}

/**
 * Prove the runtime that will execute a script actually exists before any
 * script is authored. A missing interpreter is an environment failure, and
 * finding it here keeps it out of the failure analysis loop.
 */
async function selfCheck(options) {
  const opts = options || {};
  const settings = opts.settings || {};
  const timeoutMs = opts.timeoutMs || PROBE_TIMEOUT_MS;
  const found = await resolveInterpreter({
    settings: settings,
    cwd: opts.cwd,
    timeoutMs: timeoutMs,
  });
  const configured = settings && settings.runnerCommand ? String(settings.runnerCommand) : null;
  return {
    ok: found.ok,
    node: found.version || process.version,
    // execPath stays the host binary: the host redacts absolute paths, and the
    // interesting fact is which interpreter won, not where it lives.
    execPath: process.execPath,
    interpreter: found.source,
    platform: process.platform,
    configuredRunner: configured,
    detail: found.detail,
  };
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT,
  PROBE_TIMEOUT_MS,
  splitCommand,
  extensionFor,
  writeScript,
  resolveInvocation,
  defaultNodeCommand,
  runScript,
  runBatch,
  resolveInterpreter,
  selfCheck,
  tail,
};