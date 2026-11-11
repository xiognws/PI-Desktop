<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { PlayCircle, RefreshCw, FileText, ChevronDown, ChevronRight } from 'lucide-vue-next'

const route = useRoute()
const projectId = route.params.projectId as string

type Run = {
  id: string
  module?: string
  requirement_ref?: string
  stage?: string
  status: string
  created_at?: string
  updated_at?: string
}
type Step = {
  id: number
  seq: number
  tool: string
  stage?: string
  status: string
  summary?: string
  error_code?: string
  started_at?: string
  ended_at?: string
}
type Pending = { id: string; prompt?: string; options?: string[]; stage?: string; created_at?: string }
type RunDetail = Run & { steps?: Step[]; pending?: Pending[] }

const runs = ref<Run[]>([])
const expandedId = ref('')
const detail = ref<RunDetail | null>(null)
const loading = ref(false)
const message = ref('')
const report = ref<{ name: string; markdown: string } | null>(null)

const STATUS_LABELS: Record<string, string> = {
  running: '进行中',
  waiting_human: '待审批',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
}
const STEP_LABELS: Record<string, string> = {
  ok: '成功',
  warning: '警告',
  failed: '失败',
  running: '执行中',
}

function statusLabel(status?: string) {
  return status ? STATUS_LABELS[status] || status : ''
}
function statusClass(status?: string) {
  if (status === 'running') return 'bg-blue-50 text-blue-600'
  if (status === 'waiting_human') return 'bg-yellow-50 text-yellow-600'
  if (status === 'done') return 'bg-green-50 text-green-600'
  if (status === 'failed') return 'bg-red-50 text-red-600'
  return 'bg-gray-100 text-gray-500'
}
function stepClass(status?: string) {
  if (status === 'ok') return 'bg-green-50 text-green-600'
  if (status === 'warning') return 'bg-yellow-50 text-yellow-600'
  if (status === 'failed') return 'bg-red-50 text-red-600'
  if (status === 'running') return 'bg-blue-50 text-blue-600'
  return 'bg-gray-100 text-gray-500'
}
function shortTime(value?: string) {
  return value ? value.replace('T', ' ').slice(5, 16) : ''
}

async function loadRuns() {
  loading.value = true
  try {
    const res = await fetch(`/api/projects/${projectId}/workflow/runs?limit=50`)
    const body = await res.json()
    runs.value = body?.data?.runs || []
    // 从缺陷页/侧栏跳过来时带 ?run=wf-xxx，直接展开那一条
    const wanted = typeof route.query.run === 'string' ? route.query.run : ''
    if (wanted && runs.value.some(r => r.id === wanted)) await toggle(wanted)
  } catch {
    message.value = '加载运行记录失败'
  } finally {
    loading.value = false
  }
}

async function toggle(id: string) {
  if (expandedId.value === id) {
    expandedId.value = ''
    detail.value = null
    return
  }
  expandedId.value = id
  report.value = null
  try {
    const res = await fetch(`/api/projects/${projectId}/workflow/runs/${id}`)
    const body = await res.json()
    detail.value = body?.data || null
  } catch {
    detail.value = null
    message.value = '加载运行详情失败'
  }
}

async function decide(decisionId: string, answer: string) {
  if (!expandedId.value) return
  try {
    const res = await fetch(
      `/api/projects/${projectId}/workflow/runs/${expandedId.value}/pending/${decisionId}/decide`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ answer }),
      },
    )
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(body?.detail || `HTTP ${res.status}`)
    message.value = `已记录确认：${answer}`
    const keep = expandedId.value
    expandedId.value = ''
    await loadRuns()
    await toggle(keep)
  } catch (e: any) {
    message.value = e?.message || '审批失败'
  }
}

async function openReport(id: string) {
  try {
    const res = await fetch(`/api/projects/${projectId}/workflow/runs/${id}/report-content`)
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(body?.detail || `HTTP ${res.status}`)
    report.value = { name: body?.data?.name || '报告', markdown: body?.data?.markdown || '' }
  } catch (e: any) {
    message.value = `${id} 还没有报告：${e?.message || ''}`
  }
}

// ---- 执行与报告：把「跑起来」和「出报告」两件事搬到界面上 ----------------
// 后端这两个动作本来就存在（/workflow/runs/{id}/execute、/report），但界面上
// 一直没有入口，等于只能靠 Agent 会话触发。工具返回摘要 + 句柄，这里只显示
// 摘要并刷新时间线；大对象（用例、缺陷）去各自的页面看。

const busyAction = ref('')

async function refreshDetail(id: string) {
  if (!id || expandedId.value !== id) return
  try {
    const res = await fetch(`/api/projects/${projectId}/workflow/runs/${id}`)
    const body = await res.json()
    detail.value = body?.data || null
  } catch {
    // 轮询失败不打断界面，下一次再试。
  }
}

async function startExecution(runId: string) {
  busyAction.value = `execute:${runId}`
  try {
    const res = await fetch(`/api/projects/${projectId}/workflow/runs/${runId}/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // script_ids 留空 = 投递这个 run 已落库的全部脚本；timeout 给足 120s
      body: JSON.stringify({ script_ids: null, timeout_s: 120 }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok || body?.ok === false) {
      throw new Error(body?.summary || body?.detail || `HTTP ${res.status}`)
    }
    message.value = body?.summary || '已投递执行，进度见「执行」页'
    await refreshDetail(runId)
    await loadRuns()
  } catch (e: any) {
    message.value = `投递执行失败：${e?.message || ''}`
  } finally {
    busyAction.value = ''
  }
}

async function generateReport(runId: string) {
  busyAction.value = `report:${runId}`
  try {
    const res = await fetch(`/api/projects/${projectId}/workflow/runs/${runId}/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok || body?.ok === false) {
      throw new Error(body?.summary || body?.detail || `HTTP ${res.status}`)
    }
    message.value = body?.summary || '报告已生成'
    await refreshDetail(runId)
    await openReport(runId)
  } catch (e: any) {
    message.value = `生成报告失败：${e?.message || ''}`
  } finally {
    busyAction.value = ''
  }
}

// 展开的运行还在进行中时每 5s 拉一次详情：执行投递后阶段/步骤会变化，
// 不轮询就得手点刷新才知道跑到哪一步。
let pollTimer: ReturnType<typeof setInterval> | null = null
function stopPolling() {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
}
function syncPolling() {
  stopPolling()
  const status = detail.value?.status
  if (!expandedId.value) return
  if (status !== 'running' && status !== 'waiting_human') return
  pollTimer = setInterval(() => void refreshDetail(expandedId.value), 5000)
}
watch([expandedId, () => detail.value?.status], syncPolling)
onBeforeUnmount(stopPolling)

onMounted(loadRuns)
</script>

<template>
  <div class="flex-1 flex flex-col overflow-hidden">
    <div class="bg-white border-b border-gray-200 px-6 py-3">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-3">
          <h2 class="text-base font-medium text-gray-900">运行记录</h2>
          <span class="text-sm text-gray-400">共 {{ runs.length }} 次</span>
        </div>
        <div class="flex items-center gap-3">
          <span v-if="message" class="text-xs text-gray-500">{{ message }}</span>
          <button class="p-1.5 text-gray-500 hover:text-gray-800" :disabled="loading" @click="loadRuns">
            <RefreshCw class="w-4 h-4" :class="loading ? 'animate-spin' : ''" />
          </button>
        </div>
      </div>
    </div>

    <div class="flex-1 overflow-auto bg-white">
      <div class="p-6 space-y-4">
        <div v-for="run in runs" :key="run.id" class="bg-gray-50 rounded-lg border border-gray-200">
          <div class="p-5">
            <div class="flex items-center justify-between mb-3">
              <div class="flex items-center gap-2 min-w-0">
                <PlayCircle class="w-5 h-5 text-blue-600 flex-shrink-0" />
                <span class="font-medium text-gray-900 font-mono">{{ run.id }}</span>
                <span class="text-xs px-2 py-0.5 rounded" :class="statusClass(run.status)">{{ statusLabel(run.status) }}</span>
                <span class="text-xs px-2 py-0.5 rounded bg-white border border-gray-200 text-gray-600">{{ run.module || '未标模块' }}</span>
              </div>
              <span class="text-xs text-gray-400 flex-shrink-0">{{ shortTime(run.created_at) }}</span>
            </div>

            <div class="flex items-center gap-6 text-sm text-gray-600 mb-3">
              <span>当前阶段 {{ run.stage || '—' }}</span>
              <span v-if="run.requirement_ref" class="truncate">需求 {{ run.requirement_ref }}</span>
            </div>

            <div class="flex items-center gap-3">
              <button
                class="flex items-center gap-1 text-sm text-blue-600 hover:underline"
                @click="toggle(run.id)"
              >
                <ChevronDown v-if="expandedId === run.id" class="w-4 h-4" />
                <ChevronRight v-else class="w-4 h-4" />
                {{ expandedId === run.id ? '收起详情' : '查看步骤' }}
              </button>
              <button
                class="flex items-center gap-1 text-sm text-gray-600 hover:text-blue-600"
                @click="openReport(run.id)"
              >
                <FileText class="w-4 h-4" />
                查看报告
              </button>
              <!-- 跑起来 / 出报告：以前只能靠 Agent 会话触发，这里是同一个后端的入口 -->
              <button
                class="flex items-center gap-1 text-sm text-gray-600 hover:text-blue-600 disabled:opacity-50"
                :disabled="busyAction === `execute:${run.id}`"
                @click="startExecution(run.id)"
              >
                <PlayCircle class="w-4 h-4" />
                {{ busyAction === `execute:${run.id}` ? '投递中…' : '执行用例' }}
              </button>
              <button
                class="flex items-center gap-1 text-sm text-gray-600 hover:text-blue-600 disabled:opacity-50"
                :disabled="busyAction === `report:${run.id}`"
                @click="generateReport(run.id)"
              >
                <FileText class="w-4 h-4" />
                {{ busyAction === `report:${run.id}` ? '生成中…' : '生成报告' }}
              </button>
              <router-link
                :to="`/project/${projectId}/executions`"
                class="text-sm text-gray-500 hover:text-blue-600"
              >
                执行记录 →
              </router-link>
            </div>
          </div>

          <!-- 展开：待审批 + 步骤 -->
          <div v-if="expandedId === run.id" class="border-t border-gray-200 bg-white rounded-b-lg px-5 py-4 space-y-3">
            <div
              v-for="item in detail?.pending || []"
              :key="item.id"
              class="border border-yellow-200 bg-yellow-50/60 rounded-lg p-3"
            >
              <div class="text-xs text-yellow-700 font-medium">待审批 · {{ item.stage || '' }}</div>
              <div class="mt-1 text-sm text-gray-800 whitespace-pre-wrap">{{ item.prompt || '是否继续？' }}</div>
              <div class="mt-2 flex items-center gap-2">
                <button
                  v-for="opt in (item.options && item.options.length ? item.options : ['approve', 'reject'])"
                  :key="opt"
                  class="px-3 py-1.5 text-xs rounded-lg border"
                  :class="opt === 'reject'
                    ? 'border-gray-300 text-gray-700 hover:border-red-400 hover:text-red-600'
                    : 'bg-blue-600 border-blue-600 text-white hover:bg-blue-700'"
                  @click="decide(item.id, opt)"
                >
                  {{ opt === 'approve' ? '通过' : opt === 'reject' ? '驳回' : opt }}
                </button>
              </div>
            </div>

            <div class="rounded-lg border border-gray-200 divide-y divide-gray-100">
              <div v-for="step in detail?.steps || []" :key="step.id" class="px-3 py-2 flex items-start gap-3">
                <span class="w-5 text-xs text-gray-400 pt-0.5">{{ step.seq }}</span>
                <span class="w-36 text-xs font-mono text-gray-700 truncate">{{ step.tool }}</span>
                <span class="text-xs px-2 py-0.5 rounded flex-shrink-0" :class="stepClass(step.status)">
                  {{ STEP_LABELS[step.status] || step.status }}
                </span>
                <span class="flex-1 text-xs text-gray-600">{{ step.summary || '' }}</span>
                <span class="text-xs text-gray-400 flex-shrink-0">{{ shortTime(step.started_at) }}</span>
              </div>
              <div v-if="!(detail?.steps || []).length" class="px-3 py-8 text-center text-xs text-gray-400">还没有步骤</div>
            </div>
          </div>
        </div>

        <div v-if="!runs.length" class="text-center py-12 text-gray-400 text-sm">
          暂无运行记录，在 Pi 客户端里让 Agent 跑一条工作流
        </div>
      </div>
    </div>

    <!-- 报告弹层 -->
    <div v-if="report" class="fixed inset-0 bg-black/30 flex items-center justify-center z-40" @click.self="report = null">
      <div class="w-[720px] max-h-[80vh] bg-white rounded-lg shadow-lg flex flex-col">
        <div class="h-11 px-4 flex items-center justify-between border-b border-gray-100">
          <span class="text-sm font-medium text-gray-900">{{ report.name }}</span>
          <button class="text-gray-400 hover:text-gray-800" @click="report = null">关闭</button>
        </div>
        <pre class="flex-1 overflow-auto p-4 text-xs leading-relaxed whitespace-pre-wrap text-gray-800">{{ report.markdown }}</pre>
      </div>
    </div>
  </div>
</template>
