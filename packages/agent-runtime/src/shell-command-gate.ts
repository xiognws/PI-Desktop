/**
 * Command risk gate for the shell (`Bash`) tool.
 *
 * Ported from the rule engine of `@xynogen/pix-gate` (MIT) so the desktop
 * refuses catastrophic or destructive shell invocations before they reach the
 * host. The rules are pure: no pi API, no host access, no I/O. The runtime
 * decides *when* to ask; this module decides *what* a command is.
 *
 * Policy (mirrors pix's non-interactive behaviour, where no dialog exists):
 *   critical  — always rejected; no mode, model, or setting may approve it.
 *   dangerous — rejected by default; the model is told to ask the user.
 *   risky     — allowed; the desktop has no confirmation surface to attach to.
 *
 * `PI_DESKTOP_SHELL_GATE` overrides the ceiling:
 *   `critical` — reject only the critical tier
 *   `off`      — disable the gate entirely (documented escape hatch)
 * Anything else, or nothing, keeps the default `dangerous` ceiling.
 */

export type ShellGateSeverity = "critical" | "dangerous" | "risky";

export interface ShellGateRule {
  pattern: RegExp;
  severity: ShellGateSeverity;
  reason: string;
}

export type ShellGateVerdict =
  | { action: "allow" }
  | { action: "deny"; severity: ShellGateSeverity; reason: string };

/**
 * Command position: line start, after an operator / subshell / quote, or after a
 * wrapper (`sudo`, `env`, `xargs`, …). Keeps `grep shutdown src/` and
 * `echo mkfs` from matching. `\|` is an escaped pipe inside a pattern, not an
 * operator. A quote starts a command only after `-c` (`sh -c "…"`), not in
 * `git commit -m "reboot"`.
 */
const AT_CMD = String.raw`(?:^|(?<!\\)[;&|({\x60!]|\$\(|-c\s+["'])\s*(?:(?:sudo|doas|env|nohup|time|exec|nice|xargs|command|builtin|then|do|else)\s+(?:-\S+\s+)*)*`;
const at = (body: string, flags = "i"): RegExp => new RegExp(AT_CMD + body, flags);

/** One shell segment (stops at the next operator). */
const SEG = String.raw`[^;&|\n]*`;
/** `rm` with a recursive flag (-r, -R, -rf, -fr, --recursive). */
const RM_R = String.raw`rm\b(?=${SEG}\s(?:-[a-z]*r[a-z]*|--recursive)(?=\s|$))`;
/** A target that is `/`, `~`, `$HOME`, or everything under them. */
const ROOT_TARGET = String.raw`${SEG}\s["']?(?:\/\*?|~\/?\*?|\$\{?HOME\}?\/?\*?)["']?(?=\s|$|[;&|])`;
/** A target that is a top-level system directory. */
const SYS_TARGET = String.raw`${SEG}\s["']?\/(?:bin|boot|dev|etc|home|lib|lib64|opt|proc|root|sbin|srv|sys|usr|var)\/?\*?["']?(?=\s|$|[;&|])`;
const RAW_DISK = String.raw`\/dev\/(?:sd|nvme|disk|hd|vd|xvd|mmcblk)`;

const RM_ROOT = at(RM_R + ROOT_TARGET);

// Recursive delete of a drive root or the user profile (cmd.exe `rd /s`,
// PowerShell `-Recurse`).
const WINDOWS_ROOT_WIPE =
  /\b(?:rd|rmdir|del|erase|Remove-Item|ri|rm)\b(?=[^|;\n]*\s(?:\/s|-r\w*)\b)[^|;\n]*\s["']?(?:[A-Za-z]:|~|\$env:USERPROFILE|%USERPROFILE%|\$HOME)[\\/]?["']?(?=\s|$|[;|&])/i;

export const DEFAULT_SHELL_GATE_RULES: readonly ShellGateRule[] = [
  // CRITICAL — destructive, irreversible, or system-wide
  { pattern: RM_ROOT, severity: "critical", reason: "recursive rm on / or $HOME" },
  {
    pattern: at(RM_R + SYS_TARGET),
    severity: "critical",
    reason: "recursive rm on a system directory",
  },
  {
    pattern: at(String.raw`(?:mkfs(?:\.\w+)?|wipefs|blkdiscard)\b`),
    severity: "critical",
    reason: "filesystem format / wipe",
  },
  {
    pattern: new RegExp(String.raw`\bdd\b[^\n]*\bof=${RAW_DISK}`, "i"),
    severity: "critical",
    reason: "dd to raw block device",
  },
  {
    pattern: new RegExp(String.raw`>\s*${RAW_DISK}`, "i"),
    severity: "critical",
    reason: "writing to raw block device",
  },
  {
    pattern: /:\(\)\s*\{\s*:\|:&\s*\}\s*;:/,
    severity: "critical",
    reason: "fork bomb",
  },
  {
    pattern: at(
      String.raw`(?:shutdown|reboot|halt|poweroff|systemctl\s+(?:poweroff|reboot|halt|kexec)|init\s+[06])\b`,
    ),
    severity: "critical",
    reason: "system power command",
  },
  {
    pattern: WINDOWS_ROOT_WIPE,
    severity: "critical",
    reason: "recursive delete of drive root / profile",
  },
  {
    pattern: /\b(Format-Volume|Clear-Disk|Initialize-Disk|diskpart)\b|\bformat(\.com)?\s+[A-Za-z]:/i,
    severity: "critical",
    reason: "disk format / wipe (Windows)",
  },
  {
    pattern: /\bvssadmin\b[^|;\n]*\bdelete\b|\bwmic\b[^|;\n]*\bshadowcopy\b[^|;\n]*\bdelete\b/i,
    severity: "critical",
    reason: "delete shadow copies (restore points)",
  },
  {
    pattern: /\b(Stop-Computer|Restart-Computer)\b/i,
    severity: "critical",
    reason: "system power command (PowerShell)",
  },

  // DANGEROUS — destructive or privileged but recoverable in scope
  { pattern: at(RM_R), severity: "dangerous", reason: "recursive remove" },
  {
    pattern: at(String.raw`(?:sudo|doas|pkexec|su)\b`),
    severity: "dangerous",
    reason: "privilege escalation",
  },
  {
    pattern: at(String.raw`chmod\b${SEG}\s(?:[0-7]?0?777|[ugo]*a[ugo]*\+[rx]*w|o\+[rx]*w|a=rwx)`),
    severity: "dangerous",
    reason: "world-writable permissions",
  },
  {
    pattern: at(
      String.raw`(?:chmod|chown|chgrp)\s+(?:-\S+\s+)*-[a-z]*R(?:${SYS_TARGET}|${ROOT_TARGET})`,
    ),
    severity: "dangerous",
    reason: "recursive permission / owner change on a system path",
  },
  {
    pattern:
      /\b(?:curl|wget)\b[^\n]*\|\s*(?:sudo\s+(?:-\S+\s+)*)?(?:sh|bash|zsh|dash|ksh|fish|python[\d.]*|perl|ruby|node|bun|deno)\b|(?:^|\s)(?:sh|bash|zsh|dash|ksh|eval|source|\.)\s[^\n]*(?:\$\(|<\(|\x60)\s*(?:curl|wget)\b/i,
    severity: "dangerous",
    reason: "remote script execution (curl|sh)",
  },
  {
    // Case-sensitive: `branch -D` force-deletes, `branch -d` does not.
    pattern: new RegExp(
      String.raw`\bgit\b${SEG}\s(?:push\b${SEG}\s(?:-f|--force(?:-with-lease)?|--mirror|--delete|-d|\+\S+|:\S+)(?=\s|$)|reset\s+--hard|clean\s+-[a-zA-Z]*f|branch\s+(?:${SEG}\s)?(?:-D|--delete\s+--force)\b|filter-branch|filter-repo|reflog\s+expire|update-ref\s+-d)`,
    ),
    severity: "dangerous",
    reason: "destructive git operation",
  },
  {
    pattern: new RegExp(
      String.raw`\b(?:(?:npm|pnpm|yarn|bun)\s+(?:publish|unpublish|deprecate)|cargo\s+(?:publish|yank)|twine\s+upload|gem\s+push)\b(?!${SEG}--dry-run)`,
      "i",
    ),
    severity: "dangerous",
    reason: "package publish",
  },
  {
    pattern: new RegExp(
      String.raw`\bdocker\s+(?:system\s+prune|volume\s+(?:rm|prune)|(?:rm|rmi)\s+-[a-z]*f|image\s+prune\s+-a)|\bdocker(?:\s+compose|-compose)\s+down\b${SEG}\s(?:-v|--volumes)\b`,
      "i",
    ),
    severity: "dangerous",
    reason: "destructive docker operation",
  },
  {
    pattern: new RegExp(String.raw`\bfind\b${SEG}\s(?:-delete\b|-exec(?:dir)?\s+rm\b)`, "i"),
    severity: "dangerous",
    reason: "find with delete",
  },
  {
    pattern: at(
      String.raw`(?:crontab\s+-r|kubectl\s+delete|helm\s+(?:uninstall|delete)|terraform\s+destroy|mv\b${SEG}\s\/dev\/null)\b`,
    ),
    severity: "dangerous",
    reason: "destructive infra / scheduler operation",
  },
  {
    pattern: /\b(?:DROP\s+(?:TABLE|DATABASE|SCHEMA)|TRUNCATE\s+TABLE)\b/i,
    severity: "dangerous",
    reason: "destructive SQL",
  },
  {
    pattern: /\bkill\s+-9\s+-1\b/i,
    severity: "dangerous",
    reason: "kill all processes",
  },
  // PowerShell accepts abbreviated params: -r/-rec/-Recurse, -fo/-Force
  {
    pattern: /\b(Remove-Item|ri|rm|rmdir|rd|del|erase)\b(?=[^|;\n]*\s-r\w*\b)(?=[^|;\n]*\s-fo\w*\b)/i,
    severity: "dangerous",
    reason: "recursive force remove (PowerShell)",
  },
  {
    pattern: /\b(rd|rmdir|del|erase)\b[^|;\n]*\s\/s\b/i,
    severity: "dangerous",
    reason: "recursive remove (cmd.exe /s)",
  },
  {
    pattern:
      /\breg(\.exe)?\s+(delete|add|import|restore)\b|\b(Remove-Item|Remove-ItemProperty|Set-ItemProperty|New-ItemProperty|Set-Item|New-Item)\b[^|;\n]*\bHK(LM|CU|CR|U|CC):/i,
    severity: "dangerous",
    reason: "registry write",
  },
  {
    pattern: /\bbcdedit\b|\bcipher\b[^|;\n]*\/w\b/i,
    severity: "dangerous",
    reason: "boot config / free-space wipe",
  },
  {
    pattern:
      /\bSet-MpPreference\b[^|;\n]*-Disable|\bAdd-MpPreference\b[^|;\n]*-Exclusion|\bnetsh\b[^|;\n]*\b(state\s+off|opmode\s+disable)\b|\bSet-NetFirewallProfile\b[^|;\n]*-Enabled\s+(\$?false|0)\b/i,
    severity: "dangerous",
    reason: "disable Defender / firewall",
  },
  {
    pattern:
      /\bicacls\b[^|;\n]*\/grant\b[^|;\n]*\b(Everyone|\*S-1-1-0)\b|\b(takeown|icacls)\b[^|;\n]*\s\/(r|t)\b/i,
    severity: "dangerous",
    reason: "recursive / world ACL change (Windows)",
  },
  {
    pattern: /\bnet\s+(user|localgroup)\b[^|;\n]*\/(add|delete)\b/i,
    severity: "dangerous",
    reason: "local user / group change",
  },
  {
    pattern: /\bsc(\.exe)?\s+(delete|config)\b|\bRemove-Service\b/i,
    severity: "dangerous",
    reason: "service delete / reconfigure",
  },
  {
    pattern: /\bwevtutil\s+cl\b|\bClear-EventLog\b/i,
    severity: "dangerous",
    reason: "clear event logs",
  },
  {
    // -e/-ec/-en/-enc/-EncodedCommand; not -ExecutionPolicy
    pattern: /\b(powershell|pwsh)(\.exe)?\b[^|;\n]*\s-(e|ec|en|enc\w*)\b/i,
    severity: "dangerous",
    reason: "encoded PowerShell command",
  },
  {
    pattern:
      /\bcertutil\b[^|;\n]*-urlcache|\bbitsadmin\b[^|;\n]*\/transfer|\bmshta\b[^|;\n]*https?:/i,
    severity: "dangerous",
    reason: "download via system binary (LOLBin)",
  },
  {
    pattern:
      /\b(iex|Invoke-Expression)\b[^\n]*\b(iwr|irm|Invoke-WebRequest|Invoke-RestMethod|DownloadString)\b|\b(iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^\n]*\|\s*(iex|Invoke-Expression)\b/i,
    severity: "dangerous",
    reason: "remote script execution (iwr|iex)",
  },
  { pattern: /\brunas\b/i, severity: "dangerous", reason: "privilege escalation (RunAs)" },

  // RISKY — allowed by the desktop, kept for classification and future use
  { pattern: /\bSet-ExecutionPolicy\b/i, severity: "risky", reason: "execution policy change" },
  {
    pattern: /\btaskkill\b[^|;\n]*\/f\b|\bStop-Process\b[^|;\n]*-fo\w*/i,
    severity: "risky",
    reason: "force-kill process",
  },
  {
    pattern: /\bschtasks\b[^|;\n]*\/create\b|\bRegister-ScheduledTask\b/i,
    severity: "risky",
    reason: "scheduled task (persistence)",
  },
  {
    pattern: /\bgit\s+checkout\s+(-f|--force)/i,
    severity: "risky",
    reason: "force checkout (overwrites local changes)",
  },
  {
    pattern: /\bgit\s+stash\s+(?:drop|clear)\b/i,
    severity: "risky",
    reason: "stash drop / clear",
  },
  {
    pattern: /\bgit\s+(?:checkout|restore)\s+(?:--\s+)?\.(?=\s|$|[;&|])/i,
    severity: "risky",
    reason: "discard all working-tree changes",
  },
  {
    pattern: at(String.raw`(?:chmod|chown|chgrp)\s+(?:-\S+\s+)*-[a-z]*R\b`),
    severity: "risky",
    reason: "recursive permission / owner change",
  },
  { pattern: />\s*[^|&;]*\.env\b/i, severity: "risky", reason: "writing to .env" },
];

/**
 * Non-lifting circuit breaker: catastrophic, unrecoverable commands that no
 * ceiling may approve, including the `critical` override.
 */
const CIRCUIT_BREAKER: readonly RegExp[] = [
  RM_ROOT,
  new RegExp(String.raw`\bdd\b[^\n]*\bof=${RAW_DISK}`, "i"),
  /\bmkfs\.\w+\s+\/dev\//i,
  /:\s*\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/,
  new RegExp(String.raw`>\s*${RAW_DISK}`, "i"),
  /\b(?:Format-Volume|Clear-Disk|diskpart)\b|\bformat(?:\.com)?\s+[A-Za-z]:/i,
  WINDOWS_ROOT_WIPE,
];

/** Enabled unless `PI_DESKTOP_SHELL_GATE=off` is set for this process. */
export function shellGateCeiling(): ShellGateSeverity | "off" {
  const raw = process.env.PI_DESKTOP_SHELL_GATE?.trim().toLowerCase();
  if (raw === "off") return "off";
  if (raw === "critical") return "critical";
  return "dangerous";
}

/** True when a command is catastrophic enough that no ceiling may approve it. */
export function isCircuitBreakerCommand(command: string): boolean {
  return CIRCUIT_BREAKER.some((re) => re.test(command));
}

/**
 * Return the highest-severity rule that matches `command`, or undefined if none.
 * Checks critical → dangerous → risky in order, returning on the first match.
 */
export function classifyShellCommand(
  command: string,
  rules: readonly ShellGateRule[] = DEFAULT_SHELL_GATE_RULES,
): ShellGateRule | undefined {
  const order: readonly ShellGateSeverity[] = ["critical", "dangerous", "risky"];
  for (const severity of order) {
    const hit = rules.find((rule) => rule.severity === severity && rule.pattern.test(command));
    if (hit) return hit;
  }
  return undefined;
}

/** Blank out quoted strings, so `git commit -m "drop sudo"` holds no `sudo` token. */
function stripQuoted(command: string): string {
  return command.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''");
}

/**
 * True when the command runs `sudo` as a token — not a path such as `pix-sudo`,
 * and not text inside a quoted argument.
 */
export function isSudoCommand(command: string): boolean {
  return /(^|[\s;|&(])sudo\b/i.test(stripQuoted(command));
}

/**
 * Classify one shell command and decide whether the desktop may run it.
 * `deny` carries a model-facing reason; `allow` is the pre-existing behaviour.
 */
export function shellGateVerdict(command: string): ShellGateVerdict {
  const ceiling = shellGateCeiling();
  if (ceiling === "off") return { action: "allow" };
  if (!command.trim()) return { action: "allow" };
  const rule = classifyShellCommand(command);
  if (!rule) return { action: "allow" };
  if (rule.severity === "risky") return { action: "allow" };
  if (rule.severity === "critical" || ceiling === "dangerous") {
    return { action: "deny", severity: rule.severity, reason: rule.reason };
  }
  return { action: "allow" };
}

const MAX_ECHOED_COMMAND_CHARS = 200;

/**
 * Model-facing block reason. It names the rule and the escape route without
 * echoing an unbounded command back into the transcript.
 */
export function shellGateBlockReason(verdict: Extract<ShellGateVerdict, { action: "deny" }>, command: string): string {
  const echoed =
    command.length > MAX_ECHOED_COMMAND_CHARS
      ? `${command.slice(0, MAX_ECHOED_COMMAND_CHARS)}…`
      : command;
  const circuit = isCircuitBreakerCommand(command);
  return [
    `Blocked before execution by the shell command gate: ${verdict.severity} risk — ${verdict.reason}.`,
    `Command: ${echoed}`,
    circuit
      ? "This command is catastrophic and cannot be approved by any mode. Do not retry it or work around the gate."
      : "Nothing was run and no state changed. Choose a scoped, reversible alternative instead; if the user truly needs this command, ask them to run it themselves.",
  ].join(" ");
}
