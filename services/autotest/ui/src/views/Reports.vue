<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { BarChart3, Download, TrendingUp, RefreshCw } from 'lucide-vue-next'
import MarkdownBlock from '../components/MarkdownBlock.vue'

const route = useRoute()
const projectId = route.params.projectId as string

// 报告弹层两种看法：渲染后的 Markdown（默认）与原文。
const reportView = ref<'rendered' | 'raw'>('rendered')

// 报告由 workflow run 产出：跑过 report 步骤的 run 才有 markdown 可取。
type RunRow = {
  id: string
  module?: string
  stage?: string
  status: string
  created_at?: string
  updated_at?: string
}

const runs = ref<RunRow[]>([])
const loading = ref(false)
const message = ref('')
const opened = ref<{ runId: string; name: string; markdown: string } | null>(null)

const STATUS_LABELS: Record<string, string> = {
  running: '进行中',
  waiting_human: '待审批',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

const stats = computed(() => ({
  total: runs.value.length,
  done: runs.value.filter(r => r.status === 'done').length,
  failed: runs.value.filter(r => r.status === 'failed').length,
  waiting: runs.value.filter(r => r.status === 'waiting_human').length,
}))

function shortTime(value?: string) {
  return value ? value.replace('T', ' ').slice(5, 16) : ''
}

async function loadRuns() {
  loading.value = true
  try {
    const res = await fetch(`/api/projects/${projectId}/workflow/runs?limit=50`)
    const body = await res.json()
    runs.value = body?.data?.runs || []
  } catch {
    message.value = '加载报告列表失败'
  } finally {
    loading.value = false
  }
}

async function openReport(run: RunRow) {
  message.value = ''
  try {
    const res = await fetch(`/api/projects/${projectId}/workflow/runs/${run.id}/report-content`)
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(body?.detail || `HTTP ${res.status}`)
    opened.value = {
      runId: run.id,
      name: body?.data?.name || `${run.id}-report.md`,
      markdown: body?.data?.markdown || '',
    }
  } catch (e: any) {
    message.value = `${run.id} 还没有报告：${e?.message || ''}`
  }
}

function download() {
  if (!opened.value) return
  const blob = new Blob([opened.value.markdown], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = opened.value.name
  a.click()
  URL.revokeObjectURL(url)
}

onMounted(loadRuns)
</script>

<template>
  <div class="flex-1 flex flex-col overflow-auto bg-surface">
    <div class="p-6">
      <div class="flex items-center justify-between mb-6">
        <div>
          <h2 class="text-lg font-medium text-fg">测试报告</h2>
          <p class="text-sm text-muted mt-1">共 {{ runs.length }} 条运行，点开取该次运行的 Markdown 报告</p>
        </div>
        <div class="flex gap-2">
          <button
            @click="loadRuns"
            :disabled="loading"
            class="flex items-center gap-2 px-4 py-2 border border-line rounded-lg text-sm hover:bg-surface-2 disabled:opacity-60"
          >
            <RefreshCw class="w-4 h-4" :class="loading ? 'animate-spin' : ''" />
            刷新
          </button>
        </div>
      </div>

      <!-- 统计卡片 -->
      <div class="grid grid-cols-4 gap-4 mb-6">
        <div class="bg-surface-2 rounded-lg border border-line p-4">
          <div class="text-sm text-muted mb-1">运行总数</div>
          <div class="text-2xl font-semibold text-fg">{{ stats.total }}</div>
        </div>
        <div class="bg-surface-2 rounded-lg border border-line p-4">
          <div class="text-sm text-muted mb-1">已完成</div>
          <div class="text-2xl font-semibold text-success">{{ stats.done }}</div>
        </div>
        <div class="bg-surface-2 rounded-lg border border-line p-4">
          <div class="text-sm text-muted mb-1">失败</div>
          <div class="text-2xl font-semibold text-danger">{{ stats.failed }}</div>
        </div>
        <div class="bg-surface-2 rounded-lg border border-line p-4">
          <div class="text-sm text-muted mb-1">待审批</div>
          <div class="text-2xl font-semibold text-warn">{{ stats.waiting }}</div>
        </div>
      </div>

      <!-- 报告列表 -->
      <div class="space-y-3">
        <div v-for="run in runs" :key="run.id" class="bg-surface-2 rounded-lg border border-line p-5">
          <div class="flex items-center justify-between mb-3">
            <div class="flex items-center gap-2">
              <BarChart3 class="w-5 h-5 text-accent" />
              <span class="font-medium text-fg font-mono">{{ run.id }}</span>
              <span class="text-xs px-2 py-0.5 rounded bg-surface border border-line text-fg-3">{{ run.module || '未标模块' }}</span>
            </div>
            <span class="text-xs text-muted-2">{{ shortTime(run.created_at) }}</span>
          </div>

          <div class="flex items-center gap-6 text-sm text-fg-3 mb-3">
            <span>阶段 {{ run.stage || '—' }}</span>
            <span :class="run.status === 'done' ? 'text-success' : run.status === 'failed' ? 'text-danger' : 'text-muted'">
              {{ STATUS_LABELS[run.status] || run.status }}
            </span>
          </div>

          <div class="flex items-center gap-2">
            <TrendingUp class="w-4 h-4 text-success" />
            <button class="text-sm text-accent hover:underline" @click="openReport(run)">查看报告</button>
          </div>
        </div>

        <div v-if="!runs.length" class="text-center py-12 text-muted-2 text-sm">
          暂无运行记录，先去「运行记录」跑一条
        </div>
      </div>

      <div v-if="message" class="mt-4 text-xs text-muted">{{ message }}</div>
    </div>

    <!-- 报告弹层 -->
    <div v-if="opened" class="fixed inset-0 bg-black/30 flex items-center justify-center z-40" @click.self="opened = null">
      <div class="w-[760px] max-h-[80vh] bg-surface rounded-lg shadow-lg flex flex-col">
        <div class="h-11 px-4 flex items-center justify-between border-b border-line-soft">
          <span class="text-sm font-medium text-fg">{{ opened.name }}</span>
          <div class="flex items-center gap-3">
            <button class="text-xs text-accent hover:underline" @click="download">
              <Download class="w-3.5 h-3.5 inline" /> 下载 .md
            </button>
            <button class="text-muted-2 hover:text-fg" @click="opened = null">关闭</button>
          </div>
        </div>
        <div class="h-9 px-4 flex items-center gap-2 border-b border-line-soft bg-surface-2">
          <button
            class="text-xs px-2 py-0.5 rounded"
            :class="reportView === 'rendered' ? 'bg-surface text-fg shadow-sm' : 'text-muted'"
            @click="reportView = 'rendered'"
          >阅读</button>
          <button
            class="text-xs px-2 py-0.5 rounded"
            :class="reportView === 'raw' ? 'bg-surface text-fg shadow-sm' : 'text-muted'"
            @click="reportView = 'raw'"
          >原文</button>
          <span class="ml-auto text-xs text-muted-2">Markdown</span>
        </div>
        <div class="flex-1 overflow-auto p-4">
          <MarkdownBlock v-if="reportView === 'rendered'" :source="opened.markdown" />
          <pre v-else class="text-xs leading-relaxed whitespace-pre-wrap text-fg">{{ opened.markdown }}</pre>
        </div>
      </div>
    </div>
  </div>
</template>
