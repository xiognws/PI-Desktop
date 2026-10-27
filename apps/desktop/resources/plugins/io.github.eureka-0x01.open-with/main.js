"use strict";

/**
 * Open With — PI-Desktop 插件主进程（CommonJS）。
 *
 * 应用列表两层结构：
 *   ① 内置默认：系统文件管理器（explorer / open / xdg-open）——硬编码、
 *      locked，不可编辑、不可删除，任何机器都有；
 *   ② 自定义应用：存插件 settings 的 apps 数组，{ id, label, command, args }，
 *      args 里的 "{{dir}}" 会替换成当前工作目录。
 *
 * rendererCallMethods：open / list / add / update / remove。
 * 拉起方式沿用 pi-open-in-vscode 验证过的模式：detached + stdio ignore，
 * spawn 事件即成功（explorer.exe 退出码不可靠，不能当失败信号）。
 */

const { spawn } = require("node:child_process");
const { existsSync } = require("node:fs");

/** 内置打开方式（锁定，不在用户可编辑的列表里）。 */
const BUILTIN_APPS = [
  { id: "explorer", label: "File Explorer", locked: true, builtin: true },
];

/** 名称 / id 上限。 */
const MAX_LABEL = 40;
const MAX_APPS = 32;

/** Windows PowerShell 绝对路径（插件进程拿不到宿主 PATH，绝对路径最稳）。 */
const POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
// plugin.call 的宿主时限为 2 秒；图标只是可选展示，超时回退默认图标。
const ICON_TIMEOUT_MS = 1000;
const ICON_MAX_BASE64 = 200 * 1024;

/** 弹应用内 toast。 */
function toast(message) {
  if (typeof pi === "object" && pi && pi.ui && typeof pi.ui.showToast === "function") {
    return Promise.resolve(pi.ui.showToast(message));
  }
  return Promise.resolve();
}

/** 读当前工作区绝对路径；没有打开项目时返回 null。 */
async function readWorkspacePath() {
  const workspace = await pi.workspace.get();
  if (!workspace) {
    return null;
  }
  if (typeof workspace.path !== "string" || workspace.path.trim() === "") {
    return null;
  }
  return workspace.path;
}

/** 自定义应用列表（存插件 settings.apps）。 */
async function readCustomApps() {
  try {
    const settings = (await pi.plugin.getSettings()) ?? {};
    return Array.isArray(settings.apps) ? settings.apps : [];
  } catch (_error) {
    return [];
  }
}

/** 写回自定义应用列表（保留 settings 其他键）。 */
async function writeCustomApps(apps) {
  const settings = (await pi.plugin.getSettings()) ?? {};
  await pi.plugin.setSettings({ ...settings, apps });
}

/** 全部打开方式 = 内置 + 自定义。 */
async function listApps() {
  return [...BUILTIN_APPS, ...(await readCustomApps())];
}

/**
 * 全局选中的打开方式（settings.selectedApp，跨会话持久）。
 * 主按钮始终用它打开；列表里点应用行 = 切换选中（并立即用它打开一次）。
 * 缺省 "explorer"（内置默认）；指向已删除的应用时回落 explorer。
 */
async function readSelectedApp() {
  try {
    const settings = (await pi.plugin.getSettings()) ?? {};
    const id = typeof settings.selectedApp === "string" ? settings.selectedApp.trim() : "";
    if (!id) {
      return "explorer";
    }
    const apps = await listApps();
    return apps.some(function (app) { return app && app.id === id; }) ? id : "explorer";
  } catch (_error) {
    return "explorer";
  }
}

async function writeSelectedApp(id) {
  const settings = (await pi.plugin.getSettings()) ?? {};
  await pi.plugin.setSettings({ ...settings, selectedApp: id });
}

/** label → id（小写、[a-z0-9-]）。 */
function slugify(label) {
  const slug = String(label)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "app";
}

/** 内置 explorer 的跨平台命令。 */
function builtinExplorerPlan(platform) {
  if (platform === "win32") {
    return { command: "explorer", args: [] };
  }
  if (platform === "darwin") {
    return { command: "open", args: [] };
  }
  return { command: "xdg-open", args: [] };
}

/**
 * 拉起命令后立刻返回，不等应用退出。
 * 以 spawn 事件为成功信号（进程起来了就算打开），error 为失败。
 */
function runCommand(command, args) {
  return new Promise(function (resolve, reject) {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    let settled = false;
    child.once("error", function (error) {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    });
    child.once("spawn", function () {
      if (settled) {
        return;
      }
      settled = true;
      child.unref();
      resolve();
    });
  });
}

/**
 * 拉起命令并捕获 stdout（带超时）。图标提取用：PowerShell 输出 base64。
 * 与 runCommand 的区别：不 detached、收集输出、失败/超时返回 {ok:false}。
 */
function spawnCapture(command, args, timeoutMs) {
  return new Promise(function (resolve) {
    let child;
    try {
      child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"] });
    } catch (_error) {
      resolve({ ok: false });
      return;
    }
    let out = "";
    let settled = false;
    const finish = function (result) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(function () {
      try {
        child.kill();
      } catch (_error) {
        /* 已退出 */
      }
      finish({ ok: false });
    }, timeoutMs);
    child.stdout.on("data", function (chunk) {
      out += String(chunk);
    });
    child.once("error", function () {
      finish({ ok: false });
    });
    child.once("close", function (code) {
      finish({ ok: code === 0, stdout: out });
    });
  });
}

/**
 * 提取 exe 的图标为 data URI（Windows：System.Drawing.ExtractAssociatedIcon，
 * 32×32 PNG base64，仅读取该 exe 的图标资源）。失败返回 null（列表回退图标）。
 */
async function extractIconBase64(command) {
  if (process.platform !== "win32" || !existsSync(POWERSHELL) || !existsSync(command)) {
    return null;
  }
  const escaped = String(command).replace(/'/g, "''");
  const script =
    "Add-Type -AssemblyName System.Drawing; " +
    "try { $i = [System.Drawing.Icon]::ExtractAssociatedIcon('" + escaped + "'); " +
    "if ($null -eq $i) { exit 1 }; " +
    "$b = $i.ToBitmap(); " +
    "$m = New-Object System.IO.MemoryStream; " +
    "$b.Save($m, [System.Drawing.Imaging.ImageFormat]::Png); " +
    "[Convert]::ToBase64String($m.ToArray()) } catch { exit 1 }";
  const result = await spawnCapture(
    POWERSHELL,
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    ICON_TIMEOUT_MS,
  );
  if (!result.ok || typeof result.stdout !== "string") {
    return null;
  }
  const b64 = result.stdout.trim();
  if (b64.length < 32 || b64.length > ICON_MAX_BASE64 || !/^[A-Za-z0-9+/=]+$/.test(b64)) {
    return null;
  }
  return "data:image/png;base64," + b64;
}
/** 参数模板里的 {{dir}} 替换成实际目录。 */
function fillArgs(args, dir) {
  return args.map(function (part) {
    return String(part).replaceAll("{{dir}}", dir);
  });
}

/**
 * 清洗粘贴的路径/名称：去掉 Unicode 隐形字符（方向控制符 U+202A-202E、
 * 零宽字符 U+200B-200F/U+2066-2069、BOM、软连字符）和首尾引号。
 * 从网页/聊天窗口复制路径时经常混入这类字符，肉眼完全看不见，
 * 但 spawn 会因路径不匹配而 ENOENT（这正是"打不开 vscode"的根因）。
 */
const INVISIBLE_CHARS = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF\u00AD]/g;

function sanitizePasted(value) {
  return String(value)
    .replace(INVISIBLE_CHARS, "")
    .trim()
    // 剥掉包裹的直引号/弯引号（“复制文件地址”常带引号，spawn 不需要）
    .replace(/^["'\u201C\u2018](.*)["'\u201D\u2019]$/, "$1")
    .trim();
}

/** 规整字符串入参。 */
function asString(value) {
  return typeof value === "string" ? value : "";
}
/** 校验并规整一个应用条目；不合法时返回 null。 */
function normalizeAppFields(payload) {
  const label = sanitizePasted(payload?.label);
  const command = sanitizePasted(payload?.command);
  if (!label || label.length > MAX_LABEL) {
    return null;
  }
  if (!command) {
    return null;
  }
  let args = ["{{dir}}"];
  if (Array.isArray(payload?.args)) {
    if (payload.args.some(function (part) { return typeof part !== "string" || !part.trim(); })) {
      return null;
    }
    args = payload.args.slice(0, 16);
  } else if (typeof payload?.args === "string" && payload.args.trim()) {
    // 允许字符串简写：留空 = ["{{dir}}"]，"[...]" 尝试 JSON 数组，其余按单个参数
    const text = payload.args.trim();
    if (text.startsWith("[")) {
      try {
        const parsed = JSON.parse(text);
        if (!Array.isArray(parsed) || parsed.some(function (p) { return typeof p !== "string"; })) {
          return null;
        }
        args = parsed;
      } catch (_error) {
        return null;
      }
    } else {
      args = [text];
    }
  }
  return { label, command, args };
}

/** 用指定应用打开当前工作目录。 */
async function openWorkspaceWith(appId) {
  const id = asString(appId).trim() || "explorer";

  const dir = await readWorkspacePath();
  if (!dir) {
    return { ok: false, message: "当前没有打开的项目，没有可打开的目录。" };
  }

  const apps = await listApps();
  const app = apps.find(function (candidate) {
    return candidate && candidate.id === id;
  });
  if (!app) {
    return { ok: false, message: `没有找到打开方式 "${id}"。` };
  }

  let plan;
  if (app.id === "explorer") {
    const platformPlan = builtinExplorerPlan(process.platform);
    plan = { command: platformPlan.command, args: [...platformPlan.args, dir] };
  } else if (typeof app.command === "string" && app.command.trim()) {
    // 打开时再清洗一次：历史保存的条目可能带隐形字符（如 U+202A）或引号
    const command = sanitizePasted(app.command);
    if (!command) {
      return { ok: false, message: `打开方式 "${app.label ?? id}" 没有可用的程序路径。` };
    }
    plan = {
      command,
      args: fillArgs(Array.isArray(app.args) ? app.args.map(String) : ["{{dir}}"], dir),
    };
  } else {
    return { ok: false, message: `打开方式 "${app.label ?? id}" 没有配置可执行命令。` };
  }

  try {
    await runCommand(plan.command, plan.args);
    return { ok: true, message: `已用 ${app.label ?? id} 打开 ${dir}` };
  } catch (error) {
    const code = error && error.code ? String(error.code) : "";
    const reason = code === "ENOENT"
      ? "路径不存在（或粘贴时混入了不可见字符，请重新复制粘贴）"
      : code === "EACCES" || code === "EPERM"
        ? "没有执行权限"
        : `启动失败${code ? `（${code}）` : ""}`;
    return {
      ok: false,
      message: `打不开 ${app.label ?? id}：${reason}。${plan.command}`,
    };
  }
}

/** Windows 上要求命令以 .exe 结尾（用户粘贴 exe 文件的完整路径）。 */
function commandExtensionError(command) {
  if (process.platform === "win32" && !/\.exe$/i.test(command)) {
    return "程序路径必须以 .exe 结尾——请粘贴 exe 文件的完整路径。";
  }
  return null;
}

/** 保存时校验绝对路径确实存在（相对命令无从校验，打开时报错兜底）。 */
function commandExistenceError(command) {
  if (process.platform === "win32" && /^[A-Za-z]:[\\/]/.test(command) && !existsSync(command)) {
    return `文件不存在，请检查路径：${command}`;
  }
  return null;
}
/** 添加自定义应用。 */
async function addApp(payload) {
  const fields = normalizeAppFields(payload);
  if (!fields) {
    return { ok: false, message: "名称与程序路径不能为空（名称 ≤ 40 字符）。" };
  }
  const extError = commandExtensionError(fields.command);
  if (extError) {
    return { ok: false, message: extError };
  }
  const existsError = commandExistenceError(fields.command);
  if (existsError) {
    return { ok: false, message: existsError };
  }

  const custom = await readCustomApps();
  if (custom.length >= MAX_APPS) {
    return { ok: false, message: `最多 ${MAX_APPS} 个自定义应用。` };
  }

  // id：优先用传入的合法 slug，否则从名称生成；撞号则追加序号
  let id = /^[a-z0-9][a-z0-9-]*$/.test(asString(payload?.id).trim())
    ? payload.id.trim()
    : slugify(fields.label);
  const taken = new Set(custom.map(function (app) { return app?.id; }));
  if (taken.has(id) || BUILTIN_APPS.some(function (app) { return app.id === id; })) {
    let n = 2;
    while (taken.has(`${id}-${n}`)) {
      n += 1;
    }
    id = `${id}-${n}`;
  }

  // 保存时顺带提取 exe 图标（PowerShell + System.Drawing；失败则无图标，列表回退）
  const icon = await extractIconBase64(fields.command);
  const entry = { id, label: fields.label, command: fields.command, args: fields.args };
  if (icon) {
    entry.icon = icon;
  }
  custom.push(entry);
  await writeCustomApps(custom);
  return { ok: true, apps: await listApps(), message: `已添加 ${fields.label}` };
}

/** 修改自定义应用（内置 explorer 拒绝）。 */
async function updateApp(payload) {
  const id = asString(payload?.id).trim();
  if (!id) {
    return { ok: false, message: "缺少应用 id。" };
  }
  if (BUILTIN_APPS.some(function (app) { return app.id === id; })) {
    return { ok: false, message: "内置打开方式不可编辑。" };
  }

  const custom = await readCustomApps();
  const index = custom.findIndex(function (app) { return app && app.id === id; });
  if (index < 0) {
    return { ok: false, message: `没有找到应用 "${id}"。` };
  }

  // 允许局部更新：没传的字段保持原值
  const current = custom[index];
  const merged = normalizeAppFields({
    label: payload?.label !== undefined ? payload.label : current.label,
    command: payload?.command !== undefined ? payload.command : current.command,
    args: payload?.args !== undefined ? payload.args : current.args,
  });
  if (!merged) {
    return { ok: false, message: "名称与程序路径不能为空（名称 ≤ 40 字符）。" };
  }
  const extError = commandExtensionError(merged.command);
  if (extError) {
    return { ok: false, message: extError };
  }
  const existsError = commandExistenceError(merged.command);
  if (existsError) {
    return { ok: false, message: existsError };
  }

  // 命令变化（或历史条目还没有图标）时重新提取；否则沿用旧图标
  let icon = current.icon;
  if (merged.command !== current.command || !icon) {
    icon = await extractIconBase64(merged.command);
  }
  const updatedEntry = { ...current, label: merged.label, command: merged.command, args: merged.args };
  if (icon) {
    updatedEntry.icon = icon;
  } else {
    delete updatedEntry.icon;
  }
  custom[index] = updatedEntry;
  await writeCustomApps(custom);
  return { ok: true, apps: await listApps(), message: `已更新 ${merged.label}` };
}

/** 删除自定义应用（内置 explorer 拒绝）。 */
async function removeApp(payload) {
  const id = asString(payload?.id).trim();
  if (!id) {
    return { ok: false, message: "缺少应用 id。" };
  }
  if (BUILTIN_APPS.some(function (app) { return app.id === id; })) {
    return { ok: false, message: "内置打开方式不可删除。" };
  }

  const custom = await readCustomApps();
  const next = custom.filter(function (app) { return !(app && app.id === id); });
  if (next.length === custom.length) {
    return { ok: false, message: `没有找到应用 "${id}"。` };
  }

  await writeCustomApps(next);
  // 删的是当前选中 → 全局选中回落 explorer
  if ((await readSelectedApp()) === id) {
    await writeSelectedApp("explorer");
  }
  return { ok: true, apps: await listApps(), selected: await readSelectedApp(), message: "已删除" };
}

/**
 * plugin.call 的落地钩子。兼容 (method, args) 与 ({method, args}) 两种形态。
 * open 动作自带 toast；增删改的结果 toast 也在这里发（渲染端只展示数据与表单错误）。
 */
async function onRendererCall(method, args) {
  const request = method && typeof method === "object" ? method : null;
  const name = request ? String(request.method ?? "") : String(method ?? "");
  const payload = request ? request.args : args;

  if (name === "open") {
    // 显式传 id 用之（点应用行/切换后立即打开）；主按钮不传 id → 全局选中
    const appId = typeof payload?.id === "string" && payload.id.trim()
      ? payload.id.trim()
      : await readSelectedApp();
    const result = await openWorkspaceWith(appId);
    await toast(result.message);
    return result;
  }

  if (name === "select") {
    // 列表点行：切换全局选中（持久），返回新选中供按钮刷新
    const id = asString(payload?.id).trim();
    if (!id) {
      return { ok: false, message: "缺少应用 id。" };
    }
    const apps = await listApps();
    if (!apps.some(function (app) { return app && app.id === id; })) {
      return { ok: false, message: `没有找到打开方式 "${id}"。` };
    }
    await writeSelectedApp(id);
    const app = apps.find(function (candidate) { return candidate.id === id; });
    return { ok: true, selected: id, label: app.label ?? id };
  }

  if (name === "list") {
    return { ok: true, apps: await listApps(), selected: await readSelectedApp() };
  }
  if (name === "add") {
    const result = await addApp(payload);
    if (result.ok) {
      await toast(result.message);
    }
    return result;
  }

  if (name === "update") {
    const result = await updateApp(payload);
    if (result.ok) {
      await toast(result.message);
    }
    return result;
  }

  if (name === "remove") {
    const result = await removeApp(payload);
    if (result.ok) {
      await toast(result.message);
    }
    return result;
  }

  throw new Error(`open-with: unknown renderer call method "${name}"`);
}

/** 插件加载：无命令（入口是输入框旁的插槽按钮 + 弹层）。 */
async function onLoad() {
  // 预留：后续可为每个应用注册命令面板条目。
}

/** 插件卸载。 */
async function onUnload() {
  // nothing to tear down
}

module.exports = { onLoad, onUnload, onRendererCall };
