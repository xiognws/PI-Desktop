<script setup lang="ts">
import ThemeSwitch from '@/components/theme-switch.vue'
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

// 导航按「一次测试活动的顺序」分组：流程 → 产物 → 结果 → 资料。
// 之前顶部横排 12 项平铺，扫一遍要读完 12 个词；分组后每层 2–3 项。
const NAV: { group: string; items: { path: string; name: string }[] }[] = [
  {
    group: '流程',
    items: [
      { path: 'pipeline', name: '流水线' },
      { path: 'runs', name: '运行记录' },
      { path: 'approvals', name: '待审批' },
    ],
  },
  {
    group: '产物',
    items: [
      { path: 'cases', name: '用例' },
      { path: 'scripts', name: '脚本' },
    ],
  },
  {
    group: '结果',
    items: [
      { path: 'executions', name: '执行' },
      { path: 'reports', name: '报告' },
      { path: 'bugs', name: '缺陷' },
    ],
  },
  {
    group: '资料',
    items: [
      { path: 'requirements', name: '项目资料' },
      { path: 'knowledge', name: '知识库' },
    ],
  },
  { group: '其他', items: [{ path: 'settings', name: '设置' }] },
]

const projectId = route.params.projectId as string
const projectName = ref('加载中...')

// 从后端获取项目信息
const projectMissing = ref(false)
async function loadProject() {
  try {
    const res = await fetch('/api/projects')
    const data = await res.json()
    const p = data.projects?.find((p: any) => p.id === projectId)
    if (p) {
      projectName.value = p.name
      projectMissing.value = false
    } else {
      // 项目被删/换了数据目录后，旧链接的所有子页面都会 404：
      // 直接告诉用户并给回首页的入口，比刷一屏「加载失败」有用。
      projectMissing.value = true
      projectName.value = '项目不存在'
    }
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
  <div class="flex flex-col h-screen bg-surface-2">
    <!-- 顶部栏 -->
    <header class="h-12 bg-surface border-b border-line flex items-center justify-between px-4">
      <div class="flex items-center gap-3">
        <button @click="backToHome" class="text-sm text-muted hover:text-fg-2">
          ← 返回
        </button>
        <div class="w-px h-4 bg-surface-4"></div>
        <div class="flex items-center gap-2">
          <Cpu class="w-4 h-4 text-accent" />
          <span class="font-medium text-sm text-fg">{{ projectName }}</span>
        </div>
      </div>

      <div class="flex items-center gap-3">
        <div class="w-48 relative">
          <Search class="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-2" />
          <input
            v-model="searchText"
            @keyup.enter="submitSearch"
            type="text"
            placeholder="搜索知识库..."
            class="w-full pl-8 pr-3 py-1 text-xs border border-line rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>
        <!-- 通知：有运行在等人工审批时高亮 -->
        <button
          @click="router.push(`/project/${projectId}/runs`)"
          class="relative p-2 text-muted hover:text-fg-2"
          title="待审批的运行"
        >
          <Bell class="w-4 h-4" />
          <span
            v-if="runsSummary.waiting > 0"
            class="absolute -top-0.5 -right-0.5 min-w-3.5 h-3.5 px-1 rounded-full bg-danger text-white text-[10px] leading-3.5 text-center"
          >{{ runsSummary.waiting }}</span>
        </button>
        <!-- 运行时信息 -->
        <button @click="openRuntime" class="p-2 text-muted hover:text-fg-2">
          <Settings class="w-4 h-4" />
        </button>
        <!-- 用户头像 -->
        <div class="relative">
          <button class="w-7 h-7 rounded-full bg-accent-solid text-white flex items-center justify-center text-xs">测</button>
        </div>
      </div>
    </header>

    <div class="flex flex-1 overflow-hidden">
      <!-- 左侧栏：项目结构（真实知识模块）+ 最近运行 -->
      <aside class="w-60 bg-surface border-r border-line flex flex-col">
        <div class="flex-1 overflow-auto p-2">
          <!-- 导航：分组 + 每项 32px，选中项左侧一根 3px 竖条（全站唯一强调色） -->
          <nav class="mb-3 space-y-3">
            <div v-for="group in NAV" :key="group.group">
              <p class="px-2 pb-1 text-[12px] text-muted-2">{{ group.group }}</p>
              <div class="space-y-0.5">
                <router-link
                  v-for="item in group.items"
                  :key="item.path"
                  :to="`/project/${projectId}/${item.path}`"
                  class="flex h-8 items-center rounded-[8px] px-2 text-[13px] transition-colors"
                  :class="
                    route.path.includes(item.path)
                      ? 'state-bar bg-surface-3 text-fg'
                      : 'text-muted hover:bg-surface-3 hover:text-fg'
                  "
                  :data-tone="route.path.includes(item.path) ? 'accent' : undefined"
                >
                  {{ item.name }}
                </router-link>
              </div>
            </div>
          </nav>

          <div class="text-[12px] text-muted-2 px-2 py-2">项目结构</div>
          <div class="mb-1">
            <button
              @click="structureExpanded = !structureExpanded"
              class="w-full flex items-center gap-2 px-2 py-1 rounded text-xs text-fg-2 hover:bg-surface-3"
            >
              <ChevronRight
                class="w-3 h-3 transition-transform"
                :class="structureExpanded ? 'rotate-90' : ''"
              />
              <FolderOpen class="w-3.5 h-3.5 text-muted-2" />
              <span class="font-medium">知识模块</span>
            </button>
            <div v-if="structureExpanded" class="ml-5 mt-0.5 space-y-0.5">
              <button
                v-for="mod in modules"
                :key="mod.id"
                @click="openModule(mod.name)"
                class="relative w-full flex items-center justify-between px-2 py-1 rounded text-xs text-fg-3 hover:text-fg hover:bg-surface-3"
              >
                <span class="truncate">{{ mod.name }}</span>
                <span class="text-muted-2">{{ mod.count }}</span>
              </button>
              <div v-if="!modules.length" class="px-2 py-1 text-xs text-muted-2">知识库还没有文档</div>
            </div>
          </div>
        </div>

        <!-- 最近运行 -->
        <div class="border-t border-line-soft p-2">
          <div class="text-xs font-medium text-muted-2 px-2 py-2 flex items-center gap-1">
            <Clock class="w-3 h-3" />
            最近运行
          </div>
          <div class="space-y-0.5">
            <button
              v-for="r in recentRuns"
              :key="r.id"
              @click="openRun(r.id)"
              class="w-full text-left px-2 py-1 rounded text-xs text-fg-3 hover:bg-surface-3"
            >
              <div class="truncate mono text-[12px] text-fg-2">{{ r.id }}</div>
              <div class="truncate text-[12px] text-muted-2">{{ r.module || '未标模块' }} · {{ shortTime(r.created_at) }}</div>
            </button>
            <div v-if="!recentRuns.length" class="px-2 py-1 text-xs text-muted-2">还没有运行记录</div>
          </div>
        </div>
      </aside>

      <!-- 中间主工作区（AI 对话由桌面端提供，这里不再内嵌） -->
      <main class="flex-1 flex flex-col overflow-hidden bg-surface-2">
        <div v-if="projectMissing" class="flex-1 flex items-center justify-center">
          <div class="text-center">
            <p class="text-sm text-fg-2">这个项目（<span class="font-mono text-xs">{{ projectId }}</span>）当前数据目录里不存在。</p>
            <p class="mt-1 text-xs text-muted-2">可能是换了数据目录，或者项目已被删除。</p>
            <router-link to="/" class="mt-4 inline-block px-4 py-2 text-sm bg-accent-solid text-white rounded-lg hover:bg-blue-700">
              返回项目列表
            </router-link>
          </div>
        </div>
        <router-view v-else />
      </main>
    </div>

    <!-- 底部环境状态栏 -->
    <div class="h-7 bg-surface-3 border-t border-line flex items-center px-4 gap-4 text-xs text-fg-3 flex-shrink-0">
      <span v-for="(item, key) in envStatus" :key="key" class="flex items-center gap-1">
        <span class="w-1.5 h-1.5 rounded-full" :class="item.ok ? 'bg-success' : 'bg-danger'"></span>
        {{ item.label }}
      </span>
      <span class="ml-auto flex items-center gap-3 text-muted">
        <span class="flex items-center gap-1">
          <span class="w-1.5 h-1.5 rounded-full bg-accent-solid"></span>
          运行中 {{ runsSummary.running }}
        </span>
        <span class="flex items-center gap-1">
          <span class="w-1.5 h-1.5 rounded-full bg-warn"></span>
          待审批 {{ runsSummary.waiting }}
        </span>
        <span>最近运行 {{ runsSummary.total }} 条</span>
        <span class="text-muted-2">AutoTest · v0.2.0</span>
        <ThemeSwitch />
      </span>
    </div>

    <!-- 运行时信息浮层 -->
    <div v-if="showRuntime" class="fixed inset-0 bg-black/30 flex items-center justify-center z-40" @click.self="showRuntime = false">
      <div class="w-96 bg-surface rounded-lg shadow-lg p-5">
        <div class="flex items-center justify-between mb-3">
          <span class="text-sm font-medium text-fg">本机运行时</span>
          <button class="text-muted-2 hover:text-fg" @click="showRuntime = false">关闭</button>
        </div>
        <div class="space-y-1.5">
          <div v-for="(item, key) in runtimeInfo" :key="key" class="flex items-center justify-between text-xs">
            <span class="text-muted">{{ item.label || key }}</span>
            <span :class="item.ok ? 'text-success' : 'text-danger'">{{ item.ok ? '正常' : '不可用' }}</span>
          </div>
        </div>
        <div class="mt-3 pt-3 border-t border-line-soft text-xs text-muted-2">
          数据目录由桌面端注入，工作区文件在项目目录 data.db。
        </div>
      </div>
    </div>
  </div>
</template>
