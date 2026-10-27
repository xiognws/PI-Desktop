<script setup lang="ts">
import { ref } from 'vue'
import { GitBranch, CheckCircle, Circle } from 'lucide-vue-next'

const matrix = ref([
  {
    requirement: 'REQ-001 发动机怠速转速稳定性',
    module: '发动机控制',
    cases: [
      { id: 1, name: '冷启动怠速测试', covered: true },
      { id: 2, name: '热怠速波动测试', covered: true },
      { id: 3, name: '空调开启后怠速补偿测试', covered: false },
    ],
  },
  {
    requirement: 'REQ-002 油门踏板响应延迟',
    module: '发动机控制',
    cases: [
      { id: 4, name: '急加速响应测试', covered: true },
      { id: 5, name: '缓加速响应测试', covered: true },
    ],
  },
  {
    requirement: 'REQ-003 DTC 故障码读取',
    module: '发动机控制',
    cases: [
      { id: 6, name: '正常 DTC 读取测试', covered: true },
      { id: 7, name: '扩展会话 DTC 读取测试', covered: false },
    ],
  },
])
</script>

<template>
  <div class="flex-1 flex flex-col overflow-auto bg-white">
    <div class="p-6">
      <div class="mb-6">
        <h2 class="text-lg font-medium text-gray-900 flex items-center gap-2">
          <GitBranch class="w-5 h-5 text-blue-600" />
          需求追踪矩阵
        </h2>
        <p class="text-sm text-gray-500 mt-1">需求 → 用例的双向映射关系，分析覆盖盲区</p>
      </div>

      <div class="bg-gray-50 rounded-lg border border-gray-200">
        <div class="divide-y divide-gray-100">
          <div v-for="(item, i) in matrix" :key="i" class="p-5">
            <!-- 需求行 -->
            <div class="flex items-center justify-between mb-4">
              <div>
                <div class="font-medium text-gray-900">{{ item.requirement }}</div>
                <div class="text-xs text-gray-500 mt-1">{{ item.module }}</div>
              </div>
              <div class="text-sm text-gray-500">
                覆盖率 {{ Math.round(item.cases.filter(c => c.covered).length / item.cases.length * 100) }}%
              </div>
            </div>

            <!-- 关联用例 -->
            <div class="ml-6 space-y-2">
              <div v-for="c in item.cases" :key="c.id" class="flex items-center gap-3 text-sm">
                <CheckCircle v-if="c.covered" class="w-4 h-4 text-green-600" />
                <Circle v-else class="w-4 h-4 text-gray-300" />
                <span :class="c.covered ? 'text-gray-900' : 'text-gray-400'">{{ c.name }}</span>
                <span v-if="!c.covered" class="text-xs px-2 py-0.5 rounded bg-yellow-50 text-yellow-600">未覆盖</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
