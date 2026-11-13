import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { Badge, Button } from "../../components/ui";
import { SettingsCard, SettingsRow } from "./primitives";

type ComponentRow = {
  name: string;
  userDir: string;
  overridden: boolean;
  present: boolean;
};

/**
 * Data components the user may replace (ADR 0396 § component overlays).
 *
 * The shipped kit, model catalog and handbook are defaults. This section is the
 * visible half of that decision: where each one lives, whether the user's copy
 * is the one in effect, and a way back to the shipped copy that does not
 * destroy what they wrote — resetting renames the folder beside itself.
 */
export function DataComponentsSection() {
  const { t } = useTranslation();
  const showToast = useAppStore((s) => s.showToast);
  const [components, setComponents] = useState<ComponentRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await api.listComponents();
      setComponents(res.components ?? []);
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : String(cause), { variant: "error" });
    }
  }, [showToast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const open = async (name: string) => {
    setBusy(name);
    try {
      await api.openComponentDir(name);
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : String(cause), { variant: "error" });
    } finally {
      setBusy(null);
    }
  };

  const reset = async (name: string) => {
    setBusy(name);
    try {
      const res = await api.resetComponent(name);
      setComponents(res.components ?? []);
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : String(cause), { variant: "error" });
    } finally {
      setBusy(null);
    }
  };

  return (
    <SettingsCard
      title={t("settings.components.title")}
      description={t("settings.components.description")}
    >
      {components.map((component) => (
        <SettingsRow
          key={component.name}
          title={t(`settings.components.name.${component.name}`, {
            defaultValue: component.name,
          })}
          description={t(`settings.components.hint.${component.name}`, {
            defaultValue: "",
          })}
          detail={<span className="settings-storage-path">{component.userDir}</span>}
        >
          <div className="settings-row-controls">
            <Badge tone={component.overridden ? "success" : "neutral"}>
              {component.overridden
                ? t("settings.components.overridden")
                : t("settings.components.shipped")}
            </Badge>
            <Button
              variant="secondary"
              disabled={busy === component.name}
              onClick={() => void open(component.name)}
            >
              {t("settings.components.open")}
            </Button>
            {component.present ? (
              <Button
                variant="secondary"
                disabled={busy === component.name}
                onClick={() => void reset(component.name)}
              >
                {t("settings.components.reset")}
              </Button>
            ) : null}
          </div>
        </SettingsRow>
      ))}
    </SettingsCard>
  );
}
