<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  Search,
  ChevronRight,
  FolderOpen,
  Clock,
  Cpu,
  Bell,
  Settings,
} from 'lucide-vue-next'

const route = useRoute()
const router = useRouter()

const projectId = route.params.projectId as string
const projectName = ref('加载中...')

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

// 底部环境状态（AI 能力由桌面端 Agent 提供，这里只看本机运行时）
const envStatus = ref<Record<string, { ok: boolean; label: string }>>({
  api: { ok: false, label: '后端 API' },
  database: { ok: false, label: '数据库' },
  python: { ok: false, label: 'Python' },
  mcp_can: { ok: false, label: 'MCP CAN' },
  mcp_hmi: { ok: false, label: 'MCP HMI' },
  mcp_logger: { ok: false, label: 'MCP Logger' },
})
let envTimer: ReturnType<typeof setInterval> | null = null

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

// 状态栏运行态：只看我们自己的 workflow runs
const runsSummary = ref({ running: 0, waiting: 0, total: 0 })
let runTimer: ReturnType<typeof setInterval> | null = null

// 左侧「项目结构」：知识库里真实存在的模块 + 文档数
const modules = ref<{ id: string; name: string; count: number }[]>([])
const structureExpanded = ref(true)
// 左侧「最近访问」：最近几条运行记录，点开直接进运行详情
const recentRuns = ref<{ id: string; module?: string; created_at?: string }[]>([])

async function loadSidebar() {
  try {
    const pid = route.params.projectId
    if (!pid) return
    const [runRes, docRes] = await Promise.all([
      fetch(`/api/projects/${pid}/workflow/runs?limit=50`),
      fetch(`/api/projects/${pid}/knowledge/documents`),
    ])
    if (runRes.ok) {
      const body = await runRes.json()
      const runs = body?.data?.runs || []
      runsSummary.value = {
        running: runs.filter((r: any) => r.status === 'running').length,
        waiting: runs.filter((r: any) => r.status === 'waiting_human').length,
        total: runs.length,
      }
      recentRuns.value = runs.slice(0, 5)
    }
    if (docRes.ok) {
      const body = await docRes.json()
      const docs = body?.data?.documents || []
      const grouped = new Map<string, number>()
      for (const doc of docs) {
        const key = doc.module || '未标模块'
        grouped.set(key, (grouped.get(key) || 0) + 1)
      }
      modules.value = [...grouped.entries()]
        .map(([name, count], i) => ({ id: `m${i}`, name, count }))
        .sort((a, b) => b.count - a.count)
    }
  } catch {
    // 侧栏是旁路信息，取不到就保持上一次
  }
}

function openModule(name: string) {
  router.push({ path: `/project/${projectId}/knowledge`, query: { module: name === '未标模块' ? '' : name } })
}
function openRun(id: string) {
  router.push({ path: `/project/${projectId}/runs`, query: { run: id } })
}
function shortTime(value?: string) {
  return value ? value.replace('T', ' ').slice(5, 16) : ''
}

// 顶栏搜索：输入后按关键词检索知识库
const searchText = ref('')
function submitSearch() {
  const q = searchText.value.trim()
  router.push({ path: `/project/${projectId}/knowledge`, query: q ? { q } : {} })
}

// 设置：显示本机工作台的运行时信息（没有账号/平台设置项）
const showRuntime = ref(false)
const runtimeInfo = ref<Record<string, any>>({})
async function openRuntime() {
  showRuntime.value = true
  try {
    const res = await fetch(`/api/projects/${projectId}/env-status`)
    if (res.ok) runtimeInfo.value = await res.json()
  } catch {
    runtimeInfo.value = {}
  }
}

onMounted(() => {
  loadProject()
  loadEnvStatus()
  loadSidebar()
  envTimer = setInterval(loadEnvStatus, 30000)
  runTimer = setInterval(loadSidebar, 5000)
})

onUnmounted(() => {
  if (envTimer) clearInterval(envTimer)
  if (runTimer) clearInterval(runTimer)
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
            { path: 'runs', name: '运行记录' },
            { path: 'bugs', name: '缺陷' },
            { path: 'knowledge', name: '知识库' },
            { path: 'requirements', name: '需求' },
            { path: 'cases', name: '用例' },
            { path: 'scripts', name: '脚本' },
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
            v-model="searchText"
            @keyup.enter="submitSearch"
            type="text"
            placeholder="搜索知识库..."
            class="w-full pl-8 pr-3 py-1 text-xs border border-gray-200 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>
        <!-- 通知：有运行在等人工审批时高亮 -->
        <button
          @click="router.push(`/project/${projectId}/runs`)"
          class="relative p-1.5 text-gray-500 hover:text-gray-700"
          title="待审批的运行"
        >
          <Bell class="w-4 h-4" />
          <span
            v-if="runsSummary.waiting > 0"
            class="absolute -top-0.5 -right-0.5 min-w-3.5 h-3.5 px-1 rounded-full bg-red-500 text-white text-[10px] leading-3.5 text-center"
          >{{ runsSummary.waiting }}</span>
        </button>
        <!-- 运行时信息 -->
        <button @click="openRuntime" class="p-1.5 text-gray-500 hover:text-gray-700">
          <Settings class="w-4 h-4" />
        </button>
        <!-- 用户头像 -->
        <div class="relative">
          <button class="w-7 h-7 rounded-full bg-blue-600 text-white flex items-center justify-center text-xs">测</button>
        </div>
      </div>
    </header>

    <div class="flex flex-1 overflow-hidden">
      <!-- 左侧栏：项目结构（真实知识模块）+ 最近运行 -->
      <aside class="w-56 bg-white border-r border-gray-200 flex flex-col">
        <div class="flex-1 overflow-auto p-2">
          <div class="text-xs font-medium text-gray-400 px-2 py-1.5">项目结构</div>
          <div class="mb-1">
            <button
              @click="structureExpanded = !structureExpanded"
              class="w-full flex items-center gap-1.5 px-2 py-1 rounded text-xs text-gray-700 hover:bg-gray-100"
            >
              <ChevronRight
                class="w-3 h-3 transition-transform"
                :class="structureExpanded ? 'rotate-90' : ''"
              />
              <FolderOpen class="w-3.5 h-3.5 text-gray-400" />
              <span class="font-medium">知识模块</span>
            </button>
            <div v-if="structureExpanded" class="ml-5 mt-0.5 space-y-0.5">
              <button
                v-for="mod in modules"
                :key="mod.id"
                @click="openModule(mod.name)"
                class="relative w-full flex items-center justify-between px-2 py-1 rounded text-xs text-gray-600 hover:text-gray-900 hover:bg-gray-100"
              >
                <span class="truncate">{{ mod.name }}</span>
                <span class="text-gray-400">{{ mod.count }}</span>
              </button>
              <div v-if="!modules.length" class="px-2 py-1 text-xs text-gray-400">知识库还没有文档</div>
            </div>
          </div>
        </div>

        <!-- 最近运行 -->
        <div class="border-t border-gray-100 p-2">
          <div class="text-xs font-medium text-gray-400 px-2 py-1.5 flex items-center gap-1">
            <Clock class="w-3 h-3" />
            最近运行
          </div>
          <div class="space-y-0.5">
            <button
              v-for="r in recentRuns"
              :key="r.id"
              @click="openRun(r.id)"
              class="w-full text-left px-2 py-1 rounded text-xs text-gray-600 hover:bg-gray-100"
            >
              <div class="truncate font-mono text-[11px] text-gray-700">{{ r.id }}</div>
              <div class="truncate text-[10px] text-gray-400">{{ r.module || '未标模块' }} · {{ shortTime(r.created_at) }}</div>
            </button>
            <div v-if="!recentRuns.length" class="px-2 py-1 text-xs text-gray-400">还没有运行记录</div>
          </div>
        </div>
      </aside>

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
      <span class="ml-auto flex items-center gap-3 text-gray-500">
        <span class="flex items-center gap-1">
          <span class="w-1.5 h-1.5 rounded-full bg-blue-500"></span>
          运行中 {{ runsSummary.running }}
        </span>
        <span class="flex items-center gap-1">
          <span class="w-1.5 h-1.5 rounded-full bg-yellow-500"></span>
          待审批 {{ runsSummary.waiting }}
        </span>
        <span>最近运行 {{ runsSummary.total }} 条</span>
        <span class="text-gray-400">AutoTest · v0.2.0</span>
      </span>
    </div>

    <!-- 运行时信息浮层 -->
    <div v-if="showRuntime" class="fixed inset-0 bg-black/30 flex items-center justify-center z-40" @click.self="showRuntime = false">
      <div class="w-96 bg-white rounded-lg shadow-lg p-5">
        <div class="flex items-center justify-between mb-3">
          <span class="text-sm font-medium text-gray-900">本机运行时</span>
          <button class="text-gray-400 hover:text-gray-800" @click="showRuntime = false">关闭</button>
        </div>
        <div class="space-y-1.5">
          <div v-for="(item, key) in runtimeInfo" :key="key" class="flex items-center justify-between text-xs">
            <span class="text-gray-500">{{ item.label || key }}</span>
            <span :class="item.ok ? 'text-green-600' : 'text-red-600'">{{ item.ok ? '正常' : '不可用' }}</span>
          </div>
        </div>
        <div class="mt-3 pt-3 border-t border-gray-100 text-xs text-gray-400">
          数据目录由桌面端注入，工作区文件在项目目录 data.db。
        </div>
      </div>
    </div>
  </div>
</template>
