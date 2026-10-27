<script setup lang="ts">
import { ref } from 'vue'
import { Save, Plug, Settings2 } from 'lucide-vue-next'

// 左侧设置菜单（AI 能力由桌面端 Agent 提供，平台只保留系统与硬件 MCP 设置）
const activeTab = ref('system')
const tabs = [
  { id: 'mcp', name: 'MCP 插件', icon: Plug },
  { id: 'system', name: '系统', icon: Settings2 },
]

// LLM 配置
const llmConfig = ref({
  provider: 'changan',
  providers: [
    {
      id: 'changan',
      name: '长安内部大模型',
      baseUrl: 'https://ai.sda.changan.com.cn/api/v1',
      apiKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
      chatModel: '9554',
      embeddingModel: '10292',
    },
  ],
  temperature: 0.7,
  maxTokens: 4096,
  topP: 1.0,
  frequencyPenalty: 0.0,
  presencePenalty: 0.0,
})

// 记忆系统配置
const memoryConfig = ref({
  provider: 'hindsight',
  hindsightUrl: 'http://127.0.0.1:8889',
  enabled: true,
  autoRecall: true,
  autoRetain: true,
  recallTopK: 5,
  memoryBank: 'hermes',
})

// Agent 配置
const agents = ref([
  { id: 'requirement_analyst', name: '需求分析师', enabled: true, temperature: 0.3 },
  { id: 'test_designer', name: '用例设计师', enabled: true, temperature: 0.7 },
  { id: 'script_engineer', name: '脚本工程师', enabled: true, temperature: 0.2 },
  { id: 'executor', name: '执行器', enabled: true, temperature: 0.0 },
  { id: 'judge', name: '评判官', enabled: true, temperature: 0.1 },
  { id: 'repairer', name: '修复专家', enabled: true, temperature: 0.4 },
  { id: 'reporter', name: '报告生成器', enabled: true, temperature: 0.5 },
])

// MCP 服务器
const mcpServers = ref([
  { id: 'hindsight', name: 'Hindsight 记忆', url: 'http://127.0.0.1:8889/mcp/', enabled: true },
  { id: 'can_agent', name: 'CAN 总线代理', url: 'http://127.0.0.1:9100/mcp/', enabled: false },
  { id: 'hmi_agent', name: 'HMI 代理', url: 'http://127.0.0.1:9101/mcp/', enabled: false },
  { id: 'logger_agent', name: '日志代理', url: 'http://127.0.0.1:9102/mcp/', enabled: false },
])

// 对话设置
const chatConfig = ref({
  historyLength: 20,
  contextWindow: 8192,
  streamOutput: true,
  showToolCalls: true,
  showThoughtProcess: true,
  autoScroll: true,
})

// 系统配置
const systemConfig = ref({
  projectPath: 'D:\\Code\\AutoTestDemo\\workspace\\projects',
  autoSave: true,
  debugMode: false,
  logLevel: 'info',
})
</script>

<template>
  <div class="min-h-screen bg-gray-50">
    <header class="h-14 bg-white border-b border-gray-200 flex items-center justify-between px-6">
      <div class="flex items-center gap-2">
        <button @click="$router.push('/')" class="text-sm text-gray-500 hover:text-gray-700">← 返回工作台</button>
      </div>
      <h1 class="text-base font-medium text-gray-900">系统设置</h1>
      <div class="w-8"></div>
    </header>

    <div class="flex max-w-6xl mx-auto p-6 gap-6">
      <!-- 左侧设置菜单 -->
      <aside class="w-48 bg-white rounded-lg border border-gray-200 h-fit sticky top-6">
        <div class="p-2">
          <button
            v-for="tab in tabs"
            :key="tab.id"
            @click="activeTab = tab.id"
            class="w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm mb-0.5"
            :class="activeTab === tab.id ? 'bg-blue-50 text-blue-600 font-medium' : 'text-gray-600 hover:bg-gray-100'"
          >
            <component :is="tab.icon" class="w-4 h-4" />
            {{ tab.name }}
          </button>
        </div>
      </aside>

      <!-- 右侧设置内容 -->
      <main class="flex-1 space-y-6">
        <!-- LLM 配置 -->
        <div v-if="activeTab === 'llm'" class="bg-white rounded-lg border border-gray-200">
          <div class="px-6 py-4 border-b border-gray-200">
            <h2 class="text-base font-medium text-gray-900">大模型配置</h2>
          </div>
          <div class="p-6 space-y-6">
            <!-- 当前提供商 -->
            <div>
              <label class="block text-sm text-gray-700 mb-2">当前提供商</label>
              <select v-model="llmConfig.provider" class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm">
                <option value="changan">长安内部大模型</option>
              </select>
            </div>

            <!-- 提供商详情 -->
            <div class="space-y-4">
              <div>
                <label class="block text-sm text-gray-700 mb-1">API Base URL</label>
                <input v-model="llmConfig.providers[0].baseUrl" type="text" class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" />
              </div>
              <div>
                <label class="block text-sm text-gray-700 mb-1">API Key</label>
                <input v-model="llmConfig.providers[0].apiKey" type="password" class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" />
              </div>
              <div class="grid grid-cols-2 gap-4">
                <div>
                  <label class="block text-sm text-gray-700 mb-1">对话模型 ID</label>
                  <input v-model="llmConfig.providers[0].chatModel" type="text" class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" />
                </div>
                <div>
                  <label class="block text-sm text-gray-700 mb-1">Embedding 模型 ID</label>
                  <input v-model="llmConfig.providers[0].embeddingModel" type="text" class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" />
                </div>
              </div>
            </div>

            <!-- 模型参数 -->
            <div class="border-t border-gray-100 pt-6">
              <h3 class="text-sm font-medium text-gray-900 mb-4">模型参数</h3>
              <div class="space-y-4">
                <div>
                  <label class="block text-sm text-gray-700 mb-1">Temperature: {{ llmConfig.temperature }}</label>
                  <input v-model.number="llmConfig.temperature" type="range" min="0" max="2" step="0.1" class="w-full" />
                </div>
                <div>
                  <label class="block text-sm text-gray-700 mb-1">Max Tokens: {{ llmConfig.maxTokens }}</label>
                  <input v-model.number="llmConfig.maxTokens" type="number" class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" />
                </div>
                <div class="grid grid-cols-2 gap-4">
                  <div>
                    <label class="block text-sm text-gray-700 mb-1">Top P</label>
                    <input v-model.number="llmConfig.topP" type="number" step="0.1" min="0" max="1" class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" />
                  </div>
                  <div>
                    <label class="block text-sm text-gray-700 mb-1">Frequency Penalty</label>
                    <input v-model.number="llmConfig.frequencyPenalty" type="number" step="0.1" min="-2" max="2" class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 记忆系统 -->
        <div v-if="activeTab === 'memory'" class="bg-white rounded-lg border border-gray-200">
          <div class="px-6 py-4 border-b border-gray-200">
            <h2 class="text-base font-medium text-gray-900">记忆系统（Hindsight）</h2>
          </div>
          <div class="p-6 space-y-4">
            <div class="flex items-center justify-between">
              <div>
                <div class="text-sm font-medium text-gray-900">启用 Hindsight 记忆</div>
                <div class="text-xs text-gray-500 mt-0.5">让 AI 记住之前的测试经验和教训</div>
              </div>
              <input v-model="memoryConfig.enabled" type="checkbox" class="w-4 h-4" />
            </div>
            <div>
              <label class="block text-sm text-gray-700 mb-1">Hindsight API URL</label>
              <input v-model="memoryConfig.hindsightUrl" type="text" class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" />
            </div>
            <div class="grid grid-cols-2 gap-4">
              <div class="flex items-center justify-between">
                <span class="text-sm text-gray-700">自动召回记忆</span>
                <input v-model="memoryConfig.autoRecall" type="checkbox" />
              </div>
              <div class="flex items-center justify-between">
                <span class="text-sm text-gray-700">自动保存记忆</span>
                <input v-model="memoryConfig.autoRetain" type="checkbox" />
              </div>
            </div>
            <div class="grid grid-cols-2 gap-4">
              <div>
                <label class="block text-sm text-gray-700 mb-1">召回数量 (Top K)</label>
                <input v-model.number="memoryConfig.recallTopK" type="number" class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" />
              </div>
              <div>
                <label class="block text-sm text-gray-700 mb-1">记忆库名称</label>
                <input v-model="memoryConfig.memoryBank" type="text" class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" />
              </div>
            </div>
          </div>
        </div>

        <!-- Agent 配置 -->
        <div v-if="activeTab === 'agents'" class="bg-white rounded-lg border border-gray-200">
          <div class="px-6 py-4 border-b border-gray-200">
            <h2 class="text-base font-medium text-gray-900">Agent 角色配置</h2>
          </div>
          <div class="p-6">
            <div class="space-y-4">
              <div v-for="agent in agents" :key="agent.id" class="flex items-center justify-between p-3 border border-gray-100 rounded-lg">
                <div class="flex items-center gap-3">
                  <input v-model="agent.enabled" type="checkbox" />
                  <div>
                    <div class="text-sm font-medium text-gray-900">{{ agent.name }}</div>
                    <div class="text-xs text-gray-500">{{ agent.id }}</div>
                  </div>
                </div>
                <div class="flex items-center gap-2">
                  <span class="text-xs text-gray-500">Temperature</span>
                  <input v-model.number="agent.temperature" type="number" step="0.1" min="0" max="2" class="w-20 px-2 py-1 border border-gray-200 rounded text-sm" />
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- MCP 插件 -->
        <div v-if="activeTab === 'mcp'" class="bg-white rounded-lg border border-gray-200">
          <div class="px-6 py-4 border-b border-gray-200">
            <h2 class="text-base font-medium text-gray-900">MCP 服务器</h2>
          </div>
          <div class="p-6">
            <div class="space-y-3">
              <div v-for="server in mcpServers" :key="server.id" class="flex items-center justify-between p-3 border border-gray-100 rounded-lg">
                <div class="flex items-center gap-3">
                  <input v-model="server.enabled" type="checkbox" />
                  <div>
                    <div class="text-sm font-medium text-gray-900">{{ server.name }}</div>
                    <div class="text-xs text-gray-500">{{ server.url }}</div>
                  </div>
                </div>
                <span class="text-xs text-green-500" v-if="server.enabled">已启用</span>
                <span class="text-xs text-gray-400" v-else>未启用</span>
              </div>
            </div>
          </div>
        </div>

        <!-- 对话设置 -->
        <div v-if="activeTab === 'chat'" class="bg-white rounded-lg border border-gray-200">
          <div class="px-6 py-4 border-b border-gray-200">
            <h2 class="text-base font-medium text-gray-900">对话设置</h2>
          </div>
          <div class="p-6 space-y-4">
            <div class="grid grid-cols-2 gap-4">
              <div>
                <label class="block text-sm text-gray-700 mb-1">历史对话长度</label>
                <input v-model.number="chatConfig.historyLength" type="number" class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" />
              </div>
              <div>
                <label class="block text-sm text-gray-700 mb-1">上下文窗口</label>
                <input v-model.number="chatConfig.contextWindow" type="number" class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" />
              </div>
            </div>
            <div class="space-y-3">
              <div class="flex items-center justify-between">
                <span class="text-sm text-gray-700">流式输出</span>
                <input v-model="chatConfig.streamOutput" type="checkbox" />
              </div>
              <div class="flex items-center justify-between">
                <span class="text-sm text-gray-700">显示工具调用过程</span>
                <input v-model="chatConfig.showToolCalls" type="checkbox" />
              </div>
              <div class="flex items-center justify-between">
                <span class="text-sm text-gray-700">显示思考过程</span>
                <input v-model="chatConfig.showThoughtProcess" type="checkbox" />
              </div>
              <div class="flex items-center justify-between">
                <span class="text-sm text-gray-700">自动滚动到底部</span>
                <input v-model="chatConfig.autoScroll" type="checkbox" />
              </div>
            </div>
          </div>
        </div>

        <!-- 系统设置 -->
        <div v-if="activeTab === 'system'" class="bg-white rounded-lg border border-gray-200">
          <div class="px-6 py-4 border-b border-gray-200">
            <h2 class="text-base font-medium text-gray-900">系统设置</h2>
          </div>
          <div class="p-6 space-y-4">
            <div>
              <label class="block text-sm text-gray-700 mb-1">项目工作空间路径</label>
              <input v-model="systemConfig.projectPath" type="text" class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" />
            </div>
            <div class="flex items-center justify-between">
              <span class="text-sm text-gray-700">自动保存</span>
              <input v-model="systemConfig.autoSave" type="checkbox" />
            </div>
            <div class="flex items-center justify-between">
              <span class="text-sm text-gray-700">调试模式</span>
              <input v-model="systemConfig.debugMode" type="checkbox" />
            </div>
            <div>
              <label class="block text-sm text-gray-700 mb-1">日志级别</label>
              <select v-model="systemConfig.logLevel" class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm">
                <option value="debug">Debug</option>
                <option value="info">Info</option>
                <option value="warn">Warn</option>
                <option value="error">Error</option>
              </select>
            </div>
          </div>
        </div>

        <!-- 保存按钮 -->
        <div class="flex justify-end">
          <button class="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700">
            <Save class="w-4 h-4" />
            保存设置
          </button>
        </div>
      </main>
    </div>
  </div>
</template>
