<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
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

const visible = computed(() => executions.value.filter(matchesFilter))
const hasRunning = computed(() => executions.value.some((e) => e.status === '执行中' || e.running > 0))

function percent(e: Execution) {
  if (!e.total) return 0
  return Math.min(100, Math.round((e.passed / e.total) * 100))
}

function openExecution(id: number) {
  router.push({ name: 'ExecutionDetail', params: { projectId, id } })
}

function statusClass(status: string) {
  if (status === '执行中') return 'bg-blue-50 text-blue-600'
  if (status === '已完成') return 'bg-green-50 text-green-600'
  if (status === '已取消') return 'bg-amber-50 text-amber-600'
  return 'bg-red-50 text-red-600'
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
    <div class="bg-white border-b border-gray-200 px-6 py-3">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-3">
          <h2 class="text-base font-medium text-gray-900">执行记录</h2>
          <span class="text-sm text-gray-400">共 {{ executions.length }} 次</span>
          <span v-if="hasRunning" class="text-xs px-2 py-0.5 rounded bg-blue-50 text-blue-600">实时刷新中</span>
        </div>
        <div class="flex items-center gap-1">
          <button
            v-for="f in FILTERS"
            :key="f.key"
            class="px-2.5 py-1 text-xs rounded-lg"
            :class="filter === f.key ? 'bg-blue-600 text-white' : 'text-gray-600 hover:bg-gray-100'"
            @click="filter = f.key"
          >
            {{ f.label }}
          </button>
          <button class="p-1.5 ml-2 text-gray-500 hover:text-gray-800" :disabled="loading" @click="loadExecutions()">
            <RefreshCw class="w-4 h-4" :class="loading ? 'animate-spin' : ''" />
          </button>
        </div>
      </div>
    </div>

    <p v-if="error" class="px-6 py-2 text-xs text-red-600 bg-red-50 border-b border-red-100">{{ error }}</p>

    <div class="flex-1 overflow-auto bg-white">
      <div class="p-6 space-y-4">
        <div v-for="e in visible" :key="e.id"
          class="bg-gray-50 rounded-lg border border-gray-200 p-5 cursor-pointer hover:border-blue-300"
          @click="openExecution(e.id)">
          <div class="flex items-center justify-between mb-3">
            <div class="flex items-center gap-2">
              <PlayCircle class="w-5 h-5 text-blue-600" />
              <span class="font-medium text-gray-900">{{ e.name }}</span>
              <span class="text-xs text-gray-400">#{{ e.id }}</span>
              <span class="text-xs px-2 py-0.5 rounded" :class="statusClass(e.status)">
                {{ e.status }}
              </span>
              <span v-if="e.executor" class="text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-500">{{ e.executor }}</span>
              <span v-if="e.channel" class="text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-500">{{ e.channel }}</span>
            </div>
            <span class="text-xs text-gray-400">{{ e.started_at ?? '' }}</span>
          </div>

          <div class="flex items-center gap-6 text-sm text-gray-600">
            <span>总共 {{ e.total }} 条</span>
            <span class="text-green-600">通过 {{ e.passed }}</span>
            <span class="text-red-600">失败 {{ e.failed }}</span>
            <span v-if="e.running > 0" class="text-blue-600">执行中 {{ e.running }}</span>
            <span v-if="e.finished_at" class="text-gray-400">结束 {{ e.finished_at }}</span>
          </div>

          <div class="mt-3 h-2 bg-gray-200 rounded-full overflow-hidden">
            <div class="h-full bg-green-500" :style="{ width: `${percent(e)}%` }"></div>
          </div>
        </div>

        <div v-if="!visible.length" class="text-center py-12 text-gray-400 text-sm">
          {{ executions.length ? '当前筛选下没有执行记录' : '暂无执行记录：在「运行记录」里点“执行用例”，或在「脚本」页运行单个脚本' }}
        </div>
      </div>
    </div>
  </div>
</template>
