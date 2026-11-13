<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Bug, Filter, RefreshCw } from 'lucide-vue-next'

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
const STATUS_CLASS: Record<string, string> = {
  open: 'bg-danger-soft text-danger',
  fixed: 'bg-warn-soft text-warn',
  verified: 'bg-success-soft text-success',
  wontfix: 'bg-surface-3 text-fg-3',
}
const SEVERITY_CLASS: Record<string, string> = {
  blocker: 'bg-danger-soft text-danger',
  major: 'bg-warn-soft text-warn',
  minor: 'bg-surface-3 text-fg-3',
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
const showFilter = ref(true)

function shortTime(value?: string) {
  return value ? value.replace('T', ' ').slice(5, 16) : ''
}
function reproText(repro?: string) {
  if (!repro) return ''
  return /^\d+$/.test(repro.trim()) ? `执行 #${repro}` : repro
}
function statusClass(status: string) {
  return STATUS_CLASS[status] || 'bg-surface-3 text-fg-3'
}
function severityClass(severity?: string) {
  return SEVERITY_CLASS[severity || ''] || 'bg-surface-3 text-fg-3'
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
  <div class="flex-1 flex flex-col overflow-auto p-6">
    <div class="flex items-center justify-between mb-6">
      <div>
        <h2 class="text-lg font-medium text-fg">缺陷管理</h2>
        <p class="text-sm text-muted mt-1">失败用例自动归并为缺陷单，复发自动记录次数</p>
      </div>
      <div class="flex gap-2">
        <button
          @click="showFilter = !showFilter"
          class="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-line rounded-lg hover:bg-surface-2"
        >
          <Filter class="w-4 h-4" />
          筛选
        </button>
        <button
          @click="loadBugs"
          :disabled="loading"
          class="flex items-center gap-2 px-4 py-2 bg-accent-solid text-white rounded-lg hover:bg-blue-700 disabled:opacity-60"
        >
          <RefreshCw class="w-4 h-4" :class="loading ? 'animate-spin' : ''" />
          刷新
        </button>
      </div>
    </div>

    <!-- 统计卡片 -->
    <div class="grid grid-cols-4 gap-4 mb-4">
      <div class="bg-surface rounded-lg border border-line p-4">
        <div class="text-2xl font-semibold text-fg">{{ counts.total }}</div>
        <div class="text-sm text-muted mt-1">当前列表缺陷数</div>
      </div>
      <div class="bg-surface rounded-lg border border-line p-4">
        <div class="text-2xl font-semibold text-danger">{{ counts.open }}</div>
        <div class="text-sm text-muted mt-1">待修</div>
      </div>
      <div class="bg-surface rounded-lg border border-line p-4">
        <div class="text-2xl font-semibold text-warn">{{ counts.fixed }}</div>
        <div class="text-sm text-muted mt-1">已修（待验证）</div>
      </div>
      <div class="bg-surface rounded-lg border border-line p-4">
        <div class="text-2xl font-semibold text-success">{{ counts.verified }}</div>
        <div class="text-sm text-muted mt-1">已验证</div>
      </div>
    </div>

    <!-- 状态筛选 -->
    <div v-if="showFilter" class="flex items-center gap-2 mb-4">
      <button
        v-for="tab in STATUS_TABS"
        :key="tab.key"
        class="px-3 py-1.5 text-xs rounded-lg border transition-colors"
        :class="filter === tab.key
          ? 'bg-accent-soft border-accent-line text-accent font-medium'
          : 'bg-surface border-line text-fg-3 hover:bg-surface-2'"
        @click="setFilter(tab.key)"
      >
        {{ tab.label }}
      </button>
      <span v-if="message" class="ml-3 text-xs text-muted">{{ message }}</span>
    </div>

    <!-- 批量操作条：有选中才出现 -->
    <div v-if="bugs.length" class="flex items-center gap-3 mb-3 text-xs">
      <label class="flex items-center gap-1.5 text-fg-3">
        <input type="checkbox" :checked="allSelected" @change="toggleSelectAll()" />
        全选本页 {{ bugs.length }} 张
      </label>
      <template v-if="selected.length">
        <span class="text-muted">已选 {{ selected.length }} 张 →</span>
        <button
          v-for="target in BATCH_TARGETS"
          :key="target.key"
          class="h-7 px-2.5 rounded border border-line text-fg-3 hover:border-blue-400 hover:text-accent disabled:opacity-40"
          :disabled="batchBusy"
          @click="batchSetStatus(target.key)"
        >{{ target.label }}</button>
        <button class="h-7 px-2 text-muted-2 hover:text-fg-2" :disabled="batchBusy" @click="selected = []">取消选择</button>
      </template>
      <span v-if="message" class="ml-auto text-muted">{{ message }}</span>
    </div>

    <!-- 缺陷列表 -->
    <div class="bg-surface rounded-lg border border-line">
      <div class="divide-y divide-line-soft">
        <div v-for="bug in bugs" :key="bug.id" class="p-5 hover:bg-surface-2">
          <div class="flex items-center justify-between mb-2">
            <div class="flex items-center gap-3 min-w-0">
              <input
                type="checkbox"
                class="flex-shrink-0"
                :checked="selected.includes(bug.id)"
                @change="toggleSelect(bug.id)"
              />
              <Bug class="w-5 h-5 text-red-500 flex-shrink-0" />
              <span class="font-medium text-fg truncate">{{ bug.title || bug.id }}</span>
              <span class="text-xs px-2 py-0.5 rounded flex-shrink-0" :class="statusClass(bug.status)">
                {{ STATUS_LABELS[bug.status] || bug.status }}
              </span>
              <span v-if="bug.occurrences && bug.occurrences > 1" class="text-xs text-muted-2 flex-shrink-0">
                复发 {{ bug.occurrences }} 次
              </span>
            </div>
            <div class="flex items-center gap-3 flex-shrink-0">
              <span class="text-xs text-muted-2">最近 {{ shortTime(bug.last_seen_at || bug.created_at) }}</span>
              <button
                v-for="act in actionsFor(bug.status)"
                :key="act.key"
                class="h-7 px-2.5 text-xs rounded border border-line text-fg-3 hover:border-blue-400 hover:text-accent"
                @click="setStatus(bug, act.key)"
              >
                {{ act.label }}
              </button>
            </div>
          </div>

          <div class="flex items-center gap-4 text-sm text-muted ml-8 flex-wrap">
            <span class="font-mono text-xs text-muted-2">{{ bug.id }}</span>
            <span v-if="bug.script_name">脚本：{{ bug.script_name }}</span>
            <span class="text-xs px-2 py-0.5 rounded" :class="severityClass(bug.severity)">{{ severityLabel(bug.severity) }}</span>
            <span v-if="bug.error_type">类型：{{ bug.error_type }}</span>
            <button
              v-if="bug.last_run_id"
              class="text-xs text-accent hover:underline font-mono"
              @click="jumpToRun(bug.last_run_id)"
            >{{ bug.last_run_id }}</button>
            <button
              class="text-xs text-muted-2 hover:text-accent ml-auto"
              @click="expanded = expanded === bug.id ? '' : bug.id"
            >{{ expanded === bug.id ? '收起' : '详情' }}</button>
          </div>

          <div v-if="expanded === bug.id" class="ml-8 mt-3 pt-3 border-t border-line-soft space-y-1 text-xs text-fg-3">
            <div v-if="bug.summary"><span class="text-muted-2">摘要：</span>{{ bug.summary }}</div>
            <div v-if="bug.repro"><span class="text-muted-2">复现：</span>{{ reproText(bug.repro) }}</div>
            <div>
              <span class="text-muted-2">首次：</span>{{ shortTime(bug.created_at) }}
              <span class="ml-3 text-muted-2">最近：</span>{{ shortTime(bug.last_seen_at) }}
            </div>
          </div>
        </div>

        <div v-if="!bugs.length" class="py-16 text-center text-sm text-muted-2">
          这个筛选下没有缺陷单
        </div>
      </div>
    </div>
  </div>
</template>
