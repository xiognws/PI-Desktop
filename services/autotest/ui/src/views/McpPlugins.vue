<script setup lang="ts">
import { ref } from 'vue'
import { Plug, CheckCircle, XCircle, RefreshCw } from 'lucide-vue-next'

const mcpServers = ref([
  {
    id: 'hindsight',
    name: 'Hindsight 记忆服务',
    url: 'http://127.0.0.1:8889/mcp/',
    status: 'running',
    tools: 12,
    description: '长期记忆存储与检索',
  },
  {
    id: 'can_agent',
    name: 'CAN 总线测试服务',
    url: 'http://127.0.0.1:9100/mcp/',
    status: 'running',
    tools: 8,
    description: 'CAN 帧收发、UDS 诊断、DTC 读取',
  },
  {
    id: 'hmi_agent',
    name: '座舱 HMI 测试服务',
    url: 'http://127.0.0.1:9101/mcp/',
    status: 'stopped',
    tools: 15,
    description: '座舱 UI 自动化操作、视觉断言',
  },
  {
    id: 'logger_agent',
    name: '日志采集服务',
    url: 'http://127.0.0.1:9102/mcp/',
    status: 'running',
    tools: 5,
    description: 'DLT 日志采集、trace 抓取',
  },
])
</script>

<template>
  <div class="flex-1 flex flex-col overflow-auto p-6">
    <div class="flex items-center justify-between mb-6">
      <div>
        <h2 class="text-lg font-medium text-gray-900">MCP 插件管理</h2>
        <p class="text-sm text-gray-500 mt-1">管理本地 MCP 测试服务，启停和状态监控</p>
      </div>
      <button class="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700">
        <Plus class="w-4 h-4" />
        添加插件
      </button>
    </div>

    <div class="space-y-4">
      <div v-for="s in mcpServers" :key="s.id" class="bg-white rounded-lg border border-gray-200 p-5">
        <div class="flex items-center justify-between mb-3">
          <div class="flex items-center gap-3">
            <div class="w-10 h-10 rounded-lg bg-blue-50 flex items-center justify-center">
              <Plug class="w-5 h-5 text-blue-600" />
            </div>
            <div>
              <h3 class="font-medium text-gray-900">{{ s.name }}</h3>
              <p class="text-xs text-gray-500">{{ s.description }}</p>
            </div>
          </div>
          <span class="flex items-center gap-1.5 text-xs px-2 py-1 rounded"
            :class="s.status === 'running' ? 'bg-green-50 text-green-600' : 'bg-gray-100 text-gray-500'">
            <CheckCircle v-if="s.status === 'running'" class="w-3.5 h-3.5" />
            <XCircle v-else class="w-3.5 h-3.5" />
            {{ s.status === 'running' ? '运行中' : '已停止' }}
          </span>
        </div>

        <div class="flex items-center justify-between text-sm text-gray-500 mb-4">
          <span class="font-mono text-xs">{{ s.url }}</span>
          <span>{{ s.tools }} 个工具</span>
        </div>

        <div class="flex gap-2">
          <button class="px-3 py-1.5 text-sm border border-gray-200 rounded-lg hover:bg-gray-50">
            查看工具
          </button>
          <button v-if="s.status === 'stopped'" class="px-3 py-1.5 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700">
            启动
          </button>
          <button v-else class="px-3 py-1.5 text-sm border border-red-200 text-red-600 rounded-lg hover:bg-red-50">
            停止
          </button>
          <button class="flex items-center gap-1 px-3 py-1.5 text-sm border border-gray-200 rounded-lg hover:bg-gray-50">
            <RefreshCw class="w-3.5 h-3.5" />
            重启
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
