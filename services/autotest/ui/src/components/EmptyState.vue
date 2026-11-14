<script setup lang="ts">
/**
 * 空态：一个页面没内容时，说清"为什么空"和"下一步点哪"。
 *
 * 之前各页用内联括号文案（`（还没有运行）`）顶替，既看不出来也点不动。
 */
withDefaults(
  defineProps<{
    title: string
    hint?: string
  }>(),
  { hint: '' },
)
</script>

<template>
  <div class="flex flex-col items-start gap-2 rounded-[12px] border border-dashed border-line px-5 py-6">
    <p class="text-[13px] text-fg">{{ title }}</p>
    <p v-if="hint" class="text-[12px] text-muted">{{ hint }}</p>
    <div v-if="$slots.action" class="mt-1">
      <slot name="action" />
    </div>
  </div>
</template>
