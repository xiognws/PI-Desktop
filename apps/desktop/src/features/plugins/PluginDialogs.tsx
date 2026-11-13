import { Button, SettingsToggle, cx, portalOverlay } from "../../components/ui";
import { IconCheck, IconShield, IconSparkles, IconTriangleAlert } from "../../components/icons";
import { PluginInstallDialog } from "../../components/plugins/PluginInstallDialog";
import { PluginSettingsSheet } from "../../components/plugins/PluginSettingsSheet";
import { useBlockingOverlay } from "../../lib/blocking-overlay";
import type { ReactNode } from "react";
import { useAppStore } from "../../stores/app-store";
import {
  RISK_LABEL_KEYS,
  RISK_TIERS,
  TEMPLATE_IDS,
  permissionLabel,
  permissionRisk,
} from "./model";
import type { PluginsPageModel } from "./usePluginsPage";

function pluginModalPortal(node: ReactNode) {
  return portalOverlay(<PluginModalBlockingHost>{node}</PluginModalBlockingHost>);
}

function PluginModalBlockingHost({ children }: { children: ReactNode }) {
  useBlockingOverlay();
  return <>{children}</>;
}

export function PluginDialogs({
  t,
  pendingInstall,
  setPendingInstall,
  pendingReview,
  setPendingReview,
  confirmReview,
  autoUpdate,
  setAutoUpdate,
  isPluginBusy,
  confirmInstall,
  installJob,
  cancelInstallDownload,
  retryInstall,
  closeInstallDialog,
  settingsPlugin,
  setSettingsPlugin,
  refreshPlugins,
  templatePick,
  creating,
  setTemplatePick,
  createFromTemplate,
  pluginDirsOpen,
  setPluginDirsOpen,
  pluginDirs,
  addPluginDir,
  removePluginDir,
  revealPluginDir,
}: PluginsPageModel) {
  return (
    <>
      {pendingReview
        ? pluginModalPortal(
        <div className="plugins-modal-backdrop" role="presentation">
          <div
            className="plugins-modal"
            role="dialog"
            aria-modal="true"
            aria-label={t("plugins.permissionReview")}
          >
            <header className="plugins-modal-head">
              <span className="plugins-modal-icon" aria-hidden>
                <IconShield size={17} />
              </span>
              <div>
                <h2 className="plugins-modal-title">
                  {t(
                    pendingReview.kind === "reload"
                      ? "plugins.devReviewNewTitle"
                      : "plugins.devReviewTitle",
                    { name: pendingReview.name },
                  )}
                </h2>
                {pendingReview.version ? (
                  <p className="plugins-modal-subtitle">
                    {t("plugins.installingVersion", { version: pendingReview.version })}
                  </p>
                ) : null}
              </div>
            </header>

            <div className="plugins-modal-body">
              <p className="plugins-modal-lede">{t("plugins.devReviewBody")}</p>
              <PermissionGroups
                t={t}
                permissions={pendingReview.permissions}
                newPermissions={pendingReview.addedPermissions}
              />
            </div>

            <div className="plugins-modal-actions">
              <Button variant="secondary" onClick={() => setPendingReview(null)}>
                {t("plugins.cancel")}
              </Button>
              <Button
                variant="primary"
                disabled={isPluginBusy(pendingReview.id)}
                onClick={() => void confirmReview()}
              >
                {isPluginBusy(pendingReview.id)
                  ? t("plugins.devReviewLoading")
                  : t("plugins.devReviewAccept")}
              </Button>
            </div>
          </div>
        </div>,
      )
        : null}
      {pendingInstall
        ? pluginModalPortal(
        <div className="plugins-modal-backdrop" role="presentation">
          <div
            className="plugins-modal"
            role="dialog"
            aria-modal="true"
            aria-label={t("plugins.permissionReview")}
          >
            <header className="plugins-modal-head">
              <span className="plugins-modal-icon" aria-hidden>
                <IconShield size={17} />
              </span>
              <div>
                <h2 className="plugins-modal-title">
                  {t("plugins.permissionReviewTitle", { name: pendingInstall.name })}
                </h2>
                {pendingInstall.version ? (
                  <p className="plugins-modal-subtitle">
                    {t("plugins.installingVersion", { version: pendingInstall.version })}
                  </p>
                ) : null}
              </div>
            </header>

            <div className="plugins-modal-body">
              <p className="plugins-modal-lede">{t("plugins.permissionReviewBody")}</p>
              <PermissionGroups
                t={t}
                permissions={pendingInstall.permissions}
                newPermissions={pendingInstall.newPermissions}
              />
            </div>

            <div className="plugins-switch-row">
              <SettingsToggle
                checked={autoUpdate}
                label={t("plugins.enableAutoUpdateOnInstall")}
                onChange={() => setAutoUpdate((on) => !on)}
              />
            </div>

            <div className="plugins-modal-actions">
              <Button variant="secondary" onClick={() => setPendingInstall(null)}>
                {t("plugins.cancel")}
              </Button>
              <Button
                variant="primary"
                disabled={isPluginBusy(pendingInstall.id)}
                onClick={() => void confirmInstall()}
              >
                {isPluginBusy(pendingInstall.id)
                  ? t("plugins.installing")
                  : t("plugins.acceptInstall")}
              </Button>
            </div>
          </div>
        </div>,
      )
        : null}
      {installJob ? (
        <PluginInstallDialog
          job={installJob}
          onCancel={cancelInstallDownload}
          onRetry={retryInstall}
          onClose={closeInstallDialog}
        />
      ) : null}
      {settingsPlugin ? (
        <PluginSettingsSheet
          plugin={settingsPlugin}
          platform={(window.piDesktop?.platform ?? "darwin") as "darwin" | "win32" | "linux"}
          onClose={() => setSettingsPlugin(null)}
          onSaved={async () => {
            await refreshPlugins();
            const updated = useAppStore
              .getState()
              .plugins.find((plugin) => plugin.id === settingsPlugin.id);
            if (updated) setSettingsPlugin(updated);
          }}
        />
      ) : null}
      {templatePick
        ? pluginModalPortal(
        <div className="plugins-modal-backdrop" role="presentation">
          <div
            className="plugins-modal"
            role="dialog"
            aria-modal="true"
            aria-label={t("plugins.newFromTemplateTitle")}
          >
            <header className="plugins-modal-head">
              <span className="plugins-modal-icon" aria-hidden>
                <IconSparkles size={17} />
              </span>
              <div>
                <h2 className="plugins-modal-title">
                  {t("plugins.newFromTemplateTitle")}
                </h2>
              </div>
            </header>

            <div className="plugins-modal-body">
              <div
                className="plugins-template-list"
                role="radiogroup"
                aria-label={t("plugins.newFromTemplateTitle")}
              >
                {TEMPLATE_IDS.map((template) => {
                  const active = templatePick === template;
                  return (
                    <button
                      key={template}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      className={cx("plugins-template", active && "active")}
                      onClick={() => setTemplatePick(template)}
                    >
                      <span className="plugins-template-mark" aria-hidden>
                        {active ? <IconCheck size={13} /> : null}
                      </span>
                      <span className="plugins-template-copy">
                        <strong className="plugins-template-name">
                          {t(`plugins.templateName.${template}`)}
                        </strong>
                        <span className="plugins-template-body">
                          {t(`plugins.templateBody.${template}`)}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="plugins-modal-actions">
              <Button
                variant="secondary"
                data-action="cancel"
                disabled={creating}
                onClick={() => setTemplatePick(null)}
              >
                {t("plugins.cancel")}
              </Button>
              <Button
                variant="primary"
                disabled={creating}
                onClick={() => void createFromTemplate(templatePick)}
              >
                {creating
                  ? t("plugins.newFromTemplateCreating")
                  : t("plugins.newFromTemplateCreate")}
              </Button>
            </div>
          </div>
        </div>,
      )
        : null}
      {pluginDirsOpen
        ? pluginModalPortal(
        <div className="plugins-modal-backdrop" role="presentation">
          <div
            className="plugins-modal"
            role="dialog"
            aria-modal="true"
            aria-label={t("plugins.pluginDirsTitle")}
          >
            <header className="plugins-modal-head">
              <span className="plugins-modal-icon" aria-hidden>
                <IconSparkles size={17} />
              </span>
              <div>
                <h2 className="plugins-modal-title">{t("plugins.pluginDirsTitle")}</h2>
                <p className="plugins-modal-subtitle">{t("plugins.pluginDirsHint")}</p>
              </div>
            </header>

            <div className="plugins-modal-body">
              {pluginDirs.length ? (
                <ul className="plugins-dir-list">
                  {pluginDirs.map((dir) => (
                    <li key={dir.path} className="plugins-dir-row">
                      <div className="plugins-dir-copy">
                        <code className="plugins-dir-path">{dir.path}</code>
                        {dir.counted ? null : (
                          <span className="plugins-dir-missing">
                            {t("plugins.pluginDirsMissing")}
                          </span>
                        )}
                      </div>
                      <div className="plugins-dir-actions">
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => void revealPluginDir(dir.path)}
                        >
                          {t("plugins.pluginDirsOpen")}
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => void removePluginDir(dir.path)}
                        >
                          {t("plugins.pluginDirsRemove")}
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="plugins-modal-lede">{t("plugins.pluginDirsEmpty")}</p>
              )}
            </div>

            <div className="plugins-modal-actions">
              <Button variant="secondary" onClick={() => setPluginDirsOpen(false)}>
                {t("plugins.pluginDirsClose")}
              </Button>
              <Button variant="primary" onClick={() => void addPluginDir()}>
                {t("plugins.pluginDirsAdd")}
              </Button>
            </div>
          </div>
        </div>,
      )
        : null}
    </>
  );
}

/**
/**
 * One permission list, shared by the install review and the development review:
 * both answer the same question, so they must not drift into two renderings of
 * the same risk data.
 */
function PermissionGroups({
  t,
  permissions,
  newPermissions,
}: {
  t: PluginsPageModel["t"];
  permissions: string[];
  newPermissions: string[];
}) {
  if (!permissions.length) {
    return <p className="plugins-modal-lede">{t("plugins.noPermissions")}</p>;
  }
  return (
    <>
      {RISK_TIERS.map((tier) => {
        const scoped = permissions.filter(
          (permission) => permissionRisk(permission) === tier,
        );
        if (!scoped.length) return null;
        return (
          <div key={tier} className={cx("plugins-risk-group", `risk-${tier}`)}>
            <div className="plugins-risk-head">
              {tier === "high" ? (
                <IconTriangleAlert size={13} />
              ) : (
                <IconShield size={13} />
              )}
              {t(RISK_LABEL_KEYS[tier])}
              <span className="plugins-risk-count">{scoped.length}</span>
            </div>
            <ul className="plugins-perm-list is-plain">
              {scoped.map((permission) => (
                <li key={permission}>
                  <span className="plugins-perm-copy">
                    <strong>
                      {permissionLabel(permission, t)}
                      {newPermissions.includes(permission) ? (
                        <span className="plugins-tag is-update">
                          {t("plugins.newPermission")}
                        </span>
                      ) : null}
                    </strong>
                    <span>
                      {t(`plugins.permissionHelp.${permission}`, {
                        defaultValue: permission,
                      })}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </>
  );
}
