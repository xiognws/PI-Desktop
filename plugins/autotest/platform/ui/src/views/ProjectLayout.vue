<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  Search,
  Cpu,
  Bell,
  Settings,
} from 'lucide-vue-next'

const route = useRoute()
const router = useRouter()

const projectId = route.params.projectId as string
const projectName = ref('项目')

// 从后端获取项目信息
async function loadProject() {
  try {
    const res = await fetch('/api/projects')
    const data = await res.json()
    const p = data.projects?.find((p: any) => p.id === projectId)
    if (p) projectName.value = p.name
  } catch (e) {
    projectName.value = '项目'
  }
}

onMounted(() => {
  loadProject()
})

// 底部环境状态（AI 能力由桌面端 Agent 提供，这里只看硬件/运行时）
const envStatus = ref<Record<string, { ok: boolean; label: string }>>({
  api: { ok: false, label: '后端 API' },
  database: { ok: false, label: '数据库' },
  python: { ok: false, label: 'Python' },
  mcp_can: { ok: false, label: 'MCP CAN' },
  mcp_hmi: { ok: false, label: 'MCP HMI' },
  mcp_logger: { ok: false, label: 'MCP Logger' },
})
let envTimer: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  loadEnvStatus()
  loadRuntime()
  envTimer = setInterval(loadEnvStatus, 30000)
  runtimeTimer = setInterval(loadRuntime, 5000)
})

// 状态栏运行态（学桌面端：模型 / 用量 / 正在跑什么 / 下一次计划）
type Runtime = {
  version?: string
  running?: number
  waiting?: number
  currentStage?: string
  latestPipeline?: { id: string; status: string; modelKey?: string; stage: string } | null
  tokens?: { in: number; out: number; calls: number }
  latestTokens?: { in: number; out: number; calls: number }
  schedules?: number
  nextRun?: string | null
}
const runtime = ref<Runtime>({})
const stageLabels: Record<string, string> = {
  analyze: '需求分析',
  design: '用例设计',
  author: '脚本工程',
  gate: '静态闸门',
  execute: '脚本执行',
  judge: '结果判定',
  repair: '脚本修复',
  report: '结果收集',
}
const runtimeModel = computed(() => {
  const key = runtime.value.latestPipeline?.modelKey || ''
  if (!key) return '未使用模型'
  const parts = key.split('/')
  return parts[parts.length - 1] || key
})
const runtimeTokens = computed(() => {
  const own = runtime.value.latestTokens
  if (!own || !own.calls) return '0 tok'
  const total = own.in + own.out
  const text = total >= 1000 ? `${(total / 1000).toFixed(1)}k` : String(total)
  return `${text} tok · ${own.calls} 次`
})
const runtimeState = computed(() => {
  const latest = runtime.value.latestPipeline
  if (!latest) return '还没有流水线'
  if (runtime.value.running) {
    const stage = stageLabels[latest.stage] || latest.stage
    return `运行中 · ${stage}`
  }
  if (runtime.value.waiting) {
    const stage = stageLabels[latest.stage] || latest.stage
    return `待确认 · ${stage}`
  }
  return latest.status === 'done' ? '最近一条已完成' : `最近一条 ${latest.status}`
})
const nextRunText = computed(() => {
  const next = runtime.value.nextRun
  if (!next) return '无计划'
  return next.slice(5, 16)
})

let runtimeTimer: ReturnType<typeof setInterval> | null = null

async function loadRuntime() {
  try {
    const pid = route.params.projectId
    if (!pid) return
    const res = await fetch(`/api/runtime?projectId=${pid}`)
    if (res.ok) runtime.value = await res.json()
  } catch {
    // 状态栏是旁路信息，取不到就保持上一次
  }
}

async function loadEnvStatus() {
  try {
    const pid = route.params.projectId
    if (!pid) return
    const res = await fetch(`/api/projects/${pid}/env-status`)
    if (res.ok) {
      envStatus.value = await res.json()
    }
  } catch (e) {
    console.error('环境状态检查失败', e)
  }
}

onUnmounted(() => {
  if (envTimer) clearInterval(envTimer)
  if (runtimeTimer) clearInterval(runtimeTimer)
})


function backToHome() {
  router.push('/')
}
</script>

<template>
  <div class="flex flex-col h-screen bg-gray-50">
    <!-- 顶部栏 -->
    <header class="h-12 bg-white border-b border-gray-200 flex items-center justify-between px-4">
      <div class="flex items-center gap-3">
        <button @click="backToHome" class="text-sm text-gray-500 hover:text-gray-700">
          ← 返回
        </button>
        <div class="w-px h-4 bg-gray-200"></div>
        <div class="flex items-center gap-2">
          <Cpu class="w-4 h-4 text-blue-600" />
          <span class="font-medium text-sm text-gray-900">{{ projectName }}</span>
        </div>
      </div>

      <nav class="flex items-center gap-1">
        <router-link
          v-for="nav in [
            { path: 'requirements', name: '需求' },
            { path: 'pipeline', name: '流水线' },
            { path: 'cases', name: '用例' },
            { path: 'trace', name: '追踪' },
            { path: 'scripts', name: '脚本' },
            { path: 'plans', name: '计划' },
            { path: 'executions', name: '执行' },
            { path: 'reports', name: '报告' },
          ]"
          :key="nav.path"
          :to="`/project/${projectId}/${nav.path}`"
          class="relative px-3 py-1.5 text-xs transition-colors"
          :class="
            route.path.includes(nav.path)
              ? 'text-gray-900 font-medium'
              : 'text-gray-500 hover:text-gray-900'
          "
        >
          <!-- 选中指示条 -->
          <span
            v-if="route.path.includes(nav.path)"
            class="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-5 bg-blue-600 rounded-full"
          ></span>
          {{ nav.name }}
        </router-link>
      </nav>

      <div class="flex items-center gap-3">
        <div class="w-48 relative">
          <Search class="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            placeholder="全局搜索..."
            class="w-full pl-8 pr-3 py-1 text-xs border border-gray-200 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>
        <!-- 通知 -->
        <button class="p-1.5 text-gray-500 hover:text-gray-700">
          <Bell class="w-4 h-4" />
        </button>
        <!-- 设置 -->
        <button @click="router.push('/settings')" class="p-1.5 text-gray-500 hover:text-gray-700">
          <Settings class="w-4 h-4" />
        </button>
        <!-- 用户头像 -->
        <div class="relative">
          <button class="w-7 h-7 rounded-full bg-blue-600 text-white flex items-center justify-center text-xs">测</button>
        </div>
      </div>
    </header>

    <div class="flex flex-1 overflow-hidden">
      <!-- 左侧栏已移除：模块树/最近访问/收藏都是历史 mock 数据，
           真实导航在顶部的 需求/用例/脚本/计划/执行/报告 -->
      <!-- 中间主工作区（AI 对话由桌面端提供，这里不再内嵌） -->
      <main class="flex-1 flex flex-col overflow-hidden bg-gray-50">
        <router-view />
      </main>
    </div>

    <!-- 底部环境状态栏 -->
    <div class="h-7 bg-gray-100 border-t border-gray-200 flex items-center px-4 gap-4 text-xs text-gray-600 flex-shrink-0">
      <span v-for="(item, key) in envStatus" :key="key" class="flex items-center gap-1">
        <span class="w-1.5 h-1.5 rounded-full" :class="item.ok ? 'bg-green-500' : 'bg-red-500'"></span>
        {{ item.label }}
      </span>
      <span class="text-gray-300">|</span>
      <span class="flex items-center gap-1" :title="runtime.latestPipeline?.modelKey || ''">
        <span class="text-gray-400">模型</span>{{ runtimeModel }}
      </span>
      <span class="flex items-center gap-1">
        <span class="text-gray-400">用量</span>{{ runtimeTokens }}
      </span>
      <span class="flex items-center gap-1">
        <span class="w-1.5 h-1.5 rounded-full" :class="runtime.running ? 'bg-blue-500 animate-pulse' : 'bg-gray-300'"></span>
        {{ runtimeState }}
      </span>
      <span class="flex items-center gap-1">
        <span class="text-gray-400">下次计划</span>{{ nextRunText }}
      </span>
      <span class="ml-auto text-gray-400">AutoTest · v{{ runtime.version || '0.2.0' }}</span>
    </div>
  </div>
</template>
