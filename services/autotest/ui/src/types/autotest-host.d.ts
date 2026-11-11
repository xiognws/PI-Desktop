/**
 * 工作台窗口的 preload 暴露的唯一能力（见 electron/preload/autotest.ts）。
 * 浏览器里直接打开页面时不存在 —— 调用方要自己回落到剪贴板。
 */
export {};

declare global {
  interface Window {
    autotestHost?: {
      insertContext(text: string): Promise<{ ok: boolean; error?: string }>;
    };
  }
}
