<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { RefreshCw, ChevronDown, ChevronRight } from 'lucide-vue-next'
import Badge from '@/components/Badge.vue'
import EmptyState from '@/components/EmptyState.vue'

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
// 执行早已结束、但还没生成报告：状态仍是 running，需要明确告诉用户下一步是「生成报告」。
function needsReport(run: Run) {
  return run.status === 'running' && run.stage === 'executed'
}

function statusTone(status?: string): 'accent' | 'warn' | 'success' | 'danger' | 'neutral' {
  if (status === 'running') return 'accent'
  if (status === 'waiting_human') return 'warn'
  if (status === 'done') return 'success'
  if (status === 'failed') return 'danger'
  return 'neutral'
}
function stepTone(status?: string): 'success' | 'danger' | 'accent' | 'neutral' {
  if (status === 'ok') return 'success'
  if (status === 'error' || status === 'failed') return 'danger'
  if (status === 'running') return 'accent'
  return 'neutral'
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
  <div class="flex-1 overflow-auto bg-surface-2">
    <div class="mx-auto w-full max-w-[1200px] px-8 py-7">
      <header class="flex items-start justify-between gap-4">
        <div>
          <h1 class="text-[20px] font-medium text-fg">运行记录</h1>
          <p class="mt-1 text-[13px] text-muted">流水线每跑一步都会留下一条运行记录，展开能看到每一步调了什么、结果是什么。</p>
        </div>
        <button
          class="flex h-9 items-center gap-2 rounded-[8px] border border-line bg-surface px-3 text-[13px] text-fg hover:bg-surface-3 disabled:opacity-40"
          :disabled="loading"
          @click="loadRuns"
        >
          <RefreshCw class="h-4 w-4" :class="loading ? 'animate-spin' : ''" /> 刷新
        </button>
      </header>

      <div class="mt-5 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-[12px] border border-line bg-surface px-5 py-3">
        <span class="num text-[13px] text-fg">{{ runs.length }}<span class="text-muted"> 次运行</span></span>
        <span v-if="message" class="text-[12px] text-muted">{{ message }}</span>
      </div>

      <div class="mt-5 overflow-hidden rounded-[12px] border border-line bg-surface">
        <template v-for="run in runs" :key="run.id">
          <button
            class="state-bar grid w-full grid-cols-1 items-center gap-3 border-b border-line-soft px-5 py-3 text-left last:border-b-0 hover:bg-surface-2 lg:grid-cols-[auto_auto_auto_1fr_auto_auto]"
            :data-tone="statusTone(run.status) === 'success' ? 'success' : statusTone(run.status) === 'danger' ? 'danger' : statusTone(run.status) === 'warn' ? 'warn' : 'accent'"
            @click="toggle(run.id)"
          >
            <span class="flex items-center gap-2">
              <ChevronDown v-if="expandedId === run.id" class="h-3.5 w-3.5 text-muted" />
              <ChevronRight v-else class="h-3.5 w-3.5 text-muted" />
              <span class="mono text-[13px] text-fg">{{ run.id }}</span>
            </span>

            <span class="flex items-center gap-2">
              <Badge :tone="statusTone(run.status)">{{ statusLabel(run.status) }}</Badge>
              <Badge v-if="needsReport(run)" tone="warn">已执行 · 待出报告</Badge>
            </span>

            <span class="text-[12px] text-muted">{{ run.module || '未标模块' }}</span>

            <span class="truncate text-[12px] text-muted-2">
              当前阶段 {{ run.stage || '—' }}<template v-if="run.requirement_ref"> · 资料 {{ run.requirement_ref }}</template>
            </span>

            <span class="num text-[12px] text-muted-2">{{ shortTime(run.created_at) }}</span>

            <span class="flex items-center justify-end gap-3 text-[12px]" @click.stop>
              <button class="text-muted hover:text-fg" @click="toggle(run.id)">
                {{ expandedId === run.id ? '收起' : '步骤' }}
              </button>
              <button class="text-muted hover:text-fg" @click="openReport(run.id)">报告</button>
              <button
                class="text-muted hover:text-fg disabled:opacity-40"
                :disabled="busyAction === `execute:${run.id}`"
                @click="startExecution(run.id)"
              >{{ busyAction === `execute:${run.id}` ? '投递中…' : '执行用例' }}</button>
              <button
                class="text-muted hover:text-fg disabled:opacity-40"
                :disabled="busyAction === `report:${run.id}`"
                @click="generateReport(run.id)"
              >{{ busyAction === `report:${run.id}` ? '生成中…' : '生成报告' }}</button>
            </span>
          </button>

          <!-- 展开：待审批 + 步骤 -->
          <div v-if="expandedId === run.id" class="border-b border-line-soft bg-surface-2 px-5 py-4">
            <div
              v-for="item in detail?.pending || []"
              :key="item.id"
              class="mb-3 rounded-[8px] border border-warn-line bg-warn-soft px-4 py-3"
            >
              <p class="text-[12px] font-medium text-warn">待审批 · {{ item.stage || '' }}</p>
              <p class="mt-1 whitespace-pre-wrap text-[13px] text-fg">{{ item.prompt || '是否继续？' }}</p>
              <div class="mt-2 flex items-center gap-2">
                <button
                  v-for="opt in (item.options && item.options.length ? item.options : ['approve', 'reject'])"
                  :key="opt"
                  class="h-8 rounded-[8px] px-3 text-[12px]"
                  :class="opt === 'reject'
                    ? 'border border-line text-fg hover:border-danger hover:text-danger'
                    : 'bg-accent-solid text-white hover:bg-accent'"
                  @click="decide(item.id, opt)"
                >{{ opt === 'approve' ? '通过' : opt === 'reject' ? '驳回' : opt }}</button>
              </div>
            </div>

            <div class="overflow-hidden rounded-[8px] border border-line bg-surface">
              <div
                v-for="step in detail?.steps || []"
                :key="step.id"
                class="grid grid-cols-[28px_150px_88px_1fr_120px] items-center gap-3 border-b border-line-soft px-3 py-2 last:border-b-0"
              >
                <span class="num text-[12px] text-muted-2">{{ step.seq }}</span>
                <span class="mono truncate text-[12px] text-fg">{{ step.tool }}</span>
                <Badge :tone="stepTone(step.status)">{{ STEP_LABELS[step.status] || step.status }}</Badge>
                <span class="truncate text-[12px] text-muted">{{ step.summary || '' }}</span>
                <span class="num text-right text-[12px] text-muted-2">{{ shortTime(step.started_at) }}</span>
              </div>
              <p v-if="!(detail?.steps || []).length" class="px-3 py-6 text-center text-[12px] text-muted-2">还没有步骤</p>
            </div>
          </div>
        </template>

        <EmptyState
          v-if="!runs.length"
          class="m-5"
          title="还没有运行记录"
          hint="到「流水线」跑第一步，或用 Agent 触发一条工作流"
        />
      </div>
    </div>

    <!-- 报告弹层 -->
    <div v-if="report" class="fixed inset-0 z-40 flex items-center justify-center bg-black/30" @click.self="report = null">
      <div class="flex max-h-[80vh] w-[760px] flex-col overflow-hidden rounded-[12px] border border-line bg-surface">
        <div class="flex h-11 items-center justify-between border-b border-line px-4">
          <span class="text-[13px] font-medium text-fg">{{ report.name }}</span>
          <button class="text-[12px] text-muted hover:text-fg" @click="report = null">关闭</button>
        </div>
        <pre class="flex-1 overflow-auto px-4 py-3 text-[12px] leading-relaxed whitespace-pre-wrap text-fg">{{ report.markdown }}</pre>
      </div>
    </div>
  </div>
</template>
