<script setup lang="ts">
import { ref } from 'vue'
import { Bug, Plus, Filter } from 'lucide-vue-next'

const defects = ref([
  { id: 1, title: '点火提前角调整延迟超标', case: '急加速爆震传感器测试', status: '待处理', priority: '高', foundTime: '2026-10-14 15:30', foundBy: 'AI 自动发现' },
  { id: 2, title: '怠速转速波动超出范围', case: '冷启动怠速稳定性测试', status: '修复中', priority: '中', foundTime: '2026-10-14 14:20', foundBy: 'AI 自动发现' },
  { id: 3, title: 'DTC 读取超时', case: 'OBD 故障码读取测试', status: '已关闭', priority: '低', foundTime: '2026-10-13 16:00', foundBy: '手动提交' },
])

const statusMap: Record<string, { label: string; class: string }> = {
  '待处理': { label: '待处理', class: 'bg-red-50 text-red-600' },
  '修复中': { label: '修复中', class: 'bg-yellow-50 text-yellow-600' },
  '已关闭': { label: '已关闭', class: 'bg-green-50 text-green-600' },
}

const priorityMap: Record<string, string> = {
  '高': 'bg-red-50 text-red-600',
  '中': 'bg-yellow-50 text-yellow-600',
  '低': 'bg-gray-100 text-gray-600',
}
</script>

<template>
  <div class="flex-1 flex flex-col overflow-auto p-6">
    <div class="flex items-center justify-between mb-6">
      <div>
        <h2 class="text-lg font-medium text-gray-900">缺陷管理</h2>
        <p class="text-sm text-gray-500 mt-1">跟踪测试中发现的缺陷，从发现到修复全流程管理</p>
      </div>
      <div class="flex gap-2">
        <button class="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-gray-200 rounded-lg hover:bg-gray-50">
          <Filter class="w-4 h-4" />
          筛选
        </button>
        <button class="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700">
          <Plus class="w-4 h-4" />
          新建缺陷
        </button>
      </div>
    </div>

    <!-- 统计卡片 -->
    <div class="grid grid-cols-4 gap-4 mb-6">
      <div class="bg-white rounded-lg border border-gray-200 p-4">
        <div class="text-2xl font-semibold text-gray-900">{{ defects.length }}</div>
        <div class="text-sm text-gray-500 mt-1">总缺陷数</div>
      </div>
      <div class="bg-white rounded-lg border border-gray-200 p-4">
        <div class="text-2xl font-semibold text-red-600">{{ defects.filter(d => d.status === '待处理').length }}</div>
        <div class="text-sm text-gray-500 mt-1">待处理</div>
      </div>
      <div class="bg-white rounded-lg border border-gray-200 p-4">
        <div class="text-2xl font-semibold text-yellow-600">{{ defects.filter(d => d.status === '修复中').length }}</div>
        <div class="text-sm text-gray-500 mt-1">修复中</div>
      </div>
      <div class="bg-white rounded-lg border border-gray-200 p-4">
        <div class="text-2xl font-semibold text-green-600">{{ defects.filter(d => d.status === '已关闭').length }}</div>
        <div class="text-sm text-gray-500 mt-1">已关闭</div>
      </div>
    </div>

    <!-- 缺陷列表 -->
    <div class="bg-white rounded-lg border border-gray-200">
      <div class="divide-y divide-gray-100">
        <div v-for="d in defects" :key="d.id" class="p-5 hover:bg-gray-50">
          <div class="flex items-center justify-between mb-2">
            <div class="flex items-center gap-3">
              <Bug class="w-5 h-5 text-red-500" />
              <span class="font-medium text-gray-900">{{ d.title }}</span>
              <span class="text-xs px-2 py-0.5 rounded" :class="statusMap[d.status].class">{{ statusMap[d.status].label }}</span>
            </div>
            <span class="text-xs text-gray-400">{{ d.foundTime }}</span>
          </div>
          <div class="flex items-center gap-4 text-sm text-gray-500 ml-8">
            <span>关联用例：{{ d.case }}</span>
            <span class="text-xs px-2 py-0.5 rounded" :class="priorityMap[d.priority]">{{ d.priority }}优先级</span>
            <span>发现方式：{{ d.foundBy }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
