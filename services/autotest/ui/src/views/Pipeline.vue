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
import { AlertCircle, ArrowRight, Loader2, Play, RefreshCw } from 'lucide-vue-next'

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
// ③ 跳过哪些用例、为什么：这是"待补资料"清单，随设计结果一起显示。
const designGaps = ref<{ function_point: string; reason: string; case_types: string[] }[]>([])
// 这一页的产出按哪一版固定提示词规则生成：规则在 services/autotest/prompts/ 里，改规则要升版本。
const promptRefs = ref<{ stage: string; ref: string }[]>([])
const message = ref('')
const error = ref('')

const GAP_REASONS: Record<string, string> = {
  no_hit: '知识库没提到这个功能点，需要补一份对应资料',
  empty_source: '资料这一节只有标题、没有正文（多为表格/图片），要补原文',
  no_clause: '命中的条款没有可判定内容（没有阈值，也没有"应/必须"）',
}

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
      designGaps.value = body.data?.uncovered || []
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

async function loadPrompts() {
  try {
    const body = await api('/workflow/prompts')
    promptRefs.value = (body.data?.prompts || []).map((item: { stage: string; ref: string }) => ({
      stage: item.stage,
      ref: item.ref,
    }))
  } catch {
    promptRefs.value = []
  }
}

onMounted(async () => {
  await refresh()
  await loadPrompts()
})
</script>

<template>
  <div class="flex-1 overflow-auto bg-surface-2">
    <div class="mx-auto w-full max-w-[1100px] px-8 py-7">
      <!-- 页头：标题 + 一句说清这一页做什么。不放按钮，动作在轨道上 -->
      <header class="flex items-start justify-between gap-4">
        <div>
          <h1 class="text-[20px] font-medium text-fg">流水线</h1>
          <p class="mt-1 text-[13px] text-muted">
            资料 → 知识库 → 用例 → 脚本 → 执行 → 报告。每一步都用真实数据，前一步没完成就不让点下一步。
          </p>
        </div>
        <div class="flex items-center gap-2 pt-1">
          <select
            v-model="runId"
            class="h-9 min-w-[260px] rounded-[8px] border border-line bg-surface px-2 text-[13px] text-fg"
            @change="loadStatus"
          >
            <option value="">选择一次运行</option>
            <option v-for="run in runs" :key="run.id" :value="run.id">
              {{ run.id }} · {{ run.requirement_ref || '未选资料' }}
            </option>
          </select>
          <button
            class="flex h-9 items-center gap-2 rounded-[8px] border border-line bg-surface px-3 text-[13px] text-fg hover:bg-surface-3"
            @click="refresh"
          >
            <RefreshCw class="h-4 w-4" /> 刷新
          </button>
        </div>
      </header>

      <!-- 运行摘要：一行等宽读数（这是页面上唯一的"仪表"位置） -->
      <div class="mt-5 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-[12px] border border-line bg-surface px-5 py-3">
        <label class="flex items-center gap-2 text-[13px] text-muted">
          解析哪份资料
          <select
            v-model="reference"
            class="h-8 min-w-[240px] rounded-[8px] border border-line bg-surface px-2 text-[13px] text-fg"
          >
            <option v-for="item in requirements" :key="item.filename" :value="item.filename">
              {{ item.filename }}
            </option>
          </select>
        </label>
        <span class="mono text-[13px] text-fg">
          {{ progress }}<span class="text-muted">/{{ STEPS.length }} 步</span>
        </span>
        <span v-if="status" class="mono text-[12px] text-muted">
          {{ status.run_id }} · {{ status.stage || '—' }} · {{ statusLabel }}
        </span>
      </div>

      <p v-if="message" class="mt-3 text-[13px] text-success">{{ message }}</p>
      <p v-if="error" class="mt-3 text-[13px] text-danger">{{ error }}</p>

      <!-- 七步轨道：每步一行，左侧 3px 状态竖条 + 等宽序号 -->
      <ol class="mt-5 overflow-hidden rounded-[12px] border border-line bg-surface">
        <li
          v-for="(step, index) in STEPS"
          :key="step.key"
          class="state-bar flex items-start gap-4 border-b border-line-soft px-5 py-4 last:border-b-0"
          :data-tone="
            busy === step.key
              ? 'accent'
              : stepDone(step.key)
                ? 'success'
                : blocker(step.key)
                  ? 'neutral'
                  : 'accent'
          "
        >
          <span class="mono w-6 shrink-0 pt-0.5 text-[12px] text-muted-2">
            {{ String(index + 1).padStart(2, '0') }}
          </span>

          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-baseline gap-x-2">
              <span class="text-[14px] text-fg">{{ step.title.replace(/^[①-⑦]\s*/, '') }}</span>
              <span class="text-[12px] text-muted-2">{{ step.hint }}</span>
            </div>
            <p class="mt-1 text-[13px] text-muted">{{ stepSummary(step.key) }}</p>

            <p
              v-if="step.key === 'execute' && status?.execution?.total"
              class="mono mt-1 text-[12px] text-muted"
            >
              用例 {{ status.execution.total }} · 通过 {{ status.execution.pass ?? 0 }} · 跳过
              {{ status.execution.skip ?? 0 }} · 失败 {{ status.execution.fail ?? 0 }} · 脚本
              {{ status.execution.scripts ?? 0 }}
            </p>
            <p v-if="step.key === 'design'" class="mono mt-1 text-[12px] text-muted">
              用例库 {{ caseCount }} 条
            </p>
            <p v-if="step.key === 'author'" class="mono mt-1 text-[12px] text-muted">
              脚本库 {{ scriptCount }} 个
            </p>

            <div v-if="step.key === 'design' && designGaps.length" class="mt-2">
              <p class="text-[12px] text-warn">待补资料：这些功能点没有原文依据，未生成用例</p>
              <ul class="mt-1 space-y-0.5">
                <li v-for="gap in designGaps" :key="gap.function_point" class="text-[12px] text-muted">
                  <span class="text-fg-2">{{ gap.function_point }}</span>
                  <span class="text-muted-2"> — {{ GAP_REASONS[gap.reason] || gap.reason }}</span>
                </li>
              </ul>
            </div>

            <ul v-if="step.key === 'execute' && status?.failures?.length" class="mt-2 space-y-1">
              <li
                v-for="(item, i) in status.failures"
                :key="i"
                class="flex items-start gap-2 text-[12px] text-danger"
              >
                <AlertCircle class="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span class="truncate">{{ item.script_name }}：{{ item.failure }}</span>
              </li>
            </ul>
          </div>

          <div class="flex shrink-0 items-center gap-1">
            <button
              class="flex h-8 items-center gap-2 rounded-[8px] border border-line px-3 text-[13px] text-fg hover:bg-surface-3 disabled:opacity-40"
              :disabled="Boolean(busy) || Boolean(blocker(step.key))"
              :title="blocker(step.key) || '执行这一步'"
              @click="runStage(step.key)"
            >
              <Loader2 v-if="busy === step.key" class="h-3.5 w-3.5 animate-spin" />
              <Play v-else class="h-3.5 w-3.5" />
              {{ busy === step.key ? '进行中' : stepDone(step.key) ? '重跑' : '执行' }}
            </button>
            <router-link
              :to="`/project/${projectId}/${step.to}`"
              class="flex h-8 items-center gap-1 rounded-[8px] px-2 text-[13px] text-muted hover:bg-surface-3 hover:text-fg"
            >
              查看 <ArrowRight class="h-3.5 w-3.5" />
            </router-link>
          </div>
        </li>
      </ol>

      <footer class="mt-4 space-y-1">
        <p class="text-[12px] text-muted-2">
          ⑤ 生成的是 pytest 骨架（每条用例一个文件、断言待补）；补完断言的脚本执行时才得到真实通过/失败。
        </p>
        <p v-if="promptRefs.length" class="mono text-[12px] text-muted-2">
          规则 {{ promptRefs.map((item) => item.ref).join(' · ') }}
        </p>
      </footer>
    </div>
  </div>
</template>
