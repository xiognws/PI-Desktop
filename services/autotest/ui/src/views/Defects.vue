<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { RefreshCw } from 'lucide-vue-next'
import Badge from '@/components/Badge.vue'
import EmptyState from '@/components/EmptyState.vue'

const route = useRoute()
const router = useRouter()
const projectId = route.params.projectId as string

type BugItem = {
  id: string
  run_id?: string
  last_run_id?: string
  script_name?: string
  case_id?: string
  title?: string
  severity?: string
  status: string
  error_type?: string
  summary?: string
  repro?: string
  occurrences?: number
  created_at?: string
  last_seen_at?: string
}

const STATUS_TABS = [
  { key: '', label: '全部' },
  { key: 'open', label: '待修' },
  { key: 'fixed', label: '已修' },
  { key: 'verified', label: '已验证' },
  { key: 'wontfix', label: '忽略' },
]
const STATUS_LABELS: Record<string, string> = {
  open: '待修',
  fixed: '已修',
  verified: '已验证',
  wontfix: '忽略',
}
const SEVERITY_LABEL: Record<string, string> = {
  blocker: '阻塞',
  major: '严重',
  minor: '一般',
}

const bugs = ref<BugItem[]>([])
const filter = ref('')
const expanded = ref<string>('')
const loading = ref(false)
const message = ref('')

function shortTime(value?: string) {
  return value ? value.replace('T', ' ').slice(5, 16) : ''
}
function reproText(repro?: string) {
  if (!repro) return ''
  return /^\d+$/.test(repro.trim()) ? `执行 #${repro}` : repro
}
function statusTone(status: string): 'danger' | 'warn' | 'success' | 'neutral' {
  if (status === 'open') return 'danger'
  if (status === 'fixed') return 'warn'
  if (status === 'verified') return 'success'
  return 'neutral'
}
function severityTone(severity?: string): 'danger' | 'warn' | 'neutral' {
  if (severity === 'blocker') return 'danger'
  if (severity === 'major') return 'warn'
  return 'neutral'
}
function severityLabel(severity?: string) {
  return SEVERITY_LABEL[severity || ''] || (severity || '一般')
}

const counts = computed(() => ({
  total: bugs.value.length,
  open: bugs.value.filter(b => b.status === 'open').length,
  fixed: bugs.value.filter(b => b.status === 'fixed').length,
  verified: bugs.value.filter(b => b.status === 'verified').length,
}))

async function loadBugs() {
  loading.value = true
  try {
    const qs = new URLSearchParams()
    if (filter.value) qs.set('status', filter.value)
    qs.set('limit', '200')
    const res = await fetch(`/api/projects/${projectId}/workflow/bugs?${qs.toString()}`)
    const body = await res.json()
    bugs.value = body?.data?.bugs || []
  } catch {
    message.value = '加载缺陷单失败'
  } finally {
    loading.value = false
  }
}

function setFilter(key: string) {
  filter.value = key
  loadBugs()
}

async function setStatus(bug: BugItem, status: string) {
  try {
    const res = await fetch(`/api/projects/${projectId}/workflow/bugs/${bug.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(body?.detail || `HTTP ${res.status}`)
    message.value = `已把 ${bug.id} 标记为「${STATUS_LABELS[status] || status}」`
    await loadBugs()
  } catch (e: any) {
    message.value = e?.message || '更新状态失败'
  }
}

// 多选批量流转：手上一堆「已修」要一起验证时，一张一张点太慢。
const selected = ref<string[]>([])
const batchBusy = ref(false)

const allSelected = computed(
  () => bugs.value.length > 0 && bugs.value.every(b => selected.value.includes(b.id)),
)

function toggleSelect(id: string) {
  const idx = selected.value.indexOf(id)
  if (idx > -1) selected.value.splice(idx, 1)
  else selected.value.push(id)
}

function toggleSelectAll() {
  selected.value = allSelected.value ? [] : bugs.value.map(b => b.id)
}

// 批量只给「目标状态」四个选项：具体能不能改由后端逐条校验，前端不猜每张单的历史。
const BATCH_TARGETS = [
  { key: 'fixed', label: '标记已修' },
  { key: 'verified', label: '验证通过' },
  { key: 'wontfix', label: '忽略' },
  { key: 'open', label: '重开' },
]

async function batchSetStatus(status: string) {
  if (!selected.value.length) return
  batchBusy.value = true
  try {
    const res = await fetch(`/api/projects/${projectId}/workflow/bugs/status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [...selected.value], status }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(body?.detail || `HTTP ${res.status}`)
    const data = body?.data || {}
    message.value = body?.summary
      || `已更新 ${(data.updated || []).length} 张，失败 ${(data.failed || []).length} 张`
    selected.value = []
    await loadBugs()
  } catch (e: any) {
    message.value = e?.message || '批量更新失败'
  } finally {
    batchBusy.value = false
  }
}

function actionsFor(status: string) {
  if (status === 'open') {
    return [
      { key: 'fixed', label: '标记已修' },
      { key: 'wontfix', label: '忽略' },
    ]
  }
  if (status === 'fixed') {
    return [
      { key: 'verified', label: '验证通过' },
      { key: 'open', label: '重开' },
    ]
  }
  return [{ key: 'open', label: '重开' }]
}

function jumpToRun(runId?: string) {
  if (!runId) return
  router.push({ path: `/project/${projectId}/runs`, query: { run: runId } })
}

onMounted(loadBugs)
</script>

<template>
  <div class="flex-1 overflow-auto bg-surface-2">
    <div class="mx-auto w-full max-w-[1100px] px-8 py-7">
      <header class="flex items-start justify-between gap-4">
        <div>
          <h1 class="text-[20px] font-medium text-fg">缺陷</h1>
          <p class="mt-1 text-[13px] text-muted">失败用例自动归并成缺陷单，复发的记次数，修完在这里验证关闭。</p>
        </div>
        <button
          class="flex h-9 items-center gap-2 rounded-[8px] border border-line bg-surface px-3 text-[13px] text-fg hover:bg-surface-3 disabled:opacity-40"
          :disabled="loading"
          @click="loadBugs"
        >
          <RefreshCw class="h-4 w-4" :class="loading ? 'animate-spin' : ''" /> 刷新
        </button>
      </header>

      <div class="mt-5 grid grid-cols-2 divide-line rounded-[12px] border border-line bg-surface md:grid-cols-4 md:divide-x">
        <div class="px-5 py-4">
          <p class="text-[12px] text-muted">当前列表</p>
          <p class="num mt-1 text-[24px] leading-7 text-fg">{{ counts.total }}</p>
        </div>
        <div class="px-5 py-4">
          <p class="text-[12px] text-muted">待修</p>
          <p class="num mt-1 text-[24px] leading-7" :class="counts.open ? 'text-danger' : 'text-fg'">{{ counts.open }}</p>
        </div>
        <div class="px-5 py-4">
          <p class="text-[12px] text-muted">已修待验证</p>
          <p class="num mt-1 text-[24px] leading-7" :class="counts.fixed ? 'text-warn' : 'text-fg'">{{ counts.fixed }}</p>
        </div>
        <div class="px-5 py-4">
          <p class="text-[12px] text-muted">已验证</p>
          <p class="num mt-1 text-[24px] leading-7 text-success">{{ counts.verified }}</p>
        </div>
      </div>

      <!-- 筛选：安静的分段按钮，不抢主操作 -->
      <div class="mt-4 flex flex-wrap items-center gap-1">
        <button
          v-for="tab in STATUS_TABS"
          :key="tab.key"
          class="h-8 rounded-[8px] px-2 text-[12px] transition-colors"
          :class="filter === tab.key ? 'bg-surface-3 text-fg' : 'text-muted hover:text-fg'"
          @click="setFilter(tab.key)"
        >{{ tab.label }}</button>
        <span v-if="message" class="ml-3 text-[12px] text-muted">{{ message }}</span>
      </div>

      <!-- 批量条：只有选中才出现 -->
      <div
        v-if="selected.length"
        class="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-[8px] border border-accent-line bg-accent-soft px-4 py-2"
      >
        <span class="num text-[12px] text-accent">已选 {{ selected.length }} 张</span>
        <button
          v-for="target in BATCH_TARGETS"
          :key="target.key"
          class="text-[12px] text-fg hover:underline disabled:opacity-40"
          :disabled="batchBusy"
          @click="batchSetStatus(target.key)"
        >{{ target.label }}</button>
        <button class="text-[12px] text-muted hover:text-fg" :disabled="batchBusy" @click="selected = []">取消选择</button>
      </div>

      <div class="mt-4 overflow-hidden rounded-[12px] border border-line bg-surface">
        <div class="flex items-center gap-3 border-b border-line px-5 py-2 text-[12px] text-muted-2">
          <input type="checkbox" :checked="allSelected" class="h-3.5 w-3.5 rounded-[3px]" @change="toggleSelectAll()" />
          <span>全选本页 {{ bugs.length }} 张</span>
        </div>

        <div
          v-for="bug in bugs"
          :key="bug.id"
          class="state-bar border-b border-line-soft px-5 py-3 last:border-b-0 hover:bg-surface-2"
          :data-tone="statusTone(bug.status) === 'danger' ? 'danger' : statusTone(bug.status) === 'warn' ? 'warn' : statusTone(bug.status) === 'success' ? 'success' : 'neutral'"
        >
          <div class="flex items-center gap-3">
            <input
              type="checkbox"
              class="h-3.5 w-3.5 flex-shrink-0 rounded-[3px]"
              :checked="selected.includes(bug.id)"
              @change="toggleSelect(bug.id)"
            />
            <span class="min-w-0 flex-1 truncate text-[13px] text-fg" :title="bug.title || bug.id">{{ bug.title || bug.id }}</span>
            <Badge :tone="severityTone(bug.severity)">{{ severityLabel(bug.severity) }}</Badge>
            <Badge :tone="statusTone(bug.status)">{{ STATUS_LABELS[bug.status] || bug.status }}</Badge>
            <span v-if="bug.occurrences && bug.occurrences > 1" class="num text-[12px] text-warn">复发 {{ bug.occurrences }}</span>
            <span class="num text-[12px] text-muted-2">{{ shortTime(bug.last_seen_at || bug.created_at) }}</span>
          </div>

          <div class="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 pl-6 text-[12px] text-muted-2">
            <span class="mono">{{ bug.id }}</span>
            <span v-if="bug.script_name">脚本 {{ bug.script_name }}</span>
            <span v-if="bug.error_type">类型 {{ bug.error_type }}</span>
            <button
              v-if="bug.last_run_id"
              class="mono text-muted hover:text-fg"
              @click="jumpToRun(bug.last_run_id)"
            >{{ bug.last_run_id }}</button>
            <span class="ml-auto flex items-center gap-3">
              <button
                v-for="act in actionsFor(bug.status)"
                :key="act.key"
                class="text-muted hover:text-fg"
                @click="setStatus(bug, act.key)"
              >{{ act.label }}</button>
              <button class="text-muted hover:text-fg" @click="expanded = expanded === bug.id ? '' : bug.id">
                {{ expanded === bug.id ? '收起' : '详情' }}
              </button>
            </span>
          </div>

          <div v-if="expanded === bug.id" class="mt-2 space-y-1 border-t border-line-soft px-6 pt-2 text-[12px] text-muted">
            <p v-if="bug.summary"><span class="text-muted-2">摘要：</span>{{ bug.summary }}</p>
            <p v-if="bug.repro"><span class="text-muted-2">复现：</span>{{ reproText(bug.repro) }}</p>
            <p class="num">
              <span class="text-muted-2">首次：</span>{{ shortTime(bug.created_at) }}
              <span class="ml-3 text-muted-2">最近：</span>{{ shortTime(bug.last_seen_at) }}
            </p>
          </div>
        </div>

        <EmptyState
          v-if="!bugs.length"
          class="m-5"
          title="当前筛选下没有缺陷"
          hint="执行出现失败时，用例会自动归并成缺陷单"
        />
      </div>
    </div>
  </div>
</template>
