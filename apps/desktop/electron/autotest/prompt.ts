/**
 * 「工作台不可用」提示（Electron main 侧）。
 *
 * 菜单被点时服务可能还没 ready（`starting` / `failed` / `stopped`）。以前这里只写
 * 一条 warn 日志，用户看到的是「点了没反应」。这个模块把同一个状态变成可操作的
 * 提示：说清当前状态 + 一个「重试启动」按钮，重试由调用方负责真正执行。
 *
 * 不 import `electron`：`showMessageBox` 由调用方注入，`node --test` 能直接测。
 */

export type AutotestUnavailableState = {
  status: string;
  error?: string;
};

/** 文案由调用方按当前 locale 传入；`{status}` / `{error}` 由这里替换。 */
export type AutotestUnavailableLabels = {
  unavailableTitle: string;
  unavailableMessage: string;
  unavailableDetail: string;
  retry: string;
  close: string;
};

export type AutotestMessageBoxOptions = {
  type: "warning";
  title: string;
  message: string;
  detail: string;
  buttons: string[];
  defaultId: number;
  cancelId: number;
  noLink: boolean;
};

/** Electron 的应答索引：0 是「关闭」，1 是「重试启动」。 */
export const AUTOTEST_CLOSE_RESPONSE = 0;
export const AUTOTEST_RETRY_RESPONSE = 1;

export function autotestUnavailableDialog(
  labels: AutotestUnavailableLabels,
  state: AutotestUnavailableState,
): AutotestMessageBoxOptions {
  const detail = state.error
    ? `${labels.unavailableDetail}\n\n${state.error}`
    : labels.unavailableDetail;
  return {
    type: "warning",
    title: labels.unavailableTitle,
    message: labels.unavailableMessage.replace("{status}", state.status),
    detail,
    // 顺序固定为「关闭 / 重试」：危险动作靠后，回车默认落在重试上。
    buttons: [labels.close, labels.retry],
    defaultId: AUTOTEST_RETRY_RESPONSE,
    cancelId: AUTOTEST_CLOSE_RESPONSE,
    noLink: true,
  };
}

/** 返回 true 表示用户选择「重试启动」。 */
export async function askAutotestRetry(
  deps: { showMessageBox: (options: AutotestMessageBoxOptions) => Promise<{ response: number }> },
  labels: AutotestUnavailableLabels,
  state: AutotestUnavailableState,
): Promise<boolean> {
  const result = await deps.showMessageBox(autotestUnavailableDialog(labels, state));
  return result.response === AUTOTEST_RETRY_RESPONSE;
}

/**
 * 「提示 → 重试 → 再判断」的完整循环，与 Electron 解耦以便测试。
 *
 * - 用户关闭：直接返回，不重启（不能把用户的一次误点变成一次重启）。
 * - 重启后就绪：调 `onReady()`（由调用方开窗），结束。
 * - 重启后仍不就绪：带着新的 `error` 再提示一次，由用户决定继续重试还是放弃。
 */
export async function recoverAutotestWorkbench(
  deps: {
    showMessageBox: (options: AutotestMessageBoxOptions) => Promise<{ response: number }>;
    state: () => AutotestUnavailableState;
    restart: () => Promise<void>;
    onReady: () => void;
    log?: (message: string) => void;
  },
  labels: AutotestUnavailableLabels,
  initial: AutotestUnavailableState,
): Promise<void> {
  let state = initial;
  for (;;) {
    if (!(await askAutotestRetry({ showMessageBox: deps.showMessageBox }, labels, state))) return;
    deps.log?.("restarting backend on user request");
    await deps.restart();
    const after = deps.state();
    if (after.status === "ready") {
      deps.onReady();
      return;
    }
    deps.log?.(
      `restart did not make the workbench available: ${after.status}${after.error ? ` (${after.error})` : ""}`,
    );
    state = after;
  }
}
