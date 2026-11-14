<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { RefreshCw } from 'lucide-vue-next'
import Badge from '@/components/Badge.vue'
import EmptyState from '@/components/EmptyState.vue'

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

function bugTone(severity?: string): 'danger' | 'warn' | 'neutral' {
  if (severity === 'blocker') return 'danger'
  if (severity === 'major') return 'warn'
  return 'neutral'
}

function runTone(status: string): 'warn' | 'success' | 'danger' | 'accent' {
  if (status === 'waiting_human') return 'warn'
  if (status === 'done') return 'success'
  if (status === 'failed') return 'danger'
  return 'accent'
}

const RUN_LABEL: Record<string, string> = {
  waiting_human: '待人工确认',
  done: '已完成',
  failed: '失败',
  running: '进行中',
}

function shortTime(value?: string) {
  return value ? value.replace('T', ' ').slice(5, 16) : ''
}

onMounted(load)
</script>

<template>
  <div class="flex-1 overflow-auto bg-surface-2">
    <div class="mx-auto w-full max-w-[1100px] px-8 py-7">
      <header class="flex items-start justify-between gap-4">
        <div>
          <h1 class="text-[20px] font-medium text-fg">概览</h1>
          <p class="mt-1 text-[13px] text-muted">这个项目现在的状态：多少用例、通过率、还没关的缺陷、卡在等人确认的地方。</p>
        </div>
        <button
          class="flex h-9 items-center gap-2 rounded-[8px] border border-line bg-surface px-3 text-[13px] text-fg hover:bg-surface-3 disabled:opacity-40"
          :disabled="loading"
          @click="load"
        >
          <RefreshCw class="h-4 w-4" :class="loading ? 'animate-spin' : ''" /> 刷新
        </button>
      </header>

      <p v-if="error" class="mt-4 rounded-[8px] border border-danger-line bg-danger-soft px-4 py-2 text-[13px] text-danger">
        {{ error }}
      </p>

      <!-- 读数行：四个数并排，用分隔线而不是四张卡片 -->
      <div class="mt-5 grid grid-cols-2 divide-line rounded-[12px] border border-line bg-surface md:grid-cols-4 md:divide-x">
        <div class="px-5 py-4">
          <p class="text-[12px] text-muted">用例</p>
          <p class="num mt-1 text-[26px] leading-8 text-fg">{{ caseStats.case_count }}</p>
          <p class="num mt-0.5 text-[12px] text-muted-2">脚本 {{ scripts.length }}</p>
        </div>
        <div class="px-5 py-4">
          <p class="text-[12px] text-muted">通过率</p>
          <p
            class="num mt-1 text-[26px] leading-8"
            :class="!graded.length ? 'text-muted-2' : passRate >= 80 ? 'text-success' : passRate >= 50 ? 'text-warn' : 'text-danger'"
          >{{ graded.length ? `${passRate}%` : '—' }}</p>
          <p class="num mt-0.5 text-[12px] text-muted-2">{{ graded.length }} 次执行 · 失败 {{ failedCount }}</p>
        </div>
        <div class="px-5 py-4">
          <p class="text-[12px] text-muted">未关闭缺陷</p>
          <p class="num mt-1 text-[26px] leading-8" :class="openBugs.length ? 'text-danger' : 'text-fg'">{{ openBugs.length }}</p>
          <p class="num mt-0.5 text-[12px] text-muted-2">缺陷单共 {{ bugTotal }}</p>
        </div>
        <router-link :to="`/project/${projectId}/approvals`" class="block px-5 py-4 hover:bg-surface-2">
          <p class="text-[12px] text-muted">待审批</p>
          <p class="num mt-1 text-[26px] leading-8" :class="pendingTotal ? 'text-warn' : 'text-fg'">{{ pendingTotal }}</p>
          <p class="mt-0.5 text-[12px] text-accent">去审批 →</p>
        </router-link>
      </div>

      <div class="mt-5 grid gap-5 md:grid-cols-2">
        <!-- 趋势：柱高即通过率，方角、贴基线 -->
        <section class="rounded-[12px] border border-line bg-surface px-5 py-4">
          <div class="flex items-baseline justify-between">
            <h2 class="text-[13px] font-medium text-fg">最近执行趋势</h2>
            <span class="text-[12px] text-muted-2">最近 {{ trend.length }} 次</span>
          </div>
          <EmptyState v-if="!trend.length" class="mt-4" title="还没有执行记录" hint="到「流水线」第 ⑥ 步执行一次" />
          <div v-else class="mt-4 flex h-[132px] items-end gap-2">
            <router-link
              v-for="t in trend"
              :key="t.id"
              :to="`/project/${projectId}/executions/${t.id}`"
              class="group flex flex-1 flex-col items-center justify-end gap-1"
              :title="`#${t.id} ${t.label} · 通过 ${Math.round(t.ratio * 100)}%`"
            >
              <span class="num text-[12px]" :class="t.failed ? 'text-danger' : 'text-fg'">{{ Math.round(t.ratio * 100) }}%</span>
              <span
                class="w-full"
                :class="t.failed ? 'bg-danger' : 'bg-success'"
                :style="{ height: `${Math.max(3, t.ratio * 84)}px`, opacity: 0.85 }"
              ></span>
              <span class="num text-[12px] text-muted-2">#{{ t.id }}</span>
            </router-link>
          </div>
          <div class="mt-1 h-px w-full bg-line"></div>
        </section>

        <!-- 环境：状态是文字，不再用彩色图标 -->
        <section class="rounded-[12px] border border-line bg-surface px-5 py-4">
          <div class="flex items-baseline justify-between">
            <h2 class="text-[13px] font-medium text-fg">环境健康</h2>
            <span class="text-[12px]" :class="envDown ? 'text-warn' : 'text-muted-2'">
              {{ envDown ? `${envDown} 项未就绪` : '全部就绪' }}
            </span>
          </div>
          <div v-if="!envItems.length" class="mt-4 text-[13px] text-muted-2">没有环境检查项</div>
          <ul v-else class="mt-3 divide-y divide-line-soft">
            <li v-for="[key, item] in envItems" :key="key" class="flex items-center gap-3 py-2">
              <span class="h-3 w-[3px]" :class="item.ok ? 'bg-success' : 'bg-warn'"></span>
              <span class="text-[13px] text-fg">{{ item.label || key }}</span>
              <span class="ml-auto text-[12px]" :class="item.ok ? 'text-muted-2' : 'text-warn'">
                {{ item.ok ? '正常' : '未就绪' }}
              </span>
            </li>
          </ul>
        </section>

        <!-- 最近失败 -->
        <section class="rounded-[12px] border border-line bg-surface px-5 py-4">
          <div class="flex items-baseline justify-between">
            <h2 class="text-[13px] font-medium text-fg">最近失败</h2>
            <router-link :to="`/project/${projectId}/defects`" class="text-[12px] text-muted hover:text-fg">全部缺陷 →</router-link>
          </div>
          <EmptyState v-if="!openBugs.length" class="mt-4" title="没有未关闭的缺陷" hint="执行出现失败时会自动汇总到这里" />
          <ul v-else class="mt-3 divide-y divide-line-soft">
            <li v-for="bug in openBugs.slice(0, 5)" :key="bug.id" class="flex items-center gap-3 py-2">
              <Badge :tone="bugTone(bug.severity)">{{ bug.severity || 'major' }}</Badge>
              <span class="min-w-0 flex-1 truncate text-[13px] text-fg" :title="bug.title">{{ bug.title }}</span>
              <span v-if="(bug.occurrences ?? 1) > 1" class="num text-[12px] text-muted-2">×{{ bug.occurrences }}</span>
            </li>
          </ul>
        </section>

        <!-- 最近的 run -->
        <section class="rounded-[12px] border border-line bg-surface px-5 py-4">
          <div class="flex items-baseline justify-between">
            <h2 class="text-[13px] font-medium text-fg">最近的运行</h2>
            <router-link :to="`/project/${projectId}/runs`" class="text-[12px] text-muted hover:text-fg">全部运行 →</router-link>
          </div>
          <EmptyState v-if="!runs.length" class="mt-4" title="还没有工作流运行" hint="流水线上每跑一步都会留下一条运行记录" />
          <ul v-else class="mt-3 divide-y divide-line-soft">
            <router-link
              v-for="run in runs.slice(0, 5)"
              :key="run.id"
              :to="`/project/${projectId}/runs?run=${run.id}`"
              class="flex items-center gap-3 py-2 hover:bg-surface-2"
            >
              <span class="mono text-[12px] text-fg">{{ run.id }}</span>
              <Badge :tone="runTone(run.status)">{{ RUN_LABEL[run.status] || run.status }}</Badge>
              <span class="text-[12px] text-muted-2">{{ run.stage }}</span>
              <span class="num ml-auto text-[12px] text-muted-2">{{ shortTime(run.updated_at) }}</span>
            </router-link>
          </ul>
        </section>
      </div>
    </div>
  </div>
</template>
