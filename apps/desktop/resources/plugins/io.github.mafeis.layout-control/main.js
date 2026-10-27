/**
 * 布局控制 — 主进程入口。
 *
 * 这里只做一件事：把布局配置（宽度 / 留白 / 开关）存进插件自己的设置里，
 * 并回答渲染器扩展的两个调用。真正改界面的事在 renderer/index.mjs 里做，
 * 因为只有渲染器那一侧能碰到 PI-Desktop 自己的文档。
 */

const DEFAULT_CONFIG = { width: 1200, gutter: 24, enabled: true, followSidebar: true, showTrigger: true };
const MIN_WIDTH = 640;
const MAX_WIDTH = 2400;
const MIN_GUTTER = 8;
const MAX_GUTTER = 56;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** 满宽用 0 表示；其它一律夹到可用区间。 */
function normalizeWidth(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_CONFIG.width;
  if (n <= 0) return 0;
  return Math.round(clamp(n, MIN_WIDTH, MAX_WIDTH));
}

function normalizeGutter(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_CONFIG.gutter;
  return Math.round(clamp(n, MIN_GUTTER, MAX_GUTTER));
}

/** 设置页存回来的可能是字符串，别把 "false" 当成 true。 */
function normalizeEnabled(value, fallback = DEFAULT_CONFIG.enabled) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "string") return value !== "false" && value !== "0" && value !== "";
  return Boolean(value);
}

function normalize(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  return {
    width: normalizeWidth(src.width ?? DEFAULT_CONFIG.width),
    gutter: normalizeGutter(src.gutter ?? DEFAULT_CONFIG.gutter),
    enabled: normalizeEnabled(src.enabled),
    followSidebar: normalizeEnabled(src.followSidebar, DEFAULT_CONFIG.followSidebar),
    showTrigger: normalizeEnabled(src.showTrigger, DEFAULT_CONFIG.showTrigger),
  };
}

async function readConfig() {
  try {
    return normalize(await pi.plugin.getSettings());
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

async function onLoad() {
  // 读一次，让设置在插件加载时就定型；读失败不影响插件本身。
  await readConfig();
}

async function onRendererCall(method, args) {
  if (method === "getLayoutConfig") return readConfig();
  if (method === "setLayoutConfig") {
    const next = normalize(args);
    await pi.plugin.setSettings(next);
    return next;
  }
  const error = new Error(`未知方法：${method}`);
  error.code = "UNSUPPORTED";
  throw error;
}

module.exports = { onLoad, onRendererCall };
