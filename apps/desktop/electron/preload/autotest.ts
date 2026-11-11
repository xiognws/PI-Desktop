import { contextBridge, ipcRenderer } from "electron";
import { IPC } from "@pi-workspace/shared/protocol";

/**
 * 测试工作台窗口的 preload。
 *
 * 这个窗口加载的是本机 FastAPI 托管的页面（外部内容），所以只暴露一件事：
 * 把一段文本交给主窗口的输入框。没有 Node、没有 fs、没有通用 invoke ——
 * 通道写死在这里，页面拿不到可以自己拼 channel 的能力。
 */
const api = {
  /** 把一段文字插入当前会话的输入框；返回 { ok, error? }。 */
  insertContext: (text: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.invoke.autotestInsertContext, text) as Promise<{
      ok: boolean;
      error?: string;
    }>,
};

contextBridge.exposeInMainWorld("autotestHost", api);

export type AutotestPreloadApi = typeof api;
