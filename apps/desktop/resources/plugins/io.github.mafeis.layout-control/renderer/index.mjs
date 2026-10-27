/**
 * 布局控制 — 渲染器扩展（跑在 PI-Desktop 自己的窗口里）。
 *
 * 会话内容的宽度在 PI-Desktop 里由三个 CSS 变量决定，默认都是 760px：
 *   --chat-content-max-width   正文栏（.thread-content）与转场占位
 *   --chat-composer-max-width  输入框栈（.composer-stack）
 *   --chat-prose-max-width     单条消息 / 卡片（.message-bubble 等）
 * 宿主自己会把这三个变量以「行内样式」写到 .chat-surface 上（拖两边边缘调宽时也是），
 * 而行内样式盖不过带 !important 的样式表规则 —— 插件就是靠这一条把宽度接管过来的：
 * 值放到 html 的 --pio-w 上，规则只做 var() 转发，于是改宽度 = 改一个变量，不重新注入样式。
 *
 * 注意：布局覆盖走的是自建的 <style>，不是 pi.ui.injectStyle —— 后者会把规则包进
 * `@scope ([data-pi-plugin="<id>"])`，只能命中插件自己的子树，够不到应用的 DOM。
 * 插件自己的按钮 / 面板仍然走 injectStyle（随卸载自动回收）。
 *
 * 拖动会话边缘时宿主会给 <html> 打上 data-chat-resizing，规则在那期间让位，
 * 拖动结束后把拖出来的宽度接过来保存，所以原生拖动依然是可用的。
 */
import React from "react";

const DEFAULT_CONFIG = { width: 1200, gutter: 24, enabled: true, followSidebar: true, showTrigger: true };

const MIN_WIDTH = 640;
const MAX_WIDTH = 2400;
const MIN_GUTTER = 8;
const MAX_GUTTER = 56;
const WIDTH_STEP = 20;
const GUTTER_STEP = 4;

/** 侧栏收起后留下的窄轨道宽度；收起时腾出来的空间就按「侧栏宽 - 轨道宽」算。 */
const SIDEBAR_RAIL_WIDTH = 56;
const SIDEBAR_DEFAULT_WIDTH = 276;

/** 设置页改动的回读间隔（毫秒）；窗口重新获得焦点时还会额外立刻回读一次。 */
const SETTINGS_POLL_MS = 1500;

/** 界面文案：跟随应用语言，两边的占位符必须一致（发布前的 i18n gate 会核对）。 */
const COPY = {
  en: {
    presetDefault: "Default",
    presetComfortable: "Comfortable",
    presetWide: "Wide",
    presetExtraWide: "Extra wide",
    presetFull: "Full width",
    popoverTitle: "Conversation layout",
    ariaTrigger: "Conversation layout width",
    ariaWidth: "Conversation content width",
    ariaGutter: "Content side gutter",
    close: "Close",
    rowWidth: "Content width",
    rowGutter: "Side gutter",
    rowEnabled: "Enable layout override",
    rowFollow: "Widen when the sidebar is collapsed",
    hintDrag: "Dragging the conversation edges keeps the width you drag out.",
    fullWidth: "Full width",
    off: "off",
    bonus: " · sidebar collapsed +{n}px",
    measured: "Measured content width {n}px",
    noTranscript: "No conversation is open right now",
    disabled: "Off — using the app's own width",
    tooltipBonus: "Conversation layout: sidebar collapsed, +{n}px automatically",
    tooltip: "Conversation layout (width and gutters)",
  },
  "zh-CN": {
    presetDefault: "默认",
    presetComfortable: "舒适",
    presetWide: "宽",
    presetExtraWide: "超宽",
    presetFull: "满宽",
    popoverTitle: "会话布局",
    ariaTrigger: "会话布局宽度",
    ariaWidth: "会话内容宽度",
    ariaGutter: "内容左右留白",
    close: "关闭",
    rowWidth: "内容宽度",
    rowGutter: "左右留白",
    rowEnabled: "启用布局覆盖",
    rowFollow: "侧栏收起时自动加宽",
    hintDrag: "拖动会话两侧的边缘，会沿用拖出来的宽度。",
    fullWidth: "满宽",
    off: "关",
    bonus: " · 侧栏收起 +{n}px",
    measured: "正文栏实际宽度 {n}px",
    noTranscript: "当前没有打开的正文",
    disabled: "已关闭，使用应用自身的宽度",
    tooltipBonus: "会话布局：侧栏已收起，自动 +{n}px",
    tooltip: "会话布局（宽度 / 留白）",
  },
};

let copyTable = null;

/** 应用语言：<html lang> → data-language → 系统语言；中文一律走 zh-CN。 */
function detectLocale() {
  const root = document.documentElement;
  for (const hint of [root.getAttribute("lang"), root.dataset.language, navigator.language]) {
    const value = String(hint || "").trim().toLowerCase();
    if (value) return value.startsWith("zh") ? "zh-CN" : "en";
  }
  return "en";
}

function t(key, vars) {
  copyTable ??= COPY[detectLocale()] ?? COPY.en;
  const text = copyTable[key] ?? COPY.en[key] ?? key;
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match));
}
/** width: 0 表示满宽（跟随机栏宽度）。 */
const PRESETS = [
  { labelKey: "presetDefault", width: 760 },
  { labelKey: "presetComfortable", width: 960 },
  { labelKey: "presetWide", width: 1200 },
  { labelKey: "presetExtraWide", width: 1440 },
  { labelKey: "presetFull", width: 0 },
];

const STYLE_LAYOUT = `
:root { --pio-w: 760px; --pio-g: 32px; }

/* 宽度接管：宿主写在 .chat-surface 上的行内变量是普通声明，!important 的表规则赢得下来。 */
html[data-pio-layout="on"]:not([data-chat-resizing]) :is(.chat-surface, [data-pio-width-host]) {
  --chat-content-max-width: var(--pio-w, 760px) !important;
  --chat-composer-max-width: var(--pio-w, 760px) !important;
  --chat-prose-max-width: var(--pio-w, 760px) !important;
}

/* 左右留白：只压 .thread-content 的内边距，不动上下与底部给输入框让位的算法。 */
html[data-pio-layout="on"] :is(.chat-surface, [data-pio-width-host]) .thread-content {
  padding-inline: var(--pio-g, 32px) !important;
}
`;

const STYLE_CHROME = `
.pio-trigger {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  padding: 0;
  border: 0;
  border-radius: var(--radius-md, 8px);
  background: transparent;
  color: var(--ds-text-secondary, inherit);
  font: inherit;
  line-height: 1;
  cursor: pointer;
  -webkit-app-region: no-drag;
}
.pio-trigger:hover { background: var(--ds-tile, var(--ds-raised, rgba(127,127,127,.14))); color: var(--ds-text-primary, inherit); }
.pio-trigger:focus-visible { outline: 2px solid var(--ds-accent, currentColor); outline-offset: 2px; }
.pio-trigger[data-on="false"] { opacity: .45; }
.pio-trigger-icon { display: block; width: 18px; height: 18px; opacity: .9; }

.pio-pop {
  position: fixed;
  z-index: 1;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 272px;
  padding: 12px;
  border: 1px solid var(--ds-border-default, var(--ds-border-subtle, rgba(127,127,127,.25)));
  border-radius: var(--radius-lg, 12px);
  background-color: var(--pio-pop-solid, #1c1c1e);
  background-image: linear-gradient(var(--ds-bg-elevated-primary, transparent), var(--ds-bg-elevated-primary, transparent));
  backdrop-filter: none;
  color: var(--ds-text-primary, inherit);
  box-shadow: var(--ds-shadow-composer, 0 8px 30px rgba(0,0,0,.28));
  font-size: var(--text-sm, 12px);
  line-height: 1.45;
  -webkit-app-region: no-drag;
}
.pio-pop-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.pio-pop-title { font-size: var(--text-md, 13px); font-weight: 600; }
.pio-pop-close {
  display: inline-flex; align-items: center; justify-content: center;
  width: 22px; height: 22px; padding: 0;
  border: 0; border-radius: var(--radius-sm, 6px);
  background: transparent; color: var(--ds-text-muted, inherit);
  font: inherit; cursor: pointer;
}
.pio-pop-close:hover { background: var(--ds-tile, rgba(127,127,127,.16)); color: var(--ds-text-primary, inherit); }
.pio-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.pio-row-label { color: var(--ds-text-secondary, inherit); }
.pio-num { color: var(--ds-text-primary, inherit); font-variant-numeric: tabular-nums; font-weight: 600; }
.pio-presets { display: flex; flex-wrap: wrap; gap: 6px; }
.pio-preset {
  padding: 4px 9px;
  border: 1px solid var(--ds-border-subtle, rgba(127,127,127,.25));
  border-radius: var(--radius-full, 999px);
  background: transparent;
  color: var(--ds-text-secondary, inherit);
  font: inherit; cursor: pointer;
}
.pio-preset:hover { background: var(--ds-tile, rgba(127,127,127,.14)); color: var(--ds-text-primary, inherit); }
.pio-preset[data-active="true"] {
  border-color: color-mix(in oklab, var(--ds-accent, #4c8dff) 55%, transparent);
  background: color-mix(in oklab, var(--ds-accent, #4c8dff) 16%, transparent);
  color: var(--ds-text-primary, inherit);
}
.pio-slider { width: 100%; accent-color: var(--ds-accent, #4c8dff); cursor: pointer; }
.pio-slider:disabled { cursor: default; opacity: .45; }
.pio-check { accent-color: var(--ds-accent, #4c8dff); cursor: pointer; }
.pio-row-switch { cursor: pointer; }
.pio-measure, .pio-hint { margin: 0; color: var(--ds-text-muted, inherit); font-size: var(--text-xs, 11px); }
`;

let api = null;
let config = { ...DEFAULT_CONFIG };

let triggerNode = null;
let forceRender = () => {};

let layer = null;
let layerRoot = null;
let anchorNode = null;
let parts = {};
let saveTimer = 0;
let settingsTimer = 0;
let settingsSignature = "";
let dragObserver = null;
let layoutStyleNode = null;

/* ---------- 配置 ---------- */

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

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

function widthToCss(width) {
  return width === 0 ? "100%" : `${width}px`;
}

/* ---------- 侧栏联动 ---------- */

/** 侧栏收起时 .app-shell 会带上 sidebar-collapsed；没这个类就退回看收起后留下的轨道条。 */
function isSidebarCollapsed() {
  const shell = document.querySelector(".app-shell");
  if (shell) return shell.classList.contains("sidebar-collapsed");
  return Boolean(document.querySelector(".sidebar-rail"));
}

/** 侧栏收起时腾出来的空间 = 侧栏宽 - 收起后的轨道宽。 */
function sidebarBonus() {
  if (!config.enabled || !config.followSidebar || config.width === 0) return 0;
  if (!isSidebarCollapsed()) return 0;
  const inline = document.querySelector(".app-shell")?.style.getPropertyValue("--ds-sidebar-width")?.trim();
  const measured = inline && inline.endsWith("px") ? Number.parseFloat(inline) : NaN;
  const sidebarWidth = Number.isFinite(measured) ? measured : SIDEBAR_DEFAULT_WIDTH;
  return Math.max(0, Math.round(sidebarWidth - SIDEBAR_RAIL_WIDTH));
}

/** 真正生效的宽度：满宽（0）原样，否则基础宽度 + 侧栏腾出来的空间。 */
function effectiveWidth() {
  if (config.width === 0) return 0;
  return Math.round(clamp(config.width + sidebarBonus(), MIN_WIDTH, MAX_WIDTH));
}

/* ---------- 应用 ---------- */

/** 宿主真正写入行内变量的元素：宽度手柄的父节点就是 .chat-surface。 */
function findWidthHost() {
  const handles = document.querySelector(".chat-width-handles");
  if (handles?.parentElement) return handles.parentElement;
  return document.querySelector(".chat-surface") ?? document.querySelector(".main-pane");
}

/** 给宽度宿主打个标记，样式表里的 [data-pio-width-host] 是 .chat-surface 的后备选择器。 */
function markWidthHost() {
  const host = findWidthHost();
  if (host && !host.hasAttribute("data-pio-width-host")) host.setAttribute("data-pio-width-host", "");
  const surface = document.querySelector(".chat-surface");
  if (surface && !surface.hasAttribute("data-pio-width-host")) surface.setAttribute("data-pio-width-host", "");
}

function applyConfig() {
  const root = document.documentElement;
  if (config.enabled) {
    root.style.setProperty("--pio-w", widthToCss(effectiveWidth()));
    root.style.setProperty("--pio-g", `${config.gutter}px`);
    root.setAttribute("data-pio-layout", "on");
    markWidthHost();
  } else {
    root.removeAttribute("data-pio-layout");
  }
  if (triggerNode) triggerNode.dataset.on = String(config.enabled);
}

function setConfig(patch) {
  config = normalize({ ...config, ...patch });
  applyConfig();
  if (triggerNode) triggerNode.dataset.on = String(config.enabled);
  // 快捷图标被关掉后，弹出的面板就没了锚点，顺手收起来。
  if (!config.showTrigger && layer) closePopover();
  forceRender();
  refreshPopover();
  scheduleSave();
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = 0;
    const payload = { ...config };
    settingsSignature = signatureOf(payload);
    api
      ?.dispatch("plugin.call", { method: "setLayoutConfig", args: payload })
      .catch((error) => console.warn("[layout-control] failed to save the layout config", error));
  }, 250);
}

function signatureOf(value) {
  return JSON.stringify(normalize(value));
}

/**
 * 设置页改的设置在渲染器这一侧收不到事件（pi.plugin 在宿主里只有 id / version），
 * 所以只能自己回读：低频轮询 + 窗口重新获得焦点时立刻读一次。
 * 只有内容真的变了才应用，避免把面板里的滑杆状态抖掉。
 */
async function pullSettings() {
  if (!api) return;
  let next;
  try {
    next = normalize(await api.dispatch("plugin.call", { method: "getLayoutConfig" }));
  } catch {
    return;
  }
  const signature = signatureOf(next);
  if (signature === settingsSignature) return;
  settingsSignature = signature;
  config = next;
  lastSidebarCollapsed = isSidebarCollapsed();
  applyConfig();
  if (!config.showTrigger && layer) closePopover();
  if (triggerNode) triggerNode.title = titleOf();
  forceRender();
  refreshPopover();
}

function startSettingsWatch() {
  stopSettingsWatch();
  settingsTimer = window.setInterval(pullSettings, SETTINGS_POLL_MS);
  window.addEventListener("focus", pullSettings);
  document.addEventListener("visibilitychange", pullSettings);
  // 焦点回来或页面重新可见时立刻回读一次，轮询间隔就不用压得太短。
}

function stopSettingsWatch() {
  if (settingsTimer) clearInterval(settingsTimer);
  settingsTimer = 0;
  window.removeEventListener("focus", pullSettings);
  document.removeEventListener("visibilitychange", pullSettings);
}

/* ---------- 原生拖动：拖完把宽度接过来 ---------- */

function readInlineWidth() {
  // .chat-surface 才是宿主写行内变量的地方；findWidthHost 只是兜底，两条都试一遍。
  for (const host of [document.querySelector(".chat-surface"), findWidthHost()]) {
    const raw = host?.style?.getPropertyValue("--chat-content-max-width")?.trim();
    if (!raw || !raw.endsWith("px")) continue;
    const px = Number.parseFloat(raw);
    if (Number.isFinite(px)) return px;
  }
  return null;
}

function onDragAttributeChanged() {
  // 拖动中样式规则已经让位；拖动结束（属性被删掉）时采用拖出来的宽度。
  if (document.documentElement.hasAttribute("data-chat-resizing")) return;
  const px = readInlineWidth();
  if (px === null) return;
  // 拖出来的宽度是「含侧栏加成」的实测值，换算回基础宽度再存。
  const next = normalizeWidth(px - sidebarBonus());
  if (next === config.width) return;
  setConfig({ width: next });
}

/* ---------- 面板 ---------- */

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = String(value);
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children) if (child) node.appendChild(child);
  return node;
}

function buildPopover(root) {
  parts = { presets: [] };

  parts.widthOut = el("output", { class: "pio-num" });
  parts.gutterOut = el("output", { class: "pio-num" });
  parts.measure = el("p", { class: "pio-measure" });

  const presets = PRESETS.map((preset) => {
    const button = el("button", {
      type: "button",
      class: "pio-preset",
      "data-width": String(preset.width),
      text: t(preset.labelKey),
      onClick: () => setConfig({ width: preset.width, enabled: true }),
    });
    parts.presets.push(button);
    return button;
  });

  parts.widthSlider = el("input", {
    type: "range",
    class: "pio-slider",
    min: String(MIN_WIDTH),
    max: String(MAX_WIDTH),
    step: String(WIDTH_STEP),
    "aria-label": t("ariaWidth"),
    onInput: (event) => setConfig({ width: Number(event.currentTarget.value), enabled: true }),
  });

  parts.gutterSlider = el("input", {
    type: "range",
    class: "pio-slider",
    min: String(MIN_GUTTER),
    max: String(MAX_GUTTER),
    step: String(GUTTER_STEP),
    "aria-label": t("ariaGutter"),
    onInput: (event) => setConfig({ gutter: Number(event.currentTarget.value) }),
  });

  parts.enabled = el("input", {
    type: "checkbox",
    class: "pio-check",
    onChange: (event) => setConfig({ enabled: event.currentTarget.checked }),
  });

  parts.followSidebar = el("input", {
    type: "checkbox",
    class: "pio-check",
    onChange: (event) => setConfig({ followSidebar: event.currentTarget.checked }),
  });

  root.append(
    el(
      "div",
      { class: "pio-pop-head" },
      el("span", { class: "pio-pop-title", text: t("popoverTitle") }),
      el("button", {
        type: "button",
        class: "pio-pop-close",
        "aria-label": t("close"),
        text: "✕",
        onClick: () => closePopover(),
      }),
    ),
    el("div", { class: "pio-row" }, el("span", { class: "pio-row-label", text: t("rowWidth") }), parts.widthOut),
    el("div", { class: "pio-presets" }, ...presets),
    parts.widthSlider,
    el("div", { class: "pio-row" }, el("span", { class: "pio-row-label", text: t("rowGutter") }), parts.gutterOut),
    parts.gutterSlider,
    el(
      "label",
      { class: "pio-row pio-row-switch" },
      el("span", { class: "pio-row-label", text: t("rowEnabled") }),
      parts.enabled,
    ),
    el(
      "label",
      { class: "pio-row pio-row-switch" },
      el("span", { class: "pio-row-label", text: t("rowFollow") }),
      parts.followSidebar,
    ),
    parts.measure,
    el("p", { class: "pio-hint", text: t("hintDrag") }),
  );

  refreshPopover();
}

function refreshPopover() {
  if (!parts.widthOut) return;
  const full = config.width === 0;
  parts.widthOut.textContent = full ? t("fullWidth") : `${config.width}px`;
  parts.gutterOut.textContent = `${config.gutter}px`;
  parts.widthSlider.value = String(full ? MAX_WIDTH : config.width);
  parts.widthSlider.disabled = !config.enabled;
  parts.gutterSlider.value = String(config.gutter);
  parts.gutterSlider.disabled = !config.enabled;
  parts.enabled.checked = config.enabled;
  parts.followSidebar.checked = config.followSidebar;
  parts.followSidebar.disabled = !config.enabled || full;
  for (const button of parts.presets) {
    const width = Number(button.dataset.width);
    const active = config.enabled && (width === 0 ? full : !full && width === config.width);
    button.dataset.active = String(active);
  }
  const measured = document.querySelector(".thread-content")?.clientWidth ?? 0;
  const bonus = sidebarBonus();
  const note = bonus > 0 ? t("bonus", { n: bonus }) : "";
  parts.measure.textContent = config.enabled
    ? measured > 0
      ? `${t("measured", { n: measured })}${note}`
      : t("noTranscript")
    : t("disabled");
}

function positionPopover(anchor) {
  const root = layerRoot;
  if (!root) return;
  const target = anchor ?? anchorNode ?? triggerNode;
  const rect = target?.isConnected ? target.getBoundingClientRect() : null;
  root.style.visibility = "hidden";
  const width = root.offsetWidth || 272;
  const height = root.offsetHeight || 320;
  const margin = 12;
  let left = rect ? rect.right - width : window.innerWidth - width - margin;
  left = clamp(left, margin, Math.max(margin, window.innerWidth - width - margin));

  let top = rect ? rect.top - height - 10 : window.innerHeight - height - margin;
  if (top < margin) top = rect ? rect.bottom + 10 : margin;
  top = clamp(top, margin, Math.max(margin, window.innerHeight - height - margin));

  root.style.left = `${Math.round(left)}px`;
  root.style.top = `${Math.round(top)}px`;
  root.style.visibility = "visible";
}

function openPopover(anchor) {
  if (layer) return;
  anchorNode = anchor;
  layer = api.ui.openLayer();
  const root = el("div", { class: "pio-pop", role: "dialog", "aria-label": t("popoverTitle"), tabindex: "-1" });
  root.style.setProperty("--pio-pop-solid", solidBackdrop());
  buildPopover(root);
  layer.element.appendChild(root);
  layerRoot = root;
  positionPopover(anchor);
  document.addEventListener("pointerdown", onDocumentPointerDown, true);
  document.addEventListener("keydown", onDocumentKeyDown, true);
  window.addEventListener("resize", onWindowResize);
  root.focus({ preventScroll: true });
}

function closePopover() {
  document.removeEventListener("pointerdown", onDocumentPointerDown, true);
  document.removeEventListener("keydown", onDocumentKeyDown, true);
  window.removeEventListener("resize", onWindowResize);
  layerRoot = null;
  parts = {};
  const current = layer;
  layer = null;
  current?.close();
}

function onDocumentPointerDown(event) {
  if (!layerRoot) return;
  const target = event.target;
  if (layerRoot.contains(target) || triggerNode?.contains(target)) return;
  closePopover();
}

function onDocumentKeyDown(event) {
  if (event.key !== "Escape") return;
  event.preventDefault();
  event.stopPropagation();
  closePopover();
}

function onWindowResize() {
  positionPopover();
}

function onTriggerClick(event) {
  event.preventDefault();
  event.stopPropagation();
  if (layer) closePopover();
  else openPopover(event.currentTarget);
}

/* ---------- 输入框工具栏按钮 ---------- */

/** 图标本身不写字，当前宽度与侧栏加成都在悬浮说明里说清楚。 */
function titleOf() {
  const bonus = sidebarBonus();
  const width = effectiveWidth();
  const size = !config.enabled ? t("off") : width === 0 ? t("fullWidth") : `${width}px`;
  const base = bonus > 0 ? t("tooltipBonus", { n: bonus }) : t("tooltip");
  return `${base} · ${size}`;
}

/** 面板必须不透明：取最外层的实色背景当底衬，主题色再叠一层上去。 */
function solidBackdrop() {
  const nodes = [document.querySelector(".main-pane"), document.querySelector(".app-shell"), document.body, document.documentElement];
  for (const node of nodes) {
    if (!node) continue;
    const color = getComputedStyle(node).backgroundColor;
    if (!color || color === "transparent") continue;
    const parts = color.replace(/^rgba?\(|\)$/g, "").split(",");
    if (parts.length === 4 && Number(parts[3]) < 1) continue;
    return color;
  }
  return "#1c1c1e";
}

function LayoutTrigger() {
  const nodeRef = React.useRef(null);
  const [, setTick] = React.useState(0);

  React.useEffect(() => {
    forceRender = () => setTick((tick) => tick + 1);
    return () => {
      forceRender = () => {};
    };
  }, []);

  React.useEffect(() => {
    triggerNode = nodeRef.current;
    if (triggerNode) triggerNode.dataset.on = String(config.enabled);
    return () => {
      triggerNode = null;
    };
  }, []);

  // 设置在设置页里可以关掉这个图标；关掉后不放任何东西进工具栏。
  // 注意 hooks 必须都跑完再返回，所以判断放在这里。
  if (!config.showTrigger) return null;

  return React.createElement(
    "button",
    {
      ref: nodeRef,
      type: "button",
      className: "pio-trigger",
      "data-on": String(config.enabled),
      "aria-haspopup": "dialog",
      "aria-label": t("ariaTrigger"),
      title: titleOf(),
      onClick: onTriggerClick,
    },
    React.createElement(
      "svg",
      {
        className: "pio-trigger-icon",
        viewBox: "0 0 16 16",
        width: "18",
        height: "18",
        fill: "currentColor",
        "aria-hidden": "true",
        focusable: "false",
      },
      // 实心正文块 + 两侧实心箭头：18px 下也不糊，外框已去掉。
      React.createElement("rect", { x: "6.1", y: "4.6", width: "3.8", height: "6.8", rx: "1.5" }),
      React.createElement("path", { d: "M5.1 8 3 6.1v3.8zM10.9 8 13 6.1v3.8z" }),
    ),
  );
}

/* ---------- 生命周期 ---------- */

/**
 * 会话栏是按需挂载/卸载的，宽度宿主的标记要跟着补；顺手重建面板里的「实际宽度」。
 * childList 观察 + 微任务合并，代价只有一次 querySelector。
 */
let layoutWatchQueued = false;
let pendingShellTouch = false;
let lastSidebarCollapsed = null;
let layoutObserver = null;

function watchLayoutChanges() {
  if (layoutObserver) return;
  layoutObserver = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "attributes" && record.target instanceof Element && record.target.classList.contains("app-shell")) {
        pendingShellTouch = true;
      }
    }
    if (layoutWatchQueued) return;
    layoutWatchQueued = true;
    queueMicrotask(() => {
      const shellTouched = pendingShellTouch;
      pendingShellTouch = false;
      layoutWatchQueued = false;
      if (!config.enabled) return;
      markWidthHost();
      if (shellTouched) syncSidebarBonus();
    });
  });
  if (document.body) {
    layoutObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
  }
}

/** 侧栏收起/展开后重算宽度加成；状态没变就什么都不做。 */
function syncSidebarBonus() {
  const collapsed = isSidebarCollapsed();
  if (collapsed === lastSidebarCollapsed) return;
  lastSidebarCollapsed = collapsed;
  applyConfig();
  refreshPopover();
  forceRender();
  if (triggerNode) triggerNode.title = titleOf();
}

function unwatchLayoutChanges() {
  layoutObserver?.disconnect();
  layoutObserver = null;
}

/**
 * 布局覆盖必须走自建的 <style>：pi.ui.injectStyle 会把规则包进
 * `@scope ([data-pi-plugin="<id>"])`，只能命中插件自己的子树，
 * 够不到应用的 .chat-surface / .thread-content。
 */
function mountLayoutStyle() {
  if (layoutStyleNode?.isConnected) return;
  const node = document.createElement("style");
  node.setAttribute("data-pio-layout-style", "");
  node.textContent = STYLE_LAYOUT;
  document.head.appendChild(node);
  layoutStyleNode = node;
}

function unmountLayoutStyle() {
  layoutStyleNode?.remove();
  layoutStyleNode = null;
}

async function onLoad(hostApi) {
  api = hostApi;

  mountLayoutStyle();
  api.ui.injectStyle(STYLE_CHROME);
  api.slots.register({ slot: "composerControl", component: LayoutTrigger, positions: ["right"] });

  dragObserver = new MutationObserver(onDragAttributeChanged);
  dragObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-chat-resizing"] });
  watchLayoutChanges();

  try {
    config = normalize(await api.dispatch("plugin.call", { method: "getLayoutConfig" }));
  } catch (error) {
    console.warn("[layout-control] failed to read the layout config, using defaults", error);
    config = { ...DEFAULT_CONFIG };
  }
  // 记下刚读到的设置做指纹，之后回读时只有内容真变了才会应用。
  settingsSignature = signatureOf(config);
  lastSidebarCollapsed = isSidebarCollapsed();
  applyConfig();
  forceRender();
  startSettingsWatch();
}

function onUnload() {
  closePopover();
  dragObserver?.disconnect();
  dragObserver = null;
  unwatchLayoutChanges();
  unmountLayoutStyle();
  stopSettingsWatch();
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = 0;
  }
  const root = document.documentElement;
  root.removeAttribute("data-pio-layout");
  root.style.removeProperty("--pio-w");
  root.style.removeProperty("--pio-g");
  for (const node of document.querySelectorAll("[data-pio-width-host]")) {
    node.removeAttribute("data-pio-width-host");
  }
  forceRender = () => {};
  triggerNode = null;
  api = null;
}

export { onLoad, onUnload };
