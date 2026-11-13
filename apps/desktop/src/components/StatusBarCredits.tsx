import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../stores/app-store";
import { inheritedSessionModelBinding } from "../lib/session-model";
import {
  creditsVisibility,
  inAppProviderSurfaceFor,
  useInAppProviderCredits,
  useInAppProviderSurfaces,
  type CreditsFailureReason,
  type InAppProviderCredits,
  type InAppProviderSurface,
} from "../lib/in-app-credits";

/**
 * Remaining balance of the metered in-app provider behind the current session.
 *
 * The chip exists only for a metered account with credit left — no surface, an
 * unmetered plan, a failed read and a zero balance all render nothing at all,
 * not a placeholder. That decision lives in `creditsVisibility`, which the
 * settings card and the model picker call too, so the three surfaces cannot
 * disagree about the same balance.
 */
export type CreditsViewProps = {
  surface: InAppProviderSurface | undefined;
  credits: InAppProviderCredits | null;
  reason?: CreditsFailureReason;
  pending: boolean;
  onRefresh: () => void;
};

/** `1 234.56` — grouped, at most two decimals, never a fake zero. */
export function formatCredits(total: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(total);
}

/** The chip and its popover; renders nothing when the balance should stay hidden. */
export function StatusBarCreditsView({
  surface,
  credits,
  reason,
  pending,
  onRefresh,
}: CreditsViewProps) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const visibility = creditsVisibility({
    hasCreditsPath: Boolean(surface?.creditsPath),
    free: credits?.free,
    total: credits?.total ?? null,
    ...(credits ? {} : reason ? { reason } : {}),
  });
  const updatedAt = useMemo(() => {
    if (!credits) return "";
    try {
      return new Intl.DateTimeFormat(i18n.language, {
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(credits.fetchedAt));
    } catch {
      return "";
    }
  }, [credits, i18n.language]);

  if (visibility === "hide" || !credits) return null;

  return (
    <div className="statusbar-credits" ref={ref}>
      <button
        type="button"
        className="statusbar-credits-chip"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={t("statusBar.creditsTitle", { provider: surface?.label ?? "" })}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="statusbar-credits-dot" aria-hidden />
        <span className="statusbar-credits-value">
          {formatCredits(credits.total, i18n.language)}
        </span>
        <span className="statusbar-credits-unit">{t("statusBar.creditsUnit")}</span>
      </button>
      {open ? (
        <div className="statusbar-credits-popover" role="dialog" aria-label={t("statusBar.creditsTitle", { provider: surface?.label ?? "" })}>
          <div className="statusbar-credits-head">
            <span>{t("statusBar.creditsTitle", { provider: surface?.label ?? "" })}</span>
            <button
              type="button"
              className="statusbar-credits-refresh"
              onClick={onRefresh}
              disabled={pending}
            >
              {pending ? t("statusBar.creditsRefreshing") : t("statusBar.creditsRefresh")}
            </button>
          </div>
          <div className="statusbar-credits-total">
            {formatCredits(credits.total, i18n.language)}
          </div>
          {credits.accounts.length > 0 ? (
            <ul className="statusbar-credits-accounts">
              {credits.accounts.map((account) => (
                <li key={account.name}>
                  <span>{account.name}</span>
                  <span>
                    {formatCredits(account.remain, i18n.language)} /{" "}
                    {formatCredits(account.size, i18n.language)}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {updatedAt ? (
            <div className="statusbar-credits-updated">
              {t("statusBar.creditsUpdated", { time: updatedAt })}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Wires the chip to the session's provider and the shared credit cache. */
export function StatusBarCredits() {
  const providers = useAppStore((state) => state.providers);
  const settings = useAppStore((state) => state.settings);
  const recentModels = useAppStore((state) => state.recentModels);
  const activeSessionId = useAppStore((state) => state.activeSessionId);
  const session = useAppStore((state) =>
    state.activeSessionId
      ? state.sessions.find((candidate) => candidate.id === state.activeSessionId)
      : undefined,
  );
  const draftConfiguration = useAppStore((state) => state.draftConfiguration);
  const surfaces = useInAppProviderSurfaces();

  const binding = useMemo(
    () =>
      inheritedSessionModelBinding({
        draft: session ?? draftConfiguration,
        settings,
        providers,
        recentModels,
      }),
    [session, draftConfiguration, settings, providers, recentModels, activeSessionId],
  );
  const surface = inAppProviderSurfaceFor(surfaces, binding.providerId);
  const { result, pending, refresh } = useInAppProviderCredits(surface?.id ?? null);

  return (
    <StatusBarCreditsView
      surface={surface}
      credits={result?.ok ? result.credits : null}
      {...(result && !result.ok ? { reason: result.reason } : {})}
      pending={pending}
      onRefresh={refresh}
    />
  );
}
