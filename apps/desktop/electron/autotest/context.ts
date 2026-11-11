/**
 * 「加入上下文」的入参校验（纯函数，不 import electron）。
 *
 * 这段文本会从工作台窗口跨进主窗口并插进用户正在编辑的输入框，所以只接受
 * 字符串、去掉首尾空白、限长，其余一律拒绝。校验放在这里而不是 handler 里，
 * 是为了让 `node --test` 能直接覆盖边界而不需要起 Electron。
 */

/** 8KB 足够放一段知识片段（标题 + source_ref + 摘要 + 正文节选）。 */
export const MAX_CONTEXT_CHARS = 8_000;

export type ContextTextResult =
  | { ok: true; text: string }
  | { ok: false; error: "EMPTY" | "NOT_TEXT" | "TOO_LONG" };

export function normalizeContextText(raw: unknown): ContextTextResult {
  if (typeof raw !== "string") return { ok: false, error: "NOT_TEXT" };
  const text = raw.trim();
  if (!text) return { ok: false, error: "EMPTY" };
  if (text.length > MAX_CONTEXT_CHARS) return { ok: false, error: "TOO_LONG" };
  return { ok: true, text };
}
