/**
 * Number and date formatting shared by the panel and the scripts.
 *
 * Written as a universal module: the panel loads it with a plain <script> tag
 * (`window.UsageFormat`), Node loads it through its CommonJS loader — one implementation, so
 * the probe script and the panel can never disagree about what "1.2M" means.
 */
(function attach(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else (/** @type {any} */ (root)).UsageFormat = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function factory() {
  "use strict";

  /** @param {number} value */
  function finite(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  }

  /**
   * Compact token count: 999 → "999", 1234 → "1.2K", 1234567 → "1.23M".
   * @param {number} value
   * @returns {string}
   */
  function formatTokens(value) {
    const tokens = finite(value);
    if (tokens < 1000) return String(Math.round(tokens));
    if (tokens < 1e6) {
      const thousands = tokens / 1e3;
      return `${thousands < 10 ? thousands.toFixed(1) : Math.round(thousands)}K`;
    }
    if (tokens < 1e9) {
      const millions = tokens / 1e6;
      return `${millions < 10 ? millions.toFixed(2) : Math.round(millions)}M`;
    }
    const billions = tokens / 1e9;
    return `${billions < 10 ? billions.toFixed(2) : Math.round(billions)}B`;
  }

  /**
   * Grouped integer: 1234567 → "1,234,567".
   * @param {number} value
   * @returns {string}
   */
  function formatTokensExact(value) {
    return String(Math.round(finite(value))).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  /**
   * US dollars with a precision that keeps small amounts meaningful.
   * `null`/`undefined` means "no price recorded" and renders as an em dash.
   * @param {number | null | undefined} value
   * @returns {string}
   */
  function formatUsd(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) return "—";
    const amount = Math.abs(value);
    if (amount === 0) return "$0";
    if (amount < 0.01) return `$${value.toFixed(4)}`;
    if (amount < 1) return `$${value.toFixed(3)}`;
    if (amount < 1000) return `$${value.toFixed(2)}`;
    return `$${formatTokensExact(value)}`;
  }

  /**
   * @param {number} ratio 0..1
   * @returns {string}
   */
  function formatPercent(ratio) {
    const value = finite(ratio);
    if (value === 0) return "0%";
    if (value < 0.001) return "<0.1%";
    const percent = Math.round(value * 1000) / 10;
    return `${percent}%`;
  }

  /**
   * Relative change against the previous window.
   * Returns `pct: null` when there is nothing meaningful to compare against.
   *
   * @param {number} current
   * @param {number} previous
   * @returns {{ pct: number | null, direction: "up" | "down" | "flat" | null }}
   */
  function formatDelta(current, previous) {
    const now = finite(current);
    const before = finite(previous);
    if (before <= 0) {
      if (now <= 0) return { pct: 0, direction: "flat" };
      return { pct: null, direction: null };
    }
    const pct = ((now - before) / before) * 100;
    const direction = pct > 0.05 ? "up" : pct < -0.05 ? "down" : "flat";
    return { pct, direction };
  }

  /** @returns {string} */
  function localeTag(locale) {
    return String(locale || "").toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
  }

  /**
   * @param {number} value
   * @param {string} locale
   * @returns {string}
   */
  function formatDateTime(value, locale) {
    const ms = finite(value);
    if (ms <= 0) return "";
    try {
      return new Intl.DateTimeFormat(localeTag(locale), {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(ms));
    } catch {
      return new Date(ms).toISOString();
    }
  }

  /**
   * Short bucket label: hour buckets show "14:00", day buckets "10/2",
   * month buckets "2026-10".
   *
   * @param {number} value
   * @param {"hour" | "day" | "month"} bucket
   * @returns {string}
   */
  function formatBucketLabel(value, bucket) {
    const date = new Date(finite(value));
    if (bucket === "hour") {
      return `${String(date.getHours()).padStart(2, "0")}:00`;
    }
    if (bucket === "month") {
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    }
    return `${date.getMonth() + 1}/${date.getDate()}`;
  }

  /**
   * @param {number} value
   * @returns {string} "2026-10-02"
   */
  function formatDayKey(value) {
    const date = new Date(finite(value));
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
      date.getDate(),
    ).padStart(2, "0")}`;
  }


  /**
   * Short month label for a heatmap header: zh "10月", en "Oct".
   * @param {number} value
   * @param {string} locale
   * @returns {string}
   */
  function formatMonthShort(value, locale) {
    const ms = finite(value);
    if (ms <= 0) return "";
    try {
      return new Intl.DateTimeFormat(localeTag(locale), { month: "short" }).format(new Date(ms));
    } catch {
      return String(new Date(ms).getMonth() + 1);
    }
  }

  /**
   * Narrow weekday name for a 0 = Sunday column: zh "日", en "S".
   * @param {number} dayIndex
   * @param {string} locale
   * @returns {string}
   */
  function formatWeekdayNarrow(dayIndex, locale) {
    const reference = new Date(2026, 0, 4 + (Number(dayIndex) || 0)); // 2026-01-04 is a Sunday
    try {
      return new Intl.DateTimeFormat(localeTag(locale), { weekday: "narrow" }).format(reference);
    } catch {
      return "日一二三四五六".charAt(Number(dayIndex) || 0);
    }
  }

  /**
   * Hour tick label for the hourly axis, e.g. "9h".
   * @param {number} value
   * @returns {string}
   */
  function formatHourTick(value) {
    return `${new Date(finite(value)).getHours()}h`;
  }
  return {
    formatTokens,
    formatTokensExact,
    formatUsd,
    formatPercent,
    formatDelta,
    formatDateTime,
    formatBucketLabel,
    formatMonthShort,
    formatWeekdayNarrow,
    formatHourTick,
    formatDayKey,
  };
});
