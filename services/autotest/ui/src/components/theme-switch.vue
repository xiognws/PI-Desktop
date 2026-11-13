<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { Monitor, Moon, Sun } from 'lucide-vue-next'
import { applyMode, readMode, type ThemeMode } from '@/lib/theme'

const mode = ref<ThemeMode>('system')

const options: { value: ThemeMode; label: string; icon: unknown }[] = [
  { value: 'system', label: '跟随系统', icon: Monitor },
  { value: 'light', label: '浅色', icon: Sun },
  { value: 'dark', label: '深色', icon: Moon },
]

function pick(next: ThemeMode) {
  mode.value = next
  applyMode(next)
}

onMounted(() => {
  mode.value = readMode()
})
</script>

<template>
  <div class="flex items-center border border-line rounded-lg overflow-hidden" role="group" aria-label="主题">
    <button
      v-for="option in options"
      :key="option.value"
      class="flex items-center gap-1 px-2 py-1 text-xs transition-colors"
      :class="mode === option.value
        ? 'bg-accent-soft text-accent'
        : 'text-muted hover:bg-surface-3'"
      :title="option.label"
      :aria-pressed="mode === option.value"
      @click="pick(option.value)"
    >
      <component :is="option.icon" class="w-3.5 h-3.5" />
      <span class="hidden sm:inline">{{ option.label }}</span>
    </button>
  </div>
</template>
