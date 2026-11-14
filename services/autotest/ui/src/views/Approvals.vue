<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { RefreshCw } from 'lucide-vue-next'
import Badge from '@/components/Badge.vue'
import EmptyState from '@/components/EmptyState.vue'

const route = useRoute()
const projectId = route.params.projectId as string

type Decision = {
  id: string
  run_id: string
  step_id?: string | null
  prompt?: string
  options?: string[]
  created_at?: string
  module?: string
  stage?: string
  run_status?: string
}

const decisions = ref<Decision[]>([])
const loading = ref(false)
const error = ref('')
const message = ref('')
const busyId = ref('')

const count = computed(() => decisions.value.length)

function optionLabel(option: string) {
  if (option === 'approve') return '通过'
  if (option === 'reject') return '驳回'
  return option
}

function optionClass(option: string): string {
  if (option === 'reject') return 'border border-line text-fg hover:border-danger hover:text-danger'
  return 'bg-accent-solid text-white hover:bg-accent'
}

async function load(quiet = false) {
  if (!quiet) loading.value = true
  try {
    // 一次拿全项目待办：审批页只关心「现在等我点什么」，不按 run 逐个拉。
    const res = await fetch(`/api/projects/${projectId}/workflow/pending?limit=200`)
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(body?.detail || `HTTP ${res.status}`)
    decisions.value = body?.data?.decisions || []
    error.value = ''
  } catch (e) {
    error.value = `加载待办失败：${(e as Error).message}`
  } finally {
    loading.value = false
  }
}

async function decide(item: Decision, answer: string) {
  busyId.value = item.id
  message.value = ''
  try {
    const res = await fetch(
      `/api/projects/${projectId}/workflow/runs/${item.run_id}/pending/${item.id}/decide`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ answer }),
      },
    )
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(body?.detail || `HTTP ${res.status}`)
    message.value = `已记录：${optionLabel(answer)}`
    await load(true)
  } catch (e) {
    message.value = `审批失败：${(e as Error).message}`
  } finally {
    busyId.value = ''
  }
}

// 10s 轮询：Agent 那边可能在等同一个卡点，用户在别的页面批掉后这里要跟上。
let timer: ReturnType<typeof setInterval> | null = null
onMounted(async () => {
  await load()
  timer = setInterval(() => void load(true), 10_000)
})
onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
})
</script>

<template>
  <div class="flex-1 overflow-auto bg-surface-2">
    <div class="mx-auto w-full max-w-[900px] px-8 py-7">
      <header class="flex items-start justify-between gap-4">
        <div>
          <h1 class="text-[20px] font-medium text-fg">待审批</h1>
          <p class="mt-1 text-[13px] text-muted">
            Agent 跑到需要人拍板的步骤会停在这里。不确认，流水线不会往下走。
          </p>
        </div>
        <button
          class="flex h-9 items-center gap-2 rounded-[8px] border border-line bg-surface px-3 text-[13px] text-fg hover:bg-surface-3 disabled:opacity-40"
          :disabled="loading"
          @click="load()"
        >
          <RefreshCw class="h-4 w-4" :class="loading ? 'animate-spin' : ''" /> 刷新
        </button>
      </header>

      <div class="mt-5 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-[12px] border border-line bg-surface px-5 py-3">
        <span class="num text-[13px]" :class="count ? 'text-warn' : 'text-fg'">
          {{ count }}<span class="text-muted"> 条等确认</span>
        </span>
        <span v-if="message" class="text-[12px] text-muted">{{ message }}</span>
      </div>

      <p v-if="error" class="mt-3 rounded-[8px] border border-danger-line bg-danger-soft px-4 py-2 text-[13px] text-danger">
        {{ error }}
      </p>

      <div v-if="decisions.length" class="mt-5 space-y-4">
        <article
          v-for="item in decisions"
          :key="item.id"
          class="rounded-[12px] border border-warn-line bg-surface px-5 py-4"
        >
          <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span class="h-3 w-[3px] bg-warn"></span>
            <span class="text-[13px] text-fg">人工卡点 · {{ item.stage || '未标阶段' }}</span>
            <span class="mono text-[12px] text-muted-2">{{ item.run_id }}</span>
            <Badge v-if="item.module" tone="neutral">{{ item.module }}</Badge>
            <span class="num ml-auto text-[12px] text-muted-2">{{ item.created_at || '' }}</span>
          </div>

          <p class="mt-3 whitespace-pre-wrap text-[13px] leading-6 text-fg">
            {{ item.prompt || '是否继续？' }}
          </p>

          <div class="mt-4 flex flex-wrap items-center gap-2">
            <button
              v-for="option in (item.options && item.options.length ? item.options : ['approve', 'reject'])"
              :key="option"
              class="h-8 rounded-[8px] px-3 text-[13px] disabled:opacity-40"
              :class="optionClass(option)"
              :disabled="busyId === item.id"
              @click="decide(item, option)"
            >{{ optionLabel(option) }}</button>
            <router-link
              :to="`/project/${projectId}/runs?run=${item.run_id}`"
              class="ml-auto text-[12px] text-muted hover:text-fg"
            >查这个 run 的步骤 →</router-link>
          </div>
        </article>
      </div>

      <EmptyState
        v-else
        class="mt-5"
        title="没有待审批的卡点"
        hint="Agent 跑到需要人确认的步骤时，这里会出现一条"
      />
    </div>
  </div>
</template>
