<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { RefreshCw } from 'lucide-vue-next'
import Badge from '@/components/Badge.vue'
import EmptyState from '@/components/EmptyState.vue'
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
  <div class="flex-1 overflow-auto bg-surface-2">
    <div class="mx-auto w-full max-w-[1100px] px-8 py-7">
      <header class="flex items-start justify-between gap-4">
        <div>
          <h1 class="text-[20px] font-medium text-fg">测试报告</h1>
          <p class="mt-1 text-[13px] text-muted">一次运行一份报告，点开看 Markdown 正文，可下载留档。</p>
        </div>
        <button
          class="flex h-9 items-center gap-2 rounded-[8px] border border-line bg-surface px-3 text-[13px] text-fg hover:bg-surface-3 disabled:opacity-40"
          :disabled="loading"
          @click="loadRuns"
        >
          <RefreshCw class="h-4 w-4" :class="loading ? 'animate-spin' : ''" /> 刷新
        </button>
      </header>

      <div class="mt-5 grid grid-cols-2 divide-line rounded-[12px] border border-line bg-surface md:grid-cols-4 md:divide-x">
        <div class="px-5 py-4">
          <p class="text-[12px] text-muted">运行总数</p>
          <p class="num mt-1 text-[24px] leading-7 text-fg">{{ stats.total }}</p>
        </div>
        <div class="px-5 py-4">
          <p class="text-[12px] text-muted">已完成</p>
          <p class="num mt-1 text-[24px] leading-7 text-success">{{ stats.done }}</p>
        </div>
        <div class="px-5 py-4">
          <p class="text-[12px] text-muted">失败</p>
          <p class="num mt-1 text-[24px] leading-7" :class="stats.failed ? 'text-danger' : 'text-fg'">{{ stats.failed }}</p>
        </div>
        <div class="px-5 py-4">
          <p class="text-[12px] text-muted">待审批</p>
          <p class="num mt-1 text-[24px] leading-7" :class="stats.waiting ? 'text-warn' : 'text-fg'">{{ stats.waiting }}</p>
        </div>
      </div>

      <div class="mt-5 overflow-hidden rounded-[12px] border border-line bg-surface">
        <div class="hidden grid-cols-[1fr_140px_120px_1fr_auto] gap-4 border-b border-line px-5 py-2 text-[12px] text-muted-2 md:grid">
          <span>运行</span>
          <span>模块</span>
          <span>状态</span>
          <span>阶段</span>
          <span class="text-right">操作</span>
        </div>

        <div
          v-for="run in runs"
          :key="run.id"
          class="grid grid-cols-1 items-center gap-4 border-b border-line-soft px-5 py-3 last:border-b-0 hover:bg-surface-2 md:grid-cols-[1fr_140px_120px_1fr_auto]"
        >
          <div class="min-w-0">
            <p class="mono truncate text-[13px] text-fg">{{ run.id }}</p>
            <p class="num text-[12px] text-muted-2">{{ shortTime(run.created_at) }}</p>
          </div>
          <span class="truncate text-[12px] text-muted">{{ run.module || '未标模块' }}</span>
          <Badge :tone="run.status === 'done' ? 'success' : run.status === 'failed' ? 'danger' : run.status === 'waiting_human' ? 'warn' : 'accent'">
            {{ STATUS_LABELS[run.status] || run.status }}
          </Badge>
          <span class="truncate text-[12px] text-muted-2">{{ run.stage || '—' }}</span>
          <button class="text-right text-[12px] text-muted hover:text-fg" @click="openReport(run)">查看报告</button>
        </div>

        <EmptyState
          v-if="!runs.length"
          class="m-5"
          title="还没有可出报告的运行"
          hint="到「运行记录」跑一次流水线，或在那边点「生成报告」"
        />
      </div>

      <p v-if="message" class="mt-3 text-[12px] text-muted">{{ message }}</p>
    </div>

    <!-- 报告弹层 -->
    <div v-if="opened" class="fixed inset-0 z-40 flex items-center justify-center bg-black/30" @click.self="opened = null">
      <div class="flex max-h-[82vh] w-[820px] flex-col overflow-hidden rounded-[12px] border border-line bg-surface">
        <div class="flex h-11 items-center justify-between border-b border-line px-4">
          <span class="mono text-[13px] text-fg">{{ opened.name }}</span>
          <div class="flex items-center gap-3">
            <button class="text-[12px] text-muted hover:text-fg" @click="download">下载 .md</button>
            <button class="text-[12px] text-muted hover:text-fg" @click="opened = null">关闭</button>
          </div>
        </div>
        <div class="flex h-9 items-center gap-1 border-b border-line px-4">
          <button
            class="h-7 rounded-[6px] px-2 text-[12px]"
            :class="reportView === 'rendered' ? 'bg-surface-3 text-fg' : 'text-muted hover:text-fg'"
            @click="reportView = 'rendered'"
          >阅读</button>
          <button
            class="h-7 rounded-[6px] px-2 text-[12px]"
            :class="reportView === 'raw' ? 'bg-surface-3 text-fg' : 'text-muted hover:text-fg'"
            @click="reportView = 'raw'"
          >原文</button>
          <span class="ml-auto text-[12px] text-muted-2">Markdown</span>
        </div>
        <div class="flex-1 overflow-auto px-4 py-3">
          <MarkdownBlock v-if="reportView === 'rendered'" :source="opened.markdown" />
          <pre v-else class="text-[12px] leading-relaxed whitespace-pre-wrap text-fg">{{ opened.markdown }}</pre>
        </div>
      </div>
    </div>
  </div>
</template>
