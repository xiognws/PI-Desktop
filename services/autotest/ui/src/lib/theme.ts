/**
 * 主题：跟随系统 / 浅色 / 深色。
 *
 * 只有 `<html class="dark">` 一个开关 —— 配色全在 style.css 的语义变量里，
 * 组件不需要 `dark:` 前缀，也就不存在“漏改某处深色仍发白”的情况。
 * 选择存在 localStorage；`system` 时监听系统主题变化实时跟随。
 */

export type ThemeMode = 'system' | 'light' | 'dark'

const STORAGE_KEY = 'autotest-theme'
const MODES: ThemeMode[] = ['system', 'light', 'dark']

const darkQuery = (): MediaQueryList | null => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null
  return window.matchMedia('(prefers-color-scheme: dark)')
}

export function readMode(): ThemeMode {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    return MODES.includes(raw as ThemeMode) ? (raw as ThemeMode) : 'system'
  } catch {
    // 隐私模式 / file:// 下 localStorage 可能抛异常，退回跟随系统
    return 'system'
  }
}

/** 当前实际生效的是深色还是浅色（system 时按系统解析）。 */
export function resolvedDark(mode: ThemeMode = readMode()): boolean {
  if (mode === 'dark') return true
  if (mode === 'light') return false
  return darkQuery()?.matches ?? false
}

export function applyMode(mode: ThemeMode): void {
  const dark = resolvedDark(mode)
  const root = document.documentElement
  root.classList.toggle('dark', dark)
  root.dataset.theme = mode
  try {
    window.localStorage.setItem(STORAGE_KEY, mode)
  } catch {
    // 存不下也不影响本次切换
  }
}

/** 系统主题变化时，只有跟随系统才跟着变。 */
export function watchSystemTheme(): void {
  const query = darkQuery()
  if (!query) return
  const onChange = () => {
    if (readMode() === 'system') applyMode('system')
  }
  if (typeof query.addEventListener === 'function') {
    query.addEventListener('change', onChange)
  } else if (typeof query.addListener === 'function') {
    query.addListener(onChange)
  }
}

/** 应用启动时先定主题，避免先画一帧白色再跳成深色。 */
export function initTheme(): void {
  applyMode(readMode())
  watchSystemTheme()
}
