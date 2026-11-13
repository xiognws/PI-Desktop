import type { ChangelogEntry } from "./changelog.js";

export const enEntries: ChangelogEntry[] = [
  {
    version: "0.21.0",
    date: "2026-11-13",
    highlights: [
      "Projects, sessions, plugins, models, and scheduled tasks live in one desktop app instead of separate tools.",
      "Choose Agent, Plan, or Goal per session; a permission layer decides every tool call before it runs.",
      "Delegate to five built-in subagents: explorer, code reviewer, test runner, fixer, and UI designer, each with its own context.",
      "Connect any OpenAI-compatible endpoint or a local model runtime, and switch models inside a running session.",
      "Extend the desktop itself with plugins: commands, panels, floating widgets, work-panel views, agent tools, themes, MCP servers, and background services.",
      "Keep data on this machine: sessions, logs, and credentials stay local, and the app sends no telemetry.",
      "Review changes in the diff panel, follow background commands, and reopen any file a session touched from the artifacts list.",
      "Run scheduled agent tasks while the app is open, and render interactive cards directly inside a conversation.",
    ],
  },
];
