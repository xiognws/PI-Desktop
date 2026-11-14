import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import type { InAppProviderSurface } from "../../lib/in-app-credits";
import { Badge, SettingsToggle } from "../../components/ui";
import { SettingsCard, SettingsRow } from "../../features/settings/primitives";

/**
 * The providers whose gateway is part of the image (ADR 0397).
 *
 * They are ordinary provider rows once the gateway is up, which is exactly why
 * they need a card of their own: the row looks like every other provider, and
 * the two things a user cannot see from it are whether the gateway is running
 * and where it listens. The switch is the persisted setting — turning it off
 * stops the gateway now and keeps it off on the next launch — so this card is
 * the only place either decision is visible.
 */
export function InAppProviderCard() {
  const { t } = useTranslation();
  const showToast = useAppStore((s) => s.showToast);
  const [providers, setProviders] = useState<InAppProviderSurface[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const result = await api.inAppProviders();
      setProviders(result.providers ?? []);
    } catch {
      // Main answers with a state, never an error; a missing host during boot is
      // the one case that throws, and the card simply stays empty until mount.
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggle = useCallback(
    async (provider: InAppProviderSurface, enabled: boolean) => {
      if (busy) return;
      setBusy(provider.id);
      try {
        const result = await api.setInAppProviderEnabled({
          providerId: provider.id,
          enabled,
        });
        setProviders(result.providers ?? []);
      } catch (cause) {
        showToast(cause instanceof Error ? cause.message : String(cause), {
          variant: "error",
        });
      } finally {
        setBusy(null);
      }
    },
    [busy, showToast],
  );

  if (!loaded || providers.length === 0) return null;

  return (
    <SettingsCard
      title={t("settings.inAppProviders")}
      caption={t("settings.inAppProvidersCaption")}
    >
      {providers.map((provider) => {
        const running = provider.running && provider.enabled;
        return (
          <SettingsRow
            key={provider.id}
            title={provider.label}
            detail={
              running
                ? t("settings.inAppProviderPortDetail", {
                    port: provider.port,
                    models: provider.models,
                  })
                : provider.enabled && provider.reason
                  ? t("settings.inAppProviderGatewayDown", { reason: provider.reason })
                  : undefined
            }
            description={t("settings.inAppProviderToggleDescription", {
              port: provider.port,
            })}
          >
            <div className="settings-row-actions">
              <Badge tone={running ? "success" : "neutral"}>
                {running
                  ? t("settings.inAppProviderRunning")
                  : t("settings.inAppProviderStopped")}
              </Badge>
              <SettingsToggle
                checked={provider.enabled}
                busy={busy === provider.id}
                label={t("settings.inAppProviderToggle")}
                onChange={() => void toggle(provider, !provider.enabled)}
              />
            </div>
          </SettingsRow>
        );
      })}
    </SettingsCard>
  );
}
