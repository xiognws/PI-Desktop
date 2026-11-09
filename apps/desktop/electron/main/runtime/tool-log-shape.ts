/**
 * Privacy-safe summary of a shell command for the app log.
 *
 * The log answers two questions: which commands an agent actually reaches for,
 * and whether it batches steps into one call instead of many. Both are answered
 * by the first word plus a size, so the command line itself is never recorded —
 * it routinely carries access tokens, passwords, connection strings and file
 * contents.
 */

const MAX_HEAD_LENGTH = 24;

/** Tools whose arguments carry a `command` string today (`Bash` is the protocol name). */
const SHELL_TOOL_NAMES = new Set(["bash"]);

export interface ShellCommandShape {
  /** First whitespace-delimited word, path-stripped and shortened. */
  head: string;
  /** Characters in the command, so a swallowed batch and a typo are distinguishable. */
  length: number;
  /** Newlines plus one: the batching signal this log exists to measure. */
  lines: number;
}

export function shellCommandShape(
  toolName: string | undefined,
  args: unknown,
): ShellCommandShape | undefined {
  if (!toolName || !SHELL_TOOL_NAMES.has(toolName.toLowerCase())) return undefined;
  if (!args || typeof args !== "object") return undefined;
  const command = (args as { command?: unknown }).command;
  if (typeof command !== "string") return undefined;
  const trimmed = command.trim();
  if (trimmed === "") return undefined;

  const firstWord = trimmed.split(/\s+/, 1)[0] ?? "";
  const baseName = firstWord.replace(/^.*[\\/]/, "");
  const head = baseName.slice(0, MAX_HEAD_LENGTH).toLowerCase();
  if (head === "") return undefined;

  return {
    head,
    length: command.length,
    lines: command.split("\n").length,
  };
}
