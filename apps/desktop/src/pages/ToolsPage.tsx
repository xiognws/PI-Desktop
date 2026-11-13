import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type {
  WidgetRuntimeState,
  WidgetSummary,
  WidgetTrust,
  ToolPackageSummary,
  ToolPackageTool,
} from "@pi-workspace/shared";

import { IconChevronDown, IconChevronRight, IconRefresh, IconSparkles, IconWrench } from "../components/icons";
import { Badge, Button, SettingsToggle, TooltipButton } from "../components/ui";
import { api } from "../lib/api";
import "../features/tools/tools.css";

/**
 * Tools: one page for both kinds of package this build can run (D681, D699).
 *
 * Tool packages are directories under `resources/tools` with a `tool.json`
 * manifest; widget packages are directories the *user* drops into
 * `<userData>/widgets`. They are listed together — widgets first,
 * because a scanned widget folder is the only thing on this page the user
 * personally put there. Each section only renders packages that were actually
 * found, so an empty scan produces no heading and no empty card.
 */
export function ToolsPage() {
  const { t } = useTranslation();
  const [packages, setPackages] = useState<ToolPackageSummary[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [widgets, setCapabilities] = useState<WidgetSummary[]>([]);
  const [widgetStates, setWidgetStates] = useState<WidgetRuntimeState[]>([]);
  const [widgetStatus, setWidgetStatus] = useState<"loading" | "ready" | "error">("loading");
  const [widgetError, setWidgetError] = useState("");
  const [widgetBusyId, setWidgetBusyId] = useState<string | null>(null);

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
    setWidgetStatus((current) => (current === "ready" ? current : "loading"));
    try {
      const result = await api.listWidgets();
      setCapabilities(result.packages);
      setWidgetError("");
      setWidgetStatus("ready");
      // Runtime state is advisory: the sidecar is not necessarily up, and that
      // must not blank out a list the host just answered.
      const runtime = await api.widgetRuntime().catch(() => ({ states: [] }));
      setWidgetStates(runtime.states);
    } catch (cause) {
      setWidgetError(cause instanceof Error ? cause.message : String(cause));
      setWidgetStatus("error");
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

  /** Settle the widget section after any write, and mirror the runtime. */
  const settleCapabilities = async (next: WidgetSummary[]) => {
    setCapabilities(next);
    setWidgetError("");
    setWidgetStatus("ready");
    const runtime = await api.widgetRuntime().catch(() => ({ states: [] }));
    setWidgetStates(runtime.states);
  };

  const toggleWidget = async (id: string, enabled: boolean) => {
    setWidgetBusyId(id);
    try {
      const result = await api.setWidgetEnabled(id, enabled);
      await settleCapabilities(result.packages);
    } catch (cause) {
      setWidgetError(cause instanceof Error ? cause.message : String(cause));
      setWidgetStatus("error");
    } finally {
      setWidgetBusyId(null);
    }
  };

  /**
   * Trust is pinned to the digest on screen. Files that changed after review are
   * rejected by the host instead of being trusted silently, and that failure is
   * shown here so the user can reload and look again.
   */
  const setWidgetTrust = async (pkg: WidgetSummary, trusted: boolean) => {
    setWidgetBusyId(pkg.id);
    try {
      const result = await api.setWidgetTrust(pkg.id, pkg.digest, trusted);
      await settleCapabilities(result.packages);
    } catch (cause) {
      setWidgetError(cause instanceof Error ? cause.message : String(cause));
      setWidgetStatus("error");
    } finally {
      setWidgetBusyId(null);
    }
  };

  const revealWidget = async (id: string) => {
    try {
      await api.revealWidget(id);
    } catch (cause) {
      setWidgetError(cause instanceof Error ? cause.message : String(cause));
      setWidgetStatus("error");
    }
  };

  const revealCapabilitiesDir = async () => {
    try {
      await api.revealWidgetsDir();
    } catch (cause) {
      setWidgetError(cause instanceof Error ? cause.message : String(cause));
      setWidgetStatus("error");
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
        <WidgetSection
          packages={widgets}
          states={widgetStates}
          status={widgetStatus}
          error={widgetError}
          busyId={widgetBusyId}
          onReload={() => void loadCapabilities()}
          onToggle={(id, enabled) => void toggleWidget(id, enabled)}
          onTrust={(pkg, trusted) => void setWidgetTrust(pkg, trusted)}
          onReveal={(id) => void revealWidget(id)}
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
 * Widget packages found under `<userData>/widgets` (D699).
 *
 * Nothing is rendered when the scan found nothing: this section exists because
 * the user put those folders there, not because the build promises a feature.
 * Each action can be run from here, which is the client side of the two-way
 * contract — the agent reaches the same actions through its `Widget` tool.
 */
function WidgetSection({
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
  packages: WidgetSummary[];
  states: WidgetRuntimeState[];
  status: "loading" | "ready" | "error";
  error: string;
  busyId: string | null;
  onReload: () => void;
  onToggle: (id: string, enabled: boolean) => void;
  onTrust: (pkg: WidgetSummary, trusted: boolean) => void;
  onReveal: (id: string) => void;
  onRevealDir: () => void;
}) {
  const { t } = useTranslation();
  const stateOf = (id: string) => states.find((state) => state.id === id);

  if (status === "loading" && packages.length === 0) {
    return <p className="tools-placeholder">{t("widgets.loading")}</p>;
  }
  if (status === "error" && packages.length === 0) {
    return (
      <div className="tools-widget-section">
        <p className="tools-placeholder is-error">
          {t("widgets.loadFailed", { message: error })}
        </p>
        <div className="tools-widget-section-actions">
          <Button variant="ghost" size="sm" onClick={onReload}>
            {t("widgets.refresh")}
          </Button>
          <Button variant="ghost" size="sm" onClick={onRevealDir}>
            {t("widgets.revealDir")}
          </Button>
        </div>
      </div>
    );
  }
  if (packages.length === 0) return null;

  return (
    <div className="tools-widget-section" data-widget-section="true">
      <div className="tools-widget-section-head">
        <div className="tools-widget-section-title">
          <IconSparkles size={14} aria-hidden />
          <h3>{t("widgets.title")}</h3>
          <span className="tools-count">
            {t("widgets.count", { count: packages.length })}
          </span>
        </div>
        <Button variant="ghost" size="sm" onClick={onRevealDir}>
          {t("widgets.revealDir")}
        </Button>
      </div>
      {status === "error" ? (
        <p className="tools-placeholder is-error">
          {t("widgets.loadFailed", { message: error })}
        </p>
      ) : null}
      <div className="tools-list">
        {packages.map((pkg) => (
          <article
            key={pkg.id}
            className={`tools-card widgets-card${pkg.enabled ? "" : " is-disabled"}`}
            data-widget={pkg.id}
            data-trust={pkg.trust}
          >
            <div className="tools-card-head">
              <div className="tools-card-identity">
                <span className="tools-card-name">{pkg.name}</span>
                {pkg.version ? (
                  <Badge tone="neutral" className="tools-card-version">
                    {t("widgets.version", { version: pkg.version })}
                  </Badge>
                ) : null}
                <TrustBadge trust={pkg.trust} />
              </div>
              <SettingsToggle
                checked={pkg.enabled}
                label={t("widgets.enableLabel", { name: pkg.name })}
                busy={busyId === pkg.id}
                disabled={busyId === pkg.id || pkg.trust === "untrusted"}
                onChange={() => onToggle(pkg.id, !pkg.enabled)}
              />
            </div>

            {pkg.error ? (
              <p className="tools-card-error" role="alert">
                {t("widgets.broken", { message: pkg.error })}
              </p>
            ) : (
              <>
                {pkg.description ? (
                  <p className="tools-card-description">{pkg.description}</p>
                ) : null}

                <dl className="widgets-facts">
                  <dt>{t("widgets.factPermissions")}</dt>
                  <dd>
                    <PermissionBadges
                      requested={pkg.requestedPermissions}
                      granted={pkg.grantedPermissions}
                    />
                  </dd>
                  <dt>{t("widgets.factRuntime")}</dt>
                  <dd>
                    <RuntimeLabel state={stateOf(pkg.id)} />
                  </dd>
                </dl>

                {pkg.actions.length === 0 ? (
                  <p className="tools-card-note">{t("widgets.noActions")}</p>
                ) : (
                  <ul className="widgets-action-list">
                    {pkg.actions.map((action) => (
                      <WidgetActionRow
                        key={action.name}
                        pkg={pkg}
                        actionName={action.name}
                        description={action.description}
                      />
                    ))}
                  </ul>
                )}

                <div className="widgets-card-actions">
                  {pkg.trust === "trusted" ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busyId === pkg.id}
                      onClick={() => onTrust(pkg, false)}
                    >
                      {t("widgets.revokeTrust")}
                    </Button>
                  ) : (
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={busyId === pkg.id}
                      onClick={() => onTrust(pkg, true)}
                    >
                      {pkg.trust === "modified"
                        ? t("widgets.trustAgain")
                        : t("widgets.trustLabel")}
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" onClick={() => onReveal(pkg.id)}>
                    {t("widgets.reveal")}
                  </Button>
                  <span className="widgets-digest" title={pkg.digest}>
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
 * produced it: a widget package is arbitrary user code, so seeing what it
 * returned — or why it failed — is the only honest feedback available.
 *
 * The result starts collapsed to a single status line. A package can return
 * pages of JSON and a card holds several actions, so an always-open block turns
 * one card into a wall of text. The status line still says whether it worked and
 * how long it took; the payload is one click away.
 */
function WidgetActionRow({
  pkg,
  actionName,
  description,
}: {
  pkg: WidgetSummary;
  actionName: string;
  description: string;
}) {
  const { t } = useTranslation();
  const [result, setResult] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [running, setRunning] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [durationMs, setDurationMs] = useState(0);

  const run = async () => {
    setRunning(true);
    setFailed(false);
    // Collapse the previous answer: the old payload must not sit above the new
    // one while the call is in flight.
    setExpanded(false);
    const startedAt = Date.now();
    try {
      const answer = await api.invokeWidget(pkg.id, actionName, {});
      setResult(formatValue(answer.value));
      setDurationMs(typeof answer.durationMs === "number" ? answer.durationMs : Date.now() - startedAt);
    } catch (cause) {
      setFailed(true);
      setResult(cause instanceof Error ? cause.message : String(cause));
      setDurationMs(Date.now() - startedAt);
    } finally {
      setRunning(false);
    }
  };

  const status = failed ? t("widgets.resultFailed") : t("widgets.resultOk");

  return (
    <li className="widgets-action-row">
      <div className="widgets-action">
        <code className="widgets-action-name">{actionName}</code>
        <span className="widgets-action-description">{description}</span>
        <Button
          variant="ghost"
          size="sm"
          className="widgets-action-run"
          disabled={!pkg.enabled || pkg.trust !== "trusted" || running}
          onClick={() => void run()}
        >
          {running ? t("widgets.running") : t("widgets.run")}
        </Button>
      </div>
      {result !== null ? (
        <div className="widgets-result" data-widget-result={actionName}>
          <button
            type="button"
            className={`widgets-result-toggle${failed ? " is-error" : ""}`}
            aria-expanded={expanded}
            data-widget-expanded={expanded ? "true" : "false"}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? (
              <IconChevronDown size={12} aria-hidden />
            ) : (
              <IconChevronRight size={12} aria-hidden />
            )}
            <span className="widgets-result-status">{status}</span>
            <span className="widgets-result-duration">{formatDuration(durationMs)}</span>
            <span className="widgets-result-hint">
              {expanded ? t("widgets.hideResult") : t("widgets.showResult")}
            </span>
          </button>
          {expanded ? (
            <pre className={`widgets-action-result${failed ? " is-error" : ""}`}>{result}</pre>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** Milliseconds once, seconds above 1000 — the two scales a user can feel. */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
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

function TrustBadge({ trust }: { trust: WidgetTrust }) {
  const { t } = useTranslation();
  const tone = trust === "trusted" ? "success" : trust === "modified" ? "warning" : "neutral";
  return (
    <Badge tone={tone} className="widgets-trust">
      {t(`widgets.trust.${trust}`)}
    </Badge>
  );
}

function RuntimeLabel({ state }: { state?: WidgetRuntimeState }) {
  const { t } = useTranslation();
  if (!state) return <span className="widgets-muted">{t("widgets.runtimeAbsent")}</span>;
  return (
    <span className={`widgets-runtime is-${state.state}`}>
      {t(`widgets.runtime.${state.state}`)}
    </span>
  );
}

function PermissionBadges({
  requested,
  granted,
}: {
  requested: WidgetSummary["requestedPermissions"];
  granted: WidgetSummary["grantedPermissions"];
}) {
  if (requested.length === 0) return null;
  return (
    <span className="widgets-permissions">
      {requested.map((permission) => {
        const held = granted.includes(permission);
        return (
          <Badge
            key={permission}
            tone={held ? "neutral" : "warning"}
            className={`widgets-permission${held ? "" : " is-denied"}`}
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
