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

One runner and one interpreter per shell session, reused by every call. The
runner copy is gone: the host starts the interpreter itself and writes cells
straight into its stdin, so a session adds exactly one process and that process
is a signed interpreter.

```
pi-desktop-host-core.exe
  └─ cmd.exe / powershell.exe / bash.exe              (long-lived, stdin piped)
       └─ the command (one process per call, unavoidable)
```

The intermediate copy (`pi-desktop-host-core.exe --internal-tool-runner`, a
second unsigned binary that spawned the interpreter and relayed between the two)
was removed on 2026-11-17: this deployment's endpoint agent kept scoring it as
`PDM:Trojan.Win32.Generic` — an unsigned executable spawning interpreters in a
loop — and quarantined the app's binaries for it. It bought the session nothing,
because the relay only turned control frames into the shell text the host can
write itself (`shell_session::spawn_session_shell`).

The one-shot path (`--internal-tool-runner` config without `persistent`) is
unchanged and still spawns the copy: it exists for background tasks and for
calls a session cannot carry.

## Protocol

A cell is one shell snippet built by `cell_text`: it changes into the command's
working directory, runs the command with the interpreter's stdin isolated, then
prints `<nonce> <exitCode>`. The host writes that snippet straight into the
interpreter's stdin and scans its stdout for the marker, so a live session needs
no framing layer between the two.

The length-prefixed JSON frames (`u32 LE length | JSON {kind, command, cwd,
timeoutMs, nonce}`) remain the protocol of `--internal-tool-runner` session
mode. That mode still works and the one-shot/background paths still use it, but
the host no longer starts a runner for a live session.

The first cell is a start-up cell whose output the host discards, so the session
is known to answer before a real command depends on it.

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
