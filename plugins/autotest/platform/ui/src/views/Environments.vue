<script setup lang="ts">
import { ref } from 'vue'
import { Server, Plus } from 'lucide-vue-next'

const environments = ref([
  {
    id: 1,
    name: '长安深蓝 S7 实车环境',
    type: '实车',
    ip: '192.168.1.100',
    port: 8888,
    canChannel: 'CAN1',
    status: 'online',
    description: '深蓝 S7 实车测试环境，连接 CAN 分析仪',
  },
  {
    id: 2,
    name: '台架测试环境',
    type: '台架',
    ip: '192.168.1.200',
    port: 8888,
    canChannel: 'CAN0',
    status: 'online',
    description: '发动机+变速箱台架，可模拟各种工况',
  },
  {
    id: 3,
    name: '仿真环境',
    type: '仿真',
    ip: '127.0.0.1',
    port: 9000,
    canChannel: '虚拟CAN',
    status: 'offline',
    description: 'CarSim 仿真环境，用于回归测试',
  },
])
</script>

<template>
  <div class="flex-1 flex flex-col overflow-auto p-6">
    <div class="flex items-center justify-between mb-6">
      <div>
        <h2 class="text-lg font-medium text-gray-900">测试环境配置</h2>
        <p class="text-sm text-gray-500 mt-1">管理被测系统的连接环境，实车/台架/仿真</p>
      </div>
      <button class="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700">
        <Plus class="w-4 h-4" />
        新增环境
      </button>
    </div>

    <div class="grid grid-cols-2 gap-4">
      <div v-for="env in environments" :key="env.id" class="bg-white rounded-lg border border-gray-200 p-5">
        <div class="flex items-center justify-between mb-3">
          <div class="flex items-center gap-3">
            <div class="w-10 h-10 rounded-lg bg-blue-50 flex items-center justify-center">
              <Server class="w-5 h-5 text-blue-600" />
            </div>
            <div>
              <h3 class="font-medium text-gray-900">{{ env.name }}</h3>
              <span class="text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-600">{{ env.type }}</span>
            </div>
          </div>
          <span class="flex items-center gap-1.5 text-xs px-2 py-1 rounded"
            :class="env.status === 'online' ? 'bg-green-50 text-green-600' : 'bg-gray-100 text-gray-500'">
            <span class="w-1.5 h-1.5 rounded-full" :class="env.status === 'online' ? 'bg-green-500' : 'bg-gray-400'"></span>
            {{ env.status === 'online' ? '已连接' : '未连接' }}
          </span>
        </div>

        <p class="text-sm text-gray-500 mb-4">{{ env.description }}</p>

        <div class="space-y-2 text-sm text-gray-600 mb-4">
          <div class="flex justify-between">
            <span class="text-gray-400">IP 地址</span>
            <span class="font-mono">{{ env.ip }}:{{ env.port }}</span>
          </div>
          <div class="flex justify-between">
            <span class="text-gray-400">CAN 通道</span>
            <span>{{ env.canChannel }}</span>
          </div>
        </div>

        <div class="flex gap-2 pt-3 border-t border-gray-100">
          <button class="flex-1 px-3 py-1.5 text-sm border border-gray-200 rounded-lg hover:bg-gray-50">
            编辑
          </button>
          <button v-if="env.status === 'offline'" class="flex-1 px-3 py-1.5 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700">
            连接
          </button>
          <button v-else class="flex-1 px-3 py-1.5 text-sm border border-red-200 text-red-600 rounded-lg hover:bg-red-50">
            断开
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
