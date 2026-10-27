"use strict";

/**
 * pi-desktop-workbuddy - panel logic.
 *
 * The panel owns no data and makes no network request: everything it shows
 * comes from the plugin's main process through `window.pluginBridge.invoke`,
 * and every channel name matches a case in `onPanelInvoke` (main.js).
 *
 * All API-derived text is written with textContent / createElement, never
 * innerHTML, so a model id or an upstream error can never inject markup.
 */

// ------------------------------------------------------------------ bridge

var bridge = window.pluginBridge || null;

function invoke(channel, payload) {
  if (!bridge || typeof bridge.invoke !== "function") {
    return Promise.reject(new Error("panel bridge unavailable"));
  }
  return bridge.invoke(channel, payload || {});
}

// ------------------------------------------------------------------ locale

var EN = {
  "tab.pool": "Pool",
  "tab.models": "Models",
  "tab.check": "Connection check",
  "btn.rescan": "Detect accounts again",
  "btn.reset": "Clear all cooldowns",
  "btn.refresh": "Refresh",
  "btn.checkin": "Check in",
  "btn.checkinDone": "Checked in today",
  "btn.save": "Save",
  "btn.discard": "Discard",
  "btn.doctor": "Run connection check",
  "btn.copy": "Copy report",
  "copy.ok": "copied",
  "copy.fail": "copy failed",
  "region.cn": "国内版",
  "region.global": "国际版",
  "region.cnShort": "CN",
  "region.globalShort": "Global",
  "pool.summary": "{count} account(s) · {cooling} cooling",
  "pool.healthy": "Requests rotate across accounts automatically.",
  "pool.allCooling": "Every account is rate-limited right now; requests pause until a cooldown lifts.",
  "pool.emptyRegion": "No {region} account is signed in yet.",
  "pool.emptyHint": "Sign in to that edition in the WorkBuddy desktop app, then choose “Detect accounts again”. The two editions keep separate accounts and credits, so each needs its own sign-in.",
  "badge.next": "next up",
  "badge.cooling": "cooling",
  "badge.healthy": "healthy",
  "acct.token": "token {time}",
  "acct.tokenExpiring": "token expires in {min} min",
  "acct.noExpiry": "no token expiry reported",
  "acct.coolUntil": "cooling until {time}",
  "acct.hits": "{hits} rate-limit hit(s)",
  "acct.modelCool": "{model} cooling until {time}",
  "credits.title": "Credits",
  "credits.total": "Total",
  "credits.unavailable": "credits unavailable",
  "credits.package": "{remain} / {size}",
  "credits.monthly": "monthly",
  "credits.soon": "expiring in 3 days",
  "checkin.title": "Daily check-in",
  "checkin.streak": "{days}-day streak",
  "checkin.daily": "+{credit} credits/day",
  "checkin.bonus": "day {days} bonus +{credit}",
  "checkin.claimed": "claimed +{credit} credits",
  "checkin.inactive": "check-in is not available for this account",
  "checkin.claiming": "Checking in…",
  "models.title": "Models",
  "models.serviceModels": "Models for this service",
  "models.fetchModelList": "Fetch list",
  "models.modelsLoading": "Fetching model list…",
  "models.searchModelId": "Search model ID…",
  "models.selectAll": "Select all",
  "models.deselectAll": "Deselect all",
  "models.back": "Back to models",
  "models.modelConfigurations": "Model settings",
  "models.searchChosen": "Search added models…",
  "models.noModelsChosen": "No model selected yet. Tick one in the model list.",
  "models.noChosenMatch": "No added model matches",
  "models.removeModel": "Remove model",
  "models.advanced": "Advanced",
  "models.alias": "Alias",
  "models.aliasPlaceholder": "e.g. fast",
  "models.aliasHelp": "Shown wherever the model is named; the request still uses the model ID.",
  "models.window": "Context window",
  "models.windowFollows": "Follows the catalog; editing pins your value.",
  "models.maxOutput": "Max output",
  "models.outputHelp": "The largest reply this model may produce.",
  "models.levels": "Thinking levels",
  "models.defaultLevel": "Default thinking level",
  "models.capabilities": "Attachments",
  "models.imageInput": "Images",
  "models.pdfInput": "PDF",
  "models.imageModel": "Use for image generation",
  "models.subagents": "Available for AI delegation",
  "models.webSearch": "Native web search",
  "models.hostOnly": "Not available for a plugin-provided model: PI-Desktop does not read this field from a plugin declaration.",
  "models.empty": "No model in the catalog yet.",
  "models.noMatch": "No model matches the filter.",
  "models.zeroEnabled": "Enable at least one model before saving.",
  "models.dirty": "Unsaved changes",
  "models.saving": "Saving…",
  "models.saved": "Model selection saved",
  "models.applyHint": "Saved. PI-Desktop caches each provider's model list, so open Settings → Models and press \"Set as default\" on this provider (or toggle it off and on) to make the picker match.",
  "models.saveError": "Could not save: {message}",
  "models.reload": "The model list changed. Turn this plugin off and on again (or restart the app) so the picker matches.",
  "models.addressDrift": "The address the host cached does not match the endpoint this plugin is serving. Turn this plugin off and on again (or restart the app) so the host re-reads it.",
  "dist.title": "Account usage",
  "dist.priority": "Priority",
  "dist.roundRobin": "Round-robin",
  "dist.hintPriority": "Drain one account first, then move on to the next.",
  "dist.hintRoundRobin": "Spread the spend evenly across every account.",
  "check.title": "Connection check",
  "check.empty": "Run the check to see whether a chat can reach WorkBuddy.",
  "foot.version": "v{version}",
  "foot.shim": "endpoint {url}",
  "foot.shimOff": "endpoint not listening",
  "foot.refresh": "catalog refresh every {min} min",
  "err.bridge": "The panel bridge is unavailable.",
  "tag.free": "free",
  "tag.limited": "limited free",
  "tag.night": "night",
  "tag.rate": "x{rate}",
  "state.loading": "Loading…",
  "state.refreshing": "checking…",
  "probe.pending": "reading…",
  "btn.refreshing": "Refreshing…",
  "models.staleSelection": "The saved model selection for the {region} group names models that no longer exist, so every model is shown. Pick the models you want and save again.",
};

var ZH = {
  "tab.pool": "账号池",
  "tab.models": "模型",
  "tab.check": "连接检查",
  "btn.rescan": "重新检测账号",
  "btn.reset": "清除所有冷却",
  "btn.refresh": "刷新",
  "btn.checkin": "签到",
  "btn.checkinDone": "今日已签到",
  "btn.save": "保存",
  "btn.discard": "放弃",
  "btn.doctor": "运行连接检查",
  "btn.copy": "复制报告",
  "copy.ok": "已复制",
  "copy.fail": "复制失败",
  "region.cn": "国内版",
  "region.global": "国际版",
  "region.cnShort": "国内版",
  "region.globalShort": "国际版",
  "pool.summary": "{count} 个账号 · {cooling} 个冷却中",
  "pool.healthy": "请求会在账号之间自动轮换。",
  "pool.allCooling": "所有账号当前都被限流，请求会等到有账号冷却结束。",
  "pool.emptyRegion": "这一侧还没有登录的账号。",
  "pool.emptyHint": "请在该版本的 WorkBuddy 桌面 App 里登录，然后点「重新检测账号」。国内版与国际版的账号和积分各自独立，需要分别登录。",
  "badge.next": "下一个",
  "badge.cooling": "冷却中",
  "badge.healthy": "可用",
  "acct.token": "令牌 {time}",
  "acct.tokenExpiring": "令牌将在 {min} 分钟后过期",
  "acct.noExpiry": "令牌没有报告有效期",
  "acct.coolUntil": "冷却至 {time}",
  "acct.hits": "已触发 {hits} 次限流",
  "acct.modelCool": "{model} 冷却至 {time}",
  "credits.title": "积分",
  "credits.total": "合计",
  "credits.unavailable": "积分读取失败",
  "credits.package": "{remain} / {size}",
  "credits.monthly": "每月刷新",
  "credits.soon": "3 天内过期",
  "checkin.title": "每日签到",
  "checkin.streak": "连签 {days} 天",
  "checkin.daily": "每天 +{credit} 积分",
  "checkin.bonus": "第 {days} 天额外 +{credit}",
  "checkin.claimed": "已领取 +{credit} 积分",
  "checkin.inactive": "该账号没有签到活动",
  "checkin.claiming": "签到中…",
  "models.title": "模型",
  "models.serviceModels": "该服务的模型",
  "models.fetchModelList": "获取列表",
  "models.modelsLoading": "正在获取模型列表…",
  "models.searchModelId": "搜索模型 ID…",
  "models.selectAll": "全选",
  "models.deselectAll": "取消全选",
  "models.back": "返回模型列表",
  "models.modelConfigurations": "模型设置",
  "models.searchChosen": "搜索已添加模型…",
  "models.noModelsChosen": "尚未选择模型。请在模型列表中勾选。",
  "models.noChosenMatch": "没有匹配的已添加模型",
  "models.removeModel": "移除模型",
  "models.advanced": "高级",
  "models.alias": "别名",
  "models.aliasPlaceholder": "例如 fast",
  "models.aliasHelp": "在显示模型名称的地方生效；请求仍使用模型 ID。",
  "models.window": "上下文窗口",
  "models.windowFollows": "跟随目录；手动修改后会固定为你的值。",
  "models.maxOutput": "最大输出",
  "models.outputHelp": "该模型单次回复的最大长度。",
  "models.levels": "思考等级",
  "models.defaultLevel": "默认思考等级",
  "models.capabilities": "附件",
  "models.imageInput": "图片",
  "models.pdfInput": "PDF",
  "models.imageModel": "设为生图模型",
  "models.subagents": "可供 AI 自动调度",
  "models.webSearch": "原生联网搜索",
  "models.hostOnly": "插件提供的模型不支持此项：PI-Desktop 不会从插件声明里读取该字段。",
  "models.empty": "目录里还没有模型。",
  "models.noMatch": "没有匹配的模型。",
  "models.zeroEnabled": "至少启用一个模型才能保存。",
  "models.dirty": "有未保存的修改",
  "models.saving": "保存中…",
  "models.saved": "模型选择已保存",
  "models.applyHint": "已保存。PI-Desktop 会缓存每个服务商的模型列表，请在「设置 → 模型」里对本服务商点一次「设为默认」，或关掉再开启一次，模型选择器才会同步。",
  "models.saveError": "保存失败：{message}",
  "models.reload": "模型列表有变化。请把插件关掉再打开（或重启应用），模型选择器才会同步。",
  "models.addressDrift": "服务地址与宿主已缓存的地址不一致。请把本插件关掉再打开（或重启应用）以让宿主重新读取。",
  "dist.title": "账号使用方式",
  "dist.priority": "优先用一个",
  "dist.roundRobin": "轮流使用",
  "dist.hintPriority": "先用完一个账号的额度，再换下一个。",
  "dist.hintRoundRobin": "把消耗均摊到每个账号上。",
  "check.title": "连接检查",
  "check.empty": "运行检查可以看到对话能否连上 WorkBuddy。",
  "foot.version": "v{version}",
  "foot.shim": "端点 {url}",
  "foot.shimOff": "端点未监听",
  "foot.refresh": "模型目录每 {min} 分钟刷新",
  "err.bridge": "面板桥不可用。",
  "tag.free": "免费",
  "tag.limited": "限时免费",
  "tag.night": "夜间",
  "tag.rate": "x{rate}",
  "state.loading": "加载中…",
  "state.refreshing": "正在检测…",
  "probe.pending": "读取中…",
  "btn.refreshing": "刷新中…",
  "models.staleSelection": "{region}这一侧保存的模型选择里已经有不存在的模型，因此现在显示全部模型。请重新勾选后保存。",
};

var locale = String(document.documentElement.lang || navigator.language || "zh-CN");
var TABLE = locale.toLowerCase().indexOf("zh") === 0 ? ZH : EN;
function t(key, vars) {
  var text = TABLE[key] !== undefined ? TABLE[key] : (EN[key] !== undefined ? EN[key] : key);
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, function (match, name) {
    return vars[name] === undefined ? match : String(vars[name]);
  });
}

// ---------------------------------------------------------------- helpers

function $(id) { return document.getElementById(id); }

function el(tag, className, text) {
  var node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function show(node, visible) { node.hidden = !visible; }

function num(value, fallback) {
  var n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function formatStamp(iso) {
  if (!iso) return "";
  var d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}

function formatRelative(iso) {
  if (!iso) return "";
  var d = new Date(iso).getTime();
  if (!Number.isFinite(d)) return "";
  var ms = d - Date.now();
  var mins = Math.round(ms / 60000);
  if (mins <= 0) return t("badge.cooling");
  if (mins < 60) return mins + " min";
  var hours = Math.round(mins / 60);
  if (hours < 48) return hours + " h";
  return Math.round(hours / 24) + " d";
}

function minutesUntil(iso) {
  if (!iso) return null;
  var d = new Date(iso).getTime();
  if (!Number.isFinite(d)) return null;
  return Math.round((d - Date.now()) / 60000);
}

function tagOf(model) {
  var tags = model.tags || [];
  var out = [];
  if (tags.indexOf("free") >= 0) out.push(t("tag.free"));
  else if (tags.indexOf("limited-free") >= 0) out.push(t("tag.limited"));
  if (tags.indexOf("night-discount") >= 0) out.push(t("tag.night"));
  if (typeof model.multiplier === "number") out.push(t("tag.rate", { rate: model.multiplier.toFixed(2) }));
  return out;
}

function note(message, kind) {
  var banner = $("banner");
  if (!message) { show(banner, false); banner.textContent = ""; return; }
  banner.textContent = message;
  banner.className = kind === "warn" ? "banner warn" : "banner";
  show(banner, true);
}

function announce(message) {
  var live = $("live");
  live.textContent = "";
  window.setTimeout(function () { live.textContent = message; }, 20);
}

// ------------------------------------------------------------------- state

var state = null;
var activeRegion = "cn";
var activeTab = "pool";
var draft = null;          // model id -> { enabled, images, budget }
var draftRegion = null;
/**
 * Identity of the draft: the region plus the exact set of model ids it was
 * built from. The first render runs before any state has arrived, so a draft
 * built then would otherwise be reused for a model list it knows nothing about
 * (every row would read `undefined`). Keying on the id set also means a catalog
 * that gains or loses a model rebuilds the draft, while a plain refresh of the
 * same list leaves the user's unsaved edits alone.
 */
var draftKey = null;
var busy = null;           // id of the control awaiting a response
var checkinBusy = null;
var doctorResult = null;

// ----------------------------------------------------------------- render

function regionLabel(region, short) {
  if (region === "global") return t(short ? "region.globalShort" : "region.global");
  return t(short ? "region.cnShort" : "region.cn");
}

function accountsOf(region) {
  return (state && state.accounts ? state.accounts : []).filter(function (a) { return a.region === region; });
}

function modelsOf(region) {
  return (state && state.models ? state.models : []).filter(function (m) { return m.region === region; });
}

function renderHeader() {
  var accounts = state ? state.accounts || [] : [];
  var cooling = accounts.filter(function (a) { return a.cooling; }).length;
  var healthy = accounts.length > 0 && cooling < accounts.length;
  var dot = $("healthDot");
  dot.className = "dot " + (state === null ? "idle" : (healthy ? "ok" : "idle"));

  $("barTitle").textContent = "pi-desktop-workbuddy";
  var sub = state === null
    ? t("state.loading")
    : t("pool.summary", { count: accounts.length, cooling: cooling });
  // The first paint comes from cache while detection runs behind it, so say so
  // instead of leaving the user to wonder why the numbers are not final yet.
  if (state && state.refreshing === true) sub = sub + " · " + t("state.refreshing");
  $("barSub").textContent = sub;

  $("rescanBtn").textContent = t("btn.rescan");
  $("resetBtn").textContent = t("btn.reset");
  $("refreshBtn").textContent = busy !== null ? t("btn.refreshing") : t("btn.refresh");
  $("rescanBtn").disabled = busy !== null;
  $("resetBtn").disabled = busy !== null;
  $("refreshBtn").disabled = busy !== null;

  // The host discovers a provider's models from this plugin's endpoint, so a
  // changed list usually lands by itself; the banner still fires when the
  // declaration could not be written at all, or when the saved selection no
  // longer matches the live roster (which is why a save can look ignored).
  //
  // Address drift outranks both: it is the state that surfaces to the user as
  // net::ERR_CONNECTION_REFUSED, and a model issue is invisible until it is
  // fixed anyway.
  var stale = state && state.staleSelectionRegions ? state.staleSelectionRegions : [];
  if (state && state.addressDrift === true) {
    note(t("models.addressDrift"), "warn");
  } else if (state && state.declaration && state.declaration.ok === false) {
    note(t("models.reload"), "warn");
  } else if (stale.length > 0) {
    note(t("models.staleSelection", { region: regionLabel(stale[0], false) }), "warn");
  }
}

function renderRegionTabs() {
  var host = $("regionTabs");
  clear(host);
  var regions = state && state.regions && state.regions.length ? state.regions : ["cn"];
  if (regions.indexOf(activeRegion) < 0) activeRegion = regions[0];
  regions.forEach(function (region) {
    var button = el("button", region === activeRegion ? "active" : "");
    button.type = "button";
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", region === activeRegion ? "true" : "false");
    button.textContent = regionLabel(region, false);
    var count = accountsOf(region).length;
    if (count > 0) {
      var badge = el("span", "muted", " " + count);
      button.appendChild(badge);
    }
    button.addEventListener("click", function () {
      activeRegion = region;
      draft = null;
      draftRegion = null;
      draftKey = null;
      render();
    });
    host.appendChild(button);
  });
}

function renderPoolStrip() {
  var strip = $("poolStrip");
  clear(strip);
  var accounts = accountsOf(activeRegion);
  var cooling = accounts.filter(function (a) { return a.cooling; }).length;
  strip.appendChild(el("strong", null, t("pool.summary", { count: accounts.length, cooling: cooling })));
  var noteText = accounts.length === 0
    ? ""
    : (cooling >= accounts.length ? t("pool.allCooling") : t("pool.healthy"));
  if (noteText) strip.appendChild(el("span", "muted", noteText));
}

function renderDistribution() {
  $("distTitle").textContent = t("dist.title");
  var host = $("distControl");
  clear(host);
  var byRegion = (state && state.distributionByRegion) || {};
  var current = byRegion[activeRegion] || (state && state.distribution) || "priority";
  [["priority", "dist.priority"], ["round-robin", "dist.roundRobin"]].forEach(function (pair) {
    var button = el("button", current === pair[0] ? "active" : "", t(pair[1]));
    button.type = "button";
    button.setAttribute("aria-pressed", current === pair[0] ? "true" : "false");
    button.disabled = busy !== null;
    button.addEventListener("click", function () { setDistribution(pair[0]); });
    host.appendChild(button);
  });
  $("distHint").textContent = current === "round-robin" ? t("dist.hintRoundRobin") : t("dist.hintPriority");
}

function renderAccounts() {
  var host = $("accounts");
  clear(host);
  var accounts = accountsOf(activeRegion);
  if (accounts.length === 0) {
    var empty = el("div", "empty");
    empty.appendChild(el("p", null, t("pool.emptyRegion", { region: regionLabel(activeRegion, false) })));
    empty.appendChild(el("p", "hint", t("pool.emptyHint")));
    host.appendChild(empty);
    return;
  }
  accounts.forEach(function (account) { host.appendChild(accountCard(account)); });
}

function accountCard(account) {
  var card = el("div", "card");

  var head = el("div", "card-head");
  head.appendChild(el("span", "acct-label", account.label));
  head.appendChild(el("span", "region-tag", regionLabel(account.region, true)));
  if (account.active) head.appendChild(el("span", "badge next", t("badge.next")));
  head.appendChild(el("span", "badge " + (account.cooling ? "cool" : "ok"), account.cooling ? t("badge.cooling") : t("badge.healthy")));
  card.appendChild(head);

  var meta = el("div", "model-meta");
  var mins = minutesUntil(account.expiresAt);
  if (mins === null) {
    meta.appendChild(el("span", null, t("acct.noExpiry")));
  } else if (mins <= 10) {
    meta.appendChild(el("span", "finding-fail", t("acct.tokenExpiring", { min: Math.max(0, mins) })));
  } else {
    meta.appendChild(el("span", null, t("acct.token", { time: formatRelative(account.expiresAt) })));
  }
  if (account.cooling && account.cooldownUntil) {
    meta.appendChild(el("span", "finding-fail", t("acct.coolUntil", { time: formatStamp(account.cooldownUntil) })));
  }
  if (num(account.rateLimitHits, 0) > 0) {
    meta.appendChild(el("span", null, t("acct.hits", { hits: account.rateLimitHits })));
  }
  card.appendChild(meta);

  (account.modelCooldowns || []).forEach(function (mc) {
    card.appendChild(el("div", "hint", t("acct.modelCool", { model: mc.modelId, time: formatStamp(mc.until) })));
  });

  // A cold cache on the fast path: the main process has not read this
  // account's billing data yet, so say so instead of showing nothing.
  if (account.probePending === true) {
    card.appendChild(el("div", "hint muted", t("probe.pending")));
  } else if (account.creditsError) {
    card.appendChild(el("div", "hint finding-fail", t("credits.unavailable") + " — " + account.creditsError));
  } else if (account.credits) {
    card.appendChild(creditsBlock(account.credits));
  }

  card.appendChild(checkinBlock(account));
  return card;
}

function creditsBlock(credits) {
  var wrap = el("div", null);
  var head = el("div", "card-head");
  head.appendChild(el("span", "card-title", t("credits.title")));
  if (typeof credits.total === "number") {
    head.appendChild(el("span", "credit-total", String(credits.total)));
  }
  wrap.appendChild(head);

  (credits.packages || []).forEach(function (pack) {
    var row = el("div", "pack");
    row.appendChild(el("span", "pack-name", pack.packageName || "—"));
    var remain = pack.remain === undefined ? "?" : String(pack.remain);
    var size = pack.size === undefined ? "?" : String(pack.size);
    row.appendChild(el("span", "pack-num", t("credits.package", { remain: remain, size: size })));
    if (pack.monthly === true) row.appendChild(el("span", "badge", t("credits.monthly")));
    if (typeof pack.expiresAtMs === "number" && pack.expiresAtMs > 0) {
      var soon = pack.expiresAtMs - Date.now() < 72 * 60 * 60 * 1000;
      row.appendChild(el("span", soon ? "badge cool" : "badge",
        soon ? t("credits.soon") : String(new Date(pack.expiresAtMs).toLocaleDateString())));
    }
    wrap.appendChild(row);
  });
  return wrap;
}

function checkinBlock(account) {
  var wrap = el("div", "checkin");
  wrap.appendChild(el("span", "card-title", t("checkin.title")));

  if (account.checkinError) {
    wrap.appendChild(el("span", "hint finding-fail", account.checkinError));
    return wrap;
  }
  var checkin = account.checkin;
  if (!checkin) {
    wrap.appendChild(el("span", "muted", t("checkin.inactive")));
    return wrap;
  }

  if (checkin.streakDays > 0) wrap.appendChild(el("span", "muted", t("checkin.streak", { days: checkin.streakDays })));
  if (checkin.dailyCredit > 0) wrap.appendChild(el("span", "muted", t("checkin.daily", { credit: checkin.dailyCredit })));
  if (checkin.isStreakDay && checkin.streakBonusCredit > 0) {
    wrap.appendChild(el("span", "badge free", t("checkin.bonus", { days: checkin.streakDays, credit: checkin.streakBonusCredit })));
  }

  if (!checkin.active) {
    wrap.appendChild(el("span", "muted", t("checkin.inactive")));
    return wrap;
  }

  var busyHere = checkinBusy === account.id;
  var button = el("button", "primary small", busyHere
    ? t("checkin.claiming")
    : (checkin.todayCheckedIn ? t("btn.checkinDone") : t("btn.checkin")));
  button.type = "button";
  button.disabled = checkin.todayCheckedIn || busyHere;
  button.addEventListener("click", function () { claimCheckin(account.id); });
  wrap.appendChild(button);

  if (checkin.todayCheckedIn && checkin.todayCredit > 0) {
    wrap.appendChild(el("span", "muted", t("checkin.claimed", { credit: checkin.todayCredit })));
  }
  return wrap;
}

/**
 * The roster view: one checkbox per model, the host's own layout.
 *
 * The heading carries a select-all box (indeterminate while only some rows are
 * ticked), the fetch button, and a search restricted to id / name / alias.
 */
function renderModels() {
  var list = modelsOf(activeRegion);
  var selection = (state && state.selectionByRegion && state.selectionByRegion[activeRegion]) || {};
  var key = activeRegion + "\u0000" + list.map(function (model) { return model.id; }).join("\u0000");
  if (draftKey !== key || draft === null) {
    draft = draftFor(list, selection);
    draftRegion = activeRegion;
    draftKey = key;
  }

  $("modelListTitle").textContent = t("models.serviceModels");
  $("modelSearch").placeholder = t("models.searchModelId");
  $("modelFetchBtn").textContent = busy === "fetch" ? t("models.modelsLoading") : t("models.fetchModelList");
  $("modelFetchBtn").disabled = busy !== null;

  var filter = $("modelSearch").value.trim().toLowerCase();
  var host = $("models");
  clear(host);

  if (list.length === 0) {
    host.appendChild(el("div", "empty", t("models.empty")));
    $("modelSelectAll").checked = false;
    $("modelSelectAll").indeterminate = false;
    $("modelSelectAll").disabled = true;
    renderSaveBar(false);
    renderChosen();
    return;
  }

  var shown = list.filter(function (model) {
    if (!filter) return true;
    return String(model.id).toLowerCase().indexOf(filter) >= 0
      || String(model.name).toLowerCase().indexOf(filter) >= 0
      || String(model.alias || "").toLowerCase().indexOf(filter) >= 0;
  });
  if (shown.length === 0) host.appendChild(el("div", "empty", t("models.noMatch")));

  // The header box reflects the visible rows, matching the host: clearing the
  // search and ticking the box selects everything, filtering narrows it.
  var shownEnabled = shown.filter(function (model) { return draft[model.id] && draft[model.id].enabled; }).length;
  var selectAll = $("modelSelectAll");
  selectAll.disabled = busy !== null;
  selectAll.checked = shown.length > 0 && shownEnabled === shown.length;
  selectAll.indeterminate = shownEnabled > 0 && shownEnabled < shown.length;
  selectAll.title = selectAll.checked ? t("models.deselectAll") : t("models.selectAll");
  selectAll.setAttribute("aria-label", selectAll.title);

  shown.forEach(function (model) { host.appendChild(modelListRow(model)); });
  renderSaveBar(isDirty(list, selection));
  renderChosen();
}

/** One row of the roster: a checkbox plus id, catalog name and limits. */
function modelListRow(model) {
  var entry = draft[model.id];
  var row = el("li", "row");
  var label = el("label", "row-label");

  var box = document.createElement("input");
  box.type = "checkbox";
  box.className = "row-check";
  box.checked = entry.enabled;
  box.disabled = busy !== null;
  box.addEventListener("change", function () {
    entry.enabled = box.checked;
    renderModels();
  });
  label.appendChild(box);

  var copy = el("span", "row-copy");
  copy.appendChild(el("span", "row-id", model.id));
  var display = model.alias ? model.alias : model.name;
  if (display && display !== model.id) {
    copy.appendChild(el("span", "row-name", display));
  }
  label.appendChild(copy);

  var limits = el("span", "row-limits",
    formatTokens(effectiveWindow(model, entry)) + " · " + formatTokens(effectiveOutput(model, entry)));
  label.appendChild(limits);

  // Only an enabled model has a sheet to open, which is what the second view is.
  if (entry.enabled) {
    label.appendChild(el("span", "row-open-hint", "›"));
    label.classList.add("is-openable");
    label.addEventListener("click", function (event) {
      if (event.target instanceof HTMLInputElement) return;
      openModelSheet(model.id);
    });
  }

  row.appendChild(label);
  return row;
}

/**
 * Open one model's sheet.
 *
 * The roster and the sheet are separate views because a work panel is too
 * narrow for the host's side-by-side panes.
 */
/**
 * Open one model's sheet.
 *
 * Both columns stay on screen, so this only marks which model is expanded and
 * scrolls its row into view; nothing is hidden.
 */
function openModelSheet(id) {
  var entry = draft[id];
  if (!entry || !entry.enabled) return;
  entry.open = true;
  selectedModelId = id;
  renderChosen();
  var node = $("chosen");
  if (node && node.scrollIntoView) node.scrollIntoView({ block: "nearest" });
}

/** The sheet view: every enabled model's editor, the selected one expanded. */
function renderChosen() {
  $("modelEditTitle").textContent = t("models.modelConfigurations");
  $("chosenSearch").placeholder = t("models.searchChosen");

  var list = modelsOf(activeRegion);
  var chosen = list.filter(function (model) { return draft[model.id] && draft[model.id].enabled; });
  $("modelEditCount").textContent = String(chosen.length);

  var host = $("chosen");
  clear(host);

  if (chosen.length === 0) {
    host.appendChild(el("div", "empty", t("models.noModelsChosen")));
    return;
  }

  var filter = $("chosenSearch").value.trim().toLowerCase();
  var shown = chosen.filter(function (model) {
    if (!filter) return true;
    return String(model.id).toLowerCase().indexOf(filter) >= 0
      || String(modelName(model)).toLowerCase().indexOf(filter) >= 0;
  });
  if (shown.length === 0) {
    host.appendChild(el("div", "empty", t("models.noChosenMatch")));
    return;
  }

  var host_ul = el("ul", "chosen-list");
  shown.forEach(function (model) { host_ul.appendChild(modelSheetRow(model)); });
  host.appendChild(host_ul);
}

/** The label a model shows in the sheet: the alias when set, else the name. */
function modelName(model) {
  return model.alias ? model.alias : model.name;
}

/** One model's sheet row: summary line plus the collapsible field body. */
function modelSheetRow(model) {
  var entry = draft[model.id];
  var expanded = entry.open === true;
  var row = el("li", "chosen-row");

  var head = el("div", "chosen-head");
  head.appendChild(el("span", "chosen-id", model.id));
  if (model.alias) head.appendChild(el("span", "chosen-alias", model.alias));
  head.appendChild(el("span", "chosen-limits",
    formatTokens(effectiveWindow(model, entry)) + " · " + formatTokens(effectiveOutput(model, entry))));

  var advanced = el("button", expanded ? "chosen-advanced on" : "chosen-advanced", t("models.advanced"));
  advanced.type = "button";
  advanced.setAttribute("aria-expanded", expanded ? "true" : "false");
  advanced.addEventListener("click", function () {
    entry.open = !entry.open;
    renderChosen();
  });
  head.appendChild(advanced);

  var remove = el("button", "chosen-remove", "×");
  remove.type = "button";
  remove.title = t("models.removeModel");
  remove.setAttribute("aria-label", t("models.removeModel"));
  remove.addEventListener("click", function () {
    entry.enabled = false;
    entry.open = false;
    // Removing the model being edited returns to the roster.
    if (selectedModelId === model.id) selectedModelId = null;
    renderModels();
  });
  head.appendChild(remove);
  row.appendChild(head);

  if (!expanded) return row;
  row.appendChild(modelSheetBody(model, entry));
  return row;
}

/** The model whose sheet is open, or null while the roster is showing. */
var selectedModelId = null;

/**
 * The presets the host's own model editor offers, so a value picked here lands
 * on the same ladder. Kept in this order: the chips render left to right.
 */
var CONTEXT_WINDOW_PRESETS = [
  { label: "128k", tokens: 128000 },
  { label: "256k", tokens: 256000 },
  { label: "312k", tokens: 312000 },
  { label: "500k", tokens: 500000 },
  { label: "1M", tokens: 1000000 },
];
var MAX_OUTPUT_PRESETS = [
  { label: "4k", tokens: 4000 },
  { label: "8k", tokens: 8000 },
  { label: "16k", tokens: 16000 },
  { label: "32k", tokens: 32000 },
  { label: "128k", tokens: 128000 },
];
/** Every level the host's reasoning menu can carry, in its own order. */
var THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** A fresh editable draft built from the server's document for one region. */
function draftFor(list, selection) {
  var enabled = selection.enabledModelIds;
  var overrides = selection.overrides || {};
  var out = {};
  list.forEach(function (model) {
    var saved = overrides[model.id] || {};
    out[model.id] = {
      enabled: enabled === undefined || enabled.indexOf(model.id) >= 0,
      // An absent field means "follow the catalog", which the editor shows as
      // the untouched state rather than a value of its own.
      alias: typeof saved.alias === "string" ? saved.alias : "",
      window: typeof saved.contextWindow === "number" ? saved.contextWindow : null,
      output: typeof saved.maxOutputTokens === "number" ? saved.maxOutputTokens : null,
      images: typeof saved.supportsImages === "boolean" ? saved.supportsImages : null,
      levels: Array.isArray(saved.thinkingLevels) ? saved.thinkingLevels.slice() : null,
      defaultLevel: typeof saved.defaultThinkingLevel === "string" ? saved.defaultThinkingLevel : null,
      open: false,
    };
  });
  // The sheet reopens on whatever it was showing, when that model still exists.
  if (selectedModelId && out[selectedModelId]) out[selectedModelId].open = true;
  return out;
}

/** The window a model currently advertises, override first. */
function effectiveWindow(model, entry) {
  return entry.window === null ? model.nativeContextWindow : entry.window;
}
function effectiveOutput(model, entry) {
  return entry.output === null ? model.nativeMaxOutputTokens : entry.output;
}
function effectiveImages(model, entry) {
  return entry.images === null ? model.nativeSupportsImages === true : entry.images;
}
/** The levels a model offers: the user's set, else the catalog's. */
function effectiveLevels(model, entry) {
  if (entry.levels !== null) return entry.levels;
  return Array.isArray(model.nativeThinkingLevels) ? model.nativeThinkingLevels : [];
}

/** True when the draft differs from what the main process last reported. */
function isDirty(list, selection) {
  var enabled = selection.enabledModelIds;
  var overrides = selection.overrides || {};
  for (var i = 0; i < list.length; i += 1) {
    var model = list[i];
    var entry = draft[model.id];
    if (!entry) continue;
    if (entry.enabled !== (enabled === undefined || enabled.indexOf(model.id) >= 0)) return true;
    var saved = overrides[model.id] || {};
    if (entry.alias !== (typeof saved.alias === "string" ? saved.alias : "")) return true;
    if (entry.window !== (typeof saved.contextWindow === "number" ? saved.contextWindow : null)) return true;
    if (entry.output !== (typeof saved.maxOutputTokens === "number" ? saved.maxOutputTokens : null)) return true;
    if (entry.images !== (typeof saved.supportsImages === "boolean" ? saved.supportsImages : null)) return true;
    if ((entry.levels === null ? null : entry.levels.join(","))
      !== (Array.isArray(saved.thinkingLevels) ? saved.thinkingLevels.join(",") : null)) return true;
    if (entry.defaultLevel !== (typeof saved.defaultThinkingLevel === "string" ? saved.defaultThinkingLevel : null)) return true;
  }
  return false;
}

/** A preset chip row: the chip matching the current value is highlighted. */
function presetRow(presets, value, onPick) {
  var wrap = el("div", "preset-row");
  presets.forEach(function (preset) {
    var chip = el("button", preset.tokens === value ? "preset active" : "preset", preset.label);
    chip.type = "button";
    chip.setAttribute("aria-pressed", preset.tokens === value ? "true" : "false");
    chip.addEventListener("click", function () { onPick(preset.tokens); });
    wrap.appendChild(chip);
  });
  return wrap;
}

/** A labelled field with an optional "?" hint, mirroring the host's layout. */
function field(labelKey, helpKey, control) {
  var wrap = el("div", "field");
  var head = el("div", "field-head");
  head.appendChild(el("span", "field-label", t(labelKey)));
  if (helpKey) {
    var hint = el("span", "field-help", "?");
    hint.title = t(helpKey);
    hint.setAttribute("aria-label", t(helpKey));
    head.appendChild(hint);
  }
  wrap.appendChild(head);
  wrap.appendChild(control);
  return wrap;
}

/** A checkbox row whose label carries its own hint. */
function checkRow(labelKey, checked, onChange, disabled, noteKey) {
  var label = el("label", disabled ? "check disabled" : "check");
  var box = document.createElement("input");
  box.type = "checkbox";
  box.checked = checked;
  box.disabled = disabled === true;
  box.addEventListener("change", function () { onChange(box.checked); });
  label.appendChild(box);
  label.appendChild(el("span", null, t(labelKey)));
  if (noteKey) {
    var hint = el("span", "field-help", "?");
    hint.title = t(noteKey);
    hint.setAttribute("aria-label", t(noteKey));
    label.appendChild(hint);
  }
  return label;
}

/**
 * One model's editor.
 *
 * The collapsed row is the summary the host shows: id, window · output, the
 * "高级" badge once anything is edited, and a remove button. Expanding it
 * reveals the editable fields. Everything is a draft until Save.
 */
/**
 * The editable fields of one model, as the host's sheet lays them out.
 *
 * Nothing here writes through: every control mutates the draft, and Save sends
 * the whole set. That is what makes the save bar meaningful and lets a field be
 * put back to "follow the catalog" by clearing it.
 */
function modelSheetBody(model, entry) {
  var body = el("div", "sheet-body");

  // Alias
  var aliasInput = document.createElement("input");
  aliasInput.type = "text";
  aliasInput.className = "text-input";
  aliasInput.value = entry.alias;
  aliasInput.placeholder = t("models.aliasPlaceholder");
  // The save bar tracks the draft, so typing an alias has to refresh it: an
  // edit that never reveals Save would look like it was not recorded.
  aliasInput.addEventListener("input", function () {
    entry.alias = aliasInput.value;
    var sel = (state.selectionByRegion || {})[activeRegion] || {};
    renderSaveBar(isDirty(modelsOf(activeRegion), sel));
  });
  body.appendChild(field("models.alias", "models.aliasHelp", aliasInput));

  // Context window and max output, side by side on a wide enough panel.
  var windowInput = numberInput(effectiveWindow(model, entry), function (next) {
    // A value equal to the catalog's is stored as "no override", so the row
    // keeps following the catalog instead of pinning today's number.
    entry.window = next === model.nativeContextWindow ? null : next;
    renderChosen();
  });
  var windowCol = field("models.window", "models.windowFollows", windowInput);
  windowCol.insertBefore(presetRow(CONTEXT_WINDOW_PRESETS, effectiveWindow(model, entry), function (tokens) {
    entry.window = tokens === model.nativeContextWindow ? null : tokens;
    renderChosen();
  }), windowInput);

  var outputInput = numberInput(effectiveOutput(model, entry), function (next) {
    entry.output = next === model.nativeMaxOutputTokens ? null : next;
    renderChosen();
  });
  var outputCol = field("models.maxOutput", "models.outputHelp", outputInput);
  outputCol.insertBefore(presetRow(MAX_OUTPUT_PRESETS, effectiveOutput(model, entry), function (tokens) {
    entry.output = tokens === model.nativeMaxOutputTokens ? null : tokens;
    renderChosen();
  }), outputInput);

  var pair = el("div", "field-pair");
  pair.appendChild(windowCol);
  pair.appendChild(outputCol);
  body.appendChild(pair);

  // Thinking levels
  var levels = effectiveLevels(model, entry);
  var levelsWrap = el("div", "field");
  var levelsHead = el("div", "field-head");
  levelsHead.appendChild(el("span", "field-label", t("models.levels")));

  var defaultWrap = el("span", "default-level");
  defaultWrap.appendChild(el("span", "field-label", t("models.defaultLevel")));
  var defaultSelect = document.createElement("select");
  defaultSelect.className = "select";
  THINKING_LEVELS.forEach(function (level) {
    if (levels.indexOf(level) < 0) return;
    var option = document.createElement("option");
    option.value = level;
    option.textContent = level;
    defaultSelect.appendChild(option);
  });
  var chosenDefault = entry.defaultLevel !== null ? entry.defaultLevel : (levels[0] || "off");
  if (levels.indexOf(chosenDefault) < 0) chosenDefault = levels[0] || "off";
  defaultSelect.value = chosenDefault;
  defaultSelect.addEventListener("change", function () {
    entry.defaultLevel = defaultSelect.value;
    renderSaveBar(isDirty(modelsOf(activeRegion), (state.selectionByRegion || {})[activeRegion] || {}));
  });
  defaultWrap.appendChild(defaultSelect);
  levelsHead.appendChild(defaultWrap);
  levelsWrap.appendChild(levelsHead);

  var levelRow = el("div", "level-row");
  THINKING_LEVELS.forEach(function (level) {
    var on = levels.indexOf(level) >= 0;
    var chip = el("button", on ? "level active" : "level", level);
    chip.type = "button";
    chip.setAttribute("aria-pressed", on ? "true" : "false");
    chip.addEventListener("click", function () {
      var next = levels.slice();
      var at = next.indexOf(level);
      if (at >= 0) next.splice(at, 1);
      else next.push(level);
      next = THINKING_LEVELS.filter(function (candidate) { return next.indexOf(candidate) >= 0; });
      // An empty set would mean "no reason menu", which the host cannot
      // express, so clearing every chip restores the catalog's own set.
      entry.levels = next.length === 0 ? null : next;
      if (entry.defaultLevel !== null && entry.levels !== null && entry.levels.indexOf(entry.defaultLevel) < 0) {
        entry.defaultLevel = null;
      }
      renderChosen();
    });
    levelRow.appendChild(chip);
  });
  levelsWrap.appendChild(levelRow);
  body.appendChild(levelsWrap);

  // Attachments
  var attach = el("div", "field");
  attach.appendChild(el("div", "field-head", t("models.capabilities")));
  var attachRow = el("div", "check-row");
  attachRow.appendChild(checkRow("models.imageInput", effectiveImages(model, entry), function (next) {
    entry.images = next === model.nativeSupportsImages ? null : next;
    renderChosen();
  }));
  // The host stores these three as None for a plugin-declared model
  // (crates/host-core/src/plugins/providers.rs), so a control here could never
  // take effect. They stay in place, disabled, with the reason on the help
  // mark, rather than looking editable and quietly doing nothing.
  attachRow.appendChild(checkRow("models.pdfInput", false, function () {}, true, "models.hostOnly"));
  attachRow.appendChild(checkRow("models.imageModel", false, function () {}, true, "models.hostOnly"));
  attachRow.appendChild(checkRow("models.subagents", false, function () {}, true, "models.hostOnly"));
  attachRow.appendChild(checkRow("models.webSearch", false, function () {}, true, "models.hostOnly"));
  attach.appendChild(attachRow);
  body.appendChild(attach);

  return body;
}


function numberInput(value, onChange) {
  var input = document.createElement("input");
  input.type = "number";
  input.className = "num-input";
  input.min = "1";
  input.step = "1000";
  input.value = String(value);
  input.addEventListener("change", function () {
    var next = Number(input.value);
    if (!Number.isFinite(next) || next <= 0) {
      input.value = String(value);
      return;
    }
    onChange(Math.round(next));
  });
  return input;
}

/** Trim trailing zeros from a decimal string: "1.50" -> "1.5", "1.00" -> "1". */
function trimFraction(value) {
  if (value.indexOf(".") < 0) return value;
  return value.replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * A token count as the host's own model sheet writes it.
 *
 * Ported from `formatCompactTokenCount` so a window reads identically here and
 * in Settings: one decimal at the K scale and two at the M scale, because
 * 1,000,000 / 1,048,576 / 1,050,000 are indistinguishable at one decimal and
 * rounding them together would overstate the smaller ones.
 */
function formatTokens(tokens) {
  var n = Number(tokens);
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n < 1000) return String(n);
  var thousands = n / 1000;
  if (Number(thousands.toFixed(1)) < 1000) {
    return trimFraction(thousands.toFixed(1)) + "K";
  }
  return trimFraction((n / 1000000).toFixed(2)) + "M";
}

/**
 * Show or hide the save bar and keep its buttons in step with `busy`.
 *
 * Both branches have to write the button state. A save that makes the draft
 * clean (deselecting a model, say) hides the bar on the very render that ends
 * the save, so an early return here would leave the button reading "saving"
 * and disabled forever - the data lands, but the panel never says so.
 */
function renderSaveBar(dirty) {
  var saving = busy === "save";
  show($("savebar"), dirty === true);
  $("saveBtn").textContent = saving ? t("models.saving") : t("btn.save");
  $("discardBtn").textContent = t("btn.discard");
  $("saveBtn").disabled = saving;
  $("discardBtn").disabled = saving;
  if (dirty === true) $("saveNote").textContent = t("models.dirty");
}

function renderDoctor() {
  $("checkTitle").textContent = t("check.title");
  $("doctorBtn").textContent = t("btn.doctor");
  $("copyBtn").textContent = t("btn.copy");
  $("doctorBtn").disabled = busy === "doctor";
  $("copyBtn").disabled = doctorResult === null;

  var host = $("findings");
  clear(host);
  if (doctorResult === null) {
    host.appendChild(el("div", "hint", t("check.empty")));
    $("report").textContent = "";
    return;
  }
  (doctorResult.findings || []).forEach(function (finding) {
    var row = el("div", "finding");
    row.appendChild(el("span", finding.ok ? "finding-pass" : "finding-fail", finding.ok ? "PASS" : "FAIL"));
    row.appendChild(el("span", "finding-id", finding.id));
    row.appendChild(el("span", "finding-detail", finding.detail));
    host.appendChild(row);
  });
  $("report").textContent = doctorResult.report || "";
}

function renderFooter() {
  var foot = $("foot");
  clear(foot);
  if (state === null) return;
  foot.appendChild(el("span", null, t("foot.version", { version: state.pluginVersion || "?" })));
  var shim = state.shim;
  foot.appendChild(el("span", shim && shim.running ? null : "muted",
    shim && shim.running ? t("foot.shim", { url: shim.baseUrl }) : t("foot.shimOff")));
  if (state.refreshMinutes) foot.appendChild(el("span", null, t("foot.refresh", { min: state.refreshMinutes })));
}

function render() {
  renderHeader();
  renderRegionTabs();
  renderPoolStrip();
  renderDistribution();
  renderAccounts();
  renderModels();
  renderChosen();
  renderDoctor();
  renderFooter();
}

// ---------------------------------------------------------------- actions

function adopt(next) {
  if (next && typeof next === "object") state = next;
}

function runBusy(id, work) {
  busy = id;
  render();
  return work().then(function (result) {
    busy = null;
    if (result && result.accounts) adopt(result);
    note(null);
    render();
    return result;
  }).catch(function (error) {
    busy = null;
    note(String(error && error.message ? error.message : error));
    render();
    throw error;
  });
}

/**
 * Panel poll timer for the background detection pass.
 *
 * The main process answers an open from cache and refreshes behind it, so the
 * panel has to come back for the refreshed document rather than assume the
 * first answer was final.
 */
var refreshPoll = null;
var REFRESH_POLL_MS = 1200;

function stopPolling() {
  if (refreshPoll !== null) {
    window.clearTimeout(refreshPoll);
    refreshPoll = null;
  }
}

/**
 * Adopt one document, then keep asking while the main process reports that a
 * detection pass is still running. Bounded so a permanently failing refresh
 * cannot spin forever.
 */
function adoptAndMaybePoll(next, attempts) {
  adopt(next);
  render();
  if (!next || next.refreshing !== true) { stopPolling(); return; }
  if (attempts >= 15) { stopPolling(); return; }
  stopPolling();
  refreshPoll = window.setTimeout(function () {
    invoke("xd.state").then(function (again) {
      adoptAndMaybePoll(again, attempts + 1);
    }).catch(function () { stopPolling(); });
  }, REFRESH_POLL_MS);
}

function refresh() {
  return runBusy("refresh", function () {
    // The Refresh button asks for a completed detection pass, not the cache.
    return invoke("xd.state", { wait: true });
  }).catch(function () {});
}

function rescan() {
  return runBusy("rescan", function () { return invoke("xd.rescan"); })
    .then(function (next) { announce(t("pool.summary", {
      count: (next.accounts || []).length,
      cooling: (next.accounts || []).filter(function (a) { return a.cooling; }).length,
    })); })
    .catch(function () {});
}

function clearCooldowns() {
  return runBusy("reset", function () { return invoke("xd.resetCooldowns"); }).catch(function () {});
}

function setDistribution(next) {
  return runBusy("distribution", function () {
    return invoke("xd.distribution", { region: activeRegion, distribution: next });
  }).catch(function () {});
}

function claimCheckin(accountId) {
  checkinBusy = accountId;
  render();
  return invoke("xd.checkin", { accountId: accountId }).then(function (payload) {
    checkinBusy = null;
    if (payload && payload.state) adopt(payload.state);
    note(null);
    render();
    if (payload && payload.result && payload.result.credit > 0) {
      announce(t("checkin.claimed", { credit: payload.result.credit }));
    }
  }).catch(function (error) {
    checkinBusy = null;
    note(String(error && error.message ? error.message : error));
    render();
  });
}

/**
 * Tick or untick every row the current filter shows.
 *
 * Scoped to the visible rows on purpose: the header box sits above a filtered
 * list, so "select all" that touched hidden rows would contradict what is on
 * screen (the host does the same).
 */
function toggleAllVisible() {
  var wanted = $("modelSelectAll").checked;
  var filter = $("modelSearch").value.trim().toLowerCase();
  modelsOf(activeRegion).forEach(function (model) {
    if (filter) {
      var hit = String(model.id).toLowerCase().indexOf(filter) >= 0
        || String(model.name).toLowerCase().indexOf(filter) >= 0
        || String(model.alias || "").toLowerCase().indexOf(filter) >= 0;
      if (!hit) return;
    }
    var entry = draft[model.id];
    if (entry) entry.enabled = wanted;
  });
  renderModels();
}

/**
 * Fetch the list: re-read the desktop sign-ins, then re-read each gateway's
 * catalog from the upstream.
 *
 * Both halves matter here. The roster this panel shows comes from WorkBuddy's
 * own catalogue, which is read per signed-in account, so a new account and a
 * changed upstream roster are discovered by the same gesture - which is what
 * the button reads as.
 */
function fetchModelList() {
  return runBusy("fetch", function () { return invoke("xd.rescan"); }).catch(function () {});
}

function discardDraft() {
  draft = null;
  draftRegion = null;
  draftKey = null;
  renderModels();
  note(null);
}

function saveModels() {
  var list = modelsOf(activeRegion);
  var enabledModelIds = [];
  var overrides = {};
  list.forEach(function (model) {
    var entry = draft[model.id];
    if (!entry) return;
    if (entry.enabled) enabledModelIds.push(model.id);
    // Only a field that differs from the catalog is stored: an untouched row
    // must not freeze today's catalog numbers into the settings file.
    var override = {};
    if (entry.alias !== "") override.alias = entry.alias.trim();
    if (entry.window !== null) override.contextWindow = entry.window;
    if (entry.output !== null) override.maxOutputTokens = entry.output;
    if (entry.images !== null) override.supportsImages = entry.images;
    if (entry.levels !== null) override.thinkingLevels = entry.levels;
    if (entry.defaultLevel !== null) override.defaultThinkingLevel = entry.defaultLevel;
    if (Object.keys(override).length > 0) overrides[model.id] = override;
  });

  if (enabledModelIds.length === 0) {
    note(t("models.zeroEnabled"));
    return;
  }

  busy = "save";
  render();
  invoke("xd.saveModels", {
    region: activeRegion,
    selection: { enabledModelIds: enabledModelIds, overrides: overrides },
  }).then(function (next) {
    busy = null;
    adopt(next);
    draft = null;
    draftRegion = null;
    draftKey = null;
    render();
    announce(t("models.saved"));
    // PI-Desktop discovers a provider's models by asking this plugin's loopback
    // endpoint, then caches the answer per provider and only asks again from a
    // cold cache (refreshedProviderModels in the host's catalog-slice.ts). A
    // settings write changes what the endpoint serves without the picker ever
    // re-reading it, so the new list would otherwise appear only after a
    // restart. No plugin-facing channel re-runs that discovery, so the honest
    // move is to name the control that does.
    note(t("models.applyHint"), "warn");
  }).catch(function (error) {
    busy = null;
    note(t("models.saveError", { message: String(error && error.message ? error.message : error) }));
    render();
  });
}

function runDoctor() {
  return runBusy("doctor", function () { return invoke("xd.doctor"); }).then(function (result) {
    doctorResult = result;
    render();
  }).catch(function () {});
}

function copyReport() {
  if (doctorResult === null) return;
  var text = doctorResult.report || "";
  var done = function (ok) { $("copyHint").textContent = ok ? t("copy.ok") : t("copy.fail"); };
  if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
    navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
  } else {
    done(false);
  }
}

// -------------------------------------------------------------------- tabs

function selectTab(name) {
  activeTab = name;
  var views = { pool: "poolView", models: "modelsView", check: "checkView" };
  Object.keys(views).forEach(function (key) {
    show($(views[key]), key === name);
  });
  var tabs = document.querySelectorAll(".tab");
  for (var i = 0; i < tabs.length; i += 1) {
    var isActive = tabs[i].getAttribute("data-tab") === name;
    tabs[i].className = isActive ? "tab active" : "tab";
    tabs[i].setAttribute("aria-selected", isActive ? "true" : "false");
  }
  if (name === "check" && doctorResult === null) runDoctor();
}

function labelTabs() {
  var tabs = document.querySelectorAll(".tab");
  for (var i = 0; i < tabs.length; i += 1) {
    var key = tabs[i].getAttribute("data-tab");
    tabs[i].textContent = t("tab." + key);
  }
}

// -------------------------------------------------------------------- init

function bind() {
  $("refreshBtn").addEventListener("click", refresh);
  $("rescanBtn").addEventListener("click", rescan);
  $("resetBtn").addEventListener("click", clearCooldowns);
  $("doctorBtn").addEventListener("click", runDoctor);
  $("copyBtn").addEventListener("click", copyReport);
  $("saveBtn").addEventListener("click", saveModels);
  $("discardBtn").addEventListener("click", discardDraft);
  $("modelSearch").addEventListener("input", renderModels);
  $("chosenSearch").addEventListener("input", renderChosen);
  $("modelSelectAll").addEventListener("change", toggleAllVisible);
  $("modelFetchBtn").addEventListener("click", fetchModelList);

  var tabs = document.querySelectorAll(".tab");
  for (var i = 0; i < tabs.length; i += 1) {
    (function (button) {
      button.addEventListener("click", function () { selectTab(button.getAttribute("data-tab")); });
    })(tabs[i]);
  }
}

function boot() {
  labelTabs();
  bind();
  if (bridge === null) {
    note(t("err.bridge"));
    return;
  }
  // First paint comes from cache; the poll below picks up the refresh the main
  // process runs behind it, which is what keeps opening the panel fast.
  invoke("xd.state").then(function (next) {
    adoptAndMaybePoll(next, 0);
  }).catch(function (error) {
    note(String(error && error.message ? error.message : error));
    render();
  });
}

boot();
