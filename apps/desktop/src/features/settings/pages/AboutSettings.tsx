/**
 * Info destination: what is installed, how it updates, and the two ways out of
 * a problem (logs, bug report). The Developer card stays here because the
 * things it unlocks are diagnostics, not preferences.
 */
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
      </SettingsCard>

      {settings && (
        <DeveloperSection settings={settings} saveSettings={saveSettings} />
      )}
    </div>
  );
}
