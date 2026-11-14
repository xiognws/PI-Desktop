/**
 * Settings → System → Python.
 *
 * The app always runs some interpreter, so there is no enabled/disabled switch:
 * the only decision is *which*. Leaving it on automatic prefers the user's own
 * environment and falls back to the runtime this build ships; picking a path runs
 * exactly that file and says what it is missing.
 */
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { api, type PythonCandidate, type PythonStatus } from "../../lib/api";
import { Badge, Button, SettingsToggle } from "../../components/ui";
import { SettingsCard, SettingsRow } from "./primitives";

const SOURCE_LABEL: Record<PythonCandidate["source"], string> = {
  configured: "settings.pythonSourceConfigured",
  "data-venv": "settings.pythonSourceDataVenv",
  launcher: "settings.pythonSourceLauncher",
  path: "settings.pythonSourcePath",
  common: "settings.pythonSourceCommon",
};

export function PythonSettingsSection() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<PythonStatus | null>(null);
  const [candidates, setCandidates] = useState<PythonCandidate[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [manualPath, setManualPath] = useState("");

  const refresh = useCallback(async (scan: boolean) => {
    setBusy(true);
    setError("");
    try {
      const next = await api.pythonStatus();
      setStatus(next);
      if (scan) {
        const result = await api.pythonScan();
        setCandidates(result.candidates);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void refresh(true);
  }, [refresh]);

  const choose = async (path: string) => {
    setBusy(true);
    setError("");
    try {
      // The app resolves the interpreter for the next launch, so the answer comes
      // back as a fresh status rather than being patched locally.
      setStatus(await api.pythonSetPath(path));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const browse = async () => {
    try {
      const picked = await api.pythonChoose();
      if (!picked.path) return;
      setManualPath(picked.path);
      await choose(picked.path);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const active = status?.active ?? null;
  const automatic = !status?.configured;

  return (
    <SettingsCard title={t("settings.pythonTitle")} description={t("settings.pythonCaption")}>
      <SettingsRow
        title={t("settings.pythonActive")}
        description={
          active
            ? `${active.path}${active.version ? ` · ${t("settings.pythonVersion", { version: active.version })}` : ""}`
            : t("settings.pythonNone")
        }
      >
        <div className="python-status-actions">
          {active ? (
            <Badge tone={active.source === "bundled" ? "neutral" : "success"}>
              {active.source === "bundled"
                ? t("settings.pythonBundled")
                : t(SOURCE_LABEL[active.source as PythonCandidate["source"]] ?? "settings.pythonSourceCommon")}
            </Badge>
          ) : null}
          <Button type="button" disabled={busy} onClick={() => void refresh(true)}>
            {t("settings.pythonScan")}
          </Button>
          <Button type="button" disabled={busy} onClick={() => void browse()}>
            {t("settings.pythonBrowse")}
          </Button>
        </div>
      </SettingsRow>

      {!automatic && status?.configuredUsable === false ? (
        <SettingsRow title={t("settings.pythonConfiguredMissing")} description={status.configured}>
          <Button type="button" disabled={busy} onClick={() => void choose("")}>
            {t("settings.pythonUseAutomatic")}
          </Button>
        </SettingsRow>
      ) : null}

      <SettingsRow
        title={t("settings.pythonAutomatic")}
        description={t("settings.pythonAutomaticDesc")}
      >
        <SettingsToggle
          checked={automatic}
          label={t("settings.pythonAutomatic")}
          onChange={() => void choose(automatic ? (active?.path ?? "") : "")}
        />
      </SettingsRow>

      {candidates.length > 0 ? (
        <div className="python-candidates">
          {candidates.map((candidate) => {
            const selected = status?.configured === candidate.path;
            return (
              <button
                key={candidate.path}
                type="button"
                className={selected ? "python-candidate is-selected" : "python-candidate"}
                disabled={busy}
                onClick={() => void choose(candidate.path)}
                title={candidate.path}
              >
                <span className="python-candidate-path">{candidate.path}</span>
                <span className="python-candidate-meta">
                  {candidate.version ? t("settings.pythonVersion", { version: candidate.version }) : "—"}
                  {" · "}
                  {t(SOURCE_LABEL[candidate.source])}
                </span>
                <Badge tone={candidate.hasLibraries ? "neutral" : "warning"}>
                  {candidate.hasLibraries
                    ? t("settings.pythonHasLibraries")
                    : t("settings.pythonMissingLibraries")}
                </Badge>
              </button>
            );
          })}
        </div>
      ) : (
        <SettingsRow title={t("settings.pythonNoCandidates")} description={manualPath}>
          <span />
        </SettingsRow>
      )}

      {error ? <p className="settings-error">{error}</p> : null}
    </SettingsCard>
  );
}
