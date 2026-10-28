<script setup lang="ts">
import { ref } from 'vue'
import { Search, Download } from 'lucide-vue-next'

const logs = ref([
  { time: '2026-10-14 14:32:15', level: 'INFO', module: 'Pipeline', message: '开始执行测试流水线：发动机控制模块回归测试' },
  { time: '2026-10-14 14:32:16', level: 'INFO', module: 'RequirementAnalyst', message: '正在分析需求文档：发动机怠速稳定性要求...' },
  { time: '2026-10-14 14:32:18', level: 'INFO', module: 'Hindsight', message: 'Recall 到 3 条相似历史用例' },
  { time: '2026-10-14 14:32:25', level: 'INFO', module: 'TestDesigner', message: '生成 5 条测试用例，覆盖正常/异常/边界场景' },
  { time: '2026-10-14 14:32:30', level: 'INFO', module: 'ScriptEngineer', message: '生成 pytest 脚本：test_engine_idle.py' },
  { time: '2026-10-14 14:32:35', level: 'INFO', module: 'Executor', message: '开始执行脚本...' },
  { time: '2026-10-14 14:32:45', level: 'WARN', module: 'Judge', message: '用例 3 执行失败：点火提前角调整延迟 120ms，超出预期 100ms' },
  { time: '2026-10-14 14:32:46', level: 'INFO', module: 'Repairer', message: '正在分析失败原因，尝试修复脚本...' },
  { time: '2026-10-14 14:32:50', level: 'INFO', module: 'Repairer', message: '修复完成，重新执行用例 3...' },
  { time: '2026-10-14 14:32:55', level: 'INFO', module: 'Executor', message: '重新执行成功' },
  { time: '2026-10-14 14:33:00', level: 'INFO', module: 'Reporter', message: '生成测试报告：通过率 83.3%' },
  { time: '2026-10-14 14:33:01', level: 'INFO', module: 'Hindsight', message: 'Retain 本次执行经验到知识库' },
])

const levelClass: Record<string, string> = {
  INFO: 'bg-blue-50 text-blue-600',
  WARN: 'bg-yellow-50 text-yellow-600',
  ERROR: 'bg-red-50 text-red-600',
  DEBUG: 'bg-gray-100 text-gray-500',
}
</script>

<template>
  <div class="flex-1 flex flex-col overflow-hidden">
    <div class="bg-white border-b border-gray-200 px-6 py-3">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-3">
          <h2 class="text-base font-medium text-gray-900">系统日志</h2>
          <span class="text-sm text-gray-400">共 {{ logs.length }} 条</span>
        </div>
        <div class="flex items-center gap-2">
          <div class="relative">
            <Search class="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input type="text" placeholder="搜索日志..." class="pl-9 pr-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <button class="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-gray-200 rounded-lg hover:bg-gray-50">
            <Download class="w-4 h-4" />
            导出
          </button>
        </div>
      </div>
    </div>

    <div class="flex-1 overflow-auto p-6">
      <div class="bg-white rounded-lg border border-gray-200 p-4 font-mono text-xs">
        <div v-for="(log, i) in logs" :key="i" class="flex gap-3 py-1.5 hover:bg-gray-50">
          <span class="text-gray-400 flex-shrink-0">{{ log.time }}</span>
          <span class="px-1.5 rounded flex-shrink-0" :class="levelClass[log.level]">{{ log.level }}</span>
          <span class="text-blue-600 flex-shrink-0 w-28">{{ log.module }}</span>
          <span class="text-gray-700">{{ log.message }}</span>
        </div>
      </div>
    </div>
  </div>
</template>
