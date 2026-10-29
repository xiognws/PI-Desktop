import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  artifactDirectory,
  artifactFileName,
  artifactOpKey,
  type ArtifactRow,
} from "@pi-desktop/shared";

import { IconClipboard, IconFileText, IconFolder, IconRefresh } from "../components/icons";
import { Input, TooltipButton } from "../components/ui";
import { useArtifacts } from "../features/artifacts/use-artifacts";
import { useOpenChatFileRef } from "../hooks/use-preview-target";
import "../features/artifacts/artifacts.css";

/**
 * Artifacts: every file a session wrote or edited (04-data-storage §4.9).
 *
 * The list groups by session because that is how a user remembers the work —
 * "the file the refactor wrote" — and keeps the path selectable so it can be
 * copied without a per-row action. Nothing here mutates host state: the page is
 * a read-only view over `artifacts.list`.
 */
export function ArtifactsPage() {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const workspace = useArtifacts(query);
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  // The same opener the transcript uses for a file reference: a click lands in
  // the bundled file view on a project file instead of inventing a second path.
  const openFileRef = useOpenChatFileRef();

  const formatter = useMemo(
    () => new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }),
    [],
  );

  const copy = (path: string) => {
    void navigator.clipboard.writeText(path).then(
      () => setCopiedPath(path),
      () => setCopiedPath(null),
    );
  };

  return (
    <section className="artifacts-page">
      <header className="artifacts-head">
        <div className="artifacts-title">
          <IconFileText size={16} aria-hidden />
          <h2>{t("artifacts.title")}</h2>
          <span className="artifacts-count">
            {t("artifacts.count", { count: workspace.visible, total: workspace.total })}
          </span>
        </div>
        <div className="artifacts-actions">
          <Input
            className="artifacts-search"
            value={query}
            placeholder={t("artifacts.searchPlaceholder")}
            aria-label={t("artifacts.searchPlaceholder")}
            onChange={(event) => setQuery(event.target.value)}
          />
          <TooltipButton
            type="button"
            className="artifacts-refresh"
            tooltip={t("artifacts.refresh")}
            ariaLabel={t("artifacts.refresh")}
            onClick={workspace.refresh}
          >
            <IconRefresh size={14} aria-hidden />
          </TooltipButton>
        </div>
      </header>

      {workspace.status === "loading" ? (
        <p className="artifacts-placeholder">{t("artifacts.loading")}</p>
      ) : workspace.status === "error" ? (
        <p className="artifacts-placeholder is-error">
          {t("artifacts.loadFailed", { message: workspace.error ?? "" })}
        </p>
      ) : workspace.groups.length === 0 ? (
        <div className="artifacts-placeholder">
          <p>{query ? t("artifacts.noMatches") : t("artifacts.empty")}</p>
          {query ? null : <p className="artifacts-hint">{t("artifacts.emptyHint")}</p>}
        </div>
      ) : (
        <div className="artifacts-scroll">
          {workspace.groups.map((group) => (
            <section className="artifacts-group" key={group.sessionId}>
              <h3 className="artifacts-group-head">
                <span className="artifacts-group-title">
                  {group.sessionTitle ?? t("artifacts.untitledSession")}
                </span>
                {group.projectName ? (
                  <span className="artifacts-group-project" title={group.projectPath ?? undefined}>
                    <IconFolder size={11} aria-hidden />
                    {group.projectName}
                  </span>
                ) : null}
                <span className="artifacts-group-count">{group.rows.length}</span>
              </h3>
              <ul className="artifacts-list">
                {group.rows.map((row) => (
                  <ArtifactRowItem
                    key={`${row.op}:${row.path}`}
                    row={row}
                    when={formatter.format(new Date(row.updatedAt))}
                    copied={copiedPath === row.path}
                    onCopy={() => copy(row.path)}
                    onOpen={() => openFileRef(row.path)}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </section>
  );
}

function ArtifactRowItem({
  row,
  when,
  copied,
  onCopy,
  onOpen,
}: {
  row: ArtifactRow;
  when: string;
  copied: boolean;
  onCopy: () => void;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const directory = artifactDirectory(row.path);
  return (
    <li className="artifacts-row">
      <span className={`artifacts-op is-${row.op}`}>{t(artifactOpKey(row.op))}</span>
      <button
        type="button"
        className="artifacts-name font-mono"
        title={row.path}
        aria-label={t("artifacts.openFile", { name: artifactFileName(row.path) })}
        onClick={onOpen}
      >
        {artifactFileName(row.path)}
      </button>
      <span className="artifacts-dir selectable" title={directory}>
        {directory}
      </span>
      <time className="artifacts-when" dateTime={row.updatedAt}>
        {when}
      </time>
      <TooltipButton
        type="button"
        className="artifacts-copy"
        tooltip={copied ? t("artifacts.copied") : t("artifacts.copyPath")}
        ariaLabel={t("artifacts.copyPath")}
        onClick={onCopy}
      >
        <IconClipboard size={13} aria-hidden />
      </TooltipButton>
    </li>
  );
}
