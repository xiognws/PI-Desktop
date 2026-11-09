/**
 * Sidecar-side widget registry (D691).
 *
 * One instance per sidecar process. It loads packages once, answers
 * `widget.*` RPCs, and relays a package's host wishes through the existing
 * parent-host proxy. Keeping this in one object means the RPC handlers stay a
 * thin translation layer and the "who may call what" rules live in one place.
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type {
  WidgetInvokeResult,
  WidgetRuntimeState,
  WidgetSummary,
} from "@pi-workspace/shared";
import { Type } from "typebox";

import { WidgetRunner, type WidgetRunnerHost } from "./runner.js";

/** Agent tool the model uses to reach installed packages. */
export const WIDGET_TOOL_NAME = "Widget";

/**
 * Host RPCs a package may reach when it was granted the `host` permission.
 *
 * Read-only on purpose: a widget is user code the client did not write, so
 * the default host surface lets it look, not touch. Every name here must also
 * appear in the sidecar's HOST_PROXY_ALLOWED set, or the call dies at the
 * parent boundary with "host method not allowed from sidecar".
 */
export const WIDGET_HOST_METHODS = new Set([
  "memory.recall",
  "memory.list",
  "memory.stats",
  "workspace.get",
  "app.health",
]);

export class WidgetRegistry {
  private runner: WidgetRunner;
  /** Packages the host reported but the runner refused, for status queries. */
  private rejected = new Map<string, string>();

  constructor(host: WidgetRunnerHost) {
    this.runner = new WidgetRunner(host);
  }

  /**
   * Load every enabled package from a host list, replacing what was held.
   *
   * The reply is the sidecar's view of *every* package the host reported, so the
   * page can show why a row is skipped without asking twice.
   */
  async sync(summaries: WidgetSummary[]): Promise<WidgetRuntimeState[]> {
    const usable: WidgetSummary[] = [];
    this.rejected = new Map();
    for (const summary of summaries) {
      if (!summary.enabled) continue;
      if (summary.error) {
        this.rejected.set(summary.id, summary.error);
        continue;
      }
      if (summary.trust === "untrusted") {
        // A package the user has not reviewed never runs. The row in the page
        // explains it; this list is only for the status panel.
        this.rejected.set(summary.id, "package is not trusted yet");
        continue;
      }
      usable.push(summary);
    }
    await this.runner.load(usable);
    return this.states();
  }

  states(): WidgetRuntimeState[] {
    const loaded = this.runner.states();
    const known = new Set(loaded.map((state) => state.id));
    const skipped: WidgetRuntimeState[] = [...this.rejected.entries()]
      .filter(([id]) => !known.has(id))
      .map(([id, error]) => ({ id, state: "skipped", actionNames: [], error }));
    return [...loaded, ...skipped];
  }

  /** True when a package is loaded and exposes the action. */
  has(id: string, action: string): boolean {
    return this.runner.has(id, action);
  }

  /** Run one action; the caller has already resolved the package. */
  async invoke(id: string, action: string, args: unknown): Promise<WidgetInvokeResult> {
    const result = await this.runner.invoke(id, action, args);
    return { id, action, value: result.value, durationMs: result.durationMs };
  }

  logsFor(id: string): string[] {
    return this.runner.logsFor(id);
  }

  /**
   * The `Widget` agent tool (D691 §agent side).
   *
   * Packages are listed and driven from the same surface the user sees, so the
   * model can reach a package the user installed without the client having to
   * declare each action as its own tool. Deliberately one tool with a small
   * action set: a package's action list changes while the app runs, and a stable
   * schema keeps the provider cache warm.
   */
  agentTool(): AgentTool {
    return {
      name: WIDGET_TOOL_NAME,
      label: "Widget",
      description:
        "Use the widget packages the user installed in this client. \"list\" shows the loaded packages and the actions each exposes; \"invoke\" runs one action and returns its result. Packages are user code with their own permissions, so invoke only an action that is listed.",
      parameters: Type.Object({
        action: Type.String({ description: "list or invoke." }),
        widgetId: Type.Optional(
          Type.String({ description: "Package id, from a list result. Required for invoke." }),
        ),
        actionName: Type.Optional(
          Type.String({ description: "Action name, from a list result. Required for invoke." }),
        ),
        args: Type.Optional(
          Type.Unknown({ description: "JSON arguments the action expects." }),
        ),
      }),
      executionMode: "sequential",
      execute: async (_toolCallId: string, params: Record<string, unknown>) => {
        const action = typeof params.action === "string" ? params.action.trim() : "";
        if (action === "list") {
          const packages = this.list().map((summary) => ({
            id: summary.id,
            name: summary.name,
            version: summary.version,
            description: summary.description,
            permissions: summary.requestedPermissions,
            granted: summary.grantedPermissions,
            actions: summary.actions.map((entry) => ({
              name: entry.name,
              description: entry.description,
              params: entry.params,
            })),
          }));
          const states = this.states();
          return {
            content: [
              {
                type: "text",
                text: packages.length
                  ? JSON.stringify({ packages, states })
                  : "No widget package is installed and enabled.",
              },
            ],
            details: { packages: packages.length, states: states.length },
          };
        }
        if (action !== "invoke") {
          throw new Error(`unknown widget tool action ${action || "(empty)"}`);
        }
        const widgetId = typeof params.widgetId === "string" ? params.widgetId.trim() : "";
        const actionName = typeof params.actionName === "string" ? params.actionName.trim() : "";
        if (!widgetId || !actionName) {
          throw new Error("widgetId and actionName are required for invoke");
        }
        const result = await this.invoke(widgetId, actionName, params.args);
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          details: { id: result.id, action: result.action, durationMs: result.durationMs },
        };
      },
    } as AgentTool;
  }

  /** Packages currently loaded, for the agent tool's own listing. */
  list(): WidgetSummary[] {
    return [...this.runner.summaries().values()];
  }

  clear(): void {
    this.runner.clear();
    this.rejected.clear();
  }
}
