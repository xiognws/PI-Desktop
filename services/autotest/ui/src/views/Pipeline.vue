<script setup lang="ts">
/**
 * 流水线：按「人真正会用的顺序」把一次测试活动串起来。
 *
 * 之前每一步都要靠 Agent 或 curl 打接口，界面上只能看到产物。这一页把顺序固定成
 * 资料入库 → 解析 → 设计用例 → 评审 → 生成脚本 → 执行 → 报告，每一步给出
 * 「现在能不能跑（依赖是否满足）」「跑出来的真实数字」「下一步去哪看」。
 */
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  Circle,
  Loader2,
  RefreshCw,
  Play,
} from 'lucide-vue-next'

const route = useRoute()
const projectId = route.params.projectId as string

type Run = {
  id: string
  module?: string
  requirement_ref?: string
  stage?: string
  status?: string
  updated_at?: string
}
type Step = { seq: number; tool: string; stage: string; status: string; summary: string }
type RunStatus = {
  run_id: string
  stage: string
  status: string
  steps: Step[]
  execution: Record<string, number>
  failures: { script_name: string; status: string; failure: string }[]
  bugs: number
}

const runs = ref<Run[]>([])
const runId = ref('')
const status = ref<RunStatus | null>(null)
const requirements = ref<{ filename: string }[]>([])
const knowledge = ref<{ filename: string; chunk_count: number }[]>([])
const caseCount = ref(0)
const scriptCount = ref(0)
const reference = ref('')

const busy = ref('')
const message = ref('')
const error = ref('')

const STEPS = [
  { key: 'ingest', title: '① 资料入库', hint: '把上传的项目资料切分进知识库', to: 'requirements', tool: '' },
  { key: 'parse', title: '② 解析需求', hint: '资料 → 功能点 / 非功能 / 依赖 / 风险', to: 'requirements', tool: 'autotest_prd_parse' },
  { key: 'design', title: '③ 设计用例', hint: '按功能点生成功能与异常用例', to: 'cases', tool: 'autotest_case_design' },
  { key: 'review', title: '④ 评审用例', hint: '挑出不可测与重复用例', to: 'cases', tool: 'autotest_case_review' },
  { key: 'author', title: '⑤ 生成脚本', hint: '每条用例一个 pytest 脚本', to: 'scripts', tool: 'autotest_script_author' },
  { key: 'execute', title: '⑥ 执行', hint: '跑脚本，统计用例级结果', to: 'executions', tool: 'autotest_run_result' },
  { key: 'report', title: '⑦ 出报告', hint: '生成 Markdown 报告并归档知识库', to: 'reports', tool: 'autotest_report' },
] as const

function lastStep(tool: string): Step | null {
  const steps = status.value?.steps ?? []
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    if (steps[index].tool === tool) return steps[index]
  }
  return null
}

function stepSummary(key: string): string {
  if (key === 'ingest') {
    if (!requirements.value.length) return '还没有项目资料'
    const missing = requirements.value.filter(
      (item) => !knowledge.value.some((doc) => doc.filename === item.filename),
    ).length
    const chunks = knowledge.value.reduce((sum, doc) => sum + (doc.chunk_count || 0), 0)
    return missing
      ? `${requirements.value.length} 份资料，${missing} 份未入库`
      : `${requirements.value.length} 份资料已全部入库，共 ${chunks} 个切片`
  }
  const step = lastStep(STEPS.find((item) => item.key === key)!.tool)
  if (!step) return '还没跑'
  return step.summary || '已完成'
}

function stepDone(key: string): boolean {
  if (key === 'ingest') {
    return (
      requirements.value.length > 0 &&
      requirements.value.every((item) => knowledge.value.some((doc) => doc.filename === item.filename))
    )
  }
  const step = lastStep(STEPS.find((item) => item.key === key)!.tool)
  return Boolean(step) && step!.status !== 'failed'
}

/** 依赖没满足就不让点，并在按钮旁说清楚缺哪一步。 */
function blocker(key: string): string {
  if (key === 'ingest' || key === 'parse') {
    return requirements.value.length ? '' : '先上传项目资料'
  }
  const order = ['parse', 'design', 'review', 'author', 'execute', 'report']
  const index = order.indexOf(key)
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (!stepDone(order[cursor])) {
      return `先完成「${STEPS.find((item) => item.key === order[cursor])!.title}」`
    }
  }
  if (key === 'execute' && !scriptCount.value) return '还没有脚本'
  return ''
}

const progress = computed(() => STEPS.filter((step) => stepDone(step.key)).length)

/** 执行完但还没出报告时，run 的 status 仍是 running（生命周期如此），界面上要说人话。 */
const statusLabel = computed(() => {
  const current = status.value
  if (!current) return '—'
  if (current.stage === 'executed' && current.status === 'running') return '执行完成，待出报告'
  if (current.status === 'done') return '已完成'
  if (current.status === 'running') return '进行中'
  return current.status || '—'
})

async function api(path: string, init?: RequestInit) {
  const response = await fetch(`/api/projects/${projectId}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body?.detail || `HTTP ${response.status}`)
  return body
}

async function loadAssets() {
  const [reqs, docs, cases, scripts] = await Promise.all([
    api('/requirements').catch(() => ({ requirements: [] })),
    api('/knowledge/documents').catch(() => ({})),
    api('/cases').catch(() => ({ cases: [] })),
    api('/scripts').catch(() => ({ scripts: [] })),
  ])
  requirements.value = reqs.requirements ?? []
  knowledge.value = (docs.documents ?? docs.data?.documents ?? []) as { filename: string; chunk_count: number }[]
  caseCount.value = (cases.cases ?? []).length
  scriptCount.value = (scripts.scripts ?? []).length
  if (!reference.value && requirements.value.length) {
    reference.value = requirements.value[0].filename
  }
}

async function loadRuns() {
  const body = await api('/workflow/runs?limit=20').catch(() => ({ data: { runs: [] } }))
  runs.value = body.data?.runs ?? []
  if (!runId.value && runs.value.length) runId.value = runs.value[0].id
  if (runId.value) await loadStatus()
}

async function loadStatus() {
  if (!runId.value) {
    status.value = null
    return
  }
  const body = await api(`/workflow/runs/${runId.value}/status`).catch(() => null)
  status.value = body?.data ?? null
  if (status.value?.execution) {
    caseCount.value = caseCount.value || 0
  }
}

async function refresh() {
  error.value = ''
  try {
    await loadAssets()
    await loadRuns()
  } catch (problem) {
    error.value = String((problem as Error).message ?? problem)
  }
}

async function runStage(key: string) {
  busy.value = key
  message.value = ''
  error.value = ''
  try {
    if (key === 'ingest') {
      const body = await api('/knowledge/documents/from-specs', {
        method: 'POST',
        body: JSON.stringify({ module: '', tags: '项目资料' }),
      })
      message.value = body.summary || '已入库'
    } else if (key === 'parse') {
      const body = await api('/workflow/prd-parse', {
        method: 'POST',
        body: JSON.stringify({ requirement_ref: reference.value, module: '', run_id: runId.value || undefined }),
      })
      runId.value = body.data?.run_id || runId.value
      message.value = body.summary || '解析完成'
    } else if (key === 'design') {
      const body = await api('/workflow/case-design', {
        method: 'POST',
        body: JSON.stringify({ run_id: runId.value }),
      })
      message.value = body.summary || '用例已生成'
    } else if (key === 'review') {
      const body = await api('/workflow/case-review', {
        method: 'POST',
        body: JSON.stringify({ run_id: runId.value }),
      })
      message.value = body.summary || '评审完成'
    } else if (key === 'author') {
      const body = await api('/workflow/script-author', {
        method: 'POST',
        body: JSON.stringify({ run_id: runId.value }),
      })
      message.value = body.summary || '脚本已生成'
    } else if (key === 'execute') {
      await api(`/workflow/runs/${runId.value}/execute`, {
        method: 'POST',
        body: JSON.stringify({ timeout_s: 180 }),
      })
      await waitForExecution()
      message.value = '执行完成'
    } else if (key === 'report') {
      const body = await api(`/workflow/runs/${runId.value}/report`, { method: 'POST', body: '{}' })
      message.value = body.summary || '报告已生成'
    }
    await loadAssets()
    await loadStatus()
  } catch (problem) {
    error.value = `${key} 失败：${String((problem as Error).message ?? problem)}`
  } finally {
    busy.value = ''
  }
}

/** 执行是后台线程：轮询到出现新的 run_result 步骤（或 run 结束）为止。 */
async function waitForExecution() {
  const before = (status.value?.steps ?? []).filter((s) => s.tool === 'autotest_run_result').length
  const deadline = Date.now() + 6 * 60 * 1000
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 3000))
    await loadStatus()
    const after = (status.value?.steps ?? []).filter((s) => s.tool === 'autotest_run_result').length
    if (after > before) return
    if (status.value?.status === 'done' || status.value?.status === 'failed') return
  }
  throw new Error('执行超时（6 分钟未返回结果）')
}

function dotClass(key: string): string {
  if (busy.value === key) return 'text-accent'
  if (stepDone(key)) return 'text-success'
  if (blocker(key)) return 'text-muted-2'
  return 'text-accent'
}

onMounted(refresh)
</script>

<template>
  <div class="flex-1 flex flex-col overflow-auto bg-surface">
    <div class="p-6 max-w-5xl w-full">
      <div class="flex items-start justify-between mb-5">
        <div>
          <h2 class="text-lg font-medium text-fg">流水线</h2>
          <p class="text-sm text-muted mt-1">
            资料 → 知识库 → 用例 → 脚本 → 执行 → 报告。每一步都用真实数据，做完了才允许下一步。
          </p>
        </div>
        <div class="flex items-center gap-2">
          <select
            v-model="runId"
            class="text-sm border border-line rounded-lg px-2 py-1.5 bg-surface text-fg"
            @change="loadStatus"
          >
            <option value="">（还没有运行）</option>
            <option v-for="run in runs" :key="run.id" :value="run.id">
              {{ run.id }} · {{ run.requirement_ref || '未选资料' }} · {{ run.stage || 'parsed' }}
            </option>
          </select>
          <button
            class="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-line rounded-lg hover:bg-surface-2"
            @click="refresh"
          >
            <RefreshCw class="w-4 h-4" /> 刷新
          </button>
        </div>
      </div>

      <!-- 资料来源 + 进度 -->
      <div class="bg-surface rounded-lg border border-line p-4 mb-5 flex items-center gap-4 flex-wrap">
        <label class="text-sm text-muted">解析哪份资料</label>
        <select
          v-model="reference"
          class="text-sm border border-line rounded-lg px-2 py-1.5 bg-surface text-fg min-w-64"
        >
          <option v-for="item in requirements" :key="item.filename" :value="item.filename">
            {{ item.filename }}
          </option>
        </select>
        <span class="text-xs text-muted-2">
          已完成 {{ progress }} / {{ STEPS.length }} 步
        </span>
        <span v-if="status" class="ml-auto text-xs text-muted">
          run {{ status.run_id }} · 阶段 {{ status.stage || '—' }} · 状态 {{ statusLabel }}
        </span>
      </div>

      <div v-if="message" class="text-sm text-success mb-3">{{ message }}</div>
      <div v-if="error" class="text-sm text-danger mb-3">{{ error }}</div>

      <!-- 步骤列表 -->
      <div class="space-y-3">
        <div
          v-for="step in STEPS"
          :key="step.key"
          class="bg-surface rounded-lg border border-line p-4 flex items-start gap-3"
        >
          <component
            :is="busy === step.key ? Loader2 : stepDone(step.key) ? CheckCircle2 : blocker(step.key) ? Circle : Circle"
            class="w-5 h-5 mt-0.5"
            :class="[dotClass(step.key), busy === step.key ? 'animate-spin' : '']"
          />
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <span class="font-medium text-fg">{{ step.title }}</span>
              <span class="text-xs text-muted-2">{{ step.hint }}</span>
            </div>
            <div class="text-sm text-muted mt-1">{{ stepSummary(step.key) }}</div>

            <!-- 执行统计 -->
            <div v-if="step.key === 'execute' && status?.execution?.total" class="text-xs text-muted mt-1">
              用例 {{ status.execution.total }} 条 · 通过 {{ status.execution.pass ?? 0 }} · 跳过
              {{ status.execution.skip ?? 0 }} · 失败 {{ status.execution.fail ?? 0 }} · 脚本
              {{ status.execution.scripts ?? 0 }} 个
            </div>
            <div v-if="step.key === 'design'" class="text-xs text-muted mt-1">
              用例库共 <span class="text-fg">{{ caseCount }}</span> 条
            </div>
            <div v-if="step.key === 'author'" class="text-xs text-muted mt-1">
              脚本库共 <span class="text-fg">{{ scriptCount }}</span> 个
            </div>

            <!-- 失败明细 -->
            <div
              v-if="step.key === 'execute' && status?.failures?.length"
              class="mt-2 text-xs text-danger space-y-1"
            >
              <div v-for="(item, index) in status.failures" :key="index" class="flex items-start gap-1">
                <AlertCircle class="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                <span class="truncate">{{ item.script_name }}：{{ item.failure }}</span>
              </div>
            </div>
          </div>

          <div class="flex items-center gap-2 flex-shrink-0">
            <button
              class="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-line hover:bg-surface-2 disabled:opacity-40"
              :disabled="Boolean(busy) || Boolean(blocker(step.key))"
              :title="blocker(step.key) || '执行这一步'"
              @click="runStage(step.key)"
            >
              <Play class="w-4 h-4" />
              {{ busy === step.key ? '进行中…' : stepDone(step.key) ? '重跑' : '执行' }}
            </button>
            <router-link
              :to="`/project/${projectId}/${step.to}`"
              class="flex items-center gap-1 px-2 py-1.5 text-sm text-accent hover:underline"
            >
              查看 <ArrowRight class="w-3.5 h-3.5" />
            </router-link>
          </div>
        </div>
      </div>

      <p class="text-xs text-muted-2 mt-5">
        「生成脚本」产出的是 pytest 骨架（每条用例一个文件、断言待补）；已补完断言的脚本执行时会得到真实的通过/失败。
      </p>
    </div>
  </div>
</template>
