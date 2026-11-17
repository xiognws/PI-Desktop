/**
 * Info destination: what is installed, how it updates, and the three ways out of
 * a problem (logs, a support bundle, a bug report). The Developer card stays here
 * because the things it unlocks are diagnostics, not preferences.
 */
import { useState } from "react";
import { APP_NAME, type AppSettings } from "@pi-workspace/shared";
import { useTranslation } from "react-i18next";
import { api } from "../../../lib/api";
import { useAppStore } from "../../../stores/app-store";
import { Button } from "../../../components/ui";
import { UpdatesRow } from "../agent-sections";
import { DeveloperSection } from "../developer-sections";
import { SettingsCard, SettingsRow } from "../primitives";

export function AboutSettings({
  settings,
  saveSettings,
}: {
  settings: AppSettings | null;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const version = useAppStore((s) => s.version);
  const [exporting, setExporting] = useState(false);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  /*
   * A dismissed save dialog is not a failure and not a result: the row stays as
   * it was. Only a written file or a thrown error changes what is on screen, so
   * the row never claims something happened that did not.
   */
  const exportBundle = async () => {
    setExporting(true);
    setExportError(null);
    setSavedPath(null);
    try {
      const result = await api.exportDiagnostics();
      if (result.ok) setSavedPath(result.path);
    } catch (error) {
      setExportError(error instanceof Error ? error.message : String(error));
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="settings-stack">
      <div className="settings-about-hero">
        <div className="settings-about-hero-name">{version?.name || APP_NAME}</div>
        <div className="settings-about-hero-version">
          {t("settings.aboutVersion", { version: version?.version ?? "" })}
        </div>
      </div>
      {/*
        Distribution surface: this page is what an outside reader sees first, so
        it names no build internals and points at nothing external. The update
        card is a development-only affordance — a shipped build has no reachable
        feed — and the update preference therefore never leaves a dev build.
      */}
      {import.meta.env.DEV && settings ? (
        <UpdatesRow
          currentVersion={version?.version}
          settings={settings}
          saveSettings={saveSettings}
        />
      ) : null}
      <SettingsCard>
        <SettingsRow
          title={t("settings.manual")}
          description={t("settings.manualDesc")}
        >
          <Button
            variant="secondary"
            onClick={() => void api.openManual().catch(() => undefined)}
          >
            {t("settings.openManual")}
          </Button>
        </SettingsRow>
        <SettingsRow title={t("settings.logs")}>
          <Button variant="secondary" onClick={() => void api.openLogs()}>
            {t("settings.openLogs")}
          </Button>
        </SettingsRow>
        <SettingsRow
          title={t("settings.diagnosticsExport")}
          description={t("settings.diagnosticsExportDesc")}
          detail={
            savedPath ? (
              <span className="settings-storage-path">
                {t("settings.diagnosticsExportDone", { path: savedPath })}
              </span>
            ) : undefined
          }
        >
          <Button
            variant="secondary"
            disabled={exporting}
            onClick={() => void exportBundle()}
          >
            {t("settings.diagnosticsExport")}
          </Button>
        </SettingsRow>
        {exportError ? (
          <p className="settings-error" role="alert">
            {t("settings.diagnosticsExportFailed", { error: exportError })}
          </p>
        ) : null}
      </SettingsCard>

      {settings && (
        <DeveloperSection settings={settings} saveSettings={saveSettings} />
      )}
    </div>
  );
}
