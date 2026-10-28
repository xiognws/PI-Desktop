<script setup lang="ts">
import { ref } from 'vue'
import { Search, Lightbulb } from 'lucide-vue-next'

const knowledge = ref([
  { id: 1, title: '发动机启动转速测试经验', type: '测试用例', project: '长安深蓝 S7 ECU 测试', summary: '怠速转速应稳定在 800±50rpm，冷启动时可能偏高...', time: '2026-10-10' },
  { id: 2, title: 'DTC 读取失败修复方案', type: '脚本修复', project: '长安深蓝 S7 ECU 测试', summary: 'UDS 0x22 服务读取 DTC 失败，原因是会话未切换到扩展会话...', time: '2026-10-08' },
  { id: 3, title: '座舱蓝牙连接测试最佳实践', type: '测试用例', project: '阿维塔 12 座舱测试', summary: '蓝牙搜索设备列表加载时间应 < 3 秒，需断言列表项数量...', time: '2026-10-05' },
])

const searchText = ref('')
</script>

<template>
  <div class="min-h-screen bg-gray-50">
    <header class="h-14 bg-white border-b border-gray-200 flex items-center justify-between px-6">
      <div class="flex items-center gap-2">
        <button @click="$router.push('/')" class="text-sm text-gray-500 hover:text-gray-700">← 返回工作台</button>
      </div>
      <h1 class="text-base font-medium text-gray-900">知识库</h1>
      <div class="w-8"></div>
    </header>

    <div class="max-w-5xl mx-auto p-8">
      <div class="relative mb-6 max-w-xl">
        <Search class="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
        <input
          v-model="searchText"
          type="text"
          placeholder="搜索历史经验、用例、修复方案..."
          class="w-full pl-9 pr-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      <div class="space-y-4">
        <div v-for="k in knowledge" :key="k.id" class="bg-white rounded-lg border border-gray-200 p-5">
          <div class="flex items-center gap-2 mb-2">
            <Lightbulb class="w-4 h-4 text-yellow-500" />
            <span class="font-medium text-gray-900">{{ k.title }}</span>
            <span class="text-xs px-2 py-0.5 rounded bg-blue-50 text-blue-600">{{ k.type }}</span>
          </div>
          <p class="text-sm text-gray-600 mb-3">{{ k.summary }}</p>
          <div class="flex items-center justify-between text-xs text-gray-400">
            <span>{{ k.project }}</span>
            <span>{{ k.time }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
