/**
 * Stream rules (ADR 0400): patterns matched against the agent's own text while it
 * streams. A match aborts the turn, injects the rule message and retries it — so a
 * rule costs nothing on the turns that behave, which is why this belongs in
 * settings rather than in the system prompt.
 *
 * The editor stays deliberately narrow: a rule is a regex and a sentence. Anything
 * that needs a second condition is two rules. Saves go out immediately (like the
 * other behavior toggles on this page) because the runtime picks them up on the
 * next message of an open session.
 */
import type { AppSettings, StreamRuleSetting } from "@pi-workspace/shared";
import { useTranslation } from "react-i18next";
import { Button, Input, SettingsToggle } from "../../../components/ui";
import { SettingsCard, SettingsRow } from "../primitives";

type Patch = (patch: Partial<AppSettings>) => Promise<void>;

function newRule(): StreamRuleSetting {
  // `id` is what activation counts are reported under, so it must stay stable while
  // the user edits the pattern. A timestamp plus a counter is enough here: two rules
  // created in the same millisecond would still differ by the counter.
  const id = `rule-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4).toString(36)}`;
  return { id, name: "", pattern: "", message: "", enabled: true };
}

export function StreamRulesSettings({
  settings,
  saveSettings,
}: {
  settings: AppSettings;
  saveSettings: Patch;
}) {
  const { t } = useTranslation();
  const rules = settings.streamRules ?? [];

  const write = (next: StreamRuleSetting[]) => {
    // Drop rules the user added and left empty: a rule with no pattern can never
    // fire, and storing it would make the list look configured while it is not.
    const kept = next.filter((rule) => rule.pattern.trim() !== "");
    void saveSettings({ streamRules: kept });
  };

  const update = (index: number, patch: Partial<StreamRuleSetting>) =>
    write(rules.map((rule, position) => (position === index ? { ...rule, ...patch } : rule)));

  return (
    <SettingsCard title={t("settings.streamRules")} caption={t("settings.streamRulesCaption")}>
      {rules.length === 0 ? (
        <SettingsRow title={t("settings.streamRulesEmpty")} description={t("settings.streamRulesEmptyDesc")}>
          <Button variant="secondary" onClick={() => write([...rules, newRule()])}>
            {t("settings.streamRulesAdd")}
          </Button>
        </SettingsRow>
      ) : (
        <>
          {rules.map((rule, index) => (
            <SettingsRow
              key={rule.id}
              title={rule.name.trim() || t("settings.streamRulesUntitled")}
              description={t("settings.streamRulesRuleDesc")}
            >
              <div className="settings-stream-rule">
                <Input
                  value={rule.pattern}
                  placeholder={t("settings.streamRulesPatternPlaceholder")}
                  aria-label={t("settings.streamRulesPattern")}
                  onChange={(event) => update(index, { pattern: event.currentTarget.value })}
                  onBlur={(event) => {
                    // The name is derived once, from the pattern, so the log line that
                    // reports a firing is readable without a separate naming step.
                    if (rule.name.trim() === "") update(index, { name: event.currentTarget.value.trim() });
                  }}
                />
                <Input
                  value={rule.message}
                  placeholder={t("settings.streamRulesMessagePlaceholder")}
                  aria-label={t("settings.streamRulesMessage")}
                  onChange={(event) => update(index, { message: event.currentTarget.value })}
                />
                <SettingsToggle
                  checked={rule.enabled !== false}
                  label={t("settings.streamRulesEnabled")}
                  onChange={() => update(index, { enabled: rule.enabled === false })}
                />
                <Button variant="ghost" onClick={() => write(rules.filter((_, position) => position !== index))}>
                  {t("settings.streamRulesRemove")}
                </Button>
              </div>
            </SettingsRow>
          ))}
          <SettingsRow title={t("settings.streamRulesAdd")} description={t("settings.streamRulesCaption")}>
            <Button variant="secondary" onClick={() => write([...rules, newRule()])}>
              {t("settings.streamRulesAdd")}
            </Button>
          </SettingsRow>
        </>
      )}
    </SettingsCard>
  );
}
