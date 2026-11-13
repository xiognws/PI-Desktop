<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { PlayCircle, RefreshCw } from 'lucide-vue-next'

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

function statusClass(status: string) {
  if (status === '执行中') return 'bg-accent-soft text-accent'
  if (status === '已完成') return 'bg-success-soft text-success'
  if (status === '已取消') return 'bg-warn-soft text-warn'
  return 'bg-danger-soft text-danger'
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
  <div class="flex-1 flex flex-col overflow-hidden">
    <div class="bg-surface border-b border-line px-6 py-3">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-3">
          <h2 class="text-base font-medium text-fg">执行记录</h2>
          <span class="text-sm text-muted-2">共 {{ executions.length }} 次</span>
          <span v-if="hasRunning" class="text-xs px-2 py-0.5 rounded bg-accent-soft text-accent">实时刷新中</span>
        </div>
        <div class="flex items-center gap-1">
          <input
            v-model="query"
            class="h-7 w-40 px-2 mr-2 text-xs border border-line rounded-lg"
            placeholder="搜脚本名 / 执行号"
          />
          <button
            v-for="f in FILTERS"
            :key="f.key"
            class="px-2.5 py-1 text-xs rounded-lg"
            :class="filter === f.key ? 'bg-accent-solid text-white' : 'text-fg-3 hover:bg-surface-3'"
            @click="filter = f.key"
          >
            {{ f.label }}
          </button>
          <button class="p-1.5 ml-2 text-muted hover:text-fg" :disabled="loading" @click="loadExecutions()">
            <RefreshCw class="w-4 h-4" :class="loading ? 'animate-spin' : ''" />
          </button>
        </div>
      </div>
    </div>

    <p v-if="error" class="px-6 py-2 text-xs text-danger bg-danger-soft border-b border-danger-line">{{ error }}</p>

    <div class="flex-1 overflow-auto bg-surface">
      <div class="p-6 space-y-4">
        <div v-for="e in paged" :key="e.id"
          class="bg-surface-2 rounded-lg border border-line p-5 cursor-pointer hover:border-accent-line"
          @click="openExecution(e.id)">
          <div class="flex items-center justify-between mb-3">
            <div class="flex items-center gap-2">
              <PlayCircle class="w-5 h-5 text-accent" />
              <span class="font-medium text-fg">{{ e.name }}</span>
              <span class="text-xs text-muted-2">#{{ e.id }}</span>
              <span class="text-xs px-2 py-0.5 rounded" :class="statusClass(e.status)">
                {{ e.status }}
              </span>
              <span v-if="e.executor" class="text-xs px-2 py-0.5 rounded bg-surface-3 text-muted">{{ e.executor }}</span>
              <span v-if="e.channel" class="text-xs px-2 py-0.5 rounded bg-surface-3 text-muted">{{ e.channel }}</span>
            </div>
            <span class="text-xs text-muted-2">{{ e.started_at ?? '' }}</span>
          </div>

          <div class="flex items-center gap-6 text-sm text-fg-3">
            <span>总共 {{ e.total }} 条</span>
            <span class="text-success">通过 {{ e.passed }}</span>
            <span class="text-danger">失败 {{ e.failed }}</span>
            <span v-if="e.running > 0" class="text-accent">执行中 {{ e.running }}</span>
            <span v-if="e.finished_at" class="text-muted-2">结束 {{ e.finished_at }}</span>
          </div>

          <div class="mt-3 h-2 bg-surface-4 rounded-full overflow-hidden">
            <div class="h-full bg-green-500" :style="{ width: `${percent(e)}%` }"></div>
          </div>
        </div>

        <div v-if="!visible.length" class="text-center py-12 text-muted-2 text-sm">
          {{ executions.length ? '当前筛选下没有执行记录' : '暂无执行记录：在「运行记录」里点“执行用例”，或在「脚本」页运行单个脚本' }}
        </div>

        <div v-if="visible.length > PAGE_SIZE" class="flex items-center justify-center gap-3 pt-2 text-xs text-fg-3">
          <button
            class="px-2 py-1 border border-line rounded disabled:opacity-40"
            :disabled="page <= 1"
            @click="page--"
          >上一页</button>
          <span>{{ rangeText }} · 第 {{ page }} / {{ pageCount }} 页</span>
          <button
            class="px-2 py-1 border border-line rounded disabled:opacity-40"
            :disabled="page >= pageCount"
            @click="page++"
          >下一页</button>
        </div>
      </div>
    </div>
  </div>
</template>
