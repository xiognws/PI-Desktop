<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { BarChart3, Download, Eye, RefreshCw } from 'lucide-vue-next'

const route = useRoute()
const projectId = route.params.projectId as string

type Report = {
  id: string
  name: string
  total: number
  passed: number
  failed: number
  pass_rate: string
  created_at?: string
  kind: 'pipeline' | 'execution'
}

const reports = ref<Report[]>([])
const content = ref('')
const openedId = ref('')
const message = ref('')

const stats = computed(() => {
  const total = reports.value.reduce((sum, item) => sum + (item.total || 0), 0)
  const passed = reports.value.reduce((sum, item) => sum + (item.passed || 0), 0)
  const failed = reports.value.reduce((sum, item) => sum + (item.failed || 0), 0)
  const rate = total ? ((passed / total) * 100).toFixed(1) : '0.0'
  return { total, passed, failed, rate }
})

async function json<T>(path: string): Promise<T> {
  const response = await fetch(`/api${path}`)
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error((body as { detail?: string })?.detail || `HTTP ${response.status}`)
  return body as T
}

async function loadReports() {
  try {
    const body = await json<{ reports: Report[] }>(`/projects/${projectId}/reports`)
    reports.value = body.reports || []
  } catch (error) {
    message.value = String((error as Error).message || error)
  }
}

async function open(report: Report) {
  message.value = ''
  try {
    const body = await json<{ content: string }>(`/projects/${projectId}/reports/${report.id}`)
    content.value = body.content
    openedId.value = report.id
  } catch (error) {
    content.value = `无法打开：${String((error as Error).message || error)}`
    openedId.value = report.id
  }
}

function download(report: Report) {
  if (openedId.value !== report.id || !content.value) {
    open(report).then(() => download(report))
    return
  }
  const blob = new Blob([content.value], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${report.id}.md`
  link.click()
  URL.revokeObjectURL(url)
}

onMounted(loadReports)
</script>

<template>
  <div class="flex-1 flex flex-col overflow-auto bg-white">
    <div class="p-6 space-y-5">
      <div class="flex items-center justify-between">
        <div>
          <h2 class="text-lg font-medium text-gray-900">测试报告</h2>
          <p class="text-sm text-gray-500 mt-1">共 {{ reports.length }} 份报告 · 数字来自已落库的报告行</p>
        </div>
        <button class="flex items-center gap-2 px-3 py-1.5 border border-gray-200 rounded-lg text-sm hover:bg-gray-50" @click="loadReports">
          <RefreshCw class="w-4 h-4" /> 刷新
        </button>
      </div>

      <div class="grid grid-cols-4 gap-4">
        <div class="bg-gray-50 rounded-lg border border-gray-200 p-4">
          <div class="text-sm text-gray-500 mb-1">总用例数</div>
          <div class="text-2xl font-semibold text-gray-900">{{ stats.total }}</div>
        </div>
        <div class="bg-gray-50 rounded-lg border border-gray-200 p-4">
          <div class="text-sm text-gray-500 mb-1">通过</div>
          <div class="text-2xl font-semibold text-green-600">{{ stats.passed }}</div>
        </div>
        <div class="bg-gray-50 rounded-lg border border-gray-200 p-4">
          <div class="text-sm text-gray-500 mb-1">失败</div>
          <div class="text-2xl font-semibold text-red-600">{{ stats.failed }}</div>
        </div>
        <div class="bg-gray-50 rounded-lg border border-gray-200 p-4">
          <div class="text-sm text-gray-500 mb-1">通过率</div>
          <div class="text-2xl font-semibold text-blue-600">{{ stats.rate }}%</div>
        </div>
      </div>

      <div class="space-y-3">
        <div v-for="report in reports" :key="report.id" class="bg-gray-50 rounded-lg border border-gray-200 p-5">
          <div class="flex items-center justify-between mb-2">
            <div class="flex items-center gap-2">
              <BarChart3 class="w-5 h-5 text-blue-600" />
              <span class="font-medium text-gray-900">{{ report.name }}</span>
              <span class="text-[11px] px-1.5 py-0.5 rounded bg-gray-200 text-gray-600">
                {{ report.kind === 'pipeline' ? '流水线' : '执行' }}
              </span>
            </div>
            <span class="text-xs text-gray-400">{{ report.created_at }}</span>
          </div>

          <div class="flex items-center gap-6 text-sm text-gray-600 mb-3">
            <span>总共 {{ report.total }} 条</span>
            <span class="text-green-600">通过 {{ report.passed }}</span>
            <span class="text-red-600">失败 {{ report.failed }}</span>
            <span class="text-gray-500">通过率 {{ report.pass_rate }}</span>
          </div>

          <div class="flex items-center gap-2">
            <button class="flex items-center gap-1 px-2.5 py-1 text-xs border border-gray-300 rounded-lg hover:bg-white" @click="open(report)">
              <Eye class="w-3.5 h-3.5" /> 查看
            </button>
            <button
              v-if="report.kind === 'pipeline'"
              class="flex items-center gap-1 px-2.5 py-1 text-xs border border-gray-300 rounded-lg hover:bg-white"
              @click="download(report)"
            >
              <Download class="w-3.5 h-3.5" /> 下载 .md
            </button>
            <span class="text-[11px] text-gray-400">{{ report.id }}</span>
          </div>

          <pre
            v-if="openedId === report.id"
            class="mt-3 text-[11px] whitespace-pre-wrap bg-white border border-gray-200 rounded-lg p-3 max-h-72 overflow-auto"
          >{{ content }}</pre>
        </div>

        <div v-if="!reports.length" class="text-center py-12 text-gray-400 text-sm">
          暂无测试报告 · 跑一次流水线到「结果收集」就会出现在这里
        </div>
      </div>

      <div v-if="message" class="text-xs text-red-600">{{ message }}</div>
    </div>
  </div>
</template>
