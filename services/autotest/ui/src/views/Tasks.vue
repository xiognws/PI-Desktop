<script setup lang="ts">
import { ref } from 'vue'
import { PlayCircle, CheckCircle, XCircle } from 'lucide-vue-next'

const tasks = ref([
  { id: 1, name: '发动机控制模块用例生成', type: 'AI 生成', project: '长安深蓝 S7 ECU 测试', progress: 65, status: 'running', created: '2026-10-14 14:30' },
  { id: 2, name: '座舱蓝牙连接测试执行', type: '执行', project: '阿维塔 12 座舱测试', progress: 100, status: 'completed', created: '2026-10-14 10:15' },
  { id: 3, name: 'DTC 读取脚本自动修复', type: 'AI 修复', project: '长安深蓝 S7 ECU 测试', progress: 100, status: 'completed', created: '2026-10-13 16:45' },
  { id: 4, name: '数字仪表显示测试', type: '执行', project: '阿维塔 12 座舱测试', progress: 100, status: 'failed', created: '2026-10-13 14:20' },
])

const statusMap: Record<string, { label: string; class: string; icon: any }> = {
  running: { label: '执行中', class: 'bg-blue-50 text-blue-600', icon: PlayCircle },
  completed: { label: '已完成', class: 'bg-green-50 text-green-600', icon: CheckCircle },
  failed: { label: '失败', class: 'bg-red-50 text-red-600', icon: XCircle },
}
</script>

<template>
  <div class="min-h-screen bg-gray-50">
    <header class="h-14 bg-white border-b border-gray-200 flex items-center justify-between px-6">
      <div class="flex items-center gap-2">
        <button @click="$router.push('/')" class="text-sm text-gray-500 hover:text-gray-700">← 返回工作台</button>
      </div>
      <h1 class="text-base font-medium text-gray-900">任务管理</h1>
      <div class="w-8"></div>
    </header>

    <div class="max-w-5xl mx-auto p-8">
      <div class="bg-white rounded-lg border border-gray-200">
        <div class="divide-y divide-gray-100">
          <div v-for="t in tasks" :key="t.id" class="p-5">
            <div class="flex items-center justify-between mb-3">
              <div class="flex items-center gap-3">
                <span class="text-sm font-medium text-gray-900">{{ t.name }}</span>
                <span class="text-xs px-2 py-0.5 rounded"
                  :class="statusMap[t.status].class">
                  {{ statusMap[t.status].label }}
                </span>
              </div>
              <span class="text-xs text-gray-400">{{ t.created }}</span>
            </div>
            <div class="flex items-center gap-4 text-sm text-gray-500">
              <span>{{ t.type }}</span>
              <span>{{ t.project }}</span>
            </div>
            <div v-if="t.status === 'running'" class="mt-3">
              <div class="h-2 bg-gray-100 rounded-full overflow-hidden">
                <div class="h-full bg-blue-600" :style="{ width: `${t.progress}%` }"></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
