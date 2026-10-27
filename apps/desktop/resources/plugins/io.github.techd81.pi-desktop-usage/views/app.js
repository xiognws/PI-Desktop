/*
 * Usage panel.
 *
 * Plain script, no build step: the panel is one iframe document that talks to
 * the plugin backend through `window.pluginBridge.invoke(channel, payload)` and
 * to the host only for appearance.
 *
 * The layout mirrors juejin-usage: pill range tabs plus a custom range picker,
 * eight metric cards with a green mini-trend, a calendar heatmap with
 * month/weekday headers, an area card (total or four-line detail), a trend bar
 * card, two ranking cards and two donut cards. Chart geometry lives in the pure
 * helpers at the top and is unit tested directly.
 */
(function attach(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else (/** @type {any} */ (root)).UsagePanel = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function factory() {
  "use strict";

  const Fmt =
    typeof module === "object" && module.exports ? require("./lib/format.js") : (/** @type {any} */ (globalThis)).UsageFormat;

const RANGES = ["today", "7d", "30d", "90d", "all"];
const SOURCE_IDS = ["cli", "desktop"];
const ACCENTS = ["blue", "violet", "green", "amber", "rose"];
const THEMES = ["system", "light", "dark"];
const ACCENT_COLORS = {
  blue: "#0a84ff",
  violet: "#7c5cff",
  green: "#12a150",
  amber: "#f5a623",
  rose: "#e5484d",
};
  /** Rainbow ring shown on the free-form swatch before a colour is picked. */
  const ACCENT_RING = "conic-gradient(#ff5f6d, #ffc371, #4fd48c, #4aa8ff, #a58ef2, #ff5f6d)";
  const SERIES_KEYS = ["input", "output", "cacheRead", "cacheWrite"];
  const SERIES_LABELS = ["seriesInput", "seriesOutput", "seriesCacheRead", "seriesCacheWrite"];
  const SERIES_COLORS = [
    "var(--chart-input)",
    "var(--chart-output)",
    "var(--chart-cache-read)",
    "var(--chart-cache-write)",
  ];
  /**
   * The five lines of the usage-trend card, in legend order: cost is read on the
   * right axis, the token series on the left, and only cache hits get a fill.
   */
  const TREND_SERIES = [
    { key: "cost", label: "seriesCost", dashed: true },
    { key: "cacheWrite", label: "seriesCacheWrite" },
    { key: "cacheRead", label: "seriesCacheRead", fill: true },
    { key: "input", label: "seriesInput" },
    { key: "output", label: "seriesOutput" },
  ];
  const TREND_COLORS = {
    cost: "var(--chart-cost)",
    cacheWrite: "var(--chart-cache-write)",
    cacheRead: "var(--chart-cache-read)",
    input: "var(--chart-input)",
    output: "var(--chart-output)",
  };
const SLICE_COLORS = [
  "var(--slice-0)",
  "var(--slice-1)",
  "var(--slice-2)",
  "var(--slice-3)",
  "var(--slice-4)",
  "var(--slice-5)",
  "var(--slice-5)",
];
/**
 * The remainder slice: a neutral tone on purpose, so "the models that did not
 * fit" never looks like one more specific model.
 */
const OTHER_SLICE_COLOR = "color-mix(in oklab, var(--fg) 32%, transparent)";
  const HEAT_COLORS = [
    "color-mix(in oklab, var(--fg) 7%, transparent)",
    "color-mix(in oklab, var(--accent) 22%, var(--surface))",
    "color-mix(in oklab, var(--accent) 44%, var(--surface))",
    "color-mix(in oklab, var(--accent) 68%, var(--surface))",
    "var(--accent)",
  ];
  /** Minimum arc, in donut pixels, kept by any non-zero slice so it stays visible. */
  const MIN_SLICE = 4;

  /* ------------------------------------------------------------------ i18n */

  const STRINGS = {
    zh: {
      refresh: "刷新",
      themeColor: "主题色",
      accent_blue: "蓝色",
      accent_violet: "紫色",
      accent_green: "绿色",
      accent_amber: "琥珀",
      accent_rose: "玫红",
      accentCustom: "无极调色",
      scanning: "正在扫描会话…",
      allSources: "全部来源",
      sourceCli: "Pi CLI",
      sourceDesktop: "PI-Desktop",
      metricCost: "总成本",
      metricTokens: "总 Token",
      metricInput: "输入 Token",
      metricOutput: "输出 Token",
      share: "占比",
      metricCostHint: "所选区间内按记录价格汇总，缺失价格会标注",
      metricTokensHint: "输入 + 输出 + 缓存读 + 缓存写",
      metricInputHint: "不含缓存命中的新增输入",
      metricOutputHint: "模型生成的输出 token",
      metricCacheRead: "缓存命中",
      metricCacheReadHint: "由供应商缓存直接提供的输入 token",
      metricCacheWrite: "缓存写入",
      metricCacheWriteHint: "写入供应商缓存的输入 token",
      metricRequests: "总请求数",
      metricRequestsHint: "区间内完成的 assistant 回复条数",
      metricCacheHit: "缓存命中率",
      metricCacheHitHint: "缓存命中 ÷（新增输入 + 缓存命中）",
      prevShort: "较上期",
      noBaseline: "无可比数据",
      cacheHit: "缓存命中率",
      requestsTimes: "次请求",
      usageTrend: "使用趋势",
      seriesCost: "成本",
      averageLabel: "平均",
      trendTitle: "{range} 趋势",
      trendHintHour: "今日按小时的 Token 与费用趋势",
      trendHintDay: "按天的 Token 与费用趋势",
      tokenLabel: "Token",
      seriesInput: "输入",
      seriesOutput: "输出",
      seriesCacheRead: "缓存命中",
      seriesCacheWrite: "缓存创建",
      costLabel: "费用",
      sourceUsage: "来源用量",
      sourceUsageHint: "按来源比较总 Token",
      totalLabel: "合计",
      rangeCustom: "自定义",
      presetToday: "当天",
      preset24h: "近 24 小时",
      preset7d: "近 7 天",
      preset14d: "近 14 天",
      preset30d: "近 30 天",
      presetAll: "全部",
      startTime: "开始时间",
      endTime: "结束时间",
      followNow: "结束时间跟随当前时刻",
      cancel: "取消",
      confirm: "确定",
      themeLabel: "明暗",
      themeSystem: "跟随系统",
      themeLight: "亮面",
      themeDark: "暗面",
      customRangeLabel: "自定义区间",
      prevMonth: "上个月",
      nextMonth: "下个月",
      projectUsage: "项目分布",
      projectUsageHint: "按项目比较总 Token",
      sourceDist: "来源分布",
      sourceDistHint: "按来源查看 Token 与费用占比",
      modelDist: "模型分布",
      modelDistHint: "按模型查看 Token 与费用占比",
      otherModels: "其他模型",
      heatmap: "活跃热力图",
      heatPickHint: "点任意方块查看当天用量与费用",
      heatLevel: "等级",
      heatModels: "模型明细",
      heatTotal: "总用量",
      less: "少",
      more: "多",
      unassigned: "未归属",
      unknownModel: "未知模型",
      emptyTitle: "还没有找到用量记录",
      emptyBody: "产生一次对话后点刷新即可；下面两个目录是唯一的数据来源。",
      rootsTitle: "数据目录",
      missingRoot: "目录不存在",
      errorTitle: "加载失败",
      retry: "重试",
    },
    en: {
      refresh: "Refresh",
      themeColor: "Theme color",
      accent_blue: "Blue",
      accent_violet: "Violet",
      accent_green: "Green",
      accent_amber: "Amber",
      accent_rose: "Rose",
      accentCustom: "Custom color",
      scanning: "Scanning sessions…",
      allSources: "All sources",
      sourceCli: "Pi CLI",
      sourceDesktop: "PI-Desktop",
      metricCost: "Total cost",
      metricTokens: "Total tokens",
      metricInput: "Input tokens",
      metricOutput: "Output tokens",
      metricCostHint: "Sum of recorded prices in the range; missing prices are marked",
      metricTokensHint: "Input + output + cache read + cache write",
      metricInputHint: "Fresh input, excluding cache hits",
      metricOutputHint: "Tokens generated by the model",
      metricCacheRead: "Cache hits",
      metricCacheReadHint: "Input tokens served from the provider cache",
      share: "Share",
      metricCacheWrite: "Cache writes",
      metricCacheWriteHint: "Input tokens written into the provider cache",
      metricRequests: "Requests",
      metricRequestsHint: "Finalized assistant responses in the range",
      metricCacheHit: "Cache hit rate",
      metricCacheHitHint: "Cache hits divided by fresh input plus cache hits",
      prevShort: "vs previous",
      noBaseline: "No baseline",
      cacheHit: "Cache hit rate",
      requestsTimes: "requests",
      usageTrend: "Usage trend",
      seriesCost: "Cost",
      averageLabel: "Avg",
      trendTitle: "{range} trend",
      trendHintHour: "Token and cost by hour today",
      trendHintDay: "Token and cost by day",
      tokenLabel: "Token",
      seriesInput: "Input",
      seriesOutput: "Output",
      seriesCacheRead: "Cache hits",
      seriesCacheWrite: "Cache writes",
      costLabel: "Cost",
      sourceUsage: "Source usage",
      sourceUsageHint: "Total tokens by source",
      totalLabel: "Total",
      rangeCustom: "Custom",
      presetToday: "Today",
      preset24h: "Last 24h",
      preset7d: "Last 7d",
      preset14d: "Last 14d",
      preset30d: "Last 30d",
      presetAll: "All",
      startTime: "Start",
      endTime: "End",
      followNow: "End follows the current time",
      cancel: "Cancel",
      confirm: "Apply",
      themeLabel: "Appearance",
      themeSystem: "Follow system",
      themeLight: "Light",
      themeDark: "Dark",
      customRangeLabel: "Custom range",
      prevMonth: "Previous month",
      nextMonth: "Next month",
      projectUsage: "Projects",
      projectUsageHint: "Total tokens by project",
      sourceDist: "Source split",
      sourceDistHint: "Token and cost share by source",
      modelDist: "Model split",
      modelDistHint: "Token and cost share by model",
      otherModels: "Other models",
      heatmap: "Activity heatmap",
      heatPickHint: "Pick a square to see that day's tokens and cost",
      heatLevel: "Level",
      heatModels: "Model detail",
      heatTotal: "Total",
      less: "Less",
      more: "More",
      unassigned: "Unassigned",
      unknownModel: "Unknown model",
      emptyTitle: "No usage found yet",
      emptyBody: "Start a conversation and press refresh; these two directories are the only sources.",
      rootsTitle: "Data directories",
      missingRoot: "directory missing",
      errorTitle: "Could not load",
      retry: "Retry",
    },
  };

  /**
   * @param {"zh" | "en"} locale
   * @param {string} key
   * @param {Record<string, string | number>} [vars]
   */
  function t(locale, key, vars) {
    const table = STRINGS[locale] ?? STRINGS.zh;
    const template = table[key] ?? STRINGS.zh[key] ?? key;
    if (!vars) return template;
    return template.replace(/\{(\w+)\}/g, (match, name) =>
      Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match,
    );
  }

  /* ----------------------------------------------------------------- pure */

  /** @param {unknown} value */
  function esc(value) {
    return String(value === null || value === undefined ? "" : value).replace(/[&<>"']/g, (character) => {
      if (character === "&") return "&amp;";
      if (character === "<") return "&lt;";
      if (character === ">") return "&gt;";
      if (character === '"') return "&quot;";
      return "&#39;";
    });
  }

  /** @param {number} part @param {number} whole */
  /**
   * True for a `#rrggbb` string, the free-form accent kept in preferences.
   * @param {unknown} value
   */
  function isHexColor(value) {
    return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
  }

  function shareOf(part, whole) {
    if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return 0;
    return Math.max(0, Math.min(1, part / whole));
  }

  /**
   * @param {number[]} values
   * @param {number} width
   * @param {number} height
   * @param {number} maxY
   * @returns {string}
   */
  function linePath(values, width, height, maxY) {
    if (!Array.isArray(values) || values.length === 0) return "";
    const safeMax = maxY > 0 ? maxY : 1;
    const step = values.length > 1 ? width / (values.length - 1) : 0;
    return values
      .map((value, index) => {
        const x = values.length > 1 ? index * step : width / 2;
        const y = height - (Math.max(0, value) / safeMax) * height;
        return `${index === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join(" ");
  }

  /**
   * @param {number[]} values
   * @param {number} width
   * @param {number} height
   * @param {number} maxY
   * @returns {string}
   */
  function areaPath(values, width, height, maxY) {
    const line = linePath(values, width, height, maxY);
    if (!line) return "";
    return `${line} L${width.toFixed(2)},${height.toFixed(2)} L0,${height.toFixed(2)} Z`;
  }

  /**
   * Monotone cubic path (Fritsch–Carlson tangents), so a smoothed trend line
   * never overshoots a local extreme the way a plain cardinal spline would.
   * @param {number[]} values
   * @param {number} width
   * @param {number} height
   * @param {number} maxY
   * @returns {string}
   */
  function smoothPath(values, width, height, maxY) {
    if (!Array.isArray(values) || values.length === 0) return "";
    const safeMax = maxY > 0 ? maxY : 1;
    const count = values.length;
    const x = (index) => (count > 1 ? (index * width) / (count - 1) : width / 2);
    const y = (value) => height - (Math.max(0, value) / safeMax) * height;
    const point = (index) => `${x(index).toFixed(2)},${y(values[index]).toFixed(2)}`;
    if (count === 1) return `M${point(0)}`;
    if (count === 2) return `M${point(0)} L${point(1)}`;

    const gaps = [];
    const slopes = [];
    for (let index = 0; index < count - 1; index += 1) {
      gaps[index] = x(index + 1) - x(index);
      slopes[index] = gaps[index] === 0 ? 0 : (y(values[index + 1]) - y(values[index])) / gaps[index];
    }
    const tangents = new Array(count).fill(0);
    for (let index = 1; index < count - 1; index += 1) {
      const previous = slopes[index - 1];
      const next = slopes[index];
      if (previous * next <= 0) {
        tangents[index] = 0;
        continue;
      }
      const before = 2 * gaps[index] + gaps[index - 1];
      const after = gaps[index] + 2 * gaps[index - 1];
      tangents[index] = (before + after) / (before / previous + after / next);
    }
    tangents[0] = slopes[0];
    tangents[count - 1] = slopes[count - 2];

    let path = `M${point(0)}`;
    for (let index = 0; index < count - 1; index += 1) {
      const controlX1 = x(index) + gaps[index] / 3;
      const controlY1 = y(values[index]) + (tangents[index] * gaps[index]) / 3;
      const controlX2 = x(index + 1) - gaps[index] / 3;
      const controlY2 = y(values[index + 1]) - (tangents[index + 1] * gaps[index]) / 3;
      path += ` C${controlX1.toFixed(2)},${controlY1.toFixed(2)} ${controlX2.toFixed(2)},${controlY2.toFixed(2)} ${point(index + 1)}`;
    }
    return path;
  }

  /**
   * @param {number[]} values
   * @param {number} width
   * @param {number} height
   * @param {number} maxY
   * @returns {string}
   */
  function smoothAreaPath(values, width, height, maxY) {
    const line = smoothPath(values, width, height, maxY);
    if (!line) return "";
    return `${line} L${width.toFixed(2)},${height.toFixed(2)} L0,${height.toFixed(2)} Z`;
  }

  /** Left axis label in thousands, the way the reference panel prints it. */
  function kiloLabel(value) {
    // Below a thousand the suffix would print a column of identical "0k" ticks.
    if (Math.abs(value) < 1000) return String(Math.round(value));
    return `${Math.round(value / 1000)}k`;
  }

  /**
   * Right axis label; the number of decimals follows the axis maximum so a
   * cheap window does not collapse into a row of $0.00.
   * @param {number} value
   * @param {number} max
   */
  function usdLabel(value, max) {
    const digits = max >= 10 ? 0 : max >= 0.5 ? 2 : 3;
    return `$${value.toFixed(digits)}`;
  }

  /**
   * @param {number} offsetX
   * @param {number} plotWidth
   * @param {number} count
   */
  function indexAt(offsetX, plotWidth, count) {
    if (count <= 0 || plotWidth <= 0) return 0;
    if (count === 1) return 0;
    const ratio = Math.max(0, Math.min(1, offsetX / plotWidth));
    return Math.round(ratio * (count - 1));
  }

  /**
   * @param {number[]} values
   * @param {number} circumference
   * @param {number} [minLength] arc kept by every non-zero slice
   * @returns {Array<{ fraction: number, length: number, dasharray: string, dashoffset: number }>}
   */
  function donutGeometry(values, circumference, minLength = MIN_SLICE) {
    const amounts = values.map((value) => (Number(value) > 0 ? Number(value) : 0));
    const total = amounts.reduce((sum, value) => sum + value, 0);
    const visible = amounts.filter((value) => value > 0).length;
    const reserved = visible > 0 ? Math.min(minLength, circumference / (visible * 2)) : 0;
    const flexible = Math.max(0, circumference - reserved * visible);
    let offset = 0;
    return amounts.map((amount) => {
      const fraction = total > 0 ? amount / total : 0;
      const length = amount > 0 ? reserved + flexible * fraction : 0;
      const segment = {
        fraction,
        length,
        dasharray: `${length.toFixed(3)} ${(circumference - length).toFixed(3)}`,
        dashoffset: -offset,
      };
      offset += length;
      return segment;
    });
  }

  /**
   * Intensity of every heatmap day: 0 for no traffic, 1..4 otherwise.
   *
   * Buckets come from the quartiles of the active days, not from a fraction of
   * the busiest one. A single runaway day (hundreds of millions of tokens) made
   * every other day a thousandth of the maximum, so the whole year landed on the
   * palest step and the map stopped telling one day from the next. Equal-count
   * buckets keep the shape of a quiet year and a spiky one alike; when every
   * active day carries the same weight there is no ordering to draw, so they
   * share one real tone instead of collapsing to the floor.
   *
   * @param {number[]} values
   * @returns {number[]} 0..4 per value
   */
  function heatLevels(values) {
    const amounts = values.map((value) => {
      const amount = Number(value);
      return Number.isFinite(amount) && amount > 0 ? amount : 0;
    });
    const active = amounts.filter((amount) => amount > 0).sort((a, b) => a - b);
    if (active.length === 0) return amounts.map(() => 0);
    if (active[0] === active[active.length - 1]) return amounts.map((amount) => (amount > 0 ? 4 : 0));
    const cut = (ratio) => active[Math.min(active.length - 1, Math.floor((active.length - 1) * ratio))];
    const low = cut(0.25);
    const mid = cut(0.5);
    const high = cut(0.75);
    return amounts.map((amount) => {
      if (amount <= 0) return 0;
      if (amount > high) return 4;
      if (amount > mid) return 3;
      if (amount > low) return 2;
      return 1;
    });
  }

  /**
   * Evenly spread tick indices, always keeping the first and last bucket.
   * @param {number} count
   * @param {number} max
   * @returns {number[]}
   */
  function tickIndices(count, max) {
    const total = Number(count) || 0;
    if (total <= 0) return [];
    const limit = Math.max(1, Math.floor(Number(max) || 0));
    if (total <= limit) return Array.from({ length: total }, (_, index) => index);
    if (limit === 1) return [0];
    const indices = new Set();
    for (let step = 0; step < limit; step += 1) {
      indices.add(Math.round((step * (total - 1)) / (limit - 1)));
    }
    return [...indices].sort((a, b) => a - b);
  }

  /**
   * @param {number} count
   * @param {number} plotWidth
   * @param {{ maxBarWidth?: number, gapRatio?: number }} [options]
   * @returns {{ slot: number, width: number }}
   */
  function barLayout(count, plotWidth, options = {}) {
    if (count <= 0 || plotWidth <= 0) return { slot: 0, width: 0 };
    const maxBarWidth = options.maxBarWidth ?? 26;
    const gapRatio = options.gapRatio ?? 0.36;
    const slot = plotWidth / count;
    const width = Math.max(2, Math.min(maxBarWidth, slot * (1 - gapRatio)));
    return { slot, width };
  }

  /**
   * Week column of the first day of each month, for the heatmap header.
   * @param {Array<{ dateMs: number }>} days
   * @returns {{ leading: number, starts: Array<{ labelMs: number, week: number }> }}
   */
  function monthStarts(days) {
    if (!Array.isArray(days) || days.length === 0) return { leading: 0, starts: [] };
    const leading = new Date(days[0].dateMs).getDay();
    const starts = [];
    let lastMonth = -1;
    days.forEach((day, index) => {
      const month = new Date(day.dateMs).getMonth();
      if (month === lastMonth) return;
      lastMonth = month;
      starts.push({ labelMs: day.dateMs, week: Math.floor((leading + index) / 7) });
    });
    return { leading, starts };
  }

  /* ------------------------------------------------------------ range picker */

  /** Presets offered inside the range picker, in display order. */
  const RANGE_PRESETS = [
    { id: "today", label: "presetToday" },
    { id: "24h", label: "preset24h" },
    { id: "7d", label: "preset7d" },
    { id: "14d", label: "preset14d" },
    { id: "30d", label: "preset30d" },
    { id: "all", label: "presetAll" },
  ];

  /** @param {number} value */
  function pad2(value) {
    return String(value).padStart(2, "0");
  }

  /** Local midnight of the day holding `ms`. @param {number} ms */
  function startOfLocalDay(ms) {
    const date = new Date(ms);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  }

  /** Last millisecond of the day holding `ms`. @param {number} ms */
  function endOfLocalDay(ms) {
    const date = new Date(ms);
    date.setHours(23, 59, 59, 999);
    return date.getTime();
  }

  /**
   * Local `days` days away; calendar arithmetic keeps DST boundaries exact.
   * @param {number} ms
   * @param {number} days
   */
  function shiftDays(ms, days) {
    const date = new Date(ms);
    date.setDate(date.getDate() + days);
    return date.getTime();
  }

  /** Local midnight on the first day of the month holding `ms`. @param {number} ms */
  function startOfLocalMonth(ms) {
    const date = new Date(ms);
    date.setDate(1);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  }

  /**
   * `YYYY-MM-DDTHH:mm` in local time, the value format of datetime-local.
   * @param {number} ms
   */
  function toLocalInput(ms) {
    const date = new Date(Number(ms) || 0);
    const day = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
    return `${day}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  }

  /**
   * Inverse of toLocalInput; NaN when the text is not a complete local stamp.
   * @param {string} value
   */
  function fromLocalInput(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(value ?? "").trim());
    if (!match) return Number.NaN;
    const date = new Date(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4]),
      Number(match[5]),
      0,
      0,
    );
    const time = date.getTime();
    return Number.isFinite(time) ? time : Number.NaN;
  }

  /**
   * Six week rows of local midnights covering the month holding `monthMs`.
   * @param {number} monthMs
   * @returns {Array<{ dateMs: number, inMonth: boolean }>}
   */
  function monthGrid(monthMs) {
    const base = new Date(startOfLocalMonth(monthMs));
    const year = base.getFullYear();
    const month = base.getMonth();
    const leading = base.getDay();
    const cells = [];
    for (let index = 0; index < 42; index += 1) {
      const date = new Date(year, month, 1 - leading + index);
      cells.push({ dateMs: date.getTime(), inMonth: date.getMonth() === month });
    }
    return cells;
  }

  /**
   * Move the clock time of `refMs` onto the calendar day of `dayMs`.
   * @param {number} dayMs
   * @param {number} refMs
   */
  function combineDayWithTime(dayMs, refMs) {
    const day = new Date(dayMs);
    const ref = new Date(refMs);
    return new Date(
      day.getFullYear(),
      day.getMonth(),
      day.getDate(),
      ref.getHours(),
      ref.getMinutes(),
      0,
      0,
    ).getTime();
  }

  /**
   * Window behind one picker preset.
   * @param {string} id
   * @param {number} nowMs
   * @returns {{ range: string, fromMs: number, toMs: number }}
   */
  function presetWindow(id, nowMs) {
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    if (id === "all") return { range: "all", fromMs: 0, toMs: 0 };
    if (id === "24h") return { range: "custom", fromMs: now - 24 * 60 * 60 * 1000, toMs: now };
    const days = { today: 1, "7d": 7, "14d": 14, "30d": 30 }[id] ?? 7;
    return { range: "custom", fromMs: startOfLocalDay(shiftDays(now, -(days - 1))), toMs: now };
  }

  /** Short local `M/D` label. @param {number} ms */
  function shortDay(ms) {
    const date = new Date(ms);
    return `${date.getMonth() + 1}/${date.getDate()}`;
  }

  /**
   * `10/1 – 10/7` for a window, `10/22` inside one day, empty when unset.
   * @param {number} fromMs
   * @param {number} toMs
   */
  function customRangeText(fromMs, toMs) {
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || !(toMs > fromMs)) return "";
    if (startOfLocalDay(fromMs) === startOfLocalDay(toMs)) return shortDay(fromMs);
    return `${shortDay(fromMs)} – ${shortDay(toMs)}`;
  }

  /* ------------------------------------------------------------------ state */

  /** @type {any} */
  const state = {
    locale: "zh",
    prefs: { range: "7d", sources: [], accent: "blue", theme: "system", fromMs: 0, toMs: 0 },
    hostAppearance: null,
    hello: null,
    usage: null,
    scanning: false,
    progress: null,
    error: null,
    barMetric: "tokens",
    donutMetric: { source: "tokens", model: "tokens" },
    hidden: new Set(),
    openMenu: null,
    heatDay: 0,
    draft: null,
    calendarMonth: 0,
  };

  let booted = false;

  function sourceLabel(source) {
    return source === "desktop" ? t(state.locale, "sourceDesktop") : t(state.locale, "sourceCli");
  }

  function sourceColor(source) {
    return source === "desktop" ? "var(--source-desktop)" : "var(--source-cli)";
  }

  /**
   * Asset directory derived from this script's own URL, so the same markup works
   * from views/index.html and from the test harness.
   * @param {string} scriptSrc
   * @returns {string}
   */
  function assetBaseFrom(scriptSrc) {
    const src = String(scriptSrc || "");
    const cut = src.lastIndexOf("/");
    return cut === -1 ? "./assets/" : `${src.slice(0, cut)}/assets/`;
  }

  const ASSET_BASE = (() => {
    if (typeof document === "undefined") return "./assets/";
    const script = /** @type {any} */ (document.currentScript);
    return assetBaseFrom(script?.src ?? "");
  })();

  /**
   * Official marks of the two data sources, bundled locally.
   * @param {string} source
   */
  function sourceIcon(source) {
    const file = source === "desktop" ? "pi-desktop.png" : "pi-cli.svg";
    const name = source === "desktop" ? "PI-Desktop" : "Pi CLI";
    return `<img class="rank-logo" src="${ASSET_BASE}${file}" alt="${esc(name)} logo" />`;
  }

  const FOLDER_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`;

  const ICON_CALENDAR = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><rect x="3.5" y="5" width="17" height="16" rx="2.5"></rect><path d="M3.5 10h17M8 3v4M16 3v4"></path></svg>`;
  const ICON_MONITOR = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><rect x="3" y="4.5" width="18" height="12" rx="2"></rect><path d="M8.5 20h7M12 16.5V20"></path></svg>`;
  const ICON_SUN = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="4"></circle><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6L17 7M7 17l-1.4 1.4"></path></svg>`;
  const ICON_MOON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"></path></svg>`;
  const THEME_ICONS = { system: ICON_MONITOR, light: ICON_SUN, dark: ICON_MOON };
  const THEME_LABELS = { system: "themeSystem", light: "themeLight", dark: "themeDark" };

  /**
   * Cost of one aggregate row: complete rows are exact, partial rows are marked
   * "≈", rows with no priced record show a dash.
   * @param {any} row
   */
  function rowCost(row) {
    if (!row) return "—";
    if (row.costComplete) return Fmt.formatUsd(row.cost);
    if (row.requests > 0 && row.costMissing >= row.requests) return "—";
    return `≈${Fmt.formatUsd(row.cost)}`;
  }

  /**
   * Cost of a group of rows in the one vocabulary the whole panel uses: exact
   * when every row is priced, "≈" when only part of it is, "—" when none is.
   * A partially priced total must never look like an exact one.
   * @param {any[]} rows
   */
  function costSum(rows) {
    if (!rows || rows.length === 0) return "—";
    // Nothing measured at all is "no answer", not "zero dollars".
    const requests = rows.reduce((sum, row) => sum + (Number(row.requests) || 0), 0);
    if (requests === 0) return "—";
    const unknown = rows.filter((row) => {
      const rowRequests = Number(row.requests) || 0;
      return rowRequests > 0 && (Number(row.costMissing) || 0) >= rowRequests;
    });
    if (unknown.length === rows.length) return "—";
    const total = rows.reduce((sum, row) => sum + (Number(row.cost) || 0), 0);
    return rows.every((row) => row.costComplete === true) ? Fmt.formatUsd(total) : `≈${Fmt.formatUsd(total)}`;
  }

  /* ----------------------------------------------------------------- bridge */

  function bridge() {
    return typeof window === "undefined" ? null : (/** @type {any} */ (window)).pluginBridge;
  }

  /**
   * @param {string} channel
   * @param {any} [payload]
   */
  async function call(channel, payload) {
    const current = bridge();
    if (!current || typeof current.invoke !== "function") {
      throw new Error("plugin bridge unavailable");
    }
    return await current.invoke(channel, payload ?? {});
  }

  /* ------------------------------------------------------------------ flow */

  function applyAppearance(appearance) {
    if (typeof document === "undefined") return;
    if (appearance) state.hostAppearance = appearance;
    const chosen = state.prefs.theme;
    const host = state.hostAppearance;
    const base =
      chosen === "light" || chosen === "dark"
        ? chosen
        : host && (host.base === "light" || host.base === "dark")
          ? host.base
          : window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches
            ? "light"
            : "dark";
    document.documentElement.dataset.base = base;
    document.documentElement.style.colorScheme = base;
    // Remembered so the next mount paints the right theme before the host
    // bridge answers; see the bootstrap in index.html.
    try {
      window.localStorage.setItem("usage.base", base);
    } catch {
      // Storage may be disabled; the panel then simply follows the host.
    }
    const locale = String(appearance?.locale ?? navigator.language ?? "").toLowerCase();
    state.locale = locale.startsWith("zh") ? "zh" : "en";
    document.documentElement.lang = state.locale === "zh" ? "zh-CN" : "en";
  }

  /** Paint the chosen accent palette onto the document root. */
  function applyAccent() {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    const accent = state.prefs.accent;
    if (isHexColor(accent)) {
      root.dataset.accent = "custom";
      root.style.setProperty("--accent", accent);
      root.style.setProperty("--accent-soft", `color-mix(in oklab, ${accent} 16%, transparent)`);
      return;
    }
    const name = ACCENTS.includes(accent) ? accent : "blue";
    root.dataset.accent = name;
    root.style.removeProperty("--accent");
    root.style.removeProperty("--accent-soft");
  }

  /** Monotonic token so a slow query cannot overwrite a newer one. */
  let loadSeq = 0;

  async function loadUsage() {
    const token = (loadSeq += 1);
    let usage;
    try {
      usage = await call("usage.get", {
        range: state.prefs.range,
        sources: state.prefs.sources,
        fromMs: state.prefs.fromMs,
        toMs: state.prefs.toMs,
      });
    } catch (error) {
      // A superseded query must drive neither the data nor the banner: only the
      // newest request may report, otherwise a slow old failure paints an error
      // over a screen that already shows the new numbers.
      if (token !== loadSeq) return;
      throw error;
    }
    if (token !== loadSeq) return;
    if (!usage || usage.ok === false) throw new Error(usage?.message || "query failed");
    state.usage = usage;
    state.error = null;
  }

  async function runScan() {
    state.scanning = true;
    state.error = null;
    render();
    try {
      let attempts = 0;
      for (;;) {
        const result = await call("usage.scan", {});
        if (!result || result.ok === false) throw new Error(result?.message || "scan failed");
        state.progress = result.progress ?? null;
        render();
        attempts += 1;
        if (!result.budgetExhausted || attempts >= 12) break;
      }
      await loadUsage();
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
    } finally {
      state.progress = null;
      state.scanning = false;
      render();
    }
  }

  /**
   * @param {{ range?: string, sources?: string[], accent?: string, theme?: string, fromMs?: number, toMs?: number }} patch
   */
  async function setPrefs(patch) {
    state.prefs = { ...state.prefs, ...patch };
    applyAccent();
    render();
    try {
      await call("usage.prefs.set", patch);
    } catch {
      // A preference that cannot be persisted is still valid for this session.
    }
    try {
      await loadUsage();
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
      // Keeping the previous window's numbers under the new label would present
      // stale data as the answer to the new question.
      state.usage = null;
      render();
    }
    render();
  }

  /* ----------------------------------------------------------------- render */

  function rangeLabel(range) {
    if (range === "custom") return customRangeText(state.prefs.fromMs, state.prefs.toMs) || t(state.locale, "rangeCustom");
    const zh = { today: "今天", "7d": "7D", "30d": "30D", "90d": "90D", all: "全部" };
    const en = { today: "Today", "7d": "7D", "30d": "30D", "90d": "90D", all: "All" };
    return (state.locale === "zh" ? zh : en)[range] ?? "7D";
  }

  function deltaText(current, previous) {
    const delta = Fmt.formatDelta(current, previous);
    if (delta.direction === null) return t(state.locale, "noBaseline");
    const arrow = delta.direction === "up" ? "↑" : delta.direction === "down" ? "↓" : "→";
    return `${t(state.locale, "prevShort")} ${arrow}${Math.abs(delta.pct ?? 0).toFixed(1)}%`;
  }

  /**
   * Mini-trend of one metric card. The stroke follows the period-over-period
   * direction so the card reads at a glance; without a baseline it keeps the
   * theme colour.
   *
   * @param {number[]} values
   * @param {"up" | "down" | ""} [tone]
   */
  function sparkline(values, tone) {
    const trimmed = values.slice(-24);
    const max = trimmed.reduce((best, value) => (value > best ? value : best), 0);
    const path = linePath(trimmed, 88, 24, max > 0 ? max : 1);
    if (!path) return "";
    const color = tone === "up" ? "var(--delta-up)" : tone === "down" ? "var(--delta-down)" : "var(--accent)";
    return `
      <svg class="spark" viewBox="0 0 92 30" aria-hidden="true">
        <path class="spark-fill" d="${areaPath(trimmed, 88, 24, max > 0 ? max : 1)}" transform="translate(2,3)"
          fill="${color}" fill-opacity="0.14" stroke="none"></path>
        <path class="spark-line" pathLength="1" d="${path}" transform="translate(2,3)" fill="none"
          stroke="${color}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"></path>
      </svg>`;
  }

  function topbarHtml() {
    const ranges = RANGES.map(
      (range) => `
        <button type="button" role="tab" data-action="range" data-range="${range}"
          aria-selected="${state.prefs.range === range ? "true" : "false"}">${esc(rangeLabel(range))}</button>`,
    ).join("");

    const customLabel =
      state.prefs.range === "custom" ? rangeLabel("custom") : t(state.locale, "rangeCustom");

    const selected = state.prefs.sources;
    const label =
      selected.length === 0
        ? t(state.locale, "allSources")
        : selected.map((source) => sourceLabel(source)).join(" + ");

    const items = SOURCE_IDS.map((source) => {
      const checked = selected.includes(source) ? "checked" : "";
      return `
        <label>
          <input type="checkbox" data-source="${source}" ${checked} />
          <span class="dot" style="width:8px;height:8px;border-radius:50%;background:${sourceColor(source)}"></span>
          ${esc(sourceLabel(source))}
        </label>`;
    }).join("");

    const accentOptions = ACCENTS.map(
      (accent) => `
        <button class="accent-swatch" type="button" data-action="accent" data-accent="${accent}"
          aria-pressed="${state.prefs.accent === accent ? "true" : "false"}"
          title="${esc(t(state.locale, `accent_${accent}`))}">
          <span style="background:${ACCENT_COLORS[accent]}"></span>
        </button>`,
    ).join("");

    const freeAccent = isHexColor(state.prefs.accent);
    const accentRing = freeAccent ? state.prefs.accent : ACCENT_RING;
    const customSwatch = `
        <label class="accent-swatch accent-custom" data-role="accent-custom"
          aria-pressed="${freeAccent ? "true" : "false"}" title="${esc(t(state.locale, "accentCustom"))}">
          <span class="accent-custom-ring" style="background:${accentRing}"></span>
          <input type="color" data-role="accent-color"
            value="${esc(freeAccent ? state.prefs.accent : ACCENT_COLORS[state.prefs.accent] ?? ACCENT_COLORS.blue)}"
            aria-label="${esc(t(state.locale, "accentCustom"))}" />
        </label>`;
    const accentChoices = `${accentOptions}${customSwatch}`;

    const themeOptions = THEMES.map(
      (theme) => `
        <button type="button" role="menuitemradio" data-action="theme" data-theme="${theme}"
          aria-checked="${state.prefs.theme === theme ? "true" : "false"}">
          ${THEME_ICONS[theme]}<span>${esc(t(state.locale, THEME_LABELS[theme]))}</span>
          <span class="check">✓</span>
        </button>`,
    ).join("");

    return `
      <header class="topbar">
        <div class="topbar-left">
          <div class="range-filter menu-host">
            <div class="tabs" role="tablist">${ranges}</div>
            <button class="pill range-custom" type="button" data-action="toggle-menu" data-menu-toggle="range"
              aria-haspopup="dialog" aria-expanded="${state.openMenu === "range" ? "true" : "false"}"
              data-active="${state.prefs.range === "custom" ? "true" : "false"}"
              title="${esc(t(state.locale, "customRangeLabel"))}">
              ${ICON_CALENDAR}<span>${esc(customLabel)}</span><span class="caret">▾</span>
            </button>
            <div class="menu range-menu" role="dialog" data-menu="range"
              ${state.openMenu === "range" ? "" : "hidden"}></div>
          </div>
        </div>
        <div class="topbar-actions">
          <div class="source-filter menu-host">
            <button class="pill" type="button" data-action="toggle-menu" data-menu-toggle="source"
              aria-haspopup="true" aria-expanded="${state.openMenu === "source" ? "true" : "false"}">
              ${esc(label)}<span class="caret">▾</span>
            </button>
            <div class="menu" role="menu" data-menu="source" ${state.openMenu === "source" ? "" : "hidden"}>
              ${items}
              <div class="menu-sep"></div>
              <button class="menu-action" type="button" data-action="clear-sources">${esc(
                t(state.locale, "allSources"),
              )}</button>
            </div>
          </div>
          <div class="accent-filter menu-host">
            <button class="icon-btn" type="button" data-action="toggle-menu" data-menu-toggle="accent"
              aria-haspopup="true" aria-expanded="${state.openMenu === "accent" ? "true" : "false"}"
              title="${esc(t(state.locale, "themeColor"))}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">
                <circle cx="12" cy="12" r="8.5"></circle>
                <circle cx="9" cy="9.5" r="1.1" fill="currentColor" stroke="none"></circle>
                <circle cx="14.6" cy="8.8" r="1.1" fill="currentColor" stroke="none"></circle>
                <circle cx="15.4" cy="14.2" r="1.1" fill="currentColor" stroke="none"></circle>
                <circle cx="9.6" cy="14.6" r="1.1" fill="currentColor" stroke="none"></circle>
              </svg>
            </button>
            <div class="menu accent-menu" role="menu" data-menu="accent" ${
              state.openMenu === "accent" ? "" : "hidden"
            }>
              <div class="accent-row">${accentChoices}</div>
            </div>
          </div>
          <div class="theme-filter menu-host">
            <button class="icon-btn" type="button" data-action="toggle-menu" data-menu-toggle="theme"
              aria-haspopup="true" aria-expanded="${state.openMenu === "theme" ? "true" : "false"}"
              title="${esc(t(state.locale, "themeLabel"))}">
              ${THEME_ICONS[state.prefs.theme] ?? ICON_MONITOR}
            </button>
            <div class="menu theme-menu" role="menu" data-menu="theme" ${
              state.openMenu === "theme" ? "" : "hidden"
            }>${themeOptions}</div>
          </div>
          <button class="icon-btn" type="button" data-action="refresh" title="${esc(
            t(state.locale, "refresh"),
          )}" ${state.scanning ? "disabled" : ""}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
              <path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>
            </svg>
          </button>
        </div>
      </header>`;
  }

  function metricCard(options) {
    return `
      <article class="card metric">
        <div class="metric-head">
          <p class="label">${esc(options.label)}
            <i class="info" title="${esc(options.hint)}">i</i>
          </p>
          ${options.badge ?? ""}
        </div>
        <p class="value">${esc(options.value)}</p>
        ${options.sub ? `<p class="sub">${esc(options.sub)}</p>` : ""}
        ${options.spark ?? ""}
      </article>`;
  }

  /**
   * Cache hit ratio of one bucket or of a totals object: cache reads over fresh
   * input plus cache reads. Null when the bucket has no input at all.
   * @param {{ input?: number, cacheRead?: number }} point
   */
  function bucketCacheRate(point) {
    const input = Number(point?.input) || 0;
    const cacheRead = Number(point?.cacheRead) || 0;
    const base = input + cacheRead;
    return base > 0 ? cacheRead / base : null;
  }
  /**
   * Which way the pill and the mini-trend lean. A percentage needs a baseline:
   * with an empty previous window the honest reading is "up", not "flat".
   *
   * @param {number} current
   * @param {number} previous
   * @returns {"up" | "down" | ""}
   */
  function deltaTone(current, previous) {
    const now = Number(current) || 0;
    const before = Number(previous) || 0;
    const delta = Fmt.formatDelta(now, before);
    if (delta.pct === null) return before <= 0 && now > 0 ? "up" : "";
    return delta.direction === "up" ? "up" : delta.direction === "down" ? "down" : "";
  }

  /**
   * Period-over-period pill: the arrow carries the direction, the colour repeats
   * it, and the title spells out what is being compared.
   *
   * @param {number} current
   * @param {number} previous
   * @param {(value: number) => string} absolute Formatter for the no-baseline case
   */
  function deltaBadge(current, previous, absolute) {
    const now = Number(current) || 0;
    const before = Number(previous) || 0;
    const delta = Fmt.formatDelta(now, before);
    const tone = deltaTone(now, before);
    if (!tone) return "";
    const text =
      delta.pct === null
        ? `+${absolute(now)}`
        : `${Math.abs(delta.pct).toFixed(1)}%`;
    const arrow = tone === "up" ? "↑" : "↓";
    const spoken = `${t(state.locale, "prevShort")} ${arrow}${text}`;
    return `<span class="delta-badge is-${tone}" title="${esc(spoken)}" aria-label="${esc(
      spoken,
    )}">${arrow}${esc(text)}</span>`;
  }

  function metricsHtml(usage) {
    const totals = usage.totals;
    const previous = usage.previous;
    const series = usage.series ?? [];
    const costValue = costSum([totals]);
    const cacheRate = bucketCacheRate(totals);
    const shareOfTokens = (value) => (totals.tokens > 0 ? Fmt.formatPercent(value / totals.tokens) : "0%");
    const hitRate = cacheRate === null ? "—" : Fmt.formatPercent(cacheRate);

    return `
      <section class="metrics">
        ${metricCard({
          label: t(state.locale, "metricCost"),
          hint: t(state.locale, "metricCostHint"),
          value: costValue,
          badge: deltaBadge(totals.cost, previous.cost, Fmt.formatUsd),
          spark: sparkline(
            series.map((point) => Number(point.cost) || 0),
            deltaTone(totals.cost, previous.cost),
          ),
        })}
        ${metricCard({
          label: t(state.locale, "metricTokens"),
          hint: t(state.locale, "metricTokensHint"),
          value: Fmt.formatTokens(totals.tokens),
          badge: deltaBadge(totals.tokens, previous.tokens, Fmt.formatTokens),
          sub: `${Fmt.formatTokensExact(totals.requests)} ${t(state.locale, "requestsTimes")}`,
          spark: sparkline(
            series.map((point) => Number(point.total) || 0),
            deltaTone(totals.tokens, previous.tokens),
          ),
        })}
        ${metricCard({
          label: t(state.locale, "metricInput"),
          hint: t(state.locale, "metricInputHint"),
          value: Fmt.formatTokens(totals.input),
          badge: deltaBadge(totals.input, previous.input, Fmt.formatTokens),
          sub: `${t(state.locale, "metricCacheHit")} ${hitRate}`,
          spark: sparkline(
            series.map((point) => Number(point.input) || 0),
            deltaTone(totals.input, previous.input),
          ),
        })}
        ${metricCard({
          label: t(state.locale, "metricOutput"),
          hint: t(state.locale, "metricOutputHint"),
          value: Fmt.formatTokens(totals.output),
          badge: deltaBadge(totals.output, previous.output, Fmt.formatTokens),
          sub: `${t(state.locale, "share")} ${shareOfTokens(totals.output)}`,
          spark: sparkline(
            series.map((point) => Number(point.output) || 0),
            deltaTone(totals.output, previous.output),
          ),
        })}
        ${metricCard({
          label: t(state.locale, "metricCacheRead"),
          hint: t(state.locale, "metricCacheReadHint"),
          value: Fmt.formatTokens(totals.cacheRead),
          badge: deltaBadge(totals.cacheRead, previous.cacheRead, Fmt.formatTokens),
          sub: `${t(state.locale, "share")} ${shareOfTokens(totals.cacheRead)}`,
          spark: sparkline(
            series.map((point) => Number(point.cacheRead) || 0),
            deltaTone(totals.cacheRead, previous.cacheRead),
          ),
        })}
        ${metricCard({
          label: t(state.locale, "metricCacheWrite"),
          hint: t(state.locale, "metricCacheWriteHint"),
          value: Fmt.formatTokens(totals.cacheWrite),
          badge: deltaBadge(totals.cacheWrite, previous.cacheWrite, Fmt.formatTokens),
          sub: `${t(state.locale, "share")} ${shareOfTokens(totals.cacheWrite)}`,
          spark: sparkline(
            series.map((point) => Number(point.cacheWrite) || 0),
            deltaTone(totals.cacheWrite, previous.cacheWrite),
          ),
        })}
        ${metricCard({
          label: t(state.locale, "metricRequests"),
          hint: t(state.locale, "metricRequestsHint"),
          value: Fmt.formatTokensExact(totals.requests),
          badge: deltaBadge(totals.requests, previous.requests, Fmt.formatTokensExact),
          spark: sparkline(
            series.map((point) => Number(point.requests) || 0),
            deltaTone(totals.requests, previous.requests),
          ),
        })}
        ${metricCard({
          label: t(state.locale, "metricCacheHit"),
          hint: t(state.locale, "metricCacheHitHint"),
          value: hitRate,
          sub: `${t(state.locale, "metricCacheRead")} ${Fmt.formatTokens(totals.cacheRead)}`,
          spark: sparkline(
            series.map((point) => Number(bucketCacheRate(point)) || 0),
            "",
          ),
        })}
      </section>`;
  }

  function heatmapHtml(usage) {
    const days = usage.heatmap ?? [];
    if (days.length === 0) return "";
    const levels = heatLevels(days.map((day) => day.tokens));
    const { leading, starts } = monthStarts(days);
    const weeks = Math.max(1, Math.ceil((leading + days.length) / 7));
    const months = starts
      .map(
        (entry) =>
          `<span style="left:${((entry.week / weeks) * 100).toFixed(3)}%">${esc(
            Fmt.formatMonthShort(entry.labelMs, state.locale),
          )}</span>`,
      )
      .join("");
    const weekdays = Array.from({ length: 7 }, (_, index) => Fmt.formatWeekdayNarrow(index, state.locale))
      .map((label) => `<span>${esc(label)}</span>`)
      .join("");
    const blanks = Array.from(
      { length: leading },
      () => `<span class="heat-cell" style="visibility:hidden"></span>`,
    ).join("");
    const cells = days
      .map((day, index) => {
        const selected = state.heatDay === day.dateMs;
        const label = `${dayTitle(day.dateMs)} · ${Fmt.formatTokens(day.tokens)} · ${Fmt.formatUsd(day.cost)}`;
        return `<button type="button" class="heat-cell${selected ? " is-selected" : ""}" data-action="heat-day"
          data-day="${day.dateMs}" aria-pressed="${selected}" aria-label="${esc(label)}" title="${esc(label)}"
          style="background:${HEAT_COLORS[levels[index]]}"></button>`;
      })
      .join("");

    return `
      <section class="card heat-card">
        <h2 class="visually-hidden" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">${esc(
          t(state.locale, "heatmap"),
        )}</h2>
        <div class="heat-months">${months}</div>
        <div class="heat-body">
          <div class="heat-weekdays">${weekdays}</div>
          <div class="heat-grid" style="--weeks:${weeks};grid-template-columns:repeat(${weeks}, minmax(2px, 1fr))">${blanks}${cells}</div>
        </div>
        <div class="heat-foot">
          <div class="heat-detail" data-heat-detail>${heatDetailHtml(usage)}</div>
          <div class="heat-legend">
            <span>${esc(t(state.locale, "less"))}</span>
            ${HEAT_COLORS.map((color) => `<span class="heat-cell" style="background:${color}"></span>`).join("")}
            <span>${esc(t(state.locale, "more"))}</span>
          </div>
        </div>
      </section>`;
  }

  /** `2026年10月22日` / `Oct 22, 2026`. */
  function dayTitle(ms) {
    const date = new Date(ms);
    if (state.locale === "zh") return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
    return `${Fmt.formatMonthShort(ms, state.locale)} ${date.getDate()}, ${date.getFullYear()}`;
  }

  /** Detail line under the heatmap: the picked day, or a hint before any pick. */
  function heatDetailHtml(usage) {
    const day = (usage?.heatmap ?? []).find((entry) => entry.dateMs === state.heatDay);
    if (!day) return `<span class="heat-hint">${esc(t(state.locale, "heatPickHint"))}</span>`;
    const cost = day.costComplete === false ? `≈${Fmt.formatUsd(day.cost)}` : Fmt.formatUsd(day.cost);
    return `
      <span class="heat-date">${esc(dayTitle(day.dateMs))}</span>
      <span class="heat-stat"><b>${esc(Fmt.formatTokens(day.tokens))}</b>${esc(t(state.locale, "tokenLabel"))}</span>
      <span class="heat-stat"><b>${esc(cost)}</b>${esc(t(state.locale, "costLabel"))}</span>
      <span class="heat-stat"><b>${esc(Fmt.formatTokensExact(day.requests))}</b>${esc(
        t(state.locale, "requestsTimes"),
      )}</span>`;
  }

  /** `2026-08-02`, the compact stamp the hover card carries. */
  function dayStamp(ms) {
    const date = new Date(Number(ms) || 0);
    const pad = (value) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  /** Set while the visible tooltip belongs to a heatmap square. */
  let heatTooltipOpen = false;

  /**
   * Hover card of one heatmap square: the day, its level and the models behind
   * it, ranked with their own share bars.
   *
   * @param {any} day
   * @param {number} level 0..4 from heatLevels
   */
  function heatTipHtml(day, level) {
    const total = Math.max(0, Number(day.tokens) || 0);
    const models = Array.isArray(day.models) ? day.models : [];
    const share = (tokens) => (total > 0 ? Math.max(0, Number(tokens) || 0) / total : 0);
    const row = (name, tokens, ratio, color, icon) => `
      <li class="tip-model">
        ${icon ?? `<span class="tip-model-logo"></span>`}
        <span class="tip-model-name" title="${esc(name)}">${esc(name)}</span>
        <span class="tip-model-value">${esc(Fmt.formatTokens(tokens))} · ${esc(Fmt.formatPercent(ratio))}</span>
        <span class="tip-model-bar"><i style="width:${(ratio * 100).toFixed(1)}%;background:${color}"></i></span>
      </li>`;
    const rows = models.map((entry) => {
      const name = entry.model || t(state.locale, "unknownModel");
      return row(
        entry.provider ? `${entry.provider} · ${name}` : name,
        entry.tokens,
        share(entry.tokens),
        sourceColor(entry.source),
        sourceIcon(entry.source),
      );
    });
    const rest = Math.max(0, Number(day.otherTokens) || 0);
    if (rest > 0) rows.push(row(t(state.locale, "otherModels"), rest, share(rest), OTHER_SLICE_COLOR));
    return `
      <div class="tip-heat">
        <div class="tip-heat-head">
          <span class="tip-heat-date">${esc(dayStamp(day.dateMs))}</span>
          <span class="tip-heat-level">${esc(t(state.locale, "heatLevel"))} ${level}</span>
        </div>
        <div class="tip-heat-total">
          <span class="dot" style="background:${HEAT_COLORS[level] ?? HEAT_COLORS[0]}"></span>
          <span>${esc(t(state.locale, "heatTotal"))}</span>
          <b>${esc(Fmt.formatTokens(day.tokens))}</b>
        </div>
        ${
          rows.length > 0
            ? `<p class="tip-heat-sub">${esc(t(state.locale, "heatModels"))}</p>
               <ul class="tip-model-list">${rows.join("")}</ul>`
            : ""
        }
      </div>`;
  }

  /**
   * Hover on a heatmap square swaps the shared tooltip for that day's card; a
   * square that is no longer under the pointer takes its own tooltip away.
   * @param {Event} rawEvent
   */
  function onHeatHover(rawEvent) {
    const event = /** @type {MouseEvent} */ (rawEvent);
    const target = event.target;
    const cell = target instanceof Element ? target.closest("[data-action='heat-day']") : null;
    if (!cell || !state.usage) {
      if (heatTooltipOpen) {
        heatTooltipOpen = false;
        hideTooltip();
      }
      return;
    }
    const days = state.usage.heatmap ?? [];
    const day = days.find((entry) => entry.dateMs === Number(cell.getAttribute("data-day")));
    if (!day) return;
    heatTooltipOpen = true;
    showTooltip(
      heatTipHtml(day, heatLevels(days.map((entry) => entry.tokens))[days.indexOf(day)] ?? 0),
      event.clientX,
      event.clientY,
      "heat",
    );
  }

  /** Pick or clear one heatmap day; the grid and the detail line update in place. */
  function selectHeatDay(dayMs) {
    if (!Number.isFinite(dayMs)) return;
    state.heatDay = state.heatDay === dayMs ? 0 : dayMs;
    document.querySelectorAll("[data-action='heat-day']").forEach((cell) => {
      const selected = Number(cell.getAttribute("data-day")) === state.heatDay;
      (/** @type {HTMLElement} */ (cell)).classList.toggle("is-selected", selected);
      cell.setAttribute("aria-pressed", String(selected));
    });
    const detail = document.querySelector("[data-heat-detail]");
    if (detail) detail.innerHTML = heatDetailHtml(state.usage);
  }

  /** `2026/8/6 00:00:00 - 2026/8/13 00:00:00`, the window the chart covers. */
  function usageRangeText(usage) {
    const stamp = (ms) => {
      const date = new Date(Number(ms) || 0);
      const pad = (value) => String(value).padStart(2, "0");
      return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(
        date.getMinutes(),
      )}:${pad(date.getSeconds())}`;
    };
    return `${stamp(usage.fromMs)} - ${stamp(usage.toMs)}`;
  }

  function areaCardHtml(usage) {
    const legend = TREND_SERIES.map(
      (entry) => `
        <span class="trend-legend-item" style="color:${TREND_COLORS[entry.key]}">
          <i class="dot"></i>${esc(t(state.locale, entry.label))}
        </span>`,
    ).join("");

    return `
      <section class="card trend-card">
        <div class="card-head">
          <h2>${esc(t(state.locale, "usageTrend"))}</h2>
          <p class="trend-range">${esc(usageRangeText(usage))}</p>
        </div>
        <div class="chart" data-chart="area"></div>
        <div class="trend-legend">${legend}</div>
      </section>`;
  }

  function barsCardHtml(usage) {
    const options = [
      { id: "tokens", label: "tokenLabel" },
      { id: "cost", label: "costLabel" },
    ]
      .map(
        (option) => `
        <button type="button" role="tab" data-action="bar-metric" data-metric="${option.id}"
          aria-selected="${state.barMetric === option.id ? "true" : "false"}">${esc(
            t(state.locale, option.label),
          )}</button>`,
      )
      .join("");

    const hint =
      usage.bucket === "hour" ? t(state.locale, "trendHintHour") : t(state.locale, "trendHintDay");

    return `
      <section class="card">
        <div class="card-head">
          <div>
            <h2>${esc(t(state.locale, "trendTitle", { range: rangeLabel(state.prefs.range) }))}</h2>
            <p class="hint">${esc(hint)}</p>
          </div>
          <div class="head-controls"><div class="tabs mini" role="tablist">${options}</div></div>
        </div>
        <div class="chart" data-chart="bars"></div>
      </section>`;
  }

  /**
   * @param {any[]} rows
   * @param {"source" | "project"} kind
   */
  function rankRows(rows, kind, totalOverride) {
    const total = totalOverride ?? rows.reduce((sum, row) => sum + (Number(row.tokens) || 0), 0);
    return rows
      .map((row, index) => {
        const name =
          kind === "project"
            ? row.projectName || t(state.locale, "unassigned")
            : sourceLabel(row.source);
        const icon = kind === "project" ? FOLDER_ICON : sourceIcon(row.source);
        const sub = `${Fmt.formatTokensExact(row.requests)} ${t(state.locale, "requestsTimes")} · ${esc(
          rowCost(row),
        )}`;
        const width = (shareOf(row.tokens, total) * 100).toFixed(1);
        const key = kind === "project" ? `project:${row.projectPath ?? index}` : `source:${row.source}`;
        return `
          <div class="rank-row" data-action="rank-row" data-key="${esc(key)}"
            data-name="${esc(name)}" data-tokens="${esc(Fmt.formatTokens(row.tokens))}"
            data-requests="${esc(Fmt.formatTokensExact(row.requests))}" data-cost="${esc(rowCost(row))}"
            data-share="${esc(Fmt.formatPercent(shareOf(row.tokens, total)))}"
            data-path="${esc(row.projectPath ?? "")}">
            <div class="rank-icon${kind === "source" ? " is-logo" : ""}">${icon}</div>
            <div class="rank-main">
              <div class="rank-name">${esc(name)}</div>
              <div class="rank-sub">${esc(sub)}</div>
              <div class="rank-bar"><span style="width:${width}%"></span></div>
            </div>
            <div class="rank-value">${esc(Fmt.formatTokens(row.tokens))}<small>${esc(rowCost(row))}</small></div>
          </div>`;
      })
      .join("");
  }

  function sourceRankCardHtml(usage) {
    const sources = usage.bySource ?? [];
    const total = sources.reduce(
      (acc, row) => ({
        tokens: acc.tokens + (Number(row.tokens) || 0),
        requests: acc.requests + (Number(row.requests) || 0),
        cost: acc.cost + (Number(row.cost) || 0),
        missing: acc.missing + (row.costComplete ? 0 : 1),
      }),
      { tokens: 0, requests: 0, cost: 0, missing: 0 },
    );
    const share = sources
      .map(
        (row) =>
          `<span style="width:${(shareOf(row.tokens, total.tokens) * 100).toFixed(2)}%;background:${sourceColor(
            row.source,
          )}"></span>`,
      )
      .join("");
    const costValue = costSum(sources);
    return `
      <section class="card">
        <div class="card-head">
          <div>
            <h2>${esc(t(state.locale, "sourceUsage"))}</h2>
            <p class="hint">${esc(t(state.locale, "sourceUsageHint"))}</p>
          </div>
        </div>
        <div class="rank-list">${rankRows(sources, "source") || `<p class="hint">—</p>`}</div>
        <div class="rank-summary">
          <div class="summary-bar">${share}</div>
          <div class="summary-row">
            <span class="summary-label">${esc(t(state.locale, "totalLabel"))}</span>
            <span class="summary-sub">${esc(
              `${Fmt.formatTokensExact(total.requests)} ${t(state.locale, "requestsTimes")} · ${costValue}`,
            )}</span>
            <strong>${esc(Fmt.formatTokens(total.tokens))}</strong>
          </div>
        </div>
      </section>`;
  }

  function projectRankCardHtml(usage) {
    const all = usage.byProject ?? [];
    const rows = all.slice(0, 3);
    // Shares are of the whole window, not of the three rows that fit on screen.
    const total = all.reduce((sum, row) => sum + (Number(row.tokens) || 0), 0) || usage.totals?.tokens || 0;
    return `
      <section class="card">
        <div class="card-head">
          <div>
            <h2>${esc(t(state.locale, "projectUsage"))}</h2>
            <p class="hint">${esc(t(state.locale, "projectUsageHint"))}</p>
          </div>
        </div>
        <div class="rank-list">${rankRows(rows, "project", total) || `<p class="hint">—</p>`}</div>
      </section>`;
  }

  function donutRows(kind, usage) {
    const metric = state.donutMetric[kind] ?? "tokens";
    if (kind === "model") {
      const all = usage.byModel ?? [];
      const rows = all.slice(0, 6).map((row, index) => ({
        key: `model|${row.source}|${row.model}`,
        label: row.model || t(state.locale, "unknownModel"),
        value: metric === "cost" ? row.cost : row.tokens,
        color: SLICE_COLORS[index % SLICE_COLORS.length],
        requests: row.requests,
        cost: row.cost,
        costComplete: row.costComplete,
        costMissing: row.costMissing,
      }));
      // The ring has to cover the whole window. Without a remainder slice the
      // centre total contradicts the token card as soon as a seventh model
      // appears, and every legend share becomes a share of the top six only.
      const rest = all.slice(6);
      if (rest.length > 0) {
        const sum = (field) => rest.reduce((total, row) => total + (Number(row[field]) || 0), 0);
        rows.push({
          key: "model|other",
          label: t(state.locale, "otherModels"),
          value: metric === "cost" ? sum("cost") : sum("tokens"),
          color: OTHER_SLICE_COLOR,
          requests: sum("requests"),
          cost: sum("cost"),
          costComplete: rest.every((row) => row.costComplete === true),
          costMissing: sum("costMissing"),
        });
      }
      return rows;
    }
    return (usage.bySource ?? []).map((row) => ({
      key: `source|${row.source}`,
      label: sourceLabel(row.source),
      value: metric === "cost" ? row.cost : row.tokens,
      color: sourceColor(row.source),
      requests: row.requests,
      cost: row.cost,
      costComplete: row.costComplete,
      costMissing: row.costMissing,
    }));
  }

  /**
   * Legend rows of one donut card; values and shares follow that card's metric.
   * @param {string} kind
   * @param {any} usage
   */
  function donutLegendHtml(kind, usage) {
    const rows = donutRows(kind, usage);
    const format = (state.donutMetric[kind] ?? "tokens") === "cost" ? Fmt.formatUsd : Fmt.formatTokens;
    const total = rows
      .filter((row) => !state.hidden.has(row.key))
      .reduce((sum, row) => sum + Math.max(0, Number(row.value) || 0), 0);
    const items = rows
      .map((row) => {
        const hidden = state.hidden.has(row.key);
        return `
          <li>
            <button class="${hidden ? "slice-row is-off" : "slice-row"}" type="button" data-action="toggle-slice"
              data-key="${esc(row.key)}" aria-pressed="${hidden ? "false" : "true"}">
              <span class="dot" style="background:${hidden ? "currentColor" : row.color}"></span>
              <span class="name">${esc(row.label)}</span>
              <span class="value">${esc(format(row.value))}</span>
              <span class="pct">${hidden ? "—" : esc(Fmt.formatPercent(shareOf(row.value, total)))}</span>
            </button>
          </li>`;
      })
      .join("");
    return items || `<li class="hint">—</li>`;
  }

  function donutCardHtml(kind, usage) {
    const title = kind === "model" ? "modelDist" : "sourceDist";
    const hint = kind === "model" ? "modelDistHint" : "sourceDistHint";
    const metric = state.donutMetric[kind] ?? "tokens";
    const options = [
      { id: "tokens", label: "tokenLabel" },
      { id: "cost", label: "costLabel" },
    ]
      .map(
        (option) => `
        <button type="button" role="tab" data-action="donut-metric" data-kind="${kind}"
          data-metric="${option.id}" aria-selected="${metric === option.id ? "true" : "false"}">${esc(
            t(state.locale, option.label),
          )}</button>`,
      )
      .join("");

    return `
      <section class="card" data-donut="${kind}">
        <div class="card-head">
          <div>
            <h2>${esc(t(state.locale, title))}</h2>
            <p class="hint">${esc(t(state.locale, hint))}</p>
          </div>
          <div class="head-controls"><div class="tabs mini" role="tablist">${options}</div></div>
        </div>
        <div class="donut-body">
          <div class="donut-box" data-chart="donut-${kind}"></div>
          <ul class="donut-list" data-legend="${kind}" style="list-style:none;margin:0;padding:0">${donutLegendHtml(
            kind,
            usage,
          )}</ul>
        </div>
      </section>`;
  }

  function progressHtml() {
    if (!state.scanning) return "";
    const progress = state.progress;
    const done = progress ? (progress.cli?.scannedFiles ?? 0) + (progress.desktop?.scannedFiles ?? 0) : 0;
    const total = progress ? (progress.cli?.totalFiles ?? 0) + (progress.desktop?.totalFiles ?? 0) : 0;
    const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 6;
    return `
      <div class="card">
        <div class="card-head" style="margin-bottom:0">
          <div>
            <h2>${esc(t(state.locale, "scanning"))}</h2>
            <p class="hint">${done}/${total || "?"}</p>
          </div>
        </div>
        <div class="progress"><span style="width:${percent}%"></span></div>
      </div>`;
  }

  function emptyHtml() {
    const roots = state.hello?.roots ?? {};
    const availability = state.hello?.availability ?? {};
    const row = (label, root, available) => `
      <li>
        <span>${esc(label)}</span>
        <code>${esc(root || "?")}</code>
        ${available === false ? `<span class="hint">(${esc(t(state.locale, "missingRoot"))})</span>` : ""}
      </li>`;
    return `
      <section class="card empty">
        <h2>${esc(t(state.locale, "emptyTitle"))}</h2>
        <p>${esc(t(state.locale, "emptyBody"))}</p>
        <p class="hint">${esc(t(state.locale, "rootsTitle"))}</p>
        <ul>
          ${row(t(state.locale, "sourceCli"), roots.cli, availability.cli)}
          ${row(t(state.locale, "sourceDesktop"), roots.desktop, availability.desktop)}
        </ul>
      </section>`;
  }

  function errorHtml() {
    if (!state.error) return "";
    return `
      <div class="banner" role="alert">
        <span>${esc(t(state.locale, "errorTitle"))}: ${esc(state.error)}</span>
        <button class="btn primary" type="button" data-action="refresh">${esc(t(state.locale, "retry"))}</button>
      </div>`;
  }

  function bodyHtml(usage) {
    if (!usage || usage.meta?.records === 0) return emptyHtml();
    return [
      metricsHtml(usage),
      heatmapHtml(usage),
      areaCardHtml(usage),
      barsCardHtml(usage),
      `<div class="grid-2">${sourceRankCardHtml(usage)}${projectRankCardHtml(usage)}</div>`,
      `<div class="grid-2">${donutCardHtml("source", usage)}${donutCardHtml("model", usage)}</div>`,
    ].join("");
  }

  function render() {
    if (typeof document === "undefined") return;
    const container = document.getElementById("app");
    if (!container) return;
    const scroll = window.scrollY;
    if (state.openMenu === "range") {
      state.openMenu = null;
      state.draft = null;
    }

    // Hidden slices are keyed by model and source; one that left the window must
    // not stay hidden when it comes back in a later one.
    if (state.usage) {
      const known = new Set([
        ...donutRows("model", state.usage).map((row) => row.key),
        ...donutRows("source", state.usage).map((row) => row.key),
      ]);
      for (const key of [...state.hidden]) if (!known.has(key)) state.hidden.delete(key);
      // Always leave one visible slice per ring: a new window can shrink a ring to
      // a single row that happens to be the hidden one, and an empty ring reads as
      // "the data is gone" while the metric cards right above still show numbers.
      for (const kind of ["model", "source"]) {
        const rows = donutRows(kind, state.usage);
        if (rows.length === 0) continue;
        if (!rows.every((row) => state.hidden.has(row.key))) continue;
        const top = rows.reduce((best, row) => (row.value > best.value ? row : best));
        state.hidden.delete(top.key);
      }
    }

    container.innerHTML = [
      topbarHtml(),
      errorHtml(),
      progressHtml(),
      bodyHtml(state.usage),
    ].join("");

    paint();
    window.scrollTo(0, scroll);
  }

  /* ----------------------------------------------------------------- paint */

  /**
   * @param {string} html
   * @param {number} clientX
   * @param {number} clientY
   * @param {string} [variant] Extra class for the box, e.g. the wide heat card
   */
  function showTooltip(html, clientX, clientY, variant) {
    const tooltip = document.getElementById("tooltip");
    if (!tooltip) return;
    tooltip.className = variant ? `tooltip tooltip--${variant}` : "tooltip";
    tooltip.innerHTML = html;
    tooltip.hidden = false;
    // Measure after the content is in: the box grows with the path line, so a
    // fixed width guess pushes long paths past the right edge, and an unclamped
    // top draws the box below the last visible pixel of the panel.
    const box = tooltip.getBoundingClientRect();
    const left = Math.max(8, Math.min(clientX + 12, window.innerWidth - box.width - 8));
    const top =
      clientY + 14 + box.height > window.innerHeight - 8
        ? Math.max(8, clientY - box.height - 12)
        : clientY + 14;
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  }

  /**
   * The chart listeners and the ranking handler share one tooltip element. This
   * flag records who owns the visible box, so the ranking can take down only its
   * own: a plain `hideTooltip` on every bubbled mousemove would erase the chart
   * tooltip inside the same event that just drew it.
   */
  let rankTooltipOpen = false;

  function hideTooltip() {
    rankTooltipOpen = false;
    heatTooltipOpen = false;
    const tooltip = document.getElementById("tooltip");
    if (tooltip) tooltip.hidden = true;
  }

  function axisTicks(maxY, pad, plotWidth, plotHeight, format) {
    return [0, 0.25, 0.5, 0.75, 1]
      .map((ratio) => {
        const y = pad.top + plotHeight * ratio;
        return `
          <line class="grid-line" x1="${pad.left}" y1="${y.toFixed(2)}"
            x2="${(pad.left + plotWidth).toFixed(2)}" y2="${y.toFixed(2)}"></line>
          <text class="axis-label" x="${pad.left - 8}" y="${(y + 3).toFixed(2)}" text-anchor="end">${esc(
            format(maxY * (1 - ratio)),
          )}</text>`;
      })
      .join("");
  }

  function bucketLabel(ms, bucket) {
    if (bucket === "hour") return Fmt.formatHourTick(ms);
    return Fmt.formatBucketLabel(ms, bucket === "month" ? "month" : "day");
  }

  function paintArea() {
    const element = document.querySelector('[data-chart="area"]');
    if (!element || !state.usage) return;
    const usage = state.usage;
    const series = usage.series ?? [];
    const width = Math.max(240, Math.floor(element.clientWidth || 560));
    // Height tracks width, so a tall window is not left with a letterboxed chart
    // and a short one does not spend a whole screen scrolling past it.
    const height = Math.round(Math.min(340, Math.max(200, width * 0.42)));
    const pad = { top: 18, right: 64, bottom: 30, left: 64 };
    const plotWidth = Math.max(10, width - pad.left - pad.right);
    const plotHeight = Math.max(10, height - pad.top - pad.bottom);

    /** @type {Record<string, number[]>} */
    const values = {};
    for (const entry of TREND_SERIES) {
      values[entry.key] = series.map((point) => Number(point[entry.key]) || 0);
    }
    const tokenMax = Math.max(
      1,
      ...["input", "output", "cacheRead", "cacheWrite"].flatMap((key) => values[key]),
    );
    const costMax = Math.max(0.01, ...values.cost);
    const maxFor = (key) => (key === "cost" ? costMax : tokenMax);

    const lines = TREND_SERIES.map((entry) => {
      const maxY = maxFor(entry.key);
      const path = smoothPath(values[entry.key], plotWidth, plotHeight, maxY);
      if (!path) return "";
      const fill = entry.fill
        ? `<path class="trend-fill" d="${smoothAreaPath(values[entry.key], plotWidth, plotHeight, maxY)}"
            fill="url(#trend-fade)"></path>`
        : "";
      const dash = entry.dashed ? ` stroke-dasharray="6 5"` : "";
      return `${fill}<path class="trend-line" d="${path}" fill="none" stroke="${TREND_COLORS[entry.key]}"
        stroke-width="2" stroke-linejoin="round" stroke-linecap="round"${dash}></path>`;
    }).join("");

    const grid = [0, 0.25, 0.5, 0.75, 1]
      .map((ratio) => {
        const y = pad.top + plotHeight * (1 - ratio);
        return `<line class="trend-grid" x1="${pad.left}" y1="${y.toFixed(2)}"
            x2="${(pad.left + plotWidth).toFixed(2)}" y2="${y.toFixed(2)}"></line>
          <text class="axis-label" x="${pad.left - 10}" y="${(y + 4).toFixed(2)}" text-anchor="end">${esc(
            kiloLabel(tokenMax * ratio),
          )}</text>
          <text class="axis-label" x="${pad.left + plotWidth + 10}" y="${(y + 4).toFixed(2)}" text-anchor="start">${esc(
            usdLabel(costMax * ratio, costMax),
          )}</text>`;
      })
      .join("");

    const bucket = usage.bucket === "hour" ? "hour" : usage.bucket === "month" ? "month" : "day";
    const xTicks = tickIndices(series.length, 8)
      .map((index) => {
        const x = pad.left + (series.length > 1 ? (index * plotWidth) / (series.length - 1) : plotWidth / 2);
        return `<text class="axis-label" x="${x.toFixed(2)}" y="${height - 8}" text-anchor="middle">${esc(
          bucketLabel(series[index]?.startMs ?? usage.fromMs, bucket),
        )}</text>`;
      })
      .join("");

    const dots = TREND_SERIES.map(
      (entry) =>
        `<circle class="hover-dot" r="3.4" fill="${TREND_COLORS[entry.key]}" stroke="var(--surface)"
          stroke-width="1.5" style="display:none"></circle>`,
    ).join("");

    element.innerHTML = `
      <svg class="chart-svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img"
        aria-label="${esc(t(state.locale, "usageTrend"))}">
        <defs>
          <linearGradient id="trend-fade" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="var(--chart-cache-read)" stop-opacity="0.28"></stop>
            <stop offset="100%" stop-color="var(--chart-cache-read)" stop-opacity="0.02"></stop>
          </linearGradient>
        </defs>
        ${grid}
        <g transform="translate(${pad.left},${pad.top})">${lines}</g>
        ${xTicks}
        <g class="hover-dots">${dots}</g>
        <line class="hover-line" y1="${pad.top}" y2="${pad.top + plotHeight}" style="display:none"></line>
        <rect x="${pad.left}" y="${pad.top}" width="${plotWidth}" height="${plotHeight}"
          fill="transparent" data-role="plot"></rect>
      </svg>`;

    const svg = element.querySelector("svg");
    const hoverLine = /** @type {SVGLineElement | null} */ (svg?.querySelector(".hover-line") ?? null);
    const plot = svg?.querySelector('[data-role="plot"]');
    if (!svg || !plot || !hoverLine) return;
    const dotNodes = Array.from(svg.querySelectorAll(".hover-dot")).map(
      (node) => /** @type {SVGCircleElement} */ (node),
    );

    plot.addEventListener("mousemove", (rawEvent) => {
      const event = /** @type {MouseEvent} */ (rawEvent);
      const rect = svg.getBoundingClientRect();
      const scale = rect.width > 0 ? width / rect.width : 1;
      const offsetX = (event.clientX - rect.left) * scale - pad.left;
      const index = indexAt(offsetX, plotWidth, series.length);
      const point = series[index];
      if (!point) return;
      const x = pad.left + (series.length > 1 ? (index * plotWidth) / (series.length - 1) : plotWidth / 2);
      hoverLine.setAttribute("x1", String(x));
      hoverLine.setAttribute("x2", String(x));
      hoverLine.style.display = "block";
      dotNodes.forEach((dot, layer) => {
        const entry = TREND_SERIES[layer];
        const value = Math.max(0, values[entry.key][index] ?? 0);
        dot.setAttribute("cx", String(x));
        dot.setAttribute("cy", String(pad.top + plotHeight - (value / maxFor(entry.key)) * plotHeight));
        dot.style.display = "block";
      });

      const html = `
        <div class="tip-title">${esc(bucketLabel(point.startMs, bucket))}</div>
        ${TREND_SERIES.map((entry) => {
          const raw = Number(point[entry.key]) || 0;
          const text = entry.key === "cost" ? Fmt.formatUsd(raw) : Fmt.formatTokens(raw);
          return `<div class="tip-row"><span>${esc(t(state.locale, entry.label))}</span><span>${esc(
            text,
          )}</span></div>`;
        }).join("")}`;
      showTooltip(html, event.clientX, event.clientY);
    });
    plot.addEventListener("mouseleave", () => {
      hoverLine.style.display = "none";
      dotNodes.forEach((dot) => {
        dot.style.display = "none";
      });
      hideTooltip();
    });
  }

  function paintBars() {
    const element = document.querySelector('[data-chart="bars"]');
    if (!element || !state.usage) return;
    const usage = state.usage;
    const series = usage.series ?? [];
    const width = Math.max(240, Math.floor(element.clientWidth || 560));
    const height = Math.round(Math.min(230, Math.max(150, width * 0.3)));
    const pad = { top: 14, right: 12, bottom: 24, left: 48 };
    const plotWidth = Math.max(10, width - pad.left - pad.right);
    const plotHeight = Math.max(10, height - pad.top - pad.bottom);
    const metric = state.barMetric;
    const keys = metric === "cost" ? ["cost"] : ["input", "output", "cacheRead", "cacheWrite"];
    const colors = metric === "cost" ? ["var(--accent)"] : SERIES_COLORS;
    const gradients = colors
      .map(
        (color, index) => `<linearGradient id="bar-fill-${index}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${color}" stop-opacity="1"></stop>
          <stop offset="100%" stop-color="${color}" stop-opacity="0.55"></stop>
        </linearGradient>`,
      )
      .join("");
    const bucketTotals = series.map((point) =>
      keys.reduce((sum, key) => sum + (Number(point[key]) || 0), 0),
    );
    const rawMax = bucketTotals.reduce((best, value) => (value > best ? value : best), 0);
    const maxY = rawMax > 0 ? rawMax : 1;
    const activeTotals = bucketTotals.filter((value) => value > 0);
    const average =
      activeTotals.length > 0 ? activeTotals.reduce((sum, value) => sum + value, 0) / activeTotals.length : 0;
    const { slot, width: barWidth } = barLayout(series.length, plotWidth);
    const baseline = pad.top + plotHeight;

    const bars = series
      .map((point, index) => {
        const x = pad.left + slot * index + (slot - barWidth) / 2;
        let cursor = baseline;
        const rects = keys
          .map((key, layerIndex) => {
            const value = Number(point[key]) || 0;
            if (value <= 0) return "";
            const barHeight = (value / maxY) * plotHeight;
            cursor -= barHeight;
            return `<rect x="${x.toFixed(2)}" y="${cursor.toFixed(2)}" width="${barWidth.toFixed(2)}"
              height="${barHeight.toFixed(2)}" fill="url(#bar-fill-${layerIndex})" rx="3"></rect>`;
          })
          .join("");
        return `<g class="bar-bucket" style="--bi:${index}">${rects}</g>`;
      })
      .join("");

    const bucket = usage.bucket === "hour" ? "hour" : usage.bucket === "month" ? "month" : "day";
    const ticks = tickIndices(series.length, 8)
      .map((index) => {
        const x = pad.left + slot * index + slot / 2;
        return `<text class="bars-axis-label" x="${x.toFixed(2)}" y="${height - 6}" text-anchor="middle">${esc(
          bucketLabel(series[index]?.startMs ?? usage.fromMs, bucket),
        )}</text>`;
      })
      .join("");
    const averageY = pad.top + plotHeight - (average / maxY) * plotHeight;
    const averageLine =
      average > 0
        ? `<line class="bars-average" x1="${pad.left}" y1="${averageY.toFixed(2)}"
             x2="${pad.left + plotWidth}" y2="${averageY.toFixed(2)}"></line>
           <text class="bars-average-label" x="${pad.left + plotWidth}" y="${(averageY - 6).toFixed(2)}"
             text-anchor="end">${esc(t(state.locale, "averageLabel"))} ${esc(
               metric === "cost" ? Fmt.formatUsd(average) : Fmt.formatTokens(average),
             )}</text>`
        : "";

    element.innerHTML = `
      <svg class="chart-svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img"
        aria-label="${esc(t(state.locale, "trendTitle", { range: rangeLabel(state.prefs.range) }))}">
        <defs>${gradients}</defs>
        ${axisTicks(maxY, pad, plotWidth, plotHeight, metric === "cost" ? Fmt.formatUsd : Fmt.formatTokens)}
        ${averageLine}
        ${bars}
        ${ticks}
        <rect x="${pad.left}" y="${pad.top}" width="${plotWidth}" height="${plotHeight}"
          fill="transparent" data-role="plot"></rect>
      </svg>`;

    const svg = element.querySelector("svg");
    const plot = svg?.querySelector('[data-role="plot"]');
    if (!svg || !plot) return;
    const bucketNodes = Array.from(svg.querySelectorAll(".bar-bucket")).map(
      (node) => /** @type {SVGGElement} */ (node),
    );

    plot.addEventListener("mousemove", (rawEvent) => {
      const event = /** @type {MouseEvent} */ (rawEvent);
      const rect = svg.getBoundingClientRect();
      const scale = rect.width > 0 ? width / rect.width : 1;
      const offsetX = (event.clientX - rect.left) * scale - pad.left;
      const index = Math.max(0, Math.min(series.length - 1, Math.floor(offsetX / (slot || 1))));
      bucketNodes.forEach((node, position) => {
        node.style.opacity = position === index ? "1" : "0.35";
      });
      const point = series[index];
      if (!point) return;
      const rows =
        metric === "cost"
          ? [[t(state.locale, "costLabel"), Fmt.formatUsd(point.cost)]]
          : SERIES_KEYS.map((key, layer) => [
              t(state.locale, SERIES_LABELS[layer]),
              Fmt.formatTokens(point[key]),
            ]);
      const html = `
        <div class="tip-title">${esc(bucketLabel(point.startMs, bucket))}</div>
        ${rows
          .map(
            ([name, value]) =>
              `<div class="tip-row"><span>${esc(name)}</span><span>${esc(value)}</span></div>`,
          )
          .join("")}`;
      showTooltip(html, event.clientX, event.clientY);
    });
    plot.addEventListener("mouseleave", () => {
      bucketNodes.forEach((node) => {
        node.style.opacity = "1";
      });
      hideTooltip();
    });
  }

  function paintDonut(kind) {
    const element = document.querySelector(`[data-chart="donut-${kind}"]`);
    if (!element || !state.usage) return;
    const rows = donutRows(kind, state.usage).filter((row) => !state.hidden.has(row.key));
    const size = 150;
    const thickness = 18;
    // Room for the hover growth: a 24px stroke needs 12px outside the radius,
    // and the viewBox only has (size / 2 - radius) to spare.
    const radius = (size - thickness - 12) / 2;
    const circumference = 2 * Math.PI * radius;
    const center = size / 2;
    const metric = state.donutMetric[kind] ?? "tokens";
    const format = metric === "cost" ? Fmt.formatUsd : Fmt.formatTokens;
    const total = rows.reduce((sum, row) => sum + Math.max(0, Number(row.value) || 0), 0);
    const geometry = donutGeometry(rows.map((row) => row.value), circumference);

    const arc = (index, stroke, width, className) => `
        <circle class="${className}" data-index="${index}" cx="${center}" cy="${center}" r="${radius}"
          fill="none" stroke="${stroke}" stroke-width="${width}"
          stroke-dasharray="${geometry[index].dasharray}"
          stroke-dashoffset="${geometry[index].dashoffset.toFixed(3)}"
          transform="rotate(-90 ${center} ${center})"></circle>`;
    const slices = rows.map((row, index) => arc(index, row.color, thickness, "donut-slice")).join("");
    // Wider invisible twins give every arc its own hit area, so the gaps stay inert.
    const hits = rows.map((row, index) => arc(index, "transparent", thickness + 12, "donut-hit")).join("");

    element.innerHTML = `
      <svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img"
        aria-label="${esc(t(state.locale, kind === "model" ? "modelDist" : "sourceDist"))}">
        <circle cx="${center}" cy="${center}" r="${radius}" fill="none" stroke="var(--surface-2)"
          stroke-width="${thickness}"></circle>
        ${slices}
        ${hits}
      </svg>
      <div class="donut-center">
        <span>${esc(t(state.locale, metric === "cost" ? "costLabel" : "tokenLabel"))}</span>
        <strong>${esc(format(total))}</strong>
      </div>`;

    const sliceNodes = Array.from(element.querySelectorAll(".donut-slice")).map(
      (node) => /** @type {SVGCircleElement} */ (node),
    );
    element.querySelectorAll(".donut-hit").forEach((hit) => {
      const index = Number(hit.getAttribute("data-index"));
      const row = rows[index];
      const slice = sliceNodes[index];
      if (!row) return;
      const tooltip = () => `
        <div class="tip-title">${esc(row.label)}</div>
        <div class="tip-row"><span>${esc(
          t(state.locale, metric === "cost" ? "costLabel" : "tokenLabel"),
        )}</span><span>${esc(format(row.value))}</span></div>
        <div class="tip-row"><span>${esc(t(state.locale, "share"))}</span><span>${esc(
          Fmt.formatPercent(shareOf(row.value, total)),
        )}</span></div>
        <div class="tip-row"><span>${esc(t(state.locale, "requestsTimes"))}</span><span>${esc(
          Fmt.formatTokensExact(row.requests),
        )}</span></div>`;
      hit.addEventListener("mouseenter", (rawEvent) => {
        slice?.classList.add("is-active");
        // A thicker arc overlaps its neighbours, so lift it above them while hovered.
        if (slice?.parentNode) {
          const firstHit = slice.parentNode.querySelector(".donut-hit");
          if (firstHit && firstHit !== slice) slice.parentNode.insertBefore(slice, firstHit);
        }
        const event = /** @type {MouseEvent} */ (rawEvent);
        showTooltip(tooltip(), event.clientX, event.clientY);
      });
      hit.addEventListener("mousemove", (rawEvent) => {
        const event = /** @type {MouseEvent} */ (rawEvent);
        showTooltip(tooltip(), event.clientX, event.clientY);
      });
      hit.addEventListener("mouseleave", () => {
        slice?.classList.remove("is-active");
        hideTooltip();
      });
      hit.addEventListener("click", () => {
        toggleSlice(kind, row.key);
      });
    });
  }

  function paint() {
    if (!state.usage) return;
    hideTooltip();
    paintArea();
    paintBars();
    paintDonut("source");
    paintDonut("model");
  }

  /** Show one popover menu (or none) without re-rendering the panel. */
  function setMenu(name) {
    state.openMenu = name;
    document.querySelectorAll("[data-menu]").forEach((menu) => {
      (/** @type {HTMLElement} */ (menu)).hidden = menu.getAttribute("data-menu") !== name;
    });
    document.querySelectorAll("[data-menu-toggle]").forEach((button) => {
      button.setAttribute("aria-expanded", String(button.getAttribute("data-menu-toggle") === name));
    });
  }

  /** Flip the selected pill inside one segmented control. */
  function updateTabs(action, attribute, value) {
    document.querySelectorAll(`[data-action="${action}"]`).forEach((button) => {
      button.setAttribute("aria-selected", String(button.getAttribute(attribute) === value));
    });
  }

  function setBarMetric(metric) {
    state.barMetric = metric;
    updateTabs("bar-metric", "data-metric", metric);
    paintBars();
  }

  /**
   * Show/hide switch shared by the ring and its legend.
   *
   * The last visible slice is never hidden: an empty ring offers nothing to
   * click and reads as "the data vanished".
   *
   * @param {string} kind
   * @param {string} key
   */
  function toggleSlice(kind, key) {
    const rows = state.usage ? donutRows(kind, state.usage) : [];
    const visible = rows.filter((row) => !state.hidden.has(row.key));
    if (!state.hidden.has(key) && visible.length <= 1) return;
    if (state.hidden.has(key)) state.hidden.delete(key);
    else state.hidden.add(key);
    hideTooltip();
    refreshDonut(kind);
  }

  /**
   * Rebuild one donut card's chart and legend; the card shell stays untouched.
   * @param {string} kind
   */
  function refreshDonut(kind) {
    const card = document.querySelector(`[data-donut="${kind}"]`);
    if (!card || !state.usage) return;
    const metric = state.donutMetric[kind] ?? "tokens";
    card.querySelectorAll('[data-action="donut-metric"]').forEach((button) => {
      button.setAttribute("aria-selected", String(button.getAttribute("data-metric") === metric));
    });
    const legend = card.querySelector("[data-legend]");
    if (legend) legend.innerHTML = donutLegendHtml(kind, state.usage);
    paintDonut(kind);
  }

  /**
   * @param {string} kind
   * @param {string} metric
   */
  function setDonutMetric(kind, metric) {
    if (metric !== "tokens" && metric !== "cost") return;
    if ((state.donutMetric[kind] ?? "tokens") === metric) return;
    state.donutMetric[kind] = metric;
    refreshDonut(kind);
  }

  /**
   * Apply a palette: one of the five presets or a free `#rrggbb`. Live preview
   * from the color input passes persist = false.
   * @param {string} accent
   * @param {boolean} [persist]
   */
  function setAccent(accent, persist = true) {
    const next = isHexColor(accent) ? accent.toLowerCase() : ACCENTS.includes(accent) ? accent : null;
    if (!next) return;
    // Persist before the early return: a live preview already moved
    // state.prefs, so the commit for an unchanged value is the only write that
    // would otherwise be swallowed — and it must happen exactly once.
    if (persist) void call("usage.prefs.set", { accent: next }).catch(() => {});
    if (next === state.prefs.accent) return;
    state.prefs.accent = next;
    applyAccent();
    document.querySelectorAll(".accent-swatch[data-accent]").forEach((swatch) => {
      swatch.setAttribute("aria-pressed", String(swatch.getAttribute("data-accent") === next));
    });
    const custom = document.querySelector("[data-role='accent-custom']");
    if (custom) custom.setAttribute("aria-pressed", String(isHexColor(next)));
    const ring = /** @type {HTMLElement | null} */ (document.querySelector(".accent-custom-ring"));
    if (ring) ring.style.background = isHexColor(next) ? next : ACCENT_RING;
    const picker = /** @type {HTMLInputElement | null} */ (document.querySelector("[data-role='accent-color']"));
    if (picker) picker.value = isHexColor(next) ? next : ACCENT_COLORS[next] ?? ACCENT_COLORS.blue;
  }

  /* -------------------------------------------------------- range picker ui */

  /** Month the calendar shows, as a local first-of-month stamp. */
  function draftMonth() {
    const anchor = state.calendarMonth || (state.draft ? state.draft.toMs : Date.now());
    return startOfLocalMonth(anchor);
  }

  /** `2026年10月` / `Oct 2026`. */
  function monthTitle(monthMs) {
    const date = new Date(monthMs);
    if (state.locale === "zh") return `${date.getFullYear()}年${date.getMonth() + 1}月`;
    return `${Fmt.formatMonthShort(monthMs, state.locale)} ${date.getFullYear()}`;
  }

  /** Markup of the picker body; rebuilt whenever the draft changes shape. */
  function rangeMenuInner() {
    const draft = state.draft;
    if (!draft) return "";
    const monthMs = draftMonth();
    const fromDay = startOfLocalDay(draft.fromMs);
    const toDay = startOfLocalDay(draft.toMs);
    const todayDay = startOfLocalDay(Date.now());

    const presets = RANGE_PRESETS.map(
      (preset) => `
        <button type="button" data-action="range-preset" data-preset="${preset.id}">${esc(
          t(state.locale, preset.label),
        )}</button>`,
    ).join("");

    const weekdays = Array.from({ length: 7 }, (_, index) => Fmt.formatWeekdayNarrow(index, state.locale))
      .map((name) => `<span>${esc(name)}</span>`)
      .join("");

    const cells = monthGrid(monthMs)
      .map((cell) => {
        const classes = ["cal-day"];
        if (!cell.inMonth) classes.push("is-out");
        if (cell.dateMs > fromDay && cell.dateMs < toDay) classes.push("in-range");
        if (cell.dateMs === fromDay || cell.dateMs === toDay) classes.push("is-selected");
        if (cell.dateMs === todayDay) classes.push("is-today");
        return `<button type="button" class="${classes.join(" ")}" data-action="cal-day"
          data-day="${cell.dateMs}">${new Date(cell.dateMs).getDate()}</button>`;
      })
      .join("");

    return `
      <div class="range-presets">${presets}</div>
      <div class="range-body">
        <div class="range-fields">
          <label class="range-field${draft.field === "from" ? " is-active" : ""}" data-field="from">
            <span class="range-field-label">${esc(t(state.locale, "startTime"))}</span>
            <input type="datetime-local" data-role="from" value="${toLocalInput(draft.fromMs)}" />
          </label>
          <label class="range-field${draft.field === "to" ? " is-active" : ""}" data-field="to">
            <span class="range-field-label">${esc(t(state.locale, "endTime"))}</span>
            <input type="datetime-local" data-role="to" value="${toLocalInput(draft.toMs)}" ${
              draft.follow ? "disabled" : ""
            } />
          </label>
          <label class="range-follow">
            <input type="checkbox" data-role="follow" ${draft.follow ? "checked" : ""} />
            <span>${esc(t(state.locale, "followNow"))}</span>
          </label>
        </div>
        <div class="range-cal">
          <div class="cal-head">
            <button type="button" class="cal-nav" data-action="cal-prev"
              aria-label="${esc(t(state.locale, "prevMonth"))}">‹</button>
            <span class="cal-title">${esc(monthTitle(monthMs))}</span>
            <button type="button" class="cal-nav" data-action="cal-next"
              aria-label="${esc(t(state.locale, "nextMonth"))}">›</button>
          </div>
          <div class="cal-weekdays">${weekdays}</div>
          <div class="cal-grid">${cells}</div>
        </div>
      </div>
      <div class="range-foot">
        <button type="button" class="btn" data-action="range-cancel">${esc(t(state.locale, "cancel"))}</button>
        <button type="button" class="btn primary" data-action="range-confirm" ${
          draft.toMs > draft.fromMs ? "" : "disabled"
        }>${esc(t(state.locale, "confirm"))}</button>
      </div>`;
  }

  function refreshRangeMenu() {
    const menu = document.querySelector('[data-menu="range"]');
    if (menu && state.draft) menu.innerHTML = rangeMenuInner();
  }

  /** Open the picker seeded with the window currently on screen. */
  function openRangeMenu() {
    const usage = state.usage;
    const now = Date.now();
    const fromMs = Number(usage?.fromMs) > 0 ? usage.fromMs : startOfLocalDay(shiftDays(now, -6));
    const rawTo = Number(usage?.toMs) > 0 ? usage.toMs : now;
    state.draft = { fromMs, toMs: Math.max(rawTo, fromMs + 60000), follow: false, field: "from" };
    state.calendarMonth = startOfLocalMonth(state.draft.toMs);
    refreshRangeMenu();
    setMenu("range");
  }

  /** Re-mark the calendar and the field ring without touching the inputs. */
  function paintRangeSelection() {
    const draft = state.draft;
    if (!draft) return;
    const fromDay = startOfLocalDay(draft.fromMs);
    const toDay = startOfLocalDay(draft.toMs);
    document.querySelectorAll("[data-action='cal-day']").forEach((button) => {
      const dayMs = Number(button.getAttribute("data-day"));
      const classes = (/** @type {HTMLElement} */ (button)).classList;
      classes.toggle("is-selected", dayMs === fromDay || dayMs === toDay);
      classes.toggle("in-range", dayMs > fromDay && dayMs < toDay);
    });
    document.querySelectorAll(".range-field").forEach((field) => {
      (/** @type {HTMLElement} */ (field)).classList.toggle(
        "is-active",
        field.getAttribute("data-field") === draft.field,
      );
    });
    const confirm = /** @type {HTMLButtonElement | null} */ (
      document.querySelector("[data-action='range-confirm']")
    );
    if (confirm) confirm.disabled = !(draft.toMs > draft.fromMs);
    const follow = /** @type {HTMLInputElement | null} */ (document.querySelector("[data-role='follow']"));
    if (follow) follow.checked = Boolean(draft.follow);
    const end = /** @type {HTMLInputElement | null} */ (document.querySelector("[data-role='to']"));
    if (end) end.disabled = Boolean(draft.follow);
  }

  /** First calendar click sets the start, the second sets the end and applies. */
  function pickDay(dayMs) {
    const draft = state.draft;
    if (!draft || !Number.isFinite(dayMs)) return;
    if (draft.field === "to") {
      draft.toMs = combineDayWithTime(dayMs, draft.toMs);
      draft.follow = false;
      confirmRange();
      return;
    }
    draft.fromMs = combineDayWithTime(dayMs, draft.fromMs);
    draft.field = "to";
    if (draft.fromMs >= draft.toMs) draft.toMs = endOfLocalDay(draft.fromMs);
    if (startOfLocalMonth(dayMs) !== draftMonth()) state.calendarMonth = startOfLocalMonth(dayMs);
    refreshRangeMenu();
  }

  function shiftCalendar(delta) {
    const current = new Date(draftMonth());
    state.calendarMonth = new Date(current.getFullYear(), current.getMonth() + delta, 1).getTime();
    refreshRangeMenu();
  }

  function applyPreset(id) {
    const next = presetWindow(id, Date.now());
    state.draft = null;
    setMenu(null);
    if (next.range === "all") void setPrefs({ range: "all", fromMs: 0, toMs: 0 });
    else void setPrefs({ range: "custom", fromMs: next.fromMs, toMs: next.toMs });
  }

  function confirmRange() {
    const draft = state.draft;
    if (!draft) return;
    const toMs = draft.follow ? Date.now() : draft.toMs;
    if (!(toMs > draft.fromMs)) return;
    state.draft = null;
    setMenu(null);
    void setPrefs({ range: "custom", fromMs: draft.fromMs, toMs });
  }

  function setTheme(theme) {
    if (!THEMES.includes(theme) || theme === state.prefs.theme) return;
    state.prefs.theme = theme;
    applyAppearance(null);
    document.querySelectorAll("[data-action='theme']").forEach((button) => {
      button.setAttribute("aria-checked", String(button.getAttribute("data-theme") === theme));
    });
    const toggle = document.querySelector("[data-menu-toggle='theme']");
    if (toggle) toggle.innerHTML = THEME_ICONS[theme] ?? ICON_MONITOR;
    void call("usage.prefs.set", { theme }).catch(() => {});
  }

  /* ---------------------------------------------------------------- events */

  /**
   * @param {Event} rawEvent
   */
  /**
   * Ranking rows answer on hover: the row's own numbers in the shared tooltip.
   * Clicking one focuses it and dims its siblings (handled in onClick).
   * @param {Event} rawEvent
   */
  function onRankHover(rawEvent) {
    const target = rawEvent.target;
    if (!(target instanceof Element)) return;
    const list = target.closest(".rank-list");
    if (!list) {
      if (rankTooltipOpen) hideTooltip();
      return;
    }
    const row = target.closest(".rank-row");
    if (!row) {
      if (rankTooltipOpen) hideTooltip();
      return;
    }
    const event = /** @type {MouseEvent} */ (rawEvent);
    const read = (name) => row.getAttribute(`data-${name}`) ?? "";
    const path = read("path");
    showTooltip(
      `
        <div class="tip-title">${esc(read("name"))}</div>
        ${path ? `<div class="tip-path">${esc(path)}</div>` : ""}
        <div class="tip-row"><span>${esc(t(state.locale, "tokenLabel"))}</span><span>${esc(read("tokens"))}</span></div>
        <div class="tip-row"><span>${esc(t(state.locale, "requestsTimes"))}</span><span>${esc(
          read("requests"),
        )}</span></div>
        <div class="tip-row"><span>${esc(t(state.locale, "costLabel"))}</span><span>${esc(read("cost"))}</span></div>
        <div class="tip-row"><span>${esc(t(state.locale, "share"))}</span><span>${esc(read("share"))}</span></div>`,
      event.clientX,
      event.clientY,
    );
    rankTooltipOpen = true;
  }

  function onClick(rawEvent) {
    const event = /** @type {MouseEvent} */ (rawEvent);
    const target = event.target instanceof Element ? event.target.closest("[data-action]") : null;
    if (target) {
      const action = target.getAttribute("data-action");
      if (action === "rank-row") {
        const list = target.closest(".rank-list");
        if (list) {
          const focused = target.classList.contains("is-focused");
          list.querySelectorAll(".rank-row").forEach((node) => {
            node.classList.toggle("is-focused", !focused && node === target);
            node.classList.toggle("is-dimmed", !focused && node !== target);
          });
        }
        return;
      }
      if (action === "refresh") {
        void runScan();
        return;
      }
      if (action === "range") {
        const range = target.getAttribute("data-range");
        if (range && range !== state.prefs.range) void setPrefs({ range });
        return;
      }
      if (action === "toggle-menu") {
        const name = target.getAttribute("data-menu-toggle");
        if (name === "range") openRangeMenu();
        else setMenu(state.openMenu === name ? null : name);
        return;
      }
      if (action === "range-preset") {
        const preset = target.getAttribute("data-preset");
        if (preset) applyPreset(preset);
        return;
      }
      if (action === "cal-prev" || action === "cal-next") {
        shiftCalendar(action === "cal-prev" ? -1 : 1);
        return;
      }
      if (action === "cal-day") {
        pickDay(Number(target.getAttribute("data-day")));
        return;
      }
      if (action === "range-cancel") {
        state.draft = null;
        setMenu(null);
        return;
      }
      if (action === "range-confirm") {
        confirmRange();
        return;
      }
      if (action === "theme") {
        const theme = target.getAttribute("data-theme");
        setMenu(null);
        if (theme) setTheme(theme);
        return;
      }
      if (action === "accent") {
        const accent = target.getAttribute("data-accent");
        setMenu(null);
        if (accent) setAccent(accent);
        return;
      }
      if (action === "clear-sources") {
        setMenu(null);
        void setPrefs({ sources: [] });
        return;
      }
      if (action === "bar-metric") {
        const metric = target.getAttribute("data-metric");
        if (metric === "tokens" || metric === "cost") setBarMetric(metric);
        return;
      }
      if (action === "donut-metric") {
        const metric = target.getAttribute("data-metric");
        const kind = target.getAttribute("data-kind");
        if (kind === "source" || kind === "model") setDonutMetric(kind, metric);
        return;
      }
      if (action === "toggle-slice") {
        const key = target.getAttribute("data-key");
        if (key) toggleSlice(key.startsWith("model|") ? "model" : "source", key);
        return;
      }
      if (action === "heat-day") {
        selectHeatDay(Number(target.getAttribute("data-day")));
        return;
      }
    }

    // Clicking anywhere outside an open menu closes it.
    if (state.openMenu && !clickInsideMenu(event)) setMenu(null);
  }

  /**
   * True when the click started inside a popover, including clicks whose target
   * was replaced by a menu rebuild during the same dispatch.
   * @param {Event} event
   */
  function clickInsideMenu(event) {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    if (path.some((node) => node instanceof Element && node.classList.contains("menu-host"))) return true;
    const target = event.target;
    return target instanceof Element && (target.closest(".menu-host") !== null || !target.isConnected);
  }

  /**
   * @param {Event} rawEvent
   */
  function onChange(rawEvent) {
    const event = /** @type {Event} */ (rawEvent);
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;

    const role = target.getAttribute("data-role");
    if (role === "accent-color") {
      setAccent(target.value);
      return;
    }
    if (role === "follow") {
      if (!state.draft) return;
      state.draft.follow = target.checked;
      if (state.draft.follow) state.draft.toMs = Date.now();
      refreshRangeMenu();
      return;
    }
    if (role === "from" || role === "to") {
      if (!state.draft) return;
      const value = fromLocalInput(target.value);
      if (!Number.isFinite(value)) return;
      state.draft.field = role;
      if (role === "from") {
        state.draft.fromMs = value;
        if (state.draft.fromMs >= state.draft.toMs) state.draft.toMs = endOfLocalDay(value);
      } else {
        state.draft.toMs = value;
        state.draft.follow = false;
      }
      const endInput = /** @type {HTMLInputElement | null} */ (document.querySelector("[data-role='to']"));
      if (endInput) endInput.value = toLocalInput(state.draft.toMs);
      paintRangeSelection();
      return;
    }

    if (target.type !== "checkbox") return;
    const source = target.getAttribute("data-source");
    if (!source) return;
    const next = target.checked
      ? [...state.prefs.sources, source]
      : state.prefs.sources.filter((current) => current !== source);
    void setPrefs({ sources: next });
  }

  /**
   * Typing into one endpoint makes it the field the calendar edits.
   * @param {Event} rawEvent
   */
  function onFocusIn(rawEvent) {
    const target = rawEvent.target;
    if (!(target instanceof HTMLInputElement) || !state.draft) return;
    const role = target.getAttribute("data-role");
    if (role !== "from" && role !== "to") return;
    state.draft.field = role;
    paintRangeSelection();
  }

  /**
   * Live preview while the native color picker is being dragged.
   * @param {Event} rawEvent
   */
  function onInput(rawEvent) {
    const target = rawEvent.target;
    if (!(target instanceof HTMLInputElement) || target.getAttribute("data-role") !== "accent-color") return;
    setAccent(target.value, false);
  }

  /* ------------------------------------------------------------------ boot */

  async function boot() {
    if (booted || typeof document === "undefined") return;
    booted = true;
    applyAppearance(null);

    const container = document.getElementById("app");
    container?.addEventListener("click", onClick);
    container?.addEventListener("mousemove", onRankHover);
    container?.addEventListener("mouseover", onHeatHover);
    container?.addEventListener("mouseleave", hideTooltip);
    container?.addEventListener("change", onChange);
    container?.addEventListener("focusin", onFocusIn);
    container?.addEventListener("input", onInput);
    document.addEventListener("keydown", (event) => {
      // Escape is the keyboard exit every popover owes its user; without it the
      // only way out of a menu is a click somewhere else.
      if (event.key !== "Escape" || !state.openMenu) return;
      const name = state.openMenu;
      if (name === "range") state.draft = null;
      setMenu(null);
      const toggle = document.querySelector(`[data-menu-toggle="${name}"]`);
      if (toggle instanceof HTMLElement) toggle.focus();
    });
    document.addEventListener("click", (event) => {
      if (!state.openMenu) return;
      if (clickInsideMenu(event)) return;
      setMenu(null);
    });
    window.addEventListener("resize", () => {
      window.clearTimeout((/** @type {any} */ (boot)).resizeTimer);
      (/** @type {any} */ (boot)).resizeTimer = window.setTimeout(() => paint(), 150);
    });

    const current = bridge();
    if (current && typeof current.on === "function") {
      try {
        current.on("appearance:changed", (appearance) => {
          applyAppearance(appearance);
          render();
        });
      } catch {
        // Host events are optional.
      }
    }
    call("app.getAppearance")
      .then((appearance) => {
        applyAppearance(appearance);
        render();
      })
      .catch(() => {});

    try {
      const hello = await call("usage.hello");
      state.hello = hello;
      if (hello?.prefs) {
        state.prefs = {
          range: hello.prefs.range ?? "7d",
          sources: hello.prefs.sources ?? [],
          accent: hello.prefs.accent ?? "blue",
          theme: hello.prefs.theme ?? "system",
          fromMs: hello.prefs.fromMs ?? 0,
          toMs: hello.prefs.toMs ?? 0,
        };
        applyAccent();
        applyAppearance(null);
      }
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
      render();
      return;
    }

    render();
    await runScan();
  }

  /* ---------------------------------------------------------------- exports */

  const API = {
    shareOf,
    isHexColor,
    linePath,
    areaPath,
    smoothPath,
    smoothAreaPath,
    indexAt,
    donutGeometry,
    heatLevels,
    tickIndices,
    barLayout,
    monthStarts,
    monthGrid,
    toLocalInput,
    fromLocalInput,
    presetWindow,
    customRangeText,
    startOfLocalDay,
    endOfLocalDay,
    shiftDays,
    combineDayWithTime,
    esc,
    t,
    assetBaseFrom,
    boot,
    render,
    state,
    sourceRankCardHtml,
    projectRankCardHtml,
    metricsHtml,
    heatTipHtml,
    bodyHtml,
  };
  if (typeof module === "object" && module.exports) return API;

  (/** @type {any} */ (globalThis)).UsagePanel = API;
  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => void boot());
    } else {
      void boot();
    }
  }
  return API;
});
