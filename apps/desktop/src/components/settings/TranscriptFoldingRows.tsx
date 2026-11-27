import { useTranslation } from "react-i18next";
import type { AppSettings } from "@pi-workspace/shared";
import { resolveShowThinking } from "../../lib/thinking-visibility";
import {
  resolveAutoCollapseSettledGroups,
  resolveAutoCollapseThinking,
} from "../../lib/transcript-folding";
import { SettingsRow } from "../../features/settings/primitives";
import { SettingsToggle } from "../ui";

/*
 * The two switches behind a folded transcript (issue #2094).
 *
 * Hiding a sub-row never writes a value, so a reader who turns `Show thinking`
 * off and on again finds the choice they made still in place. `Auto-fold
 * finished groups` is not hidden by any layout: it decides the turn's own
 * process disclosure too, so it survives the mode switch and stays reachable
 * from all three layouts.
 */

/** Fold reasoning that is no longer streaming. */
export function AutoCollapseThinkingRow({
  settings,
  saveSettings,
}: {
  settings: AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  // With `Show thinking` off no completed reasoning renders at all, so the
  // switch would have nothing to act on.
  if (!resolveShowThinking(settings)) return null;
  const collapse = resolveAutoCollapseThinking(settings);
  return (
    <SettingsRow
      nested
      title={t("settings.autoCollapseThinking")}
      description={t("settings.autoCollapseThinkingDesc")}
    >
      <SettingsToggle
        checked={collapse}
        label={t("settings.autoCollapseThinking")}
        onChange={() => void saveSettings({ autoCollapseThinking: !collapse })}
      />
    </SettingsRow>
  );
}

/** Fold activity groups that are no longer running. */
export function AutoCollapseSettledGroupsRow({
  settings,
  saveSettings,
}: {
  settings: AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  // The switch also governs the turn's own process disclosure, which every
  // layout renders, so it stays visible in `flat` too - a hidden switch that
  // still decides what the reader sees is worse than no switch.
  const collapse = resolveAutoCollapseSettledGroups(settings);
  return (
    <SettingsRow
      nested
      title={t("settings.autoCollapseSettledGroups")}
      description={t("settings.autoCollapseSettledGroupsDesc")}
    >
      <SettingsToggle
        checked={collapse}
        label={t("settings.autoCollapseSettledGroups")}
        onChange={() => void saveSettings({ autoCollapseSettledGroups: !collapse })}
      />
    </SettingsRow>
  );
}
