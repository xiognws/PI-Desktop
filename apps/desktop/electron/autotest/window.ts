/**
 * Autotest 独立工作台窗口。
 *
 * 为什么是独立 BrowserWindow 而不是 plugin panel：panel 是
 * `sandbox: true` 的固定 46px 拖拽带 + 右上三键胶囊，页面网络还要过
 * `net.domains` 的 webRequest 过滤。测试工作台要自己设计布局，也得能直接
 * 用 loopback 跟本机 FastAPI 通信，所以用普通窗口 + 后端托管的同源页面。
 *
 * 这个模块只放纯逻辑和窗口装配，不 import `electron`：`node --test` 要能
 * 直接跑它，`BrowserWindow` 由调用方注入。
 */

export type ServiceStatus = "idle" | "starting" | "ready" | "failed" | "stopped";

export type ServiceSnapshot = {
  status: ServiceStatus;
  port?: number;
};

export const AUTOTEST_WINDOW_WIDTH = 1180;
export const AUTOTEST_WINDOW_HEIGHT = 760;
export const AUTOTEST_WINDOW_MIN_WIDTH = 720;
export const AUTOTEST_WINDOW_MIN_HEIGHT = 480;

/** 只认 loopback：窗口加载的是本机服务，任何外部地址都不该进这个窗口。 */
export function isLoopbackUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:") return false;
    return url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  } catch {
    return false;
  }
}

/**
 * 服务 ready 且端口合法才返回地址；其余状态返回 null，让调用方给出可读
 * 提示，而不是打开一个必然白屏的窗口。
 */
export function autotestWorkbenchUrl(port: number | null | undefined, host = "127.0.0.1"): string | null {
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  const url = `http://${host}:${port}/`;
  return isLoopbackUrl(url) ? url : null;
}

export type AutotestWindowOptions = {
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
  title: string;
  show: boolean;
  autoHideMenuBar: boolean;
  backgroundColor: string;
  webPreferences: {
    contextIsolation: boolean;
    nodeIntegration: boolean;
    sandbox: boolean;
    webviewTag: boolean;
  };
};

export function autotestWindowOptions(title: string): AutotestWindowOptions {
  return {
    width: AUTOTEST_WINDOW_WIDTH,
    height: AUTOTEST_WINDOW_HEIGHT,
    minWidth: AUTOTEST_WINDOW_MIN_WIDTH,
    minHeight: AUTOTEST_WINDOW_MIN_HEIGHT,
    title,
    // 先隐藏，did-finish-load 之后再显示，避免白屏闪一下。
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#101418",
    webPreferences: {
      // 后端页面是外部内容：不给 Node、不给 preload，也不允许嵌 webview。
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  };
}

export type AutotestWindowLike = {
  loadURL(url: string): Promise<unknown>;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  setMenu(menu: null): void;
  isDestroyed?(): boolean;
  focus?(): void;
  webContents?: {
    setWindowOpenHandler?(handler: () => { action: "deny" | "allow" }): void;
  };
};

export type CreateWindow = (options: AutotestWindowOptions) => AutotestWindowLike;

/**
 * 装配窗口并把外部导航掐死：`window.open`、拖拽进来的链接、页面内跳转到
 * 公网，都只允许留在 loopback。
 */
export function createAutotestWindow(
  deps: { url: string; title: string; createWindow: CreateWindow; log?: (message: string) => void },
): AutotestWindowLike {
  const window = deps.createWindow(autotestWindowOptions(deps.title));
  window.setMenu(null);
  window.webContents?.setWindowOpenHandler?.(() => ({ action: "deny" }));

  window.on("will-navigate", (...args: unknown[]) => {
    const target = args[1] ?? args[0];
    if (typeof target === "string" && !isLoopbackUrl(target)) {
      deps.log?.(`autotest window blocked navigation to ${target}`);
      if (typeof window.isDestroyed === "function" && !window.isDestroyed()) {
        window.focus?.();
      }
    }
  });

  void Promise.resolve(window.loadURL(deps.url)).catch((error: unknown) => {
    deps.log?.(`autotest window failed to load ${deps.url}: ${String(error)}`);
  });

  return window;
}

/**
 * 菜单点击走这里：窗口实例与 BrowserWindow 都由 index.ts 注册进来，菜单
 * 模块只负责触发。没注册（例如测试环境）时返回 false，不抛异常。
 */
let openWorkbench: (() => void) | null = null;

export function registerAutotestWorkbenchOpener(opener: () => void): void {
  openWorkbench = opener;
}

export function resetAutotestWorkbenchOpener(): void {
  openWorkbench = null;
}

export function openAutotestWorkbench(): boolean {
  if (!openWorkbench) return false;
  openWorkbench();
  return true;
}
