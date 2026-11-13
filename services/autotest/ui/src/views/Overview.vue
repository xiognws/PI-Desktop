<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { Activity, AlertTriangle, CheckCircle, ClipboardList, Clock, RefreshCw } from 'lucide-vue-next'

const route = useRoute()
const projectId = route.params.projectId as string

type Execution = {
  id: number
  name: string
  total: number
  passed: number
  failed: number
  status: string
  started_at?: string
}
type Bug = { id: string; title?: string; severity?: string; status?: string; occurrences?: number; last_seen_at?: string }
type Run = { id: string; module?: string; stage?: string; status: string; updated_at?: string }
type EnvItem = { ok: boolean; label: string }

const loading = ref(false)
const error = ref('')
const caseStats = ref<{ case_count: number; execution_count: number }>({ case_count: 0, execution_count: 0 })
const scripts = ref<unknown[]>([])
const executions = ref<Execution[]>([])
const bugs = ref<Bug[]>([])
const bugTotal = ref(0)
const pending = ref<unknown[]>([])
const pendingTotal = ref(0)
const runs = ref<Run[]>([])
const env = ref<Record<string, EnvItem>>({})

async function getJson(path: string) {
  const res = await fetch(path)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body?.detail || `HTTP ${res.status}`)
  return body
}

async function load() {
  loading.value = true
  try {
    const base = `/api/projects/${projectId}`
    const [stats, scriptBody, execBody, bugBody, pendingBody, runBody, envBody] = await Promise.all([
      getJson(`${base}/case-stats`),
      getJson(`${base}/scripts`),
      getJson(`${base}/executions`),
      getJson(`${base}/workflow/bugs?limit=200`),
      getJson(`${base}/workflow/pending?limit=200`),
      getJson(`${base}/workflow/runs?limit=10`),
      getJson(`${base}/env-status`),
    ])
    caseStats.value = {
      case_count: Number(stats?.case_count ?? 0),
      execution_count: Number(stats?.execution_count ?? 0),
    }
    scripts.value = scriptBody?.scripts || []
    executions.value = execBody?.executions || []
    bugs.value = bugBody?.data?.bugs || []
    bugTotal.value = Number(bugBody?.data?.total ?? bugs.value.length)
    pending.value = pendingBody?.data?.decisions || []
    pendingTotal.value = Number(pendingBody?.data?.total ?? pending.value.length)
    runs.value = runBody?.data?.runs || []
    env.value = envBody || {}
    error.value = ''
  } catch (e) {
    error.value = `加载概览失败：${(e as Error).message}`
  } finally {
    loading.value = false
  }
}

// 通过率只看有结果的执行：还在跑的那条不计入分母，否则首页数字会随进度乱跳。
const graded = computed(() => executions.value.filter((e) => e.total > 0 && e.status !== '执行中'))
const passRate = computed(() => {
  const total = graded.value.reduce((sum, e) => sum + e.total, 0)
  const passed = graded.value.reduce((sum, e) => sum + e.passed, 0)
  return total ? Math.round((passed / total) * 100) : 0
})
const failedCount = computed(() => graded.value.reduce((sum, e) => sum + e.failed, 0))

// 趋势条：最近 10 次有结果的执行，按通过率画高度。
const trend = computed(() =>
  graded.value
    .slice(0, 10)
    .reverse()
    .map((e) => ({
      id: e.id,
      label: e.name,
      ratio: e.total ? e.passed / e.total : 0,
      failed: e.failed,
    })),
)

const openBugs = computed(() => bugs.value.filter((b) => (b.status ?? 'open') !== 'verified' && b.status !== 'wontfix'))
const envItems = computed(() => Object.entries(env.value))
const envDown = computed(() => envItems.value.filter(([, item]) => !item.ok).length)

function bugClass(severity?: string) {
  if (severity === 'blocker') return 'bg-danger-soft text-danger'
  if (severity === 'major') return 'bg-warn-soft text-warn'
  return 'bg-surface-3 text-fg-3'
}

function runTone(status: string) {
  if (status === 'waiting_human') return 'bg-warn-soft text-warn'
  if (status === 'done') return 'bg-success-soft text-success'
  if (status === 'failed') return 'bg-danger-soft text-danger'
  return 'bg-accent-soft text-accent'
}

function shortTime(value?: string) {
  return value ? value.replace('T', ' ').slice(5, 16) : ''
}

onMounted(load)
</script>

<template>
  <div class="flex-1 flex flex-col overflow-auto p-6">
    <div class="max-w-5xl w-full">
      <div class="flex items-center justify-between mb-5">
        <h2 class="text-base font-medium text-fg">概览</h2>
        <button class="flex items-center gap-1 text-xs text-muted hover:text-fg" :disabled="loading" @click="load">
          <RefreshCw class="w-3.5 h-3.5" :class="loading ? 'animate-spin' : ''" />
          刷新
        </button>
      </div>

      <p v-if="error" class="mb-4 text-xs text-danger bg-danger-soft border border-danger-line rounded-lg px-3 py-2">{{ error }}</p>

      <div class="grid grid-cols-4 gap-4 mb-6">
        <div class="bg-surface rounded-lg border border-line p-4">
          <div class="flex items-center gap-2 text-xs text-muted"><ClipboardList class="w-4 h-4" /> 用例</div>
          <div class="mt-2 text-2xl font-medium text-fg">{{ caseStats.case_count }}</div>
          <div class="text-xs text-muted-2 mt-1">脚本 {{ scripts.length }} 个</div>
        </div>
        <div class="bg-surface rounded-lg border border-line p-4">
          <div class="flex items-center gap-2 text-xs text-muted"><Activity class="w-4 h-4" /> 通过率</div>
          <div class="mt-2 text-2xl font-medium" :class="passRate >= 80 ? 'text-success' : passRate >= 50 ? 'text-warn' : 'text-danger'">
            {{ graded.length ? `${passRate}%` : '—' }}
          </div>
          <div class="text-xs text-muted-2 mt-1">{{ graded.length }} 次执行 · 失败 {{ failedCount }}</div>
        </div>
        <div class="bg-surface rounded-lg border border-line p-4">
          <div class="flex items-center gap-2 text-xs text-muted"><AlertTriangle class="w-4 h-4" /> 未关闭缺陷</div>
          <div class="mt-2 text-2xl font-medium" :class="openBugs.length ? 'text-danger' : 'text-fg'">{{ openBugs.length }}</div>
          <div class="text-xs text-muted-2 mt-1">缺陷单共 {{ bugTotal }} 张</div>
        </div>
        <div class="bg-surface rounded-lg border border-line p-4">
          <div class="flex items-center gap-2 text-xs text-muted"><Clock class="w-4 h-4" /> 待审批</div>
          <div class="mt-2 text-2xl font-medium" :class="pendingTotal ? 'text-warn' : 'text-fg'">{{ pendingTotal }}</div>
          <router-link :to="`/project/${projectId}/approvals`" class="text-xs text-accent hover:underline mt-1 inline-block">
            去审批 →
          </router-link>
        </div>
      </div>

      <div class="grid grid-cols-2 gap-4 mb-6">
        <div class="bg-surface rounded-lg border border-line p-5">
          <h3 class="text-sm font-medium text-fg mb-4">最近执行趋势</h3>
          <div v-if="!trend.length" class="text-sm text-muted-2 py-8 text-center">还没有执行记录</div>
          <div v-else class="flex items-end gap-2 h-32">
            <router-link
              v-for="t in trend"
              :key="t.id"
              :to="`/project/${projectId}/executions/${t.id}`"
              class="flex-1 flex flex-col items-center justify-end gap-1 group"
              :title="`#${t.id} ${t.label} · 通过 ${Math.round(t.ratio * 100)}%`"
            >
              <span class="text-[10px]" :class="t.failed ? 'text-red-500' : 'text-muted-2'">{{ Math.round(t.ratio * 100) }}%</span>
              <div
                class="w-full rounded-t"
                :class="t.failed ? 'bg-red-300 group-hover:bg-red-400' : 'bg-green-400 group-hover:bg-green-500'"
                :style="{ height: `${Math.max(4, t.ratio * 96)}px` }"
              ></div>
              <span class="text-[10px] text-muted-2">#{{ t.id }}</span>
            </router-link>
          </div>
        </div>

        <div class="bg-surface rounded-lg border border-line p-5">
          <h3 class="text-sm font-medium text-fg mb-4">环境健康</h3>
          <div class="space-y-2">
            <div v-for="[key, item] in envItems" :key="key" class="flex items-center gap-2 text-sm">
              <component :is="item.ok ? CheckCircle : AlertTriangle" class="w-4 h-4" :class="item.ok ? 'text-green-500' : 'text-amber-500'" />
              <span class="text-fg-2">{{ item.label || key }}</span>
              <span class="ml-auto text-xs" :class="item.ok ? 'text-success' : 'text-warn'">
                {{ item.ok ? '正常' : '未就绪' }}
              </span>
            </div>
          </div>
          <div v-if="envDown" class="mt-3 text-xs text-warn">{{ envDown }} 项未就绪：执行前先确认</div>
        </div>
      </div>

      <div class="grid grid-cols-2 gap-4">
        <div class="bg-surface rounded-lg border border-line p-5">
          <h3 class="text-sm font-medium text-fg mb-3">最近失败</h3>
          <div v-if="!openBugs.length" class="text-sm text-muted-2 py-6 text-center">没有未关闭的缺陷</div>
          <div v-else class="space-y-2">
            <div v-for="bug in openBugs.slice(0, 5)" :key="bug.id" class="flex items-start gap-2 text-sm">
              <span class="text-xs px-1.5 py-0.5 rounded flex-shrink-0" :class="bugClass(bug.severity)">{{ bug.severity || 'major' }}</span>
              <span class="text-fg-2 truncate flex-1" :title="bug.title">{{ bug.title }}</span>
              <span v-if="(bug.occurrences ?? 1) > 1" class="text-xs text-muted-2">×{{ bug.occurrences }}</span>
            </div>
          </div>
        </div>

        <div class="bg-surface rounded-lg border border-line p-5">
          <h3 class="text-sm font-medium text-fg mb-3">最近的 run</h3>
          <div v-if="!runs.length" class="text-sm text-muted-2 py-6 text-center">还没有工作流运行</div>
          <div v-else class="space-y-2">
            <router-link
              v-for="run in runs.slice(0, 5)"
              :key="run.id"
              :to="`/project/${projectId}/runs?run=${run.id}`"
              class="flex items-center gap-2 text-sm hover:bg-surface-2 rounded px-1 py-0.5"
            >
              <span class="font-mono text-xs text-fg-2">{{ run.id }}</span>
              <span class="text-xs px-1.5 py-0.5 rounded" :class="runTone(run.status)">{{ run.status }}</span>
              <span class="text-xs text-muted-2">{{ run.stage }}</span>
              <span class="ml-auto text-xs text-muted-2">{{ shortTime(run.updated_at) }}</span>
            </router-link>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
