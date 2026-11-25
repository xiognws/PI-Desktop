# ADR 0406: Windows runs commands in Git Bash by default

- **Status:** Accepted
- **Date:** 2026-11-24
- **Amends:** 0054 (selectable command shell catalog), 0209 (PowerShell 7 as a distinct selection)

## Context

The command shell catalog has always defaulted to Windows PowerShell 5.1 on
Windows (`windows-powershell`) and to bash elsewhere. Two things make that
default wrong now.

1. **The reference implementation runs bash.** The agent this product is a port
   of executes every tool command as `bash -l -c <command>`; PowerShell is not
   part of its command path at all. A port that speaks PowerShell by default
   diverges from the implementation it is aligned to, which is the standing
   requirement for agent behaviour in this repository.
2. **PowerShell has no benign persistent form.** Since the persistent-shell work
   (`docs/notes/persistent-shell-runner.md`), a session reuses one interpreter
   per conversation. For bash that is `bash --noprofile --norc -s`, which is how
   every shell in the world reads commands. For PowerShell the only equivalent
   is `powershell -Command -`: an interpreter that reads its script from stdin.
   On a host whose endpoint protection scores behaviour, "unsigned application
   starts a hidden interpreter that receives its payload on stdin" is the shape
   that gets flagged — and in this deployment it was: the app's binaries were
   quarantined under `PDM:Trojan.Win32.Generic`. Bash keeps the same capability
   with none of that shape.

Git Bash is already a first-class catalog entry (`git-bash`, dialect `posix`),
the app ships a Git-Bash-dependent `rg.exe`, and the developer machines this
product runs on have it installed.

## Decision

Windows defaults to **Git Bash**. PowerShell 5.1, PowerShell 7, and `cmd` stay
selectable; nothing is removed.

- `tools::shell::default_for_platform(Windows)` returns `GIT_BASH_ID`, and
  `default_shell_id()` is now defined in terms of it, so the "which shell" answer
  has one source.
- The catalog's default marker moves from the `windows-powershell` entry to the
  `git-bash` entry.
- `packages/shared`'s `defaultCommandShellForPlatform("win32")` returns
  `"git-bash"`, so the renderer's fallback matches the host.

A machine **without** Git Bash is not left broken, and this is why the change
needs no availability probe in the default itself: `catalog_for_platform`
already keeps the configured id and falls back to the first available choice,
reporting `fallback: true`. On such a machine Windows PowerShell takes over and
the settings row says it did.

## Consequences

- New installs and unconfigured machines run commands in Git Bash on Windows.
  A persisted `defaultCommandShell` is untouched — a user who chose PowerShell,
  `cmd`, or a specific PowerShell 7 keeps it.
- The per-project setup command runs in the same default shell, so on Windows it
  now takes POSIX syntax by default. Projects that pinned a PowerShell setup
  command must keep `defaultCommandShell` on a PowerShell entry; the spec
  (`03-runtime/03-tools-and-permissions.md`) states the coupling.
- The persistent-session path uses the posix session protocol
  (`bash --noprofile --norc -s`) by default; `-Command -` now only appears for a
  machine or a user that explicitly configured a PowerShell shell.
- The catalog test asserts the new marker and adds the no-bash fallback case;
  shell IDs, dialects, labels, resolution and the `fallback` protocol are
  unchanged, so no IPC or persisted-format change follows.

## Alternatives considered

- **Keep PowerShell as the default and give the session a fixed `.ps1` driver**
  (`-File <driver>` reading commands from stdin). Rejected: it re-implements
  REPL semantics (timeouts, cancellation, cwd, error-record mapping) in a script
  we then have to keep in sync with the Rust session protocol, and it still
  leaves the default diverging from the reference implementation.
- **Keep PowerShell as the default and drop persistent sessions on Windows.**
  Rejected: it trades one flagged shape for hundreds of extra interpreter
  processes per conversation — the other axis this deployment was flagged on.
- **Default to `cmd`.** Rejected: `cmd` has no reliable completion/exit contract
  for streaming output and no POSIX tooling; it would also split the command
  language from the reference implementation just as much as PowerShell.
