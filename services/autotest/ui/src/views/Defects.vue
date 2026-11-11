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
  open: 'bg-red-50 text-red-600',
  fixed: 'bg-yellow-50 text-yellow-600',
  verified: 'bg-green-50 text-green-600',
  wontfix: 'bg-gray-100 text-gray-600',
}
const SEVERITY_CLASS: Record<string, string> = {
  blocker: 'bg-red-50 text-red-600',
  major: 'bg-yellow-50 text-yellow-600',
  minor: 'bg-gray-100 text-gray-600',
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
  return STATUS_CLASS[status] || 'bg-gray-100 text-gray-600'
}
function severityClass(severity?: string) {
  return SEVERITY_CLASS[severity || ''] || 'bg-gray-100 text-gray-600'
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
        <h2 class="text-lg font-medium text-gray-900">缺陷管理</h2>
        <p class="text-sm text-gray-500 mt-1">失败用例自动归并为缺陷单，复发自动记录次数</p>
      </div>
      <div class="flex gap-2">
        <button
          @click="showFilter = !showFilter"
          class="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-gray-200 rounded-lg hover:bg-gray-50"
        >
          <Filter class="w-4 h-4" />
          筛选
        </button>
        <button
          @click="loadBugs"
          :disabled="loading"
          class="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-60"
        >
          <RefreshCw class="w-4 h-4" :class="loading ? 'animate-spin' : ''" />
          刷新
        </button>
      </div>
    </div>

    <!-- 统计卡片 -->
    <div class="grid grid-cols-4 gap-4 mb-4">
      <div class="bg-white rounded-lg border border-gray-200 p-4">
        <div class="text-2xl font-semibold text-gray-900">{{ counts.total }}</div>
        <div class="text-sm text-gray-500 mt-1">当前列表缺陷数</div>
      </div>
      <div class="bg-white rounded-lg border border-gray-200 p-4">
        <div class="text-2xl font-semibold text-red-600">{{ counts.open }}</div>
        <div class="text-sm text-gray-500 mt-1">待修</div>
      </div>
      <div class="bg-white rounded-lg border border-gray-200 p-4">
        <div class="text-2xl font-semibold text-yellow-600">{{ counts.fixed }}</div>
        <div class="text-sm text-gray-500 mt-1">已修（待验证）</div>
      </div>
      <div class="bg-white rounded-lg border border-gray-200 p-4">
        <div class="text-2xl font-semibold text-green-600">{{ counts.verified }}</div>
        <div class="text-sm text-gray-500 mt-1">已验证</div>
      </div>
    </div>

    <!-- 状态筛选 -->
    <div v-if="showFilter" class="flex items-center gap-2 mb-4">
      <button
        v-for="tab in STATUS_TABS"
        :key="tab.key"
        class="px-3 py-1.5 text-xs rounded-lg border transition-colors"
        :class="filter === tab.key
          ? 'bg-blue-50 border-blue-200 text-blue-700 font-medium'
          : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'"
        @click="setFilter(tab.key)"
      >
        {{ tab.label }}
      </button>
      <span v-if="message" class="ml-3 text-xs text-gray-500">{{ message }}</span>
    </div>

    <!-- 缺陷列表 -->
    <div class="bg-white rounded-lg border border-gray-200">
      <div class="divide-y divide-gray-100">
        <div v-for="bug in bugs" :key="bug.id" class="p-5 hover:bg-gray-50">
          <div class="flex items-center justify-between mb-2">
            <div class="flex items-center gap-3 min-w-0">
              <Bug class="w-5 h-5 text-red-500 flex-shrink-0" />
              <span class="font-medium text-gray-900 truncate">{{ bug.title || bug.id }}</span>
              <span class="text-xs px-2 py-0.5 rounded flex-shrink-0" :class="statusClass(bug.status)">
                {{ STATUS_LABELS[bug.status] || bug.status }}
              </span>
              <span v-if="bug.occurrences && bug.occurrences > 1" class="text-xs text-gray-400 flex-shrink-0">
                复发 {{ bug.occurrences }} 次
              </span>
            </div>
            <div class="flex items-center gap-3 flex-shrink-0">
              <span class="text-xs text-gray-400">最近 {{ shortTime(bug.last_seen_at || bug.created_at) }}</span>
              <button
                v-for="act in actionsFor(bug.status)"
                :key="act.key"
                class="h-7 px-2.5 text-xs rounded border border-gray-200 text-gray-600 hover:border-blue-400 hover:text-blue-700"
                @click="setStatus(bug, act.key)"
              >
                {{ act.label }}
              </button>
            </div>
          </div>

          <div class="flex items-center gap-4 text-sm text-gray-500 ml-8 flex-wrap">
            <span class="font-mono text-xs text-gray-400">{{ bug.id }}</span>
            <span v-if="bug.script_name">脚本：{{ bug.script_name }}</span>
            <span class="text-xs px-2 py-0.5 rounded" :class="severityClass(bug.severity)">{{ severityLabel(bug.severity) }}</span>
            <span v-if="bug.error_type">类型：{{ bug.error_type }}</span>
            <button
              v-if="bug.last_run_id"
              class="text-xs text-blue-600 hover:underline font-mono"
              @click="jumpToRun(bug.last_run_id)"
            >{{ bug.last_run_id }}</button>
            <button
              class="text-xs text-gray-400 hover:text-blue-600 ml-auto"
              @click="expanded = expanded === bug.id ? '' : bug.id"
            >{{ expanded === bug.id ? '收起' : '详情' }}</button>
          </div>

          <div v-if="expanded === bug.id" class="ml-8 mt-3 pt-3 border-t border-gray-100 space-y-1 text-xs text-gray-600">
            <div v-if="bug.summary"><span class="text-gray-400">摘要：</span>{{ bug.summary }}</div>
            <div v-if="bug.repro"><span class="text-gray-400">复现：</span>{{ reproText(bug.repro) }}</div>
            <div>
              <span class="text-gray-400">首次：</span>{{ shortTime(bug.created_at) }}
              <span class="ml-3 text-gray-400">最近：</span>{{ shortTime(bug.last_seen_at) }}
            </div>
          </div>
        </div>

        <div v-if="!bugs.length" class="py-16 text-center text-sm text-gray-400">
          这个筛选下没有缺陷单
        </div>
      </div>
    </div>
  </div>
</template>
