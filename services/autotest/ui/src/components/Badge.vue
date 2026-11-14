<script setup lang="ts">
/**
 * 状态徽标：全站只有这一种。
 *
 * 之前每页各写一套药丸（执行页一个屏幕 32 个 rounded-full），读起来像一堆标签。
 * 现在统一成小方角 + 3px 左边条：颜色只在左边条上，文字保持正文色，
 * 一行里十个徽标也不会糊成一团。
 */
withDefaults(
  defineProps<{
    tone?: 'neutral' | 'accent' | 'success' | 'warn' | 'danger'
    label?: string
  }>(),
  { tone: 'neutral', label: '' },
)

const TONE_BAR: Record<string, string> = {
  neutral: 'bg-surface-4',
  accent: 'bg-accent-solid',
  success: 'bg-success',
  warn: 'bg-warn',
  danger: 'bg-danger',
}
</script>

<template>
  <span
    class="inline-flex items-center gap-1.5 rounded-[4px] border border-line bg-surface-2 px-1.5 py-0.5 text-[12px] leading-4"
  >
    <span class="h-3 w-[3px] rounded-full" :class="TONE_BAR[tone]"></span>
    <slot>{{ label }}</slot>
  </span>
</template>
