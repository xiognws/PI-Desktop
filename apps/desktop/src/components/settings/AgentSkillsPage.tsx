import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  GLOBAL_SCOPE,
  type AgentCapabilityLevel,
  type BuiltinSkillRecord,
  type UserSkillRecord,
} from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { useHostCollection } from "../../hooks/use-host-collection";
import { useRowBusy } from "../../hooks/use-row-busy";
import {
  AgentCapabilityPage,
  CapabilityButton,
  CapabilityEmpty,
  CapabilityGroupHeader,
  CapabilityPanel,
  CapabilityRow,
  CapabilityRowMenu,
  CapabilityToggle,
  CapabilityToolbar,
  matchesCapabilitySearch,
  useArmedDelete,
  type CapabilityFilter,
  type CapabilityMenuItem,
} from "./AgentCapabilityLayout";
import {
  SkillEditorSheet,
  draftFromSkill,
  emptySkillDraft,
  type SkillDraft,
} from "./SkillEditorSheet";
import {
  IconBookOpen,
  IconDownload,
  IconFileText,
  IconFolderOpen,
  IconPencil,
  IconPlus,
  IconTrash,
} from "../icons";
import { SkillMarketPanel } from "./SkillMarketPanel";
import { AgentSkillImportPanel } from "../../features/settings/imports/AgentSkillImportPanel";
import { ImportToggleButton } from "../../features/settings/import-workbench";

import { TooltipButton } from "../ui";
const GLOBAL_SKILLS_PATH = "~/.agents/skills";

/** Skills are a single flat library, so every row lives at this level. */
const SKILL_LEVEL: AgentCapabilityLevel = "global";
const SKILL_LEVEL_QUERY = { level: SKILL_LEVEL } as const;

type SkillEditorState = {
  draft: SkillDraft;
  editing: UserSkillRecord | null;
  level: AgentCapabilityLevel;
};

type SkillCollection = {
  builtins: BuiltinSkillRecord[];
  global: UserSkillRecord[];
};

const EMPTY_SKILL_COLLECTION: SkillCollection = { builtins: [], global: [] };

export function AgentSkillsPage() {
  const { t } = useTranslation();
  const showToast = useAppStore((state) => state.showToast);
  const fetchSkills = useCallback(async (): Promise<SkillCollection> => {
    const [builtins, global] = await Promise.all([
      api.listBuiltinSkills(),
      api.listUserSkills({ level: SKILL_LEVEL }),
    ]);
    return {
      builtins: builtins.builtins ?? [],
      global: global.skills ?? [],
    };
  }, []);
  const {
    data: { builtins: builtinSkills, global: globalSkills },
    setData: setSkills,
    loading,
    refreshing,
    reload: load,
  } = useHostCollection(fetchSkills, EMPTY_SKILL_COLLECTION, (error) =>
    showToast(error instanceof Error ? error.message : String(error), { variant: "error" }),
  );
  const [filter, setFilter] = useState<CapabilityFilter>("all");
  const [importOpen, setImportOpen] = useState(false);
  const [search, setSearch] = useState("");
  const rowBusy = useRowBusy();
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [editor, setEditor] = useState<SkillEditorState | null>(null);
  const [view, setView] = useState<"skills" | "market">("skills");
  const [saving, setSaving] = useState(false);
  const { armed, setArmed } = useArmedDelete();

  const rowKey = (level: AgentCapabilityLevel, id: string) => `${level}:${id}`;
  const builtinRowKey = (id: string) => `builtin:${id}`;

  const patchBuiltin = (id: string, patch: Partial<BuiltinSkillRecord>) => {
    setSkills((current) => ({
      ...current,
      builtins: current.builtins.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    }));
  };

  const patchRow = (id: string, patch: Partial<UserSkillRecord>) => {
    setSkills((current) => ({
      ...current,
      global: current.global.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    }));
  };

  /**
   * The switch flips locally first and only reverts if the host refuses, so one
   * row's request never blanks the list or freezes the others.
   */
  const toggle = async (skill: UserSkillRecord) => {
    const key = rowKey(SKILL_LEVEL, skill.id);
    if (!rowBusy.begin(key)) return;
    const next = !skill.enabled;
    patchRow(skill.id, { enabled: next });
    try {
      await api.setUserSkillEnabled(skill.id, next, SKILL_LEVEL_QUERY);
      showToast(
        t(next ? "settings.capabilityEnabled" : "settings.capabilityDisabled", {
          name: skill.name || skill.id,
        }),
        { variant: "success" },
      );
    } catch (error) {
      patchRow(skill.id, { enabled: skill.enabled });
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      rowBusy.end(key);
    }
  };

  const toggleBuiltin = async (skill: BuiltinSkillRecord) => {
    const key = builtinRowKey(skill.id);
    if (!rowBusy.begin(key)) return;
    const next = !skill.enabled;
    patchBuiltin(skill.id, { enabled: next });
    try {
      await api.setBuiltinSkillEnabled(skill.id, next);
      showToast(
        t(next ? "settings.capabilityEnabled" : "settings.capabilityDisabled", {
          name: skill.name || skill.id,
        }),
        { variant: "success" },
      );
    } catch (error) {
      patchBuiltin(skill.id, { enabled: skill.enabled });
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      rowBusy.end(key);
    }
  };

  const openCreate = () => {
    setEditor({
      draft: { ...emptySkillDraft(), scope: GLOBAL_SCOPE },
      editing: null,
      level: SKILL_LEVEL,
    });
  };

  const openEdit = async (skill: UserSkillRecord) => {
    const key = rowKey(SKILL_LEVEL, skill.id);
    if (!rowBusy.begin(key)) return;
    try {
      const result = await api.readUserSkill(skill.id, SKILL_LEVEL_QUERY);
      setEditor({
        draft: draftFromSkill(result.skill ?? skill, result.body ?? ""),
        editing: result.skill ?? skill,
        level: SKILL_LEVEL,
      });
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      rowBusy.end(key);
    }
  };

  const save = async () => {
    if (!editor) return;
    const { draft, editing } = editor;
    const payload = {
      name: draft.name.trim(),
      description: draft.description.trim(),
      body: draft.body,
      enabled: draft.enabled,
      scope: draft.scope,
      level: SKILL_LEVEL,
    };
    setSaving(true);
    try {
      if (editing) await api.updateUserSkill(editing.id, payload);
      else await api.createUserSkill(payload);
      await load();
      showToast(
        t(editing ? "settings.skillSaved" : "settings.skillCreated", { name: payload.name }),
        { variant: "success" },
      );
      setEditor(null);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setSaving(false);
    }
  };

  const reveal = async (skill: UserSkillRecord) => {
    try {
      await api.revealUserSkill(skill.id, SKILL_LEVEL_QUERY);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    }
  };

  const remove = async (skill: UserSkillRecord) => {
    const key = rowKey(SKILL_LEVEL, skill.id);
    if (!rowBusy.begin(key)) return;
    try {
      await api.removeUserSkill(skill.id, SKILL_LEVEL_QUERY);
      await load();
      showToast(t("settings.capabilityDeleted", { name: skill.name || skill.id }), {
        variant: "success",
      });
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      rowBusy.end(key);
      setArmed(null);
    }
  };

  const importSkill = async (sourceKind: "file" | "dir" = "file") => {
    const importKey = sourceKind === "dir" ? "import-dir" : "import";
    if (!rowBusy.begin(importKey)) return;
    try {
      const result = await api.importUserSkill({ level: SKILL_LEVEL, sourceKind });
      if (!result.canceled) {
        await load();
        if (result.skill) {
          showToast(t("settings.skillImported", { name: result.skill.name }), {
            variant: "success",
          });
        }
        if (result.imported?.length) {
          showToast(t("settings.skillBatchImported", { count: result.imported.length }), {
            variant: "success",
          });
        }
        if (result.failed?.length) {
          const first = result.failed[0];
          const folder = first.path.split(/[\\/]/).filter(Boolean).at(-1) ?? first.path;
          showToast(t("settings.skillBatchFailed", {
            count: result.failed.length,
            first: `${folder}: ${first.error}`,
          }), { variant: "error" });
        }
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      rowBusy.end(importKey);
    }
  };

  const visible = useMemo(() => {
    const match = (skill: UserSkillRecord) =>
      matchesCapabilitySearch(search, skill.name, skill.id, skill.description);
    const matchBuiltin = (skill: BuiltinSkillRecord) =>
      matchesCapabilitySearch(search, skill.name, skill.id, skill.description);
    return {
      builtins: builtinSkills.filter(matchBuiltin),
      global: globalSkills.filter(match),
    };
  }, [builtinSkills, globalSkills, search]);

  const counts = {
    all: visible.builtins.length + visible.global.length,
    global: visible.builtins.length + visible.global.length,
    project: 0,
  };

  const renderRow = (skill: UserSkillRecord) => {
    const key = rowKey(SKILL_LEVEL, skill.id);
    const name = skill.name || skill.id;
    const busy = rowBusy.isBusy(key);
    const isArmed = armed === key;
    const items: CapabilityMenuItem[] = [
      {
        key: "reveal",
        label: t("extensions.skills.reveal"),
        icon: <IconFolderOpen size={14} />,
        onSelect: () => {
          setMenuFor(null);
          void reveal(skill);
        },
      },
      {
        key: "remove",
        label: isArmed ? t("settings.capabilityRemoveConfirm") : t("extensions.skills.remove"),
        icon: <IconTrash size={14} />,
        danger: true,
        onSelect: () => {
          if (isArmed) {
            setMenuFor(null);
            void remove(skill);
          } else {
            setArmed(key);
          }
        },
      },
    ];
    return (
      <CapabilityRow
        key={key}
        glyph={<IconBookOpen size={16} />}
        name={name}
        off={!skill.enabled}
        menuOpen={menuFor === key}
        badges={
          <>
            <span className="agent-capability-badge is-level">
              {t("settings.capabilityFilterGlobal")}
            </span>
            {skill.source === "imported" ? (
              <span className="agent-capability-badge">{t("settings.imported")}</span>
            ) : null}
          </>
        }
        description={skill.description || t("settings.noCapabilityDescription")}
        actions={
          <>
            <TooltipButton
              type="button"
              className="settings-icon-button"
              ariaLabel={t("extensions.skills.rowActions", { name })}
              tooltip={t("extensions.skills.edit")}
              disabled={busy}
              onClick={() => void openEdit(skill)}
            >
              <IconPencil size={15} />
            </TooltipButton>
            <CapabilityRowMenu
              label={t("extensions.skills.rowActions", { name })}
              items={items}
              disabled={busy}
              open={menuFor === key}
              onOpenChange={(open) => {
                setMenuFor(open ? key : null);
                if (!open) setArmed(null);
              }}
            />
            <CapabilityToggle
              checked={skill.enabled}
              busy={busy}
              label={t("settings.toggleCapability", { name })}
              onChange={() => void toggle(skill)}
            />
          </>
        }
      />
    );
  };

  const renderBuiltinRow = (skill: BuiltinSkillRecord) => {
    const key = builtinRowKey(skill.id);
    const name = skill.name || skill.id;
    const busy = rowBusy.isBusy(key);
    return (
      <CapabilityRow
        key={key}
        glyph={<IconBookOpen size={16} />}
        name={name}
        off={!skill.enabled}
        badges={
          <span className="agent-capability-badge is-level">
            {t("settings.builtin")}
          </span>
        }
        description={skill.description || t("settings.noCapabilityDescription")}
        actions={
          <CapabilityToggle
            checked={skill.enabled}
            busy={busy}
            label={t("settings.toggleCapability", { name })}
            onChange={() => void toggleBuiltin(skill)}
          />
        }
      />
    );
  };

  const importButton = (
    <>
      <CapabilityButton
        busy={rowBusy.isBusy("import")}
        title={t("settings.capabilityImportToGlobal")}
        onClick={() => void importSkill("file")}
      >
        <IconDownload size={14} />
        {t("settings.importSkillFile")}
      </CapabilityButton>
      <CapabilityButton
        busy={rowBusy.isBusy("import-dir")}
        title={t("settings.capabilityImportToGlobal")}
        onClick={() => void importSkill("dir")}
      >
        <IconDownload size={14} />
        {t("settings.importSkillDir")}
      </CapabilityButton>
    </>
  );

  const marketButton = (
    <CapabilityButton
      onClick={() => setView("market")}
    >
      <IconFileText size={14} />
      {t("settings.sklm.browse")}
    </CapabilityButton>
  );

  if (view === "market") {
    return (
      <SkillMarketPanel
        installedIds={globalSkills.map((skill) => skill.id)}
        onBack={() => {
          setView("skills");
          void load();
        }}
        onInstalled={() => {
          setView("skills");
          void load();
        }}
      />
    );
  }

  return (
    <AgentCapabilityPage
      toolbar={
        <CapabilityToolbar
          filter={filter}
          onFilterChange={setFilter}
          counts={counts}
          levels={["all", "global"]}
          search={search}
          onSearchChange={setSearch}
          searchPlaceholder={t("extensions.skills.searchPlaceholder")}
          actions={
            <>
              <ImportToggleButton
                open={importOpen}
                controls="agent-skills-import-panel"
                label={t("settings.importSkillFromTools")}
                onClick={() => setImportOpen((current) => !current)}
              />
              <CapabilityButton
                variant="primary"
                title={t("settings.capabilityCreateInGlobal")}
                onClick={openCreate}
              >
                <IconPlus size={14} />
                {t("settings.newSkill")}
              </CapabilityButton>
              {marketButton}
            </>
          }
        />
      }
    >
      <section
        id="agent-skills-import-panel"
        className="settings-card-block import-inline-section"
        hidden={!importOpen}
      >
        <div className="settings-card-heading-line">
          <h3 className="settings-card-heading">
            {t("settings.importAgentSkillsTitle")}
          </h3>
        </div>
        <div className="import-inline-workbench">
          <AgentSkillImportPanel
            key="global"
            onImported={load}
          />
        </div>
      </section>

      <CapabilityPanel
        loading={loading}
        refreshing={refreshing}
        loadingLabel={t("settings.loadingCapabilities")}
      >
        {counts.all === 0 && search.trim() ? (
          <CapabilityEmpty
            message={t("settings.capabilityNoMatches")}
            icon={<IconBookOpen size={18} />}
          />
        ) : (
          <>
            <CapabilityGroupHeader
              label={t("settings.builtinSkills")}
              count={visible.builtins.length}
            />
            {visible.builtins.map(renderBuiltinRow)}
            <CapabilityGroupHeader
              label={t("settings.globalLevel")}
              path={GLOBAL_SKILLS_PATH}
              count={visible.global.length}
              action={importButton}
            />
            {visible.global.length === 0 ? (
              <CapabilityEmpty
                message={t("settings.skillsEmpty")}
                icon={<IconBookOpen size={18} />}
                action={
                  <CapabilityButton variant="primary" onClick={openCreate}>
                    <IconPlus size={14} />
                    {t("extensions.skills.add")}
                  </CapabilityButton>
                }
              />
            ) : (
              visible.global.map(renderRow)
            )}
          </>
        )}
      </CapabilityPanel>

      {editor ? (
        <SkillEditorSheet
          draft={editor.draft}
          setDraft={(draft) => setEditor((current) => (current ? { ...current, draft } : current))}
          editing={editor.editing}
          saving={saving}
          level={editor.level}
          onClose={() => {
            if (!saving) setEditor(null);
          }}
          onSave={() => void save()}
          onReveal={
            editor.editing
              ? () => void reveal(editor.editing!)
              : undefined
          }
        />
      ) : null}
    </AgentCapabilityPage>
  );
}
