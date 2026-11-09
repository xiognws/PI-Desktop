import { useTranslation } from "react-i18next";
import { Badge } from "../../../components/ui";
import { spawnedSessionStateKey, type SpawnedSession } from "../../../lib/session-task-card";
import { useAppStore } from "../../../stores/app-store";

/**
 * A `SessionTask` spawn rendered where it happened (ADR 0386).
 *
 * The child is a durable session the shell already renders, so this card does
 * not draw a transcript of its own: activating it selects the child session.
 * That is why the card needs no delegation detail view, no extra host read, and
 * no panel of its own.
 */
export function SpawnedSessionCard({ session }: { session: SpawnedSession }) {
  const { t } = useTranslation();
  const selectSession = useAppStore((state) => state.selectSession);
  const tone =
    session.state === "failed"
      ? "error"
      : session.state === "completed"
        ? "success"
        : "neutral";
  return (
    <button
      type="button"
      className="spawned-session-card"
      data-state={session.state}
      aria-label={t("chat.spawnedSessionOpen", { title: session.title })}
      onClick={() => {
        void selectSession(session.sessionId);
      }}
    >
      <span className="spawned-session-head">
        <span className="spawned-session-title">{session.title}</span>
        <Badge tone={tone}>{t(spawnedSessionStateKey(session.state))}</Badge>
      </span>
      <span className="spawned-session-kind">{t("chat.spawnedSessionTitle")}</span>
      {session.task && session.task !== session.title ? (
        <span className="spawned-session-task">{session.task}</span>
      ) : null}
    </button>
  );
}
