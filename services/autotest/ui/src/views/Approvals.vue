<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { CheckCircle, RefreshCw, XCircle } from 'lucide-vue-next'

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

function optionClass(option: string) {
  return option === 'reject'
    ? 'border-line-strong text-fg-2 hover:border-red-400 hover:text-danger'
    : 'bg-accent-solid border-blue-600 text-white hover:bg-blue-700'
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
  <div class="flex-1 flex flex-col overflow-hidden">
    <div class="bg-surface border-b border-line px-6 py-3">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-3">
          <h2 class="text-base font-medium text-fg">待审批</h2>
          <span class="text-sm text-muted-2">
            {{ count ? `${count} 条等你确认` : '没有待办' }}
          </span>
        </div>
        <div class="flex items-center gap-3">
          <span v-if="message" class="text-xs text-muted">{{ message }}</span>
          <button class="p-1.5 text-muted hover:text-fg" :disabled="loading" @click="load()">
            <RefreshCw class="w-4 h-4" :class="loading ? 'animate-spin' : ''" />
          </button>
        </div>
      </div>
    </div>

    <p v-if="error" class="px-6 py-2 text-xs text-danger bg-danger-soft border-b border-danger-line">{{ error }}</p>

    <div class="flex-1 overflow-auto bg-surface">
      <div class="p-6 space-y-4 max-w-4xl">
        <div
          v-for="item in decisions"
          :key="item.id"
          class="border border-warn-line bg-warn-soft/50 rounded-lg p-5"
        >
          <div class="flex items-center gap-2 text-xs text-warn mb-2">
            <span class="font-medium">人工卡点 · {{ item.stage || '未标阶段' }}</span>
            <span class="font-mono text-muted">{{ item.run_id }}</span>
            <span v-if="item.module" class="px-2 py-0.5 rounded bg-surface border border-warn-line text-fg-3">
              {{ item.module }}
            </span>
            <span class="ml-auto text-muted-2">{{ item.created_at || '' }}</span>
          </div>

          <div class="text-sm text-fg whitespace-pre-wrap mb-3">
            {{ item.prompt || '是否继续？' }}
          </div>

          <div class="flex items-center gap-2">
            <button
              v-for="option in (item.options && item.options.length ? item.options : ['approve', 'reject'])"
              :key="option"
              class="px-4 py-1.5 text-sm rounded-lg border disabled:opacity-50 flex items-center gap-1"
              :class="optionClass(option)"
              :disabled="busyId === item.id"
              @click="decide(item, option)"
            >
              <component
                :is="option === 'reject' ? XCircle : CheckCircle"
                class="w-4 h-4"
              />
              {{ optionLabel(option) }}
            </button>
            <router-link
              :to="`/project/${projectId}/runs?run=${item.run_id}`"
              class="ml-auto text-xs text-muted hover:text-accent"
            >
              查看这个 run 的步骤 →
            </router-link>
          </div>
        </div>

        <div v-if="!decisions.length" class="text-center py-16 text-sm text-muted-2">
          没有待审批的卡点。等 Agent 跑到需要人确认的步骤时，这里会出现一条。
        </div>
      </div>
    </div>
  </div>
</template>
