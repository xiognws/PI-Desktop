import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type {
  CapabilityRuntimeState,
  CapabilitySummary,
  CapabilityTrust,
  ToolPackageSummary,
  ToolPackageTool,
} from "@pi-workspace/shared";

import { IconRefresh, IconSparkles, IconWrench } from "../components/icons";
import { Badge, Button, SettingsToggle, TooltipButton } from "../components/ui";
import { api } from "../lib/api";
import "../features/tools/tools.css";

/**
 * Tools: one page for both kinds of package this build can run (D681, D691).
 *
 * Tool packages are directories under `resources/tools` with a `tool.json`
 * manifest; capability packages are directories the *user* drops into
 * `<userData>/capabilities`. They are listed together — capabilities first,
 * because a scanned capability folder is the only thing on this page the user
 * personally put there. Each section only renders packages that were actually
 * found, so an empty scan produces no heading and no empty card.
 */
export function ToolsPage() {
  const { t } = useTranslation();
  const [packages, setPackages] = useState<ToolPackageSummary[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<CapabilitySummary[]>([]);
  const [capabilityStates, setCapabilityStates] = useState<CapabilityRuntimeState[]>([]);
  const [capabilityStatus, setCapabilityStatus] = useState<"loading" | "ready" | "error">("loading");
  const [capabilityError, setCapabilityError] = useState("");
  const [capabilityBusyId, setCapabilityBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setStatus((current) => (current === "ready" ? current : "loading"));
    try {
      const result = await api.listToolPackages();
      setPackages(result.packages);
      setError("");
      setStatus("ready");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setStatus("error");
    }
  }, []);

  const loadCapabilities = useCallback(async () => {
    setCapabilityStatus((current) => (current === "ready" ? current : "loading"));
    try {
      const result = await api.listCapabilities();
      setCapabilities(result.packages);
      setCapabilityError("");
      setCapabilityStatus("ready");
      // Runtime state is advisory: the sidecar is not necessarily up, and that
      // must not blank out a list the host just answered.
      const runtime = await api.capabilityRuntime().catch(() => ({ states: [] }));
      setCapabilityStates(runtime.states);
    } catch (cause) {
      setCapabilityError(cause instanceof Error ? cause.message : String(cause));
      setCapabilityStatus("error");
    }
  }, []);

  useEffect(() => {
    void load();
    void loadCapabilities();
  }, [load, loadCapabilities]);

  const toggle = async (id: string, enabled: boolean) => {
    setBusyId(id);
    try {
      // The host answers with the fresh list, so one write settles every row.
      const result = await api.setToolPackageEnabled(id, enabled);
      setPackages(result.packages);
      setError("");
      setStatus("ready");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setStatus("error");
    } finally {
      setBusyId(null);
    }
  };

  /** Settle the capability section after any write, and mirror the runtime. */
  const settleCapabilities = async (next: CapabilitySummary[]) => {
    setCapabilities(next);
    setCapabilityError("");
    setCapabilityStatus("ready");
    const runtime = await api.capabilityRuntime().catch(() => ({ states: [] }));
    setCapabilityStates(runtime.states);
  };

  const toggleCapability = async (id: string, enabled: boolean) => {
    setCapabilityBusyId(id);
    try {
      const result = await api.setCapabilityEnabled(id, enabled);
      await settleCapabilities(result.packages);
    } catch (cause) {
      setCapabilityError(cause instanceof Error ? cause.message : String(cause));
      setCapabilityStatus("error");
    } finally {
      setCapabilityBusyId(null);
    }
  };

  /**
   * Trust is pinned to the digest on screen. Files that changed after review are
   * rejected by the host instead of being trusted silently, and that failure is
   * shown here so the user can reload and look again.
   */
  const setCapabilityTrust = async (pkg: CapabilitySummary, trusted: boolean) => {
    setCapabilityBusyId(pkg.id);
    try {
      const result = await api.setCapabilityTrust(pkg.id, pkg.digest, trusted);
      await settleCapabilities(result.packages);
    } catch (cause) {
      setCapabilityError(cause instanceof Error ? cause.message : String(cause));
      setCapabilityStatus("error");
    } finally {
      setCapabilityBusyId(null);
    }
  };

  const revealCapability = async (id: string) => {
    try {
      await api.revealCapability(id);
    } catch (cause) {
      setCapabilityError(cause instanceof Error ? cause.message : String(cause));
      setCapabilityStatus("error");
    }
  };

  const revealCapabilitiesDir = async () => {
    try {
      await api.revealCapabilitiesDir();
    } catch (cause) {
      setCapabilityError(cause instanceof Error ? cause.message : String(cause));
      setCapabilityStatus("error");
    }
  };

  return (
    <section className="tools-page">
      <header className="tools-head">
        <div className="tools-title">
          <IconWrench size={16} aria-hidden />
          <h2>{t("tools.title")}</h2>
          {status === "ready" ? (
            <span className="tools-count">{t("tools.count", { count: packages.length })}</span>
          ) : null}
        </div>
        <TooltipButton
          type="button"
          className="tools-refresh"
          tooltip={t("tools.refresh")}
          ariaLabel={t("tools.refresh")}
          onClick={() => {
            void load();
            void loadCapabilities();
          }}
        >
          <IconRefresh size={14} aria-hidden />
        </TooltipButton>
      </header>

      <div className="tools-sections">
        <CapabilitySection
          packages={capabilities}
          states={capabilityStates}
          status={capabilityStatus}
          error={capabilityError}
          busyId={capabilityBusyId}
          onReload={() => void loadCapabilities()}
          onToggle={(id, enabled) => void toggleCapability(id, enabled)}
          onTrust={(pkg, trusted) => void setCapabilityTrust(pkg, trusted)}
          onReveal={(id) => void revealCapability(id)}
          onRevealDir={() => void revealCapabilitiesDir()}
        />

        {status === "loading" ? (
          <p className="tools-placeholder">{t("tools.loading")}</p>
        ) : status === "error" ? (
          <p className="tools-placeholder is-error">
            {t("tools.loadFailed", { message: error })}
          </p>
        ) : packages.length === 0 ? (
          <div className="tools-empty">
            <p className="tools-empty-title">{t("tools.empty")}</p>
            <p className="tools-empty-hint">{t("tools.emptyHint")}</p>
          </div>
        ) : (
          <div className="tools-list">
            {packages.map((pkg) => (
              <article
                key={pkg.id}
                className={`tools-card${pkg.enabled ? "" : " is-disabled"}`}
                data-tool-package={pkg.id}
              >
                <div className="tools-card-head">
                  <div className="tools-card-identity">
                    <span className="tools-card-name">{pkg.name}</span>
                    {pkg.version ? (
                      <Badge tone="neutral" className="tools-card-version">
                        {t("tools.version", { version: pkg.version })}
                      </Badge>
                    ) : null}
                    {pkg.id !== pkg.name ? (
                      <span className="tools-card-id">{pkg.id}</span>
                    ) : null}
                  </div>
                  <SettingsToggle
                    checked={pkg.enabled}
                    label={t("tools.enableLabel", { name: pkg.name })}
                    disabled={busyId === pkg.id}
                    onChange={() => void toggle(pkg.id, !pkg.enabled)}
                  />
                </div>

                {pkg.error ? (
                  <p className="tools-card-error" role="alert">
                    {t("tools.broken", { message: pkg.error })}
                  </p>
                ) : (
                  <>
                    {pkg.description ? (
                      <p className="tools-card-description">{pkg.description}</p>
                    ) : null}
                    {pkg.tools.length === 0 ? (
                      <p className="tools-card-note">{t("tools.noTools")}</p>
                    ) : (
                      <ul className="tools-tool-list">
                        {pkg.tools.map((tool) => (
                          <ToolRow key={tool.name} tool={tool} />
                        ))}
                      </ul>
                    )}
                  </>
                )}
              </article>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * Capability packages found under `<userData>/capabilities` (D691).
 *
 * Nothing is rendered when the scan found nothing: this section exists because
 * the user put those folders there, not because the build promises a feature.
 * Each action can be run from here, which is the client side of the two-way
 * contract — the agent reaches the same actions through its `Capability` tool.
 */
function CapabilitySection({
  packages,
  states,
  status,
  error,
  busyId,
  onReload,
  onToggle,
  onTrust,
  onReveal,
  onRevealDir,
}: {
  packages: CapabilitySummary[];
  states: CapabilityRuntimeState[];
  status: "loading" | "ready" | "error";
  error: string;
  busyId: string | null;
  onReload: () => void;
  onToggle: (id: string, enabled: boolean) => void;
  onTrust: (pkg: CapabilitySummary, trusted: boolean) => void;
  onReveal: (id: string) => void;
  onRevealDir: () => void;
}) {
  const { t } = useTranslation();
  const stateOf = (id: string) => states.find((state) => state.id === id);

  if (status === "loading" && packages.length === 0) {
    return <p className="tools-placeholder">{t("capabilities.loading")}</p>;
  }
  if (status === "error" && packages.length === 0) {
    return (
      <div className="tools-capability-section">
        <p className="tools-placeholder is-error">
          {t("capabilities.loadFailed", { message: error })}
        </p>
        <div className="tools-capability-section-actions">
          <Button variant="ghost" size="sm" onClick={onReload}>
            {t("capabilities.refresh")}
          </Button>
          <Button variant="ghost" size="sm" onClick={onRevealDir}>
            {t("capabilities.revealDir")}
          </Button>
        </div>
      </div>
    );
  }
  if (packages.length === 0) return null;

  return (
    <div className="tools-capability-section" data-capability-section="true">
      <div className="tools-capability-section-head">
        <div className="tools-capability-section-title">
          <IconSparkles size={14} aria-hidden />
          <h3>{t("capabilities.title")}</h3>
          <span className="tools-count">
            {t("capabilities.count", { count: packages.length })}
          </span>
        </div>
        <Button variant="ghost" size="sm" onClick={onRevealDir}>
          {t("capabilities.revealDir")}
        </Button>
      </div>
      {status === "error" ? (
        <p className="tools-placeholder is-error">
          {t("capabilities.loadFailed", { message: error })}
        </p>
      ) : null}
      <div className="tools-list">
        {packages.map((pkg) => (
          <article
            key={pkg.id}
            className={`tools-card capabilities-card${pkg.enabled ? "" : " is-disabled"}`}
            data-capability={pkg.id}
            data-trust={pkg.trust}
          >
            <div className="tools-card-head">
              <div className="tools-card-identity">
                <span className="tools-card-name">{pkg.name}</span>
                {pkg.version ? (
                  <Badge tone="neutral" className="tools-card-version">
                    {t("capabilities.version", { version: pkg.version })}
                  </Badge>
                ) : null}
                <TrustBadge trust={pkg.trust} />
              </div>
              <SettingsToggle
                checked={pkg.enabled}
                label={t("capabilities.enableLabel", { name: pkg.name })}
                busy={busyId === pkg.id}
                disabled={busyId === pkg.id || pkg.trust === "untrusted"}
                onChange={() => onToggle(pkg.id, !pkg.enabled)}
              />
            </div>

            {pkg.error ? (
              <p className="tools-card-error" role="alert">
                {t("capabilities.broken", { message: pkg.error })}
              </p>
            ) : (
              <>
                {pkg.description ? (
                  <p className="tools-card-description">{pkg.description}</p>
                ) : null}

                <dl className="capabilities-facts">
                  <dt>{t("capabilities.factPermissions")}</dt>
                  <dd>
                    <PermissionBadges
                      requested={pkg.requestedPermissions}
                      granted={pkg.grantedPermissions}
                    />
                  </dd>
                  <dt>{t("capabilities.factRuntime")}</dt>
                  <dd>
                    <RuntimeLabel state={stateOf(pkg.id)} />
                  </dd>
                </dl>

                {pkg.actions.length === 0 ? (
                  <p className="tools-card-note">{t("capabilities.noActions")}</p>
                ) : (
                  <ul className="capabilities-action-list">
                    {pkg.actions.map((action) => (
                      <CapabilityActionRow
                        key={action.name}
                        pkg={pkg}
                        actionName={action.name}
                        description={action.description}
                      />
                    ))}
                  </ul>
                )}

                <div className="capabilities-card-actions">
                  {pkg.trust === "trusted" ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busyId === pkg.id}
                      onClick={() => onTrust(pkg, false)}
                    >
                      {t("capabilities.revokeTrust")}
                    </Button>
                  ) : (
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={busyId === pkg.id}
                      onClick={() => onTrust(pkg, true)}
                    >
                      {pkg.trust === "modified"
                        ? t("capabilities.trustAgain")
                        : t("capabilities.trustLabel")}
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" onClick={() => onReveal(pkg.id)}>
                    {t("capabilities.reveal")}
                  </Button>
                  <span className="capabilities-digest" title={pkg.digest}>
                    {pkg.digest.slice(0, 12)}
                  </span>
                </div>
              </>
            )}
          </article>
        ))}
      </div>
    </div>
  );
}

/**
 * One action plus a run control. The result is kept next to the action that
 * produced it: a capability package is arbitrary user code, so seeing what it
 * returned — or why it failed — is the only honest feedback available.
 */
function CapabilityActionRow({
  pkg,
  actionName,
  description,
}: {
  pkg: CapabilitySummary;
  actionName: string;
  description: string;
}) {
  const { t } = useTranslation();
  const [result, setResult] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [running, setRunning] = useState(false);

  const run = async () => {
    setRunning(true);
    setFailed(false);
    try {
      const answer = await api.invokeCapability(pkg.id, actionName, {});
      setResult(formatValue(answer.value));
    } catch (cause) {
      setFailed(true);
      setResult(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRunning(false);
    }
  };

  return (
    <li className="capabilities-action-row">
      <div className="capabilities-action">
        <code className="capabilities-action-name">{actionName}</code>
        <span className="capabilities-action-description">{description}</span>
        <Button
          variant="ghost"
          size="sm"
          className="capabilities-action-run"
          disabled={!pkg.enabled || pkg.trust !== "trusted" || running}
          onClick={() => void run()}
        >
          {running ? t("capabilities.running") : t("capabilities.run")}
        </Button>
      </div>
      {result !== null ? (
        <pre
          className={`capabilities-action-result${failed ? " is-error" : ""}`}
          data-capability-result={actionName}
        >
          {result}
        </pre>
      ) : null}
    </li>
  );
}

/** JSON when it is an object, a bare string when the action returned one. */
function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "null";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function TrustBadge({ trust }: { trust: CapabilityTrust }) {
  const { t } = useTranslation();
  const tone = trust === "trusted" ? "success" : trust === "modified" ? "warning" : "neutral";
  return (
    <Badge tone={tone} className="capabilities-trust">
      {t(`capabilities.trust.${trust}`)}
    </Badge>
  );
}

function RuntimeLabel({ state }: { state?: CapabilityRuntimeState }) {
  const { t } = useTranslation();
  if (!state) return <span className="capabilities-muted">{t("capabilities.runtimeAbsent")}</span>;
  return (
    <span className={`capabilities-runtime is-${state.state}`}>
      {t(`capabilities.runtime.${state.state}`)}
    </span>
  );
}

function PermissionBadges({
  requested,
  granted,
}: {
  requested: CapabilitySummary["requestedPermissions"];
  granted: CapabilitySummary["grantedPermissions"];
}) {
  if (requested.length === 0) return null;
  return (
    <span className="capabilities-permissions">
      {requested.map((permission) => {
        const held = granted.includes(permission);
        return (
          <Badge
            key={permission}
            tone={held ? "neutral" : "warning"}
            className={`capabilities-permission${held ? "" : " is-denied"}`}
          >
            {permission}
          </Badge>
        );
      })}
    </span>
  );
}

function ToolRow({ tool }: { tool: ToolPackageTool }) {
  const { t } = useTranslation();
  const tone = tool.risk === "high" ? "error" : tool.risk === "medium" ? "warning" : "neutral";
  return (
    <li className="tools-tool">
      <code className="tools-tool-name">{tool.name}</code>
      {tool.risk ? (
        <Badge tone={tone} className="tools-tool-risk">
          {t(`tools.risk.${tool.risk}`)}
        </Badge>
      ) : null}
      {tool.description ? (
        <span className="tools-tool-description">{tool.description}</span>
      ) : null}
    </li>
  );
}
