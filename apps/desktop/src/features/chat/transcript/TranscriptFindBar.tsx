import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { findPosition } from "@pi-desktop/shared";

import { IconArrowDown, IconArrowUp, IconX } from "../../../components/icons";
import { Input, TooltipButton } from "../../../components/ui";

/**
 * Find inside the open conversation.
 *
 * It floats over the transcript rather than pushing it down, so opening the bar
 * never reflows the text being searched. Enter steps forward and Shift+Enter
 * back — the same pair the browser's own find box uses — and Escape closes,
 * returning focus to the row the reader came from.
 */
export function TranscriptFindBar({
  query,
  index,
  total,
  onQueryChange,
  onStep,
  onClose,
}: {
  query: string;
  index: number;
  total: number;
  onQueryChange: (value: string) => void;
  onStep: (delta: number) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const position = findPosition(index, total);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <div
      className="transcript-find"
      role="search"
      aria-label={t("chat.findInConversation")}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          onStep(event.shiftKey ? -1 : 1);
        }
      }}
    >
      <Input
        ref={inputRef}
        className="transcript-find-input"
        value={query}
        placeholder={t("chat.findPlaceholder")}
        aria-label={t("chat.findPlaceholder")}
        onChange={(event) => onQueryChange(event.target.value)}
      />
      <span className="transcript-find-count" role="status" aria-live="polite">
        {total > 0
          ? t("chat.findPosition", { current: position.current, total: position.total })
          : query.trim()
            ? t("chat.findNoMatches")
            : ""}
      </span>
      <TooltipButton
        type="button"
        className="transcript-find-step"
        tooltip={t("chat.findPrevious")}
        ariaLabel={t("chat.findPrevious")}
        disabled={total === 0}
        onClick={() => onStep(-1)}
      >
        <IconArrowUp size={14} aria-hidden />
      </TooltipButton>
      <TooltipButton
        type="button"
        className="transcript-find-step"
        tooltip={t("chat.findNext")}
        ariaLabel={t("chat.findNext")}
        disabled={total === 0}
        onClick={() => onStep(1)}
      >
        <IconArrowDown size={14} aria-hidden />
      </TooltipButton>
      <TooltipButton
        type="button"
        className="transcript-find-close"
        tooltip={t("chat.findClose")}
        ariaLabel={t("chat.findClose")}
        onClick={onClose}
      >
        <IconX size={14} aria-hidden />
      </TooltipButton>
    </div>
  );
}
