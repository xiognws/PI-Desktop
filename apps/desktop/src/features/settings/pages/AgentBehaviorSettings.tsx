/**
 * Agent behavior destination (D684): what a new conversation starts with, and
 * what the agent is allowed to do while it runs.
 *
 * Session defaults and Execution replace the old Defaults card, which had
 * grown into the page's catch-all: it mixed these decisions with transcript
 * presentation and composer input, which are now the Conversation
 * destination.
 */
import type { AppSettings, GlobalPermissionMode } from "@pi-workspace/shared";
import { useTranslation } from "react-i18next";
import { Input, SegmentedControl, SettingsToggle } from "../../../components/ui";
import { SettingsMenuSelect } from "../../../components/settings/SettingsMenuSelect";
import { StreamRulesSettings } from "../stream-rules/StreamRulesSettings";
import { GoalBudgetSettingsRow } from "../../modes/GoalBudgetSettingsRow";
import { CommandShellRow, SettingsCard, SettingsRow } from "../primitives";
import { useAppStore } from "../../../stores/app-store";

export function AgentBehaviorSettings({
  settings,
  saveSettings,
}: {
  settings: AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const providers = useAppStore((state) => state.providers);
  /** Models the chosen provider actually offers, for the second select. */
  const modelsOf = (providerId: string | null | undefined) =>
    (providers.find((row) => row.id === providerId)?.models ?? []).map((binding) => ({
      id: binding.id,
      label: binding.alias?.trim() || binding.id,
    }));
  const noneOption = [{ id: "", label: t("settings.smartModeNone") }];
  return (
    <div className="settings-stack">
      <SettingsCard
        title={t("settings.sessionDefaults")}
        caption={t("settings.sessionDefaultsCaption")}
      >
        <SettingsRow title={t("settings.mode")} description={t("settings.modeDesc")}>
          <SegmentedControl
            value={settings.defaultMode ?? "agent"}
            onChange={(value) => void saveSettings({ defaultMode: value })}
            options={[
              { value: "agent", label: t("settings.modeAgent") },
              { value: "plan", label: t("settings.modePlan") },
              { value: "goal", label: t("settings.modeGoal") },
            ]}
            label={t("settings.mode")}
            role="group"
          />
        </SettingsRow>
        <GoalBudgetSettingsRow settings={settings} saveSettings={saveSettings} />
        <SettingsRow
          title={t("settings.permissionMode")}
          description={t("settings.permissionModeDesc")}
        >
          <SettingsMenuSelect
            className="settings-permission-select"
            label={t("settings.permissionMode")}
            value={settings.defaultPermissionMode ?? "ask"}
            onChange={(mode) =>
              void saveSettings({
                defaultPermissionMode: mode as GlobalPermissionMode,
              })
            }
            options={[
              { id: "ask", label: t("settings.permissionModeAsk") },
              {
                id: "accept-edits",
                label: t("settings.permissionModeAcceptEdits"),
              },
              { id: "auto", label: t("settings.permissionModeAuto") },
            ]}
          />
        </SettingsRow>
        <CommandShellRow settings={settings} saveSettings={saveSettings} />
      </SettingsCard>

      <SettingsCard
        title={t("settings.smartMode")}
        caption={t("settings.smartModeCaption")}
      >
        <SettingsRow
          title={t("settings.smartModeMain")}
          description={t("settings.smartModeMainDesc")}
        >
          <>
            <SettingsMenuSelect
              className="settings-permission-select"
              label={t("settings.smartModeProvider")}
              value={settings.smartModeMainProviderId ?? ""}
              onChange={(id) =>
                // A model belongs to its provider, so changing one clears the other.
                void saveSettings({
                  smartModeMainProviderId: id || null,
                  smartModeMainModelId: null,
                })
              }
              options={[...noneOption, ...providers.map((row) => ({ id: row.id, label: row.name }))]}
            />
            <SettingsMenuSelect
              className="settings-permission-select"
              label={t("settings.smartModeModel")}
              value={settings.smartModeMainModelId ?? ""}
              onChange={(id) => void saveSettings({ smartModeMainModelId: id || null })}
              options={[...noneOption, ...modelsOf(settings.smartModeMainProviderId)]}
            />
          </>
        </SettingsRow>
        <SettingsRow
          title={t("settings.smartModeSub")}
          description={t("settings.smartModeSubDesc")}
        >
          <>
            <SettingsMenuSelect
              className="settings-permission-select"
              label={t("settings.smartModeProvider")}
              value={settings.smartModeSubProviderId ?? ""}
              onChange={(id) =>
                void saveSettings({
                  smartModeSubProviderId: id || null,
                  smartModeSubModelId: null,
                })
              }
              options={[...noneOption, ...providers.map((row) => ({ id: row.id, label: row.name }))]}
            />
            <SettingsMenuSelect
              className="settings-permission-select"
              label={t("settings.smartModeModel")}
              value={settings.smartModeSubModelId ?? ""}
              onChange={(id) => void saveSettings({ smartModeSubModelId: id || null })}
              options={[...noneOption, ...modelsOf(settings.smartModeSubProviderId)]}
            />
          </>
        </SettingsRow>
        <SettingsRow
          title={t("settings.smartModeTurnRouting")}
          description={t("settings.smartModeTurnRoutingDesc")}
        >
          <SettingsToggle
            checked={settings.smartModeTurnRouting !== false}
            label={t("settings.smartModeTurnRouting")}
            onChange={() =>
              void saveSettings({ smartModeTurnRouting: settings.smartModeTurnRouting === false })
            }
          />
        </SettingsRow>
        <SettingsRow
          title={t("settings.smartModeDelegateToSub")}
          description={t("settings.smartModeDelegateToSubDesc")}
        >
          <SettingsToggle
            checked={settings.smartModeDelegateToSub !== false}
            label={t("settings.smartModeDelegateToSub")}
            onChange={() =>
              void saveSettings({ smartModeDelegateToSub: settings.smartModeDelegateToSub === false })
            }
          />
        </SettingsRow>
      </SettingsCard>

      <SettingsCard
        title={t("settings.skillReview")}
        caption={t("settings.skillReviewCaption")}
      >
        <SettingsRow
          title={t("settings.skillReviewEnabled")}
          description={t("settings.skillReviewEnabledDesc")}
        >
          <SettingsToggle
            checked={settings.skillReviewAfterTurn !== false}
            label={t("settings.skillReviewEnabled")}
            onChange={() =>
              void saveSettings({
                skillReviewAfterTurn: settings.skillReviewAfterTurn === false,
              })
            }
          />
        </SettingsRow>
        <SettingsRow
          title={t("settings.skillReviewProvider")}
          description={t("settings.skillReviewProviderDesc")}
        >
          <SettingsMenuSelect
            className="settings-permission-select"
            label={t("settings.skillReviewProvider")}
            value={settings.skillReviewProviderId ?? ""}
            onChange={(id) => void saveSettings({ skillReviewProviderId: id || null })}
            options={[
              { id: "", label: t("settings.skillReviewProviderFollow") },
              ...providers.map((row) => ({ id: row.id, label: row.name })),
            ]}
          />
        </SettingsRow>
        <SettingsRow
          title={t("settings.skillReviewModel")}
          description={t("settings.skillReviewModelDesc")}
        >
          <Input
            // Remounting on the stored value keeps the field in step with an edit
            // made elsewhere, without writing settings on every keystroke.
            key={settings.skillReviewModelId ?? ""}
            defaultValue={settings.skillReviewModelId ?? ""}
            placeholder={t("settings.skillReviewModelPlaceholder")}
            aria-label={t("settings.skillReviewModel")}
            onBlur={(event) =>
              void saveSettings({ skillReviewModelId: event.target.value.trim() || null })
            }
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
        </SettingsRow>
      </SettingsCard>

      <SettingsCard title={t("settings.execution")}>
        <SettingsRow
          title={t("settings.infiniteProviderRetry")}
          description={t("settings.infiniteProviderRetryDesc")}
        >
          <SettingsToggle
            checked={settings.infiniteProviderRetry === true}
            label={t("settings.infiniteProviderRetry")}
            onChange={() => void saveSettings({ infiniteProviderRetry: settings.infiniteProviderRetry !== true })}
          />
        </SettingsRow>
        <SettingsRow
          title={t("settings.scheduledTasks")}
          description={t("settings.scheduledTasksDesc")}
        >
          <SettingsToggle
            checked={settings.scheduledTasksEnabled !== false}
            label={t("settings.scheduledTasks")}
            onChange={() => void saveSettings({
              scheduledTasksEnabled: settings.scheduledTasksEnabled === false,
            })}
          />
        </SettingsRow>
      </SettingsCard>

      <StreamRulesSettings settings={settings} saveSettings={saveSettings} />
    </div>
  );
}
