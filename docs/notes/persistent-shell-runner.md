# Persistent shell runner — design note

## Current shape (measured)

Every foreground `Bash` call costs three processes:

```
pi-desktop-host-core.exe            (the app host, unsigned)
  └─ pi-desktop-host-core.exe --internal-tool-runner   (a copy of itself, unsigned)
       └─ cmd.exe / powershell.exe                     (the interpreter)
            └─ the command (git, node, rg, ...)
```

The runner (`tools/mod.rs:472 run_internal_tool_runner`) reads one length-prefixed
JSON config frame from stdin, spawns the interpreter with `stdin=null` and
`stdout/stderr=inherit`, waits for it, and exits. So the per-call cost is two
extra processes before the command itself starts.

Measured on 865 logged calls: a turn averages 12.9 shell calls, p90 = 30, worst
observed 117. A turn therefore shows the OS dozens of short-lived
"unsigned app spawns an interpreter" events — the behaviour shape that
behaviour-based endpoint protection scores as malicious.

## Target shape

One runner and one interpreter per shell session, reused by every call:

```
pi-desktop-host-core.exe
  └─ pi-desktop-host-core.exe --internal-tool-runner   (long-lived, one per session)
       └─ cmd.exe / powershell.exe                     (long-lived, stdin piped)
            └─ the command (one process per call, unavoidable)
```

Per call the count drops from "2 + interpreter + command" to "command only".

## Protocol

Same framing style as Hermes' session kernel (`tools/code_kernel.py`): one child
per session, length-prefixed JSON control frames in, a nonce sentinel on the
output stream marking the end of each cell.

Host → runner (stdin), existing frame format kept:

```
u32 LE length | JSON { kind: "command", command, cwd, timeoutMs, nonce }
```

The first frame is still the existing `ToolRunnerStartConfig`; a config with
`persistent: true` puts the runner in session mode instead of one-shot mode.

Runner → host (stdout): raw command output bytes, unframed, exactly like today,
terminated by one control line:

```
<nonce> <exitCode>\n
```

The nonce is a random 128-bit hex string generated per runner instance, so
command output cannot forge an end-of-cell marker by accident. `stderr` keeps
flowing to the runner's stderr as today.

## Behaviour that must not change

- Each command still starts in the workspace root. The runner prefixes
  `cd /d "<cwd>"` (cmd) or `Set-Location -LiteralPath '<cwd>'` (PowerShell)
  before every command, so a `cd` inside one call does not leak into the next.
- Commands never read the control stream: cmd commands run as
  `(<command>) < nul`, PowerShell commands get `$input | Out-Null` isolation.
- Timeout or cancellation kills the runner (and its job), which kills the
  interpreter and every descendant. The next call starts a fresh runner — the
  "a wedged kernel dies, never hangs the agent" rule from the Hermes kernel.
- `runInBackground` keeps the existing detached path untouched: background tasks
  outlive the turn by design and never join a session shell.
- With `persistent` unset (or on a host that lacks a session id) the one-shot
  path is used exactly as today.

## Risks

- Environment leakage between calls: `set FOO=bar` now persists. Acceptable and
  documented; it also makes `nvm use`-style commands work.
- A command that ignores EOF on stdin could consume the command stream; the
  `< nul` / input isolation above is the guard.
- Session lifetime: the registry must drop a runner on session dispose and on an
  idle timeout, otherwise a long-lived host accumulates shells.
