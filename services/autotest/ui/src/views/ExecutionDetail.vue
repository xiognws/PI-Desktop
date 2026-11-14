<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import Badge from '@/components/Badge.vue'
import EmptyState from '@/components/EmptyState.vue'

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


const toneName = (status: string): 'success' | 'danger' | 'warn' | 'neutral' | 'accent' => {
  if (status === 'pass' || status === '已完成') return 'success'
  if (status === 'fail' || status === '失败' || status === 'error' || status === '异常') return 'danger'
  if (status === 'cancelled' || status === '已取消') return 'warn'
  if (status === 'skip') return 'neutral'
  return 'accent'
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
  <div class="flex-1 overflow-auto bg-surface-2">
    <div class="mx-auto w-full max-w-[1100px] px-8 py-7">
      <header class="flex items-start justify-between gap-4">
        <div class="min-w-0">
          <router-link
            :to="`/project/${projectId}/executions`"
            class="text-[12px] text-muted hover:text-fg"
          >← 执行列表</router-link>
          <h1 class="mono mt-1 truncate text-[20px] font-medium text-fg">
            {{ execution?.name ?? `执行 #${executionId}` }}
          </h1>
          <p class="num mt-1 text-[13px] text-muted">
            {{ execution?.started_at ?? '' }}
            <span v-if="durationText"> · 耗时 {{ durationText }}</span>
            <span v-if="execution?.executor"> · {{ execution.executor }}</span>
          </p>
        </div>
        <div class="flex items-center gap-2 pt-5">
          <Badge :tone="toneName(runStatus)">{{ statusLabel[String(execution?.status ?? '')] ?? runStatus }}</Badge>
          <button
            v-if="isRunning"
            class="h-8 rounded-[8px] border border-danger-line px-3 text-[12px] text-danger hover:bg-danger-soft disabled:opacity-50"
            :disabled="cancelling"
            @click="cancelRun"
          >{{ cancelling ? '取消中…' : '取消执行' }}</button>
        </div>
      </header>

      <!-- 读数：通过 / 失败 / 跳过，真断言与骨架分开列 -->
      <div class="mt-5 grid grid-cols-2 divide-line rounded-[12px] border border-line bg-surface md:grid-cols-4 md:divide-x">
        <div class="px-5 py-4">
          <p class="text-[12px] text-muted">通过</p>
          <p class="num mt-1 text-[24px] leading-7 text-success">{{ counts.pass }}</p>
        </div>
        <div class="px-5 py-4">
          <p class="text-[12px] text-muted">失败</p>
          <p class="num mt-1 text-[24px] leading-7" :class="counts.fail ? 'text-danger' : 'text-fg'">{{ counts.fail }}</p>
        </div>
        <div class="px-5 py-4">
          <p class="text-[12px] text-muted">跳过</p>
          <p class="num mt-1 text-[24px] leading-7 text-muted">{{ counts.skip }}</p>
        </div>
        <div class="px-5 py-4">
          <p class="text-[12px] text-muted">覆盖率</p>
          <p class="num mt-1 text-[24px] leading-7 text-fg">真断言 {{ counts.pass + counts.fail }} · 骨架 {{ counts.skip }}</p>
          <p class="num mt-0.5 text-[12px] text-muted-2">
            跳过计通过不算验过
          </p>
        </div>
      </div>

      <p v-if="error" class="mt-3 rounded-[8px] border border-danger-line bg-danger-soft px-4 py-2 text-[13px] text-danger">{{ error }}</p>

      <p v-if="runEnd" class="num mt-2 text-[12px] text-muted-2">
        replay 命中 {{ runEnd.replayHit ? '是' : '否' }} · 模型调用 {{ runEnd.modelCalls ?? 0 }}
      </p>

      <!-- 步骤 -->
      <section class="mt-5 overflow-hidden rounded-[12px] border border-line bg-surface">
        <div class="flex items-center justify-between border-b border-line px-5 py-2">
          <h2 class="text-[13px] font-medium text-fg">执行步骤</h2>
          <div class="flex items-center gap-3">
            <span class="num text-[12px] text-muted-2">{{ events.length }} 条事件</span>
            <button
              class="h-7 rounded-[6px] px-2 text-[12px]"
              :class="onlyFailed ? 'bg-danger-soft text-danger' : 'text-muted hover:text-fg'"
              @click="onlyFailed = !onlyFailed"
            >只看失败</button>
          </div>
        </div>

        <div
          v-for="s in visibleSteps"
          :key="s.id"
          class="state-bar border-b border-line-soft last:border-b-0"
          :data-tone="toneName(s.status) === 'danger' ? 'danger' : toneName(s.status) === 'success' ? 'success' : toneName(s.status) === 'warn' ? 'warn' : 'neutral'"
        >
          <button
            class="flex w-full items-center gap-3 px-5 py-2.5 text-left select-none"
            @click="toggleStep(s.id)"
          >
            <span class="min-w-0 flex-1 truncate text-[13px] text-fg">{{ s.label }}</span>
            <Badge :tone="toneName(s.status)">{{ s.status }}</Badge>
            <span v-if="s.detail && isCollapsed(s.id)" class="text-[12px] text-muted-2">
              {{ detailLines(s.detail).length }} 行
            </span>
            <span class="num w-16 text-right text-[12px] text-muted-2">
              {{ s.durationMs != null ? `${(s.durationMs / 1000).toFixed(2)}s` : '—' }}
            </span>
          </button>

          <div v-if="s.detail && !isCollapsed(s.id)" class="mx-5 mb-3 overflow-hidden rounded-[8px] border border-line bg-surface-2">
            <div
              v-for="(line, index) in detailLines(s.detail)"
              :key="index"
              class="mono whitespace-pre-wrap px-3 py-0.5 text-[12px]"
              :class="line.bad ? 'bg-danger-soft font-medium text-danger' : 'text-muted'"
            >{{ line.text || ' ' }}</div>
          </div>
        </div>

        <EmptyState
          v-if="visibleSteps.length === 0"
          class="m-5"
          :title="steps.length ? '这次执行没有失败步骤' : '还没有步骤事件'"
          :hint="steps.length ? '关掉「只看失败」看全部' : '执行刚开始，稍等一下'"
        />
      </section>

      <!-- 产物 -->
      <section v-if="artifacts.length" class="mt-5 rounded-[12px] border border-line bg-surface px-5 py-4">
        <h2 class="text-[13px] font-medium text-fg">产物</h2>
        <div class="mt-3 grid gap-3 sm:grid-cols-2 md:grid-cols-3">
          <div v-for="a in artifacts" :key="a.path" class="overflow-hidden rounded-[8px] border border-line">
            <a v-if="isImage(a.path)" :href="fileUrl(a.path)" target="_blank" rel="noreferrer" class="block">
              <img :src="fileUrl(a.path)" :alt="a.path" class="h-32 w-full bg-surface-2 object-cover" />
            </a>
            <div v-else class="flex h-32 items-center justify-center bg-surface-2 text-[12px] text-muted-2">
              {{ a.kind }}
            </div>
            <div class="border-t border-line-soft px-2 py-1.5">
              <p class="mono truncate text-[12px] text-fg">{{ a.path?.split(/[\\/]/).pop() }}</p>
              <a :href="fileUrl(a.path)" target="_blank" rel="noreferrer" class="text-[12px] text-muted hover:text-fg">
                {{ isImage(a.path) ? '打开原图' : '下载' }}
              </a>
            </div>
          </div>
        </div>
      </section>

      <p
        v-if="failure"
        class="mt-5 whitespace-pre-wrap rounded-[8px] px-4 py-3 text-[13px]"
        :class="execution?.status === '已取消' ? 'border border-warn-line bg-warn-soft text-warn' : 'border border-danger-line bg-danger-soft text-danger'"
      >{{ execution?.status === '已取消' ? '结束原因' : '失败原因' }}：{{ failure }}</p>
    </div>
  </div>
</template>
