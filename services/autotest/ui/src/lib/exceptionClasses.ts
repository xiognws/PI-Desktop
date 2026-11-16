/**
 * 异常失效模式的展示名。
 *
 * 后端 `workflow/exception_matrix.py` 里的 CLASSES 是唯一真相源；
 * 这里只负责把 id 翻成中文，避免列表页、流水线页各写一份映射。
 */
export const EXCEPTION_LABELS: Record<string, string> = {
  out_of_range: '越界值',
  boundary: '边界值',
  illegal_value: '非法枚举',
  comm_timeout: '通信超时',
  electrical: '电气故障',
  power_cycle: '上下电',
  concurrency: '并发重入',
  persistence: '持久化',
}

export function exceptionLabel(id?: string | null): string {
  if (!id) return ''
  return EXCEPTION_LABELS[id] ?? id
}

/** 把 {out_of_range: 3, comm_timeout: 1} 排成 "越界值 3 · 通信超时 1" */
export function exceptionSummary(byClass: Record<string, number> | undefined): string {
  const entries = Object.entries(byClass ?? {})
  if (!entries.length) return ''
  return entries
    .sort((a, b) => b[1] - a[1])
    .map(([id, count]) => `${exceptionLabel(id)} ${count}`)
    .join(' · ')
}
