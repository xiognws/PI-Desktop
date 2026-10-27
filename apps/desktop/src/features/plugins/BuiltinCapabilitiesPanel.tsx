/**
 * Built-in capabilities that are not plugins (settings, not extensions).
 *
 * This panel exists because those capabilities live in the settings tree, far
 * from the page a user opens when thinking "what is switched on in this app".
 * It brings the switch to where the question is asked — and nothing else:
 * anything with more than one value (which subagents, which model does search)
 * keeps a single entry point to its own settings page instead of a second copy
 * of that form here.
 *
 * Adding or removing a row is a change to the render below, no new plumbing.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { AppSettings } from "@pi-desktop/shared";
import { Badge, Button, SettingsToggle } from "../../components/ui";
import { IconBot, IconGlobe, IconSliders } from "../../components/icons";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";

type SubagentTally = { enabled: number; total: number };

export function BuiltinCapabilitiesPanel() {
  const { t } = useTranslation();
  const settings = useAppStore((s) => s.settings);
  const [tally, setTally] = useState<SubagentTally | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api
      .subagentCatalog()
      .then((catalog) => {
        if (cancelled) return;
        setTally({
          enabled: catalog.builtins.filter((row) => row.enabled).length,
          total: catalog.builtins.length,
        });
      })
      .catch(() => {
        // A catalog failure only costs the count, never the panel.
        if (!cancelled) setTally(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const openSettingsPage = (tab: "about" | "subagents" | "agent") => {
    const store = useAppStore.getState();
    store.setSettingsTab(tab);
    store.setPage("settings");
  };

  const saveSettings = async (patch: Partial<AppSettings>) => {
    if (!settings) return;
    const next = { ...settings, ...patch };
    setSaving(true);
    try {
      await api.setSettings(next);
      useAppStore.setState({ settings: next });
    } finally {
      setSaving(false);
    }
  };

  const developerMode = settings?.developerMode === true;

  return (
    <section className="plugins-group plugins-capabilities">
      <header className="plugins-group-head">
        <h2 className="plugins-group-label">{t("plugins.builtinTitle")}</h2>
        <span className="plugins-group-count">3</span>
      </header>
      <div className="plugins-list" role="list" aria-label={t("plugins.builtinTitle")}>
        <article role="listitem" className="plugins-row">
          <div className="plugins-row-head">
            <span className="plugins-glyph" aria-hidden>
              <IconSliders size={15} />
            </span>
            <div className="plugins-row-title">
              <span className="plugins-row-name">{t("plugins.capabilityDeveloper")}</span>
              <Badge tone="neutral">{t("plugins.capabilitySwitch")}</Badge>
            </div>
          </div>
          <div className="plugins-row-copy">
            <p className="plugins-row-desc">{t("plugins.capabilityDeveloperDesc")}</p>
          </div>
          <div className="plugins-row-controls">
            <SettingsToggle
              checked={developerMode}
              disabled={saving || !settings}
              label={t("plugins.capabilityDeveloper")}
              onChange={() => void saveSettings({ developerMode: !developerMode })}
            />
            <Button variant="ghost" size="sm" onClick={() => openSettingsPage("about")}>
              {t("plugins.capabilityOpenSettings")}
            </Button>
          </div>
        </article>

        <article role="listitem" className="plugins-row">
          <div className="plugins-row-head">
            <span className="plugins-glyph" aria-hidden>
              <IconBot size={15} />
            </span>
            <div className="plugins-row-title">
              <span className="plugins-row-name">{t("plugins.capabilitySubagents")}</span>
              {tally && tally.total > 0 ? (
                <Badge tone={tally.enabled > 0 ? "success" : "neutral"}>
                  {t("plugins.capabilityTally", { enabled: tally.enabled, total: tally.total })}
                </Badge>
              ) : null}
            </div>
          </div>
          <div className="plugins-row-copy">
            <p className="plugins-row-desc">{t("plugins.capabilitySubagentsDesc")}</p>
          </div>
          <div className="plugins-row-controls">
            <Button variant="ghost" size="sm" onClick={() => openSettingsPage("subagents")}>
              {t("plugins.manageSettings")}
            </Button>
          </div>
        </article>

        <article role="listitem" className="plugins-row">
          <div className="plugins-row-head">
            <span className="plugins-glyph" aria-hidden>
              <IconGlobe size={15} />
            </span>
            <div className="plugins-row-title">
              <span className="plugins-row-name">{t("plugins.capabilityWebSearch")}</span>
              <Badge tone="neutral">{t("plugins.capabilityModelProvided")}</Badge>
            </div>
          </div>
          <div className="plugins-row-copy">
            <p className="plugins-row-desc">{t("plugins.capabilityWebSearchDesc")}</p>
          </div>
          <div className="plugins-row-controls">
            <Button variant="ghost" size="sm" onClick={() => openSettingsPage("agent")}>
              {t("plugins.openModelSettings")}
            </Button>
          </div>
        </article>
      </div>
    </section>
  );
}
