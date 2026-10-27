/**
 * Open With — 渲染插槽模块（ESM，运行在 PI-Desktop 主窗口）。
 *
 * 结构：
 *   composerControl（输入框底栏左侧）注册一个"分裂按钮"：
 *     [📁 Open With][▾]
 *     —— 主区点击 = 用内置默认（资源管理器）打开当前工作目录；
 *     —— ▾ 点击   = 打开应用管理弹层（pi.ui.openLayer）：
 *                    应用列表（资源管理器置顶、锁定）、添加 / 编辑 / 删除
 *                    自定义应用，点应用即打开。
 *
 * 样式全部使用宿主的 --ds-* 设计令牌（同一文档里可直接引用），
 * 自动跟随 PI-Desktop 的明暗主题；React / react-dom 由宿主 import map 提供。
 */

import React from "react";
import { createRoot } from "react-dom/client";

const h = React.createElement;

const MENU_WIDTH = 340;

const STYLE = `
  /* —— 分裂按钮（贴合宿主 composer 控件风格）—— */
  .ow-split {
    display: inline-flex;
    align-items: stretch;
    height: var(--ds-control-size, 28px);
    margin: 0 4px;
    border: 1px solid var(--ds-border-default, rgba(128, 128, 128, 0.22));
    border-radius: var(--radius-full, 9999px);
    background: transparent;
    overflow: hidden;
  }
  .ow-split__main,
  .ow-split__chev {
    display: inline-flex;
    align-items: center;
    border: 0;
    padding: 0;
    background: transparent;
    color: var(--ds-text-secondary, #5d5d5d);
    font: inherit;
    font-size: var(--text-sm, 13px);
    font-weight: 550;
    line-height: 1;
    cursor: pointer;
    transition: background var(--motion-duration-fast, 0.15s) var(--motion-ease-out, ease-out),
      color var(--motion-duration-fast, 0.15s) var(--motion-ease-out, ease-out);
  }
  .ow-split__main {
    gap: 6px;
    padding: 0 10px 0 9px;
  }
  .ow-split__chev {
    gap: 0;
    padding: 0 7px 0 6px;
    border-left: 1px solid var(--ds-border-subtle, rgba(128, 128, 128, 0.16));
    color: var(--ds-text-faint, #afafaf);
  }
  .ow-split__main:hover,
  .ow-split__chev:hover {
    background: var(--ds-bg-hover, rgba(128, 128, 128, 0.1));
    color: var(--ds-text-primary, inherit);
  }
  .ow-split:focus-within {
    outline: 2px solid var(--ds-border-strong, rgba(128, 128, 128, 0.35));
    outline-offset: 1px;
  }
  .ow-split__label {
    white-space: nowrap;
    max-width: 120px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .ow-split__img {
    flex: none;
    width: 15px;
    height: 15px;
    object-fit: contain;
    border-radius: var(--radius-3xs, 4px);
  }

  /* —— 弹层菜单 —— */
  .ow-menu {
    position: fixed;
    width: ${MENU_WIDTH}px;
    max-width: calc(100vw - 24px);
    max-height: 70vh;
    overflow: auto;
    box-sizing: border-box;
    padding: 6px;
    background: var(--ds-bg-elevated-opaque, #ffffff);
    border: 1px solid var(--ds-border-default, rgba(0, 0, 0, 0.12));
    border-radius: var(--radius-md, 12px);
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.16), var(--ds-elevation-stroke, 0 0 0 transparent);
    color: var(--ds-text-primary, inherit);
    font-size: var(--text-sm, 13px);
    z-index: inherit;
  }
  .ow-menu__list {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .ow-row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 7px 8px;
    border: 0;
    border-radius: var(--radius-xs, 8px);
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .ow-row:hover {
    background: var(--ds-bg-hover, rgba(128, 128, 128, 0.1));
  }
  .ow-row--selected {
    background: var(--ds-bg-active, rgba(128, 128, 128, 0.16));
  }
  .ow-row--selected .ow-row__name {
    color: var(--ds-text-primary, inherit);
  }
  .ow-row--selected .ow-row__desc {
    color: var(--ds-text-secondary, #5d5d5d);
    font-weight: 550;
  }
  .ow-row__icon {
    flex: none;
    display: inline-flex;
    color: var(--ds-text-secondary, #5d5d5d);
  }
  .ow-row__img {
    flex: none;
    width: 16px;
    height: 16px;
    object-fit: contain;
    border-radius: var(--radius-3xs, 4px);
  }
  .ow-row__name {
    flex: 0 auto;
    font-weight: 560;
    white-space: nowrap;
  }
  .ow-row__desc {
    flex: 1 1 0;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--ds-text-muted, #5d5d5d);
    font-size: var(--text-xs, 12px);
  }
  .ow-row__actions {
    flex: none;
    display: inline-flex;
    gap: 2px;
    opacity: 0;
    transition: opacity var(--motion-duration-fast, 0.15s) var(--motion-ease-out, ease-out);
  }
  .ow-row:hover .ow-row__actions,
  .ow-row__actions:focus-within {
    opacity: 1;
  }
  .ow-iconbtn {
    width: 24px;
    height: 24px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 0;
    border-radius: var(--radius-3xs, 6px);
    background: transparent;
    color: var(--ds-text-muted, #5d5d5d);
    cursor: pointer;
  }
  .ow-iconbtn:hover {
    background: var(--ds-bg-active, rgba(128, 128, 128, 0.16));
    color: var(--ds-text-primary, inherit);
  }
  .ow-iconbtn--danger:hover {
    color: #e5484d;
  }
  .ow-menu__footer {
    margin-top: 4px;
    padding-top: 6px;
    border-top: 1px solid var(--ds-border-subtle, rgba(128, 128, 128, 0.16));
  }
  .ow-add {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 7px 8px;
    border: 0;
    border-radius: var(--radius-xs, 8px);
    background: transparent;
    color: var(--ds-text-secondary, #5d5d5d);
    font: inherit;
    cursor: pointer;
  }
  .ow-add:hover {
    background: var(--ds-bg-hover, rgba(128, 128, 128, 0.1));
    color: var(--ds-text-primary, inherit);
  }

  /* —— 添加 / 编辑表单 —— */
  .ow-form {
    display: grid;
    gap: 9px;
    padding: 8px 6px 6px;
  }
  .ow-form__title {
    margin: 0;
    font-size: var(--text-sm, 13px);
    font-weight: 620;
  }
  .ow-field {
    display: grid;
    gap: 4px;
  }
  .ow-field__label {
    font-size: var(--text-xs, 12px);
    color: var(--ds-text-muted, #5d5d5d);
  }
  .ow-field__input {
    width: 100%;
    box-sizing: border-box;
    padding: 6px 9px;
    border: 1px solid var(--ds-border-default, rgba(128, 128, 128, 0.28));
    border-radius: var(--radius-xs, 8px);
    background: var(--ds-bg-primary, transparent);
    color: var(--ds-text-primary, inherit);
    font: inherit;
  }
  .ow-field__input:focus {
    outline: 2px solid var(--ds-border-strong, rgba(128, 128, 128, 0.4));
    outline-offset: -1px;
    border-color: transparent;
  }
  .ow-field__hint {
    font-size: 11px;
    color: var(--ds-text-faint, #afafaf);
  }
  .ow-form__err {
    margin: 0;
    font-size: var(--text-xs, 12px);
    color: #e5484d;
  }
  .ow-form__actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  .ow-btn-solid {
    padding: 6px 14px;
    border: 0;
    border-radius: var(--radius-xs, 8px);
    background: var(--ds-accent, #1a1c1f);
    color: var(--ds-bg-primary, #ffffff);
    font: inherit;
    font-weight: 560;
    cursor: pointer;
  }
  .ow-btn-solid:hover {
    background: var(--ds-accent-hover, #303030);
  }
  .ow-btn-solid:disabled {
    opacity: 0.55;
    cursor: default;
  }
  .ow-btn-ghost {
    padding: 6px 12px;
    border: 1px solid var(--ds-border-default, rgba(128, 128, 128, 0.28));
    border-radius: var(--radius-xs, 8px);
    background: transparent;
    color: var(--ds-text-secondary, #5d5d5d);
    font: inherit;
    cursor: pointer;
  }
  .ow-btn-ghost:hover {
    background: var(--ds-bg-hover, rgba(128, 128, 128, 0.1));
    color: var(--ds-text-primary, inherit);
  }
  .ow-empty {
    padding: 14px 8px;
    text-align: center;
    color: var(--ds-text-muted, #5d5d5d);
    font-size: var(--text-xs, 12px);
  }
`;

/** —— 内联图标（lucide 描边风格）—— */
const ICON_PATHS = {
  folder: ["M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 0-1.69.9l-.8 1.2A2 2 0 0 1 7.93 9H4a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2Z"],
  chevron: ["m6 9 6 6 6-6"],
  plus: ["M5 12h14", "M12 5v14"],
  pencil: ["M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z", "m15 5 4 4"],
  trash: ["M3 6h18", "M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6", "M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"],
  terminal: ["m4 17 6-6-6-6", "M12 19h8"],
};

function Icon({ name, size = 15 }) {
  const paths = (ICON_PATHS[name] ?? []).map(function (d, i) {
    return h("path", { key: i, d });
  });
  return h(
    "svg",
    {
      width: size,
      height: size,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 2,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": "true",
    },
    paths,
  );
}

/** 宿主注入的 pi API。 */
let piApi = null;
const disposers = [];
/** 当前打开的弹层（用于 ▾ 切换）。 */
let openMenuHandle = null;

function track(dispose) {
  if (typeof dispose === "function") {
    disposers.push(dispose);
  }
}

/** 调主进程（返回主进程的结果对象）。 */
async function callMain(method, args) {
  if (!piApi) {
    return null;
  }
  try {
    return await piApi.dispatch("plugin.call", { method, args });
  } catch (error) {
    console.warn(`[open-with] plugin.call "${method}" failed:`, error);
    return null;
  }
}

/** —— 应用管理弹层 —— */

function AppRow({ app, selected, onOpen, onEdit, onRemove }) {
  const locked = Boolean(app.locked);
  const isSelected = Boolean(selected);
  return h(
    "div",
    { className: "ow-row" + (isSelected ? " ow-row--selected" : ""), role: "button", tabIndex: 0, "aria-current": isSelected ? "true" : void 0, title: "点击选中（不打开）", onClick: () => onOpen(app.id), onKeyDown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(app.id); } } },
    app.icon
      ? h("img", { className: "ow-row__img", src: app.icon, alt: "", width: 16, height: 16 })
      : h("span", { className: "ow-row__icon" }, h(Icon, { name: locked ? "folder" : "terminal" })),
    h("span", { className: "ow-row__name" }, String(app.label ?? app.id)),
    h(
      "span",
      { className: "ow-row__desc", title: locked ? "内置默认，所有机器可用" : String(app.command ?? "") },
      isSelected ? "✓ 当前选中（点主按钮打开）" : locked ? "内置默认 · 不可编辑" : String(app.command ?? ""),
    ),
    locked
      ? null
      : h(
          "span",
          { className: "ow-row__actions" },
          h("button", { type: "button", className: "ow-iconbtn", title: `编辑 ${app.label}`, "aria-label": `编辑 ${app.label}`, onClick: (e) => { e.stopPropagation(); onEdit(app); } }, h(Icon, { name: "pencil", size: 13 })),
          h("button", { type: "button", className: "ow-iconbtn ow-iconbtn--danger", title: `删除 ${app.label}`, "aria-label": `删除 ${app.label}`, onClick: (e) => { e.stopPropagation(); onRemove(app.id); } }, h(Icon, { name: "trash", size: 13 })),
        ),
  );
}

function AppForm({ mode, app, onClose, onSaved, onError }) {
  const [label, setLabel] = React.useState(app?.label ?? "");
  const [command, setCommand] = React.useState(app?.command ?? "");
  // args 对用户不可见（表单只有名称 + exe 路径）：null = 用主进程默认 ["{{dir}}"]
  const [args, setArgs] = React.useState(Array.isArray(app?.args) && app.args.length ? app.args : null);
  const [busy, setBusy] = React.useState(false);


  const submit = async function (e) {
    e.preventDefault();
    if (busy) {
      return;
    }
    setBusy(true);
    const payload = { label, command, args };
    const result = mode === "add"
      ? await callMain("add", payload)
      : await callMain("update", { ...payload, id: app.id });
    setBusy(false);
    if (result && result.ok) {
      onSaved(result.apps);
    } else {
      onError((result && result.message) || "保存失败，请重试。");
    }
  };

  return h(
    "form",
    { className: "ow-form", onSubmit: submit },
    h("p", { className: "ow-form__title" }, mode === "add" ? "添加打开方式" : `编辑：${app.label}`),
    h(
      "div",
      { className: "ow-field" },
      h("label", { className: "ow-field__label" }, "名称"),
      h("input", { className: "ow-field__input", value: label, onChange: (e) => setLabel(e.target.value), placeholder: "如 VSCode", maxLength: 40, autoFocus: true }),
    ),
    h(
      "div",
      { className: "ow-field" },
      h("label", { className: "ow-field__label" }, "exe 路径"),
      h("input", { className: "ow-field__input", value: command, onChange: (e) => { setCommand(e.target.value); setArgs(null); }, placeholder: "粘贴 exe 完整路径，如 D:/Program Files/…/idea64.exe", spellCheck: false, autoComplete: "off" }),
      h("span", { className: "ow-field__hint" }, "直接粘贴 exe 文件的完整路径（必须以 .exe 结尾）；保存后点击即用该程序打开当前项目目录。"),
    ),
    h(
      "div",
      { className: "ow-form__actions" },
      h("button", { type: "button", className: "ow-btn-ghost", onClick: onClose }, "取消"),
      h("button", { type: "submit", className: "ow-btn-solid", disabled: busy }, busy ? "保存中…" : "保存"),
    ),
  );
}
function MenuLayer({ anchorRect, close }) {
  const [apps, setApps] = React.useState(null);
  const [form, setForm] = React.useState(null); // null | {mode:"add"} | {mode:"edit", app}
  const [error, setError] = React.useState("");
  // 全局选中的打开方式（settings.selectedApp；主按钮按它打开）
  const [selected, setSelected] = React.useState("explorer");
  const menuRef = React.useRef(null);

  React.useEffect(function () {
    let alive = true;
    callMain("list", {}).then(function (result) {
      if (alive) {
        setApps(result?.apps ?? []);
        setSelected(result?.selected ?? "explorer");
      }
    });
    const onKey = function (e) {
      if (e.key === "Escape") {
        close();
      }
    };
    const onPointer = function (e) {
      // 点在按钮本身上不关闭（由 ▾ 的切换逻辑处理）
      if (e.target && e.target.closest && e.target.closest(".ow-split")) {
        return;
      }
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        close();
      }
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer, true);
    return function () {
      alive = false;
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer, true);
    };
  }, [close]);

  const openApp = async function (id) {
    // 点应用行 = 只切换全局选中（持久），不打开；打开动作只属于主按钮。
    // select 落地后立即通知主按钮刷新（两个独立 React 根，靠共享钩子联动）。
    const sel = await callMain("select", { id });
    if (sel && sel.ok) {
      setSelected(sel.selected);
      if (typeof refreshSelectedButton === "function") {
        refreshSelectedButton();
      }
    } else {
      setError((sel && sel.message) || "切换失败。");
    }
  };
  const saved = function (nextApps, nextSelected) {
    setApps(nextApps ?? []);
    if (typeof nextSelected === "string") {
      setSelected(nextSelected);
    }
    setForm(null);
    setError("");
  };
  const removeApp = async function (id) {
    const result = await callMain("remove", { id });
    if (result && result.ok) {
      setApps(result.apps ?? []);
      if (typeof result.selected === "string") {
        setSelected(result.selected);
      }
      // 删除后选中可能回落 explorer：主按钮立即同步
      if (typeof refreshSelectedButton === "function") {
        refreshSelectedButton();
      }
      setError("");
    } else {
      setError((result && result.message) || "删除失败。");
    }
  };

  // 双模式定位：应用列表跟随 ▾ 按钮锚点（下拉行为）；添加/编辑表单
  // （含浏览候选列表等高内容）才居中到窗口中间，避免被视口底边裁剪。
  // 列表模式要清掉居中的 translate。
  const style = form
    ? { left: "50%", top: "50%", transform: "translate(-50%, -50%)" }
    : {
        left: `${Math.max(8, Math.min(anchorRect.left, window.innerWidth - MENU_WIDTH - 12))}px`,
        top: `${Math.min(anchorRect.bottom + 6, Math.max(8, window.innerHeight - 160))}px`,
        transform: "none",
      };

  return h(
    "div",
    { className: "ow-menu", style, ref: menuRef, role: "menu", "aria-label": "Open With 应用列表" },
    error ? h("p", { className: "ow-form__err" }, error) : null,
    form
      ? h(AppForm, {
          mode: form.mode,
          app: form.app,
          onClose: () => { setForm(null); setError(""); },
          onSaved: saved,
          onError: setError,
        })
      : apps === null
        ? h("div", { className: "ow-empty" }, "加载中…")
        : h(
            "div",
            { className: "ow-menu__list" },
            (apps.length
              ? apps.map(function (app) {
                  return h(AppRow, {
                    key: app.id,
                    app,
                    selected: app.id === selected,
                    onOpen: openApp,
                    onEdit: (a) => { setForm({ mode: "edit", app: a }); setError(""); },
                    onRemove: removeApp,
                  });
                })
              : [h("div", { key: "empty", className: "ow-empty" }, "暂无打开方式")]),
            h(
              "div",
              { className: "ow-menu__footer" },
              h(
                "p",
                { className: "ow-cands__title", style: { padding: "0 8px 2px", margin: 0 } },
                `当前选中：${(() => { const hit = (apps ?? []).find((a) => a.id === selected); return hit ? hit.label ?? hit.id : "File Explorer"; })()}——列表点选仅切换，打开请点主按钮`,
              ),
              h(
                "button",
                { type: "button", className: "ow-add", onClick: () => { setForm({ mode: "add" }); setError(""); } },
                h(Icon, { name: "plus", size: 14 }),
                "添加打开方式",
              ),
            ),
          ),
  );
}

/** 打开（或切换关闭）应用管理弹层。 */
function toggleMenu(anchorRect) {
  if (openMenuHandle) {
    openMenuHandle.close();
    openMenuHandle = null;
    return;
  }
  if (!piApi) {
    return;
  }
  const layer = piApi.ui.openLayer();
  const root = createRoot(layer.element);
  const close = function () {
    openMenuHandle = null;
    try {
      root.unmount();
    } catch (_error) {
      /* 已卸载 */
    }
    layer.close();
    // 弹层关闭后主按钮刷新（选中可能刚被切换）
    if (typeof refreshSelectedButton === "function") {
      refreshSelectedButton();
    }
  };
  openMenuHandle = { close };
  root.render(h(MenuLayer, { anchorRect, close }));
}

/** 主按钮的选中应用刷新器：挂载时、以及每次菜单层关闭（选中可能被切换）后调用。 */
let refreshSelectedButton = null;

function fetchCurrentApp() {
  return callMain("list", {}).then(function (result) {
    if (!result || !result.ok) {
      return null;
    }
    const hit = (result.apps ?? []).find(function (app) {
      return app && app.id === result.selected;
    });
    return hit ? { label: hit.label ?? hit.id, icon: hit.icon, locked: Boolean(hit.locked) } : null;
  });
}

/** 分裂按钮：主区 = 用全局选中的应用打开（不传 id，主进程读 settings.selectedApp）；▾ = 弹层。 */
function OpenWithControl() {
  const [current, setCurrent] = React.useState(null); // {label, icon, locked}

  React.useEffect(function () {
    let alive = true;
    fetchCurrentApp().then(function (hit) {
      if (alive) {
        setCurrent(hit);
      }
    });
    refreshSelectedButton = function () {
      fetchCurrentApp().then(function (hit) {
        if (alive) {
          setCurrent(hit);
        }
      });
    };
    return function () {
      alive = false;
      refreshSelectedButton = null;
    };
  }, []);

  const label = current ? current.label : "Open With";
  return h(
    "div",
    { className: "ow-split" },
    h(
      "button",
      {
        type: "button",
        className: "ow-split__main",
        title: `用 ${label} 打开当前工作目录`,
        onClick: () => callMain("open", {}),
      },
      current && current.icon
        ? h("img", { className: "ow-split__img", src: current.icon, alt: "", width: 15, height: 15 })
        : h(Icon, { name: current && current.locked ? "folder" : "terminal", size: 15 }),
      h("span", { className: "ow-split__label" }, label),
    ),
    h(
      "button",
      {
        type: "button",
        className: "ow-split__chev",
        title: "选择应用 / 管理打开方式",
        "aria-label": "选择应用或管理打开方式",
        "aria-haspopup": "menu",
        "aria-expanded": Boolean(openMenuHandle),
        onClick: (e) => toggleMenu(e.currentTarget.getBoundingClientRect()),
      },
      h(Icon, { name: "chevron", size: 13 }),
    ),
  );
}

/** 渲染模块加载：注入样式 + 注册唯一的插槽按钮。 */
export async function onLoad(pi) {
  piApi = pi;

  track(pi.ui.injectStyle(STYLE));

  track(
    pi.slots.register({
      slot: "composerControl",
      positions: ["left"],
      component: OpenWithControl,
    }),
  );
}

/** 渲染模块卸载：关弹层 + 销毁注册与样式。 */
export async function onUnload() {
  if (openMenuHandle) {
    openMenuHandle.close();
    openMenuHandle = null;
  }
  const pending = disposers.splice(0);
  for (const dispose of pending) {
    try {
      dispose();
    } catch (error) {
      console.warn("[open-with] dispose failed:", error);
    }
  }
  piApi = null;
}
