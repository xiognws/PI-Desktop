<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { RefreshCw } from 'lucide-vue-next'
import Badge from '@/components/Badge.vue'
import EmptyState from '@/components/EmptyState.vue'

const route = useRoute()
const router = useRouter()
const projectId = route.params.projectId as string

type Execution = {
  id: number
  plan_id?: string | null
  name: string
  total: number
  passed: number
  failed: number
  running: number
  status: string
  started_at?: string
  finished_at?: string
  executor?: string
  channel?: string
}

const executions = ref<Execution[]>([])
const loading = ref(false)
const error = ref('')
const filter = ref<'all' | 'running' | 'done' | 'failed'>('all')

const FILTERS: Array<{ key: 'all' | 'running' | 'done' | 'failed'; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'running', label: '执行中' },
  { key: 'done', label: '已完成' },
  { key: 'failed', label: '失败' },
]

// 后端 status 是中文标签（执行中 / 已完成 / 失败 / 已取消），筛选在前端做，
// 免得为一个视图在 API 上加参数。
function matchesFilter(e: Execution) {
  if (filter.value === 'all') return true
  if (filter.value === 'running') return e.status === '执行中' || e.running > 0
  if (filter.value === 'done') return e.status === '已完成'
  return e.status !== '已完成' && e.status !== '执行中'
}

// 按脚本名/执行号搜一下：跑了几十轮之后，翻列表找人肉找不动。
const query = ref('')
const PAGE_SIZE = 20
const page = ref(1)

function matchesQuery(e: Execution) {
  const needle = query.value.trim().toLowerCase()
  if (!needle) return true
  return e.name.toLowerCase().includes(needle) || String(e.id) === needle
}

const visible = computed(() => executions.value.filter(matchesFilter).filter(matchesQuery))
const pageCount = computed(() => Math.max(1, Math.ceil(visible.value.length / PAGE_SIZE)))
// 分页只切前端这一份列表：接口本来就把整项目的历史一次给全，加参数只会让
// 轮询和翻页互相打架。
const paged = computed(() => {
  const start = (page.value - 1) * PAGE_SIZE
  return visible.value.slice(start, start + PAGE_SIZE)
})
const rangeText = computed(() => {
  if (!visible.value.length) return '0 条'
  const start = (page.value - 1) * PAGE_SIZE + 1
  return `${start}–${Math.min(start + PAGE_SIZE - 1, visible.value.length)} / ${visible.value.length}`
})

// 换筛选或搜索词就回第一页；列表变短（比如轮询后筛选结果变少）也别停在空页。
watch([filter, query], () => { page.value = 1 })
watch(pageCount, (count) => { if (page.value > count) page.value = count })
const hasRunning = computed(() => executions.value.some((e) => e.status === '执行中' || e.running > 0))

function percent(e: Execution) {
  if (!e.total) return 0
  return Math.min(100, Math.round((e.passed / e.total) * 100))
}

function openExecution(id: number) {
  router.push({ name: 'ExecutionDetail', params: { projectId, id } })
}

function statusTone(status: string): 'accent' | 'success' | 'warn' | 'danger' | 'neutral' {
  if (status === '执行中') return 'accent'
  if (status === '已完成') return 'success'
  if (status === '已取消') return 'warn'
  if (status === '失败') return 'danger'
  return 'neutral'
}

async function loadExecutions(quiet = false) {
  if (!quiet) loading.value = true
  try {
    // 这里读的是裸响应（{ executions: [...] }），不是 workflow 那套
    // { ok, data } 包装：executions 路由早于 workflow 化，保持原样。
    const res = await fetch(`/api/projects/${projectId}/executions`)
    const data = await res.json()
    executions.value = data.executions || []
    error.value = ''
  } catch (e) {
    error.value = `加载执行记录失败：${(e as Error).message}`
  } finally {
    loading.value = false
  }
}

// 有执行在跑就 4s 刷一次：投递执行后这一页是唯一能看进度的列表页。
let timer: ReturnType<typeof setInterval> | null = null
function syncPolling() {
  if (timer) clearInterval(timer)
  timer = null
  if (!hasRunning.value) return
  timer = setInterval(() => void loadExecutions(true), 4000)
}
function stopPolling() {
  if (timer) clearInterval(timer)
  timer = null
}

onMounted(async () => {
  await loadExecutions()
  syncPolling()
})
onBeforeUnmount(stopPolling)
</script>

<template>
  <div class="flex-1 overflow-auto bg-surface-2">
    <div class="mx-auto w-full max-w-[1200px] px-8 py-7">
      <header class="flex items-start justify-between gap-4">
        <div>
          <h1 class="text-[20px] font-medium text-fg">执行</h1>
          <p class="mt-1 text-[13px] text-muted">
            每次执行一条记录，点开看逐条用例的结果与日志。
          </p>
        </div>
        <div class="flex items-center gap-2 pt-1">
          <input
            v-model="query"
            class="h-9 w-56 rounded-[8px] border border-line bg-surface px-2 text-[13px] text-fg placeholder:text-muted-2"
            placeholder="搜脚本名或执行号"
          />
          <button
            class="flex h-9 items-center gap-2 rounded-[8px] border border-line bg-surface px-3 text-[13px] text-fg hover:bg-surface-3 disabled:opacity-40"
            :disabled="loading"
            @click="loadExecutions()"
          >
            <RefreshCw class="h-4 w-4" :class="loading ? 'animate-spin' : ''" /> 刷新
          </button>
        </div>
      </header>

      <div class="mt-5 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-[12px] border border-line bg-surface px-5 py-3">
        <span class="mono text-[13px] text-fg">{{ executions.length }}<span class="text-muted"> 次执行</span></span>
        <div class="flex items-center gap-1">
          <button
            v-for="f in FILTERS"
            :key="f.key"
            class="h-7 rounded-[8px] px-2 text-[12px] transition-colors"
            :class="filter === f.key ? 'bg-surface-3 text-fg' : 'text-muted hover:text-fg'"
            @click="filter = f.key"
          >{{ f.label }}</button>
        </div>
        <span v-if="hasRunning" class="text-[12px] text-accent">执行中，自动刷新</span>
      </div>

      <p v-if="error" class="mt-3 text-[13px] text-danger">{{ error }}</p>

      <div class="mt-5 overflow-hidden rounded-[12px] border border-line bg-surface">
        <div
          class="hidden grid-cols-[64px_1fr_96px_repeat(3,64px)_1fr] gap-4 border-b border-line px-5 py-2 text-[12px] text-muted-2 md:grid"
        >
          <span>执行号</span>
          <span>脚本</span>
          <span>状态</span>
          <span class="text-right">总数</span>
          <span class="text-right">通过</span>
          <span class="text-right">失败</span>
          <span>开始</span>
        </div>

        <button
          v-for="e in paged"
          :key="e.id"
          class="state-bar grid w-full grid-cols-1 items-center gap-4 border-b border-line-soft px-5 py-3 text-left last:border-b-0 hover:bg-surface-2 md:grid-cols-[64px_1fr_96px_repeat(3,64px)_1fr]"
          :data-tone="statusTone(e.status) === 'accent' ? 'accent' : statusTone(e.status) === 'success' ? 'success' : statusTone(e.status) === 'danger' ? 'danger' : 'neutral'"
          @click="openExecution(e.id)"
        >
          <span class="mono text-[12px] text-muted-2">#{{ e.id }}</span>

          <span class="min-w-0">
            <span class="mono block truncate text-[13px] text-fg">{{ e.name }}</span>
            <span class="mt-0.5 block h-[2px] w-full bg-surface-4">
              <span class="block h-full bg-accent-solid" :style="{ width: `${percent(e)}%` }"></span>
            </span>
          </span>

          <Badge :tone="statusTone(e.status)">{{ e.status }}</Badge>

          <span class="mono text-right text-[13px] text-fg">{{ e.total }}</span>
          <span class="mono text-right text-[13px] text-success">{{ e.passed }}</span>
          <span class="mono text-right text-[13px]" :class="e.failed ? 'text-danger' : 'text-muted-2'">
            {{ e.failed }}
          </span>

          <span class="mono truncate text-[12px] text-muted-2">{{ e.started_at ?? '—' }}</span>
        </button>

        <EmptyState
          v-if="!visible.length"
          class="m-5"
          :title="executions.length ? '当前筛选下没有记录' : '还没有执行过'"
          :hint="executions.length ? '换个筛选或清空搜索词' : '到「流水线」第 ⑥ 步执行，或在「脚本」页单跑一个'"
        />
      </div>

      <div
        v-if="visible.length > PAGE_SIZE"
        class="mt-3 flex items-center justify-center gap-3 text-[12px] text-muted"
      >
        <button
          class="h-8 rounded-[8px] border border-line px-2 text-fg disabled:opacity-40"
          :disabled="page <= 1"
          @click="page--"
        >上一页</button>
        <span class="mono">{{ rangeText }} · {{ page }} / {{ pageCount }}</span>
        <button
          class="h-8 rounded-[8px] border border-line px-2 text-fg disabled:opacity-40"
          :disabled="page >= pageCount"
          @click="page++"
        >下一页</button>
      </div>
    </div>
  </div>
</template>
