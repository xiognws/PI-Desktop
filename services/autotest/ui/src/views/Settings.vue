<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { Save, Plug, Settings2, RefreshCw } from 'lucide-vue-next'

const activeTab = ref('system')
const tabs = [
  { id: 'mcp', name: 'MCP 插件', icon: Plug },
  { id: 'system', name: '系统', icon: Settings2 },
]

// 这一页过去有四块写死的假配置：一个长安内部大模型的 baseUrl 和一个截断的
// apiKey、一套 Hindsight 记忆参数、七个 Agent 角色的 temperature、以及一个对话
// 设置。它们没有后端，也没有任何代码读它们 —— 平台侧不装模型层（模型由桌面端
// Agent 通过 pi.agent.complete 提供）。留下可编辑的假表单比留空更危险：用户会
// 以为改了就生效。现在这一页只显示真实存在、且真实生效的东西。

type Runtime = {
  healthy?: boolean
  workspace?: string
  python?: string
  backend_port?: number
  agents?: { id: string; name?: string }[]
}

const runtime = ref<Runtime>({})
const runtimeError = ref('')
const loading = ref(false)

// MCP 服务器：来自平台登记的真实清单，不是写死的四行。
type McpServer = { id: string; name?: string; url?: string; enabled?: boolean }
const mcpServers = ref<McpServer[]>([])

const systemConfig = ref({ projectPath: '' })
const saveMessage = ref('')
const saveError = ref('')

async function loadRuntime() {
  loading.value = true
  runtimeError.value = ''
  try {
    // /api/platform 是「平台装成什么样」（与项目无关）；/api/runtime 是
    // 「某个项目跑到哪」，不带 projectId 时只回版本号，设置页要的是前者。
    const res = await fetch('/api/platform')
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
    const data = (await res.json()) as Runtime & { mcp_servers?: McpServer[] }
    runtime.value = data
    if (data.workspace) systemConfig.value.projectPath = data.workspace
    mcpServers.value = (data.mcp_servers ?? []).map((s) => ({
      id: String(s.id ?? s.name ?? ''),
      name: s.name ?? s.id,
      url: s.url ?? '',
      enabled: Boolean(s.enabled),
    }))
  } catch (e) {
    runtimeError.value = `读取平台运行时失败：${(e as Error).message}`
  } finally {
    loading.value = false
  }
}

// 保存：把 workspace 路径写回平台配置。后端没有该字段时明确报错，不假装保存成功。
async function saveSettings() {
  saveMessage.value = ''
  saveError.value = ''
  try {
    const res = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace: systemConfig.value.projectPath }),
    })
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}))
      throw new Error(detail.detail || `${res.status} ${res.statusText}`)
    }
    saveMessage.value = '已保存（下次启动后端生效）'
  } catch (e) {
    saveError.value = `保存失败：${(e as Error).message}`
  }
}

onMounted(loadRuntime)
</script>

<template>
  <div class="min-h-screen bg-surface-2">
    <header class="h-14 bg-surface border-b border-line flex items-center justify-between px-6">
      <div class="flex items-center gap-2">
        <button @click="$router.push('/')" class="text-sm text-muted hover:text-fg-2">← 返回工作台</button>
      </div>
      <h1 class="text-base font-medium text-fg">系统设置</h1>
      <div class="w-8"></div>
    </header>

    <div class="flex max-w-6xl mx-auto p-6 gap-6">
      <!-- 左侧设置菜单 -->
      <aside class="w-48 bg-surface rounded-lg border border-line h-fit sticky top-6">
        <div class="p-2">
          <button
            v-for="tab in tabs"
            :key="tab.id"
            @click="activeTab = tab.id"
            class="w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm mb-0.5"
            :class="activeTab === tab.id ? 'bg-accent-soft text-accent font-medium' : 'text-fg-3 hover:bg-surface-3'"
          >
            <component :is="tab.icon" class="w-4 h-4" />
            {{ tab.name }}
          </button>
        </div>
      </aside>

      <!-- 右侧设置内容 -->
      <main class="flex-1 space-y-6">
        <p v-if="runtimeError" class="px-4 py-2 text-xs text-danger bg-danger-soft border border-danger-line rounded-lg">{{ runtimeError }}</p>

        <!-- 平台运行时：这一栏是「平台到底跑在哪、用什么解释器」的唯一答案 -->
        <div class="bg-surface rounded-lg border border-line">
          <div class="px-6 py-4 border-b border-line flex items-center justify-between">
            <h2 class="text-base font-medium text-fg">平台运行时</h2>
            <button @click="loadRuntime" :disabled="loading"
              class="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-line rounded-lg hover:bg-surface-2 disabled:opacity-50">
              <RefreshCw class="w-3.5 h-3.5" :class="loading ? 'animate-spin' : ''" />
              刷新
            </button>
          </div>
          <div class="p-6 space-y-3 text-sm">
            <div class="flex items-center justify-between">
              <span class="text-muted">状态</span>
              <span :class="runtime.healthy ? 'text-success' : 'text-danger'">
                {{ runtime.healthy ? '运行中' : '不可用' }}
              </span>
            </div>
            <div class="flex items-center justify-between gap-4">
              <span class="text-muted flex-shrink-0">Python 解释器</span>
              <span class="font-mono text-xs text-fg-2 truncate">{{ runtime.python || '（未配置）' }}</span>
            </div>
            <div class="flex items-center justify-between">
              <span class="text-muted">后端端口</span>
              <span class="font-mono text-xs text-fg-2">{{ runtime.backend_port ?? '（未知）' }}</span>
            </div>
            <div class="flex items-start justify-between gap-4">
              <span class="text-muted flex-shrink-0">项目工作空间</span>
              <span class="font-mono text-xs text-fg-2 break-all text-right">{{ runtime.workspace || '（未知）' }}</span>
            </div>
            <div v-if="runtime.agents?.length" class="pt-2 border-t border-line-soft">
              <div class="text-muted mb-2">平台侧阶段（模型由桌面端 Agent 提供）</div>
              <div class="flex flex-wrap gap-2">
                <span v-for="a in runtime.agents" :key="a.id"
                  class="px-2 py-0.5 text-xs bg-surface-3 text-fg-2 rounded">{{ a.name || a.id }}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- MCP 插件 -->
        <div v-if="activeTab === 'mcp'" class="bg-surface rounded-lg border border-line">
          <div class="px-6 py-4 border-b border-line">
            <h2 class="text-base font-medium text-fg">MCP 服务器</h2>
          </div>
          <div class="p-6">
            <div v-if="mcpServers.length === 0" class="text-sm text-muted-2 py-4">
              平台没有登记 MCP 服务器。MCP 的启用与授权在桌面端的设置里管理。
            </div>
            <div v-else class="space-y-3">
              <div v-for="server in mcpServers" :key="server.id" class="flex items-center justify-between p-3 border border-line-soft rounded-lg">
                <div class="flex items-center gap-3">
                  <span class="w-2 h-2 rounded-full" :class="server.enabled ? 'bg-green-500' : 'bg-gray-300'"></span>
                  <div>
                    <div class="text-sm font-medium text-fg">{{ server.name }}</div>
                    <div class="text-xs text-muted">{{ server.url }}</div>
                  </div>
                </div>
                <span class="text-xs" :class="server.enabled ? 'text-green-500' : 'text-muted-2'">
                  {{ server.enabled ? '已启用' : '未启用' }}
                </span>
              </div>
            </div>
          </div>
        </div>

        <!-- 系统设置 -->
        <div v-if="activeTab === 'system'" class="bg-surface rounded-lg border border-line">
          <div class="px-6 py-4 border-b border-line">
            <h2 class="text-base font-medium text-fg">系统设置</h2>
          </div>
          <div class="p-6 space-y-4">
            <div>
              <label class="block text-sm text-fg-2 mb-1">项目工作空间路径</label>
              <input v-model="systemConfig.projectPath" type="text"
                class="w-full px-3 py-2 border border-line rounded-lg text-sm font-mono" />
              <p class="text-xs text-muted-2 mt-1">
                每个项目的数据（data.db、脚本、执行记录）都落在这个目录下。
              </p>
            </div>
            <p v-if="saveMessage" class="text-xs text-success">{{ saveMessage }}</p>
            <p v-if="saveError" class="text-xs text-danger">{{ saveError }}</p>
          </div>
        </div>

        <!-- 保存按钮 -->
        <div class="flex justify-end">
          <button @click="saveSettings" class="flex items-center gap-2 px-4 py-2 bg-accent-solid text-white rounded-lg hover:bg-blue-700">
            <Save class="w-4 h-4" />
            保存设置
          </button>
        </div>
      </main>
    </div>
  </div>
</template>
