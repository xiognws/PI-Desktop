/**
 * Installed system font families for the Settings font picker.
 *
 * Implemented with platform tooling only (no native modules) so the main
 * process bundles cleanly:
 *   - macOS: `osascript` JXA bridging `CTFontManagerCopyAvailableFontFamilyNames`
 *     (the same CoreText query font_kit's `all_families()` uses, so it is fast
 *     and returns canonical CSS family names); `system_profiler` is kept as a
 *     slow fallback when osascript is unavailable
 *   - Windows: PowerShell `[Windows.Media.Fonts]::SystemFontFamilies`
 *   - Linux: `fc-list` family output
 * The Windows and Linux approaches mirror the MIT-licensed `font-list`
 * package (https://github.com/oldj/font-list). Callers cache the result.
 */
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { runtimeTempPath } from "./runtime-tmp";

const execFileAsync = promisify(execFile);

async function darwinFontFamilies(): Promise<string[]> {
  // CoreText family enumeration via the JXA ObjC bridge completes in tens of
  // milliseconds, where system_profiler takes seconds on the same machine.
  const script = [
    'ObjC.import("CoreText")',
    "const cf = $.CTFontManagerCopyAvailableFontFamilyNames()",
    "const ns = ObjC.castRefToObject(cf)",
    'ObjC.deepUnwrap(ns).join("\\n")',
  ].join("; ");
  try {
    const { stdout } = await execFileAsync(
      "osascript",
      ["-l", "JavaScript", "-e", script],
      { maxBuffer: 8 * 1024 * 1024, timeout: 15_000 },
    );
    const names = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (names.length > 0) return names;
  } catch {
    // Fall through to the system_profiler fallback below.
  }
  const { stdout } = await execFileAsync(
    "system_profiler",
    ["SPFontsDataType", "-json"],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  const data = JSON.parse(stdout) as {
    SPFontsDataType?: Array<{ typefaces?: Array<{ family?: string }> }>;
  };
  const families = new Set<string>();
  for (const item of data.SPFontsDataType ?? []) {
    for (const typeface of item.typefaces ?? []) {
      const family = typeface.family?.trim();
      if (family) families.add(family);
    }
  }
  return [...families];
}

/**
 * Fixed script file for the Windows font query.
 *
 * The query used to travel as a quoted blob: `chcp 65001|powershell -NoProfile
 * -Command "<script>"` handed to `exec`. That is a shell layer plus a hidden
 * interpreter carrying an inline payload — the shape behaviour-based endpoint
 * protection scores hardest, and none of it is needed: the script is a
 * constant, so it lives in a file the interpreter is pointed at with `-File`
 * (arguments, of which this query has none, would travel as argv). Written with
 * a BOM because Windows PowerShell 5.1 decodes a BOM-less script with the ANSI
 * code page. It lives under `<dataDir>/tmp` like every other runtime scratch
 * file, and is rewritten on first use in each process so a stale copy from an
 * older build cannot survive.
 */
const FONT_QUERY_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
  "Add-Type -AssemblyName PresentationCore",
  "$zh = [Windows.Markup.XmlLanguage]::GetLanguage('zh-cn')",
  "$en = [Windows.Markup.XmlLanguage]::GetLanguage('en-us')",
  "foreach ($family in [Windows.Media.Fonts]::SystemFontFamilies) {",
  "  $name = ''",
  "  if (-not $family.FamilyNames.TryGetValue($zh, [ref]$name)) { $name = $family.FamilyNames[$en] }",
  "  if ($name) { Write-Output $name }",
  "}",
].join("\n");

let fontQueryScriptPath: string | undefined;

function win32FontScript(): string {
  if (fontQueryScriptPath) return fontQueryScriptPath;
  const path = runtimeTempPath("pi-list-system-fonts.ps1");
  writeFileSync(path, `\ufeff${FONT_QUERY_SCRIPT}`, "utf8");
  fontQueryScriptPath = path;
  return path;
}

async function win32FontFamilies(): Promise<string[]> {
  const powershell = join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  // `-ExecutionPolicy Bypass` is required for `-File` on a machine whose policy
  // scope is undefined, and the script path must end in `.ps1` — PowerShell
  // rejects any other extension.
  const { stdout } = await execFileAsync(
    powershell,
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", win32FontScript()],
    { maxBuffer: 10 * 1024 * 1024, windowsHide: true, timeout: 20_000 },
  );
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

async function linuxFontFamilies(): Promise<string[]> {
  const { stdout } = await execFileAsync(
    "fc-list",
    ["-f", "%{family[0]}\n"],
    { maxBuffer: 10 * 1024 * 1024 },
  );
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Installed system font families, deduplicated and sorted. */
export async function listInstalledFonts(): Promise<string[]> {
  let families: string[];
  switch (process.platform) {
    case "darwin":
      families = await darwinFontFamilies();
      break;
    case "win32":
      families = await win32FontFamilies();
      break;
    case "linux":
      families = await linuxFontFamilies();
      break;
    default:
      families = [];
  }
  return [...new Set(families)]
    .map((family) => family.trim())
    // Hidden/system-reserved families (".Apple Color Emoji UI", ".Al Bayan PUA")
    // are not meaningful choices for a UI font.
    .map((family) => family.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ""))
    .filter((family) => family.length > 0 && !family.startsWith("."))
    .sort((a, b) => a.localeCompare(b));
}
