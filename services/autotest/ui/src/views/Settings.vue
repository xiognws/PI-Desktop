<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { Save, Plug, Settings2, RefreshCw } from 'lucide-vue-next'
import Badge from '@/components/Badge.vue'

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
    <header class="flex h-14 items-center justify-between border-b border-line bg-surface px-6">
      <button class="text-[13px] text-muted hover:text-fg" @click="$router.push('/')">← 返回工作台</button>
      <h1 class="text-[15px] font-medium text-fg">系统设置</h1>
      <span class="w-8"></span>
    </header>

    <div class="mx-auto flex max-w-[1040px] gap-6 px-8 py-7">
      <!-- 左侧：分组用文字标签，选中项一根竖条 -->
      <aside class="sticky top-7 h-fit w-44 rounded-[12px] border border-line bg-surface p-2">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          class="mb-0.5 flex h-8 w-full items-center gap-2 rounded-[8px] px-2 text-[13px]"
          :class="activeTab === tab.id ? 'state-bar bg-surface-3 text-fg' : 'text-muted hover:bg-surface-3 hover:text-fg'"
          @click="activeTab = tab.id"
        >
          <component :is="tab.icon" class="h-4 w-4" />
          {{ tab.name }}
        </button>
      </aside>

      <main class="flex-1 space-y-5">
        <p v-if="runtimeError" class="rounded-[8px] border border-danger-line bg-danger-soft px-4 py-2 text-[12px] text-danger">{{ runtimeError }}</p>

        <!-- 平台运行时：平台跑在哪、用什么解释器的唯一答案 -->
        <section class="rounded-[12px] border border-line bg-surface">
          <div class="flex items-center justify-between border-b border-line px-5 py-3">
            <h2 class="text-[13px] font-medium text-fg">平台运行时</h2>
            <button
              class="flex h-8 items-center gap-2 rounded-[8px] px-2 text-[12px] text-muted hover:bg-surface-3 hover:text-fg disabled:opacity-40"
              :disabled="loading"
              @click="loadRuntime"
            >
              <RefreshCw class="h-3.5 w-3.5" :class="loading ? 'animate-spin' : ''" /> 刷新
            </button>
          </div>
          <dl class="divide-y divide-line-soft text-[13px]">
            <div class="flex items-center justify-between px-5 py-2.5">
              <dt class="text-muted">状态</dt>
              <dd><Badge :tone="runtime.healthy ? 'success' : 'danger'">{{ runtime.healthy ? '运行中' : '不可用' }}</Badge></dd>
            </div>
            <div class="flex items-center justify-between gap-4 px-5 py-2.5">
              <dt class="flex-shrink-0 text-muted">Python 解释器</dt>
              <dd class="mono min-w-0 truncate text-[12px] text-fg">{{ runtime.python || '（未配置）' }}</dd>
            </div>
            <div class="flex items-center justify-between px-5 py-2.5">
              <dt class="text-muted">后端端口</dt>
              <dd class="num text-[12px] text-fg">{{ runtime.backend_port ?? '（未知）' }}</dd>
            </div>
            <div class="flex items-start justify-between gap-4 px-5 py-2.5">
              <dt class="flex-shrink-0 text-muted">项目工作空间</dt>
              <dd class="mono break-all text-right text-[12px] text-fg">{{ runtime.workspace || '（未知）' }}</dd>
            </div>
            <div v-if="runtime.agents?.length" class="px-5 py-2.5">
              <dt class="text-[12px] text-muted-2">平台侧阶段（模型由桌面端 Agent 提供）</dt>
              <dd class="mt-2 flex flex-wrap gap-2">
                <Badge v-for="a in runtime.agents" :key="a.id" tone="neutral">{{ a.name || a.id }}</Badge>
              </dd>
            </div>
          </dl>
        </section>

        <!-- MCP -->
        <section v-if="activeTab === 'mcp'" class="rounded-[12px] border border-line bg-surface">
          <div class="border-b border-line px-5 py-3">
            <h2 class="text-[13px] font-medium text-fg">MCP 服务器</h2>
          </div>
          <p v-if="mcpServers.length === 0" class="px-5 py-4 text-[13px] text-muted-2">
            平台没有登记 MCP 服务器。MCP 的启用与授权在桌面端的设置里管理。
          </p>
          <ul v-else class="divide-y divide-line-soft">
            <li v-for="server in mcpServers" :key="server.id" class="flex items-center gap-3 px-5 py-2.5">
              <span class="h-3 w-[3px]" :class="server.enabled ? 'bg-success' : 'bg-surface-4'"></span>
              <div class="min-w-0 flex-1">
                <p class="text-[13px] text-fg">{{ server.name }}</p>
                <p class="mono truncate text-[12px] text-muted-2">{{ server.url }}</p>
              </div>
              <span class="text-[12px]" :class="server.enabled ? 'text-fg' : 'text-muted-2'">
                {{ server.enabled ? '已启用' : '未启用' }}
              </span>
            </li>
          </ul>
        </section>

        <!-- 系统 -->
        <section v-if="activeTab === 'system'" class="rounded-[12px] border border-line bg-surface">
          <div class="border-b border-line px-5 py-3">
            <h2 class="text-[13px] font-medium text-fg">系统设置</h2>
          </div>
          <div class="px-5 py-4">
            <label class="block text-[12px] text-muted">项目工作空间路径</label>
            <input
              v-model="systemConfig.projectPath"
              type="text"
              class="mono mt-1 h-9 w-full rounded-[8px] border border-line bg-surface px-2 text-[12px] text-fg"
            />
            <p class="mt-1 text-[12px] text-muted-2">每个项目的数据（data.db、脚本、执行记录）都落在这个目录下。</p>
            <p v-if="saveMessage" class="mt-2 text-[12px] text-success">{{ saveMessage }}</p>
            <p v-if="saveError" class="mt-2 text-[12px] text-danger">{{ saveError }}</p>
          </div>
        </section>

        <div class="flex justify-end">
          <button
            class="flex h-9 items-center gap-2 rounded-[8px] bg-accent-solid px-3 text-[13px] text-white hover:bg-accent"
            @click="saveSettings"
          >
            <Save class="h-4 w-4" /> 保存设置
          </button>
        </div>
      </main>
    </div>
  </div>
</template>
