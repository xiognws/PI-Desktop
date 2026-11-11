<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { PlayCircle, CheckCircle, XCircle, Clock, FileText, Square } from 'lucide-vue-next'

type RunEvent = {
  type: string
  stepId?: string
  caseId?: string
  label?: string
  status?: string
  durationMs?: number
  replayHit?: boolean
  detail?: Record<string, unknown>
  failure?: string | null
  path?: string
  kind?: string
  counts?: { pass: number; fail: number; skip: number }
  // run.end 携带的执行归因：replay 命中数与模型调用数（本平台恒为 0，
  // 推理在桌面端 Agent 侧，这里只为把执行器回填的字段如实显示出来）
  replayHits?: number
  modelCalls?: number
}

const route = useRoute()
const projectId = route.params.projectId as string
const executionId = route.params.id as string

const execution = ref<Record<string, any> | null>(null)
const events = ref<RunEvent[]>([])
const loading = ref(false)
const error = ref('')
const cancelling = ref(false)

let timer: ReturnType<typeof setInterval> | null = null

const statusLabel: Record<string, string> = {
  执行中: '执行中',
  已完成: '已完成',
  失败: '失败',
  异常: '异常',
  已取消: '已取消',
}

const runEnd = computed(() => events.value.find((e) => e.type === 'run.end'))
const runStatus = computed(() => {
  if (runEnd.value?.status) return runEnd.value.status
  if (execution.value?.status === '执行中') return 'running'
  const status = String(execution.value?.status ?? '')
  return status === '已完成' ? 'pass' : status === '已取消' ? 'cancelled' : status === '失败' ? 'fail' : 'error'
})

const counts = computed(() => {
  const fallback = {
    pass: Number(execution.value?.passed ?? 0),
    fail: Number(execution.value?.failed ?? 0),
    skip: 0,
  }
  return runEnd.value?.counts ?? fallback
})

type StepRow = { id: string; label: string; status: string; durationMs?: number; detail?: string }

const steps = computed<StepRow[]>(() => {
  const started = new Map<string, StepRow>()
  const rows: StepRow[] = []
  for (const event of events.value) {
    if (event.type === 'step.start' && event.stepId) {
      const row: StepRow = {
        id: event.stepId,
        label: event.label ?? event.stepId,
        status: 'running',
      }
      started.set(event.stepId, row)
      rows.push(row)
    } else if (event.type === 'step.end' && event.stepId) {
      const row = started.get(event.stepId)
      const detail = event.detail ?? {}
      const text = [detail.stderr, detail.error]
        .map((value) => (typeof value === 'string' ? value.trim() : ''))
        .find((value) => value.length > 0)
      if (row) {
        row.status = event.status ?? 'fail'
        row.durationMs = event.durationMs
        row.detail = text
      } else {
        rows.push({
          id: event.stepId,
          label: event.stepId,
          status: event.status ?? 'fail',
          durationMs: event.durationMs,
          detail: text,
        })
      }
    }
  }
  return rows
})

const artifacts = computed(() => events.value.filter((e) => e.type === 'artifact'))
const failure = computed(
  () => events.value.find((e) => e.type === 'case.end' && e.failure)?.failure ?? '',
)

// ---- 折叠 / 高亮 / 产物预览 ------------------------------------------------
// 一次执行可能几十个步骤，全平铺时失败现场要滚很久。默认只展开非通过的步骤，
// 通过的一行收起；「只看失败」再把通过的整条过滤掉。

const collapsed = ref<Set<string>>(new Set())
const onlyFailed = ref(false)

const visibleSteps = computed(() =>
  onlyFailed.value ? steps.value.filter((s) => s.status !== 'pass') : steps.value,
)

function isCollapsed(id: string) {
  return collapsed.value.has(id)
}

function toggleStep(id: string) {
  const next = new Set(collapsed.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  collapsed.value = next
}

// 刚加载完：通过的步骤先收起，失败的保持展开。
watch(steps, (rows) => {
  const next = new Set<string>()
  for (const row of rows) {
    if (row.status === 'pass') next.add(row.id)
  }
  collapsed.value = next
})

type LogLine = { text: string; bad: boolean }
const BAD_LINE = /(Traceback|Error|FAILED|assert|\bE\s{2,}|Exception|失败)/

function detailLines(text: string): LogLine[] {
  return String(text || '')
    .split('\n')
    .map((line) => ({ text: line, bad: BAD_LINE.test(line) }))
}

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp)$/i

function isImage(path?: string) {
  return !!path && IMAGE_EXT.test(path)
}

// 产物是执行现场的绝对路径，经 /files 回读（服务端只放行本项目目录内的文件）。
function fileUrl(path?: string) {
  if (!path) return ''
  return `/api/projects/${projectId}/files?path=${encodeURIComponent(path)}`
}

const durationText = computed(() => {
  const ms = runEnd.value?.durationMs ?? 0
  if (!ms) return ''
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`
})

const isRunning = computed(() => execution.value?.status === '执行中')

const tone = (status: string) => {
  if (status === 'pass' || status === '已完成') return 'bg-green-50 text-green-600'
  if (status === 'fail' || status === '失败' || status === 'error' || status === '异常')
    return 'bg-red-50 text-red-600'
  if (status === 'cancelled' || status === '已取消') return 'bg-amber-50 text-amber-600'
  if (status === 'skip') return 'bg-gray-100 text-gray-500'
  return 'bg-blue-50 text-blue-600'
}

const icon = (status: string) => {
  if (status === 'pass' || status === '已完成') return CheckCircle
  if (status === 'fail' || status === '失败' || status === 'error' || status === '异常')
    return XCircle
  if (status === 'cancelled' || status === '已取消') return Square
  return PlayCircle
}

async function load() {
  loading.value = true
  try {
    const response = await fetch(`/api/projects/${projectId}/executions/${executionId}`)
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
    const data = await response.json()
    execution.value = data.execution ?? null
    events.value = data.events ?? []
    error.value = ''
  } catch (problem) {
    error.value = String((problem as Error).message ?? problem)
  } finally {
    loading.value = false
  }
}

async function cancelRun() {
  cancelling.value = true
  try {
    await fetch(`/api/projects/${projectId}/executions/${executionId}/cancel`, { method: 'POST' })
  } finally {
    cancelling.value = false
    setTimeout(load, 600)
  }
}

onMounted(() => {
  load()
  timer = setInterval(() => {
    if (isRunning.value) load()
  }, 2000)
})

onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
})
</script>

<template>
  <div class="flex-1 flex flex-col overflow-auto p-6">
    <div class="max-w-5xl mx-auto w-full">
      <div class="bg-white rounded-lg border border-gray-200 p-6 mb-6">
        <div class="flex items-center justify-between mb-4">
          <div>
            <h2 class="text-lg font-medium text-gray-900">
              {{ execution?.name ?? `执行 #${executionId}` }}
            </h2>
            <p class="text-sm text-gray-500 mt-1">
              {{ execution?.started_at ?? '' }}
              <span v-if="durationText"> · 耗时 {{ durationText }}</span>
              <span v-if="execution?.executor"> · {{ execution.executor }}</span>
            </p>
          </div>
          <div class="flex items-center gap-2">
            <span class="text-xs px-3 py-1 rounded" :class="tone(runStatus)">
              {{ statusLabel[String(execution?.status ?? '')] ?? runStatus }}
            </span>
            <button
              v-if="isRunning"
              class="text-xs px-3 py-1 rounded border border-red-200 text-red-600 hover:bg-red-50 disabled:opacity-50"
              :disabled="cancelling"
              @click="cancelRun"
            >
              {{ cancelling ? '取消中…' : '取消执行' }}
            </button>
          </div>
        </div>

        <div class="flex items-center gap-6 text-sm">
          <span class="text-green-600 flex items-center gap-1"><CheckCircle class="w-4 h-4" /> 通过 {{ counts.pass }}</span>
          <span class="text-red-600 flex items-center gap-1"><XCircle class="w-4 h-4" /> 失败 {{ counts.fail }}</span>
          <span class="text-gray-500 flex items-center gap-1"><Clock class="w-4 h-4" /> 跳过 {{ counts.skip }}</span>
          <span v-if="runEnd" class="text-gray-400 text-xs">replay 命中 {{ runEnd.replayHit ? '是' : '否' }} · 模型调用 {{ runEnd.modelCalls ?? 0 }}</span>
        </div>

        <div v-if="error" class="mt-4 text-sm text-red-600">{{ error }}</div>
      </div>

      <div class="bg-white rounded-lg border border-gray-200">
        <div class="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
          <h3 class="text-base font-medium text-gray-900">执行步骤</h3>
          <div class="flex items-center gap-3">
            <span class="text-xs text-gray-400">{{ events.length }} 条事件</span>
            <button
              class="text-xs px-2 py-1 rounded border"
              :class="onlyFailed ? 'border-red-300 text-red-600 bg-red-50' : 'border-gray-200 text-gray-600 hover:bg-gray-50'"
              @click="onlyFailed = !onlyFailed"
            >
              只看失败
            </button>
          </div>
        </div>
        <div v-if="visibleSteps.length === 0" class="px-6 py-10 text-center text-sm text-gray-400">
          {{ steps.length ? '这次执行没有失败步骤' : '这次执行还没有步骤事件' }}
        </div>
        <div class="divide-y divide-gray-100">
          <div v-for="s in visibleSteps" :key="s.id" class="p-5">
            <div
              class="flex items-center justify-between mb-2 cursor-pointer select-none"
              @click="toggleStep(s.id)"
            >
              <div class="flex items-center gap-3">
                <component :is="icon(s.status)" class="w-5 h-5" :class="tone(s.status).split(' ')[1]" />
                <span class="font-medium text-gray-900">{{ s.label }}</span>
                <span class="text-xs px-2 py-0.5 rounded" :class="tone(s.status)">
                  {{ s.status }}
                </span>
                <span v-if="s.detail && isCollapsed(s.id)" class="text-xs text-gray-400">
                  {{ detailLines(s.detail).length }} 行 · 点击展开
                </span>
              </div>
              <span class="text-xs text-gray-400">
                {{ s.durationMs != null ? `${(s.durationMs / 1000).toFixed(2)}s` : '' }}
              </span>
            </div>
            <div
              v-if="s.detail && !isCollapsed(s.id)"
              class="ml-8 mt-2 rounded-lg border border-gray-200 overflow-hidden"
            >
              <div
                v-for="(line, index) in detailLines(s.detail)"
                :key="index"
                class="px-3 py-0.5 font-mono text-xs whitespace-pre-wrap"
                :class="line.bad ? 'bg-red-50 text-red-700 font-medium' : 'text-gray-600'"
              >{{ line.text || ' ' }}</div>
            </div>
          </div>
        </div>
      </div>

      <div v-if="artifacts.length" class="bg-white rounded-lg border border-gray-200 mt-6 p-5">
        <h3 class="text-base font-medium text-gray-900 mb-3">产物</h3>
        <div class="grid grid-cols-3 gap-3">
          <div v-for="a in artifacts" :key="a.path" class="border border-gray-200 rounded-lg overflow-hidden">
            <a v-if="isImage(a.path)" :href="fileUrl(a.path)" target="_blank" rel="noreferrer" class="block">
              <img :src="fileUrl(a.path)" :alt="a.path" class="w-full h-32 object-cover bg-gray-50" />
            </a>
            <div v-else class="h-32 flex items-center justify-center bg-gray-50">
              <FileText class="w-6 h-6 text-gray-300" />
            </div>
            <div class="px-2 py-1.5 border-t border-gray-100">
              <div class="flex items-center gap-1">
                <span class="text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">{{ a.kind }}</span>
                <span class="text-xs text-gray-600 truncate">{{ a.path?.split(/[\\/]/).pop() }}</span>
              </div>
              <a :href="fileUrl(a.path)" target="_blank" rel="noreferrer" class="text-xs text-blue-600 hover:underline">
                {{ isImage(a.path) ? '打开原图' : '下载' }}
              </a>
            </div>
          </div>
        </div>
      </div>

      <div v-if="failure"
        class="border rounded-lg mt-6 p-5 text-sm whitespace-pre-wrap"
        :class="execution?.status === '已取消' ? 'bg-amber-50 border-amber-200 text-amber-700' : 'bg-red-50 border-red-200 text-red-700'">
        {{ execution?.status === '已取消' ? '结束原因' : '失败原因' }}：{{ failure }}
      </div>
    </div>
  </div>
</template>
