/**
 * Renderer-facing channels for in-app providers.
 *
 * The channel strings are duplicated in `src/lib/in-app-credits.ts` because the
 * renderer may not import Main implementation modules; `test/in-app-providers`
 * asserts the two lists stay identical.
 */
import { app } from "electron";
import { join } from "node:path";
import type { HostProcess } from "../host-process";
import type { Logger } from "../logger";
import type { IpcRegistrar } from "../ipc/types";
import { InAppProviders } from "./in-app-providers.ts";
import { createGatewayStarter, readOrCreateApiKey } from "./gateway-process.ts";

export const IN_APP_PROVIDER_CHANNELS = {
  list: "pi-desktop/in-app-providers/list",
  credits: "pi-desktop/in-app-providers/credits",
  setEnabled: "pi-desktop/in-app-providers/set-enabled",
} as const;

export type InAppProviderSupervisorDeps = {
  getHost: () => HostProcess | null;
  logger: Pick<Logger, "app">;
  /** Overrides the built gateway entry; tests never use this. */
  entry?: string;
};

/**
 * Where a gateway entry lives.
 *
 * The gateway is vendored CommonJS that is forked, never imported: bundling it
 * into the main bundle would make Rollup resolve its `node:` requires as an
 * external namespace chunk and fail the build. It ships as a resource instead —
 * `resources/in-app-providers/<id>/gateway.cjs` in development, the same tree
 * under `process.resourcesPath` once packaged.
 */
export function inAppGatewayEntry(providerId: string): string {
  return app.isPackaged
    ? join(process.resourcesPath, "in-app-providers", providerId, "gateway.cjs")
    : join(app.getAppPath(), "resources", "in-app-providers", providerId, "gateway.cjs");
}

/**
 * Build the supervisor Main owns for the lifetime of the app.
 *
 * Host calls are resolved late (`getHost`) because the supervisor starts as part
 * of the boot sequence, before the host handshake can be guaranteed; a call
 * while the host is still down fails that one provider and logs one line.
 */
export function createInAppProviderSupervisor({
  getHost,
  logger,
  entry,
}: InAppProviderSupervisorDeps): InAppProviders {
  const log = (level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>) => {
    logger.app("provider", level, message, data ? { data } : undefined);
  };
  return new InAppProviders({
    callHost: async <T>(method: string, params?: Record<string, unknown>) => {
      const host = getHost();
      if (!host) throw new Error("host unavailable");
      return await host.call<T>(method, params);
    },
    startGateway: createGatewayStarter({
      entry: entry ?? inAppGatewayEntry("workbuddy"),
      log,
    }),
    readSettings: async () => {
      const host = getHost();
      if (!host) throw new Error("host unavailable");
      return await host.call<Record<string, unknown>>("settings.get");
    },
    readApiKey: (provider) => readOrCreateApiKey(provider),
    log,
  });
}

export function registerInAppProviderIpc({
  registrar,
  supervisor,
}: {
  registrar: IpcRegistrar;
  supervisor: InAppProviders;
}): void {
  registrar.handle(IN_APP_PROVIDER_CHANNELS.list, async () => ({
    providers: supervisor.status(),
  }));
  // Switching a gateway on or off answers with the new status list, so the card
  // never has to guess what happened: it re-renders from the same shape.
  registrar.handle(
    IN_APP_PROVIDER_CHANNELS.setEnabled,
    async (input: { providerId?: unknown; enabled?: unknown } | undefined) => ({
      providers: await supervisor.setEnabled(
        typeof input?.providerId === "string" ? input.providerId : "",
        input?.enabled === true,
      ),
    }),
  );
  // A credit read never throws into the renderer: the UI has states for every
  // failure, and an exception would only remove them.
  registrar.handle(
    IN_APP_PROVIDER_CHANNELS.credits,
    async (input: { providerId?: unknown; refresh?: unknown } | undefined) =>
      await supervisor.readProviderCredits({
        providerId: typeof input?.providerId === "string" ? input.providerId : "",
        refresh: input?.refresh === true,
      }),
  );
}
