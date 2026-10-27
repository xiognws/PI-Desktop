<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { PlayCircle } from 'lucide-vue-next'

const route = useRoute()
const router = useRouter()
const projectId = route.params.projectId as string

const executions = ref<any[]>([])

function openExecution(id: number) {
  router.push({ name: 'ExecutionDetail', params: { projectId, id } })
}

function statusClass(status: string) {
  if (status === '执行中') return 'bg-blue-50 text-blue-600'
  if (status === '已完成') return 'bg-green-50 text-green-600'
  if (status === '已取消') return 'bg-amber-50 text-amber-600'
  return 'bg-red-50 text-red-600'
}

async function loadExecutions() {
  try {
    const res = await fetch(`/api/projects/${projectId}/executions`)
    const data = await res.json()
    executions.value = data.executions || []
  } catch (e) {
    console.error('加载执行记录失败', e)
  }
}

onMounted(() => {
  loadExecutions()
})
</script>

<template>
  <div class="flex-1 flex flex-col overflow-hidden">
    <div class="bg-white border-b border-gray-200 px-6 py-3">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-3">
          <h2 class="text-base font-medium text-gray-900">执行记录</h2>
          <span class="text-sm text-gray-400">共 {{ executions.length }} 次</span>
        </div>
      </div>
    </div>

    <div class="flex-1 overflow-auto bg-white">
      <div class="p-6 space-y-4">
        <div v-for="e in executions" :key="e.id"
          class="bg-gray-50 rounded-lg border border-gray-200 p-5 cursor-pointer hover:border-blue-300"
          @click="openExecution(e.id)">
          <div class="flex items-center justify-between mb-3">
            <div class="flex items-center gap-2">
              <PlayCircle class="w-5 h-5 text-blue-600" />
              <span class="font-medium text-gray-900">{{ e.name }}</span>
              <span class="text-xs px-2 py-0.5 rounded" :class="statusClass(e.status)">
                {{ e.status }}
              </span>
              <span v-if="e.executor" class="text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-500">{{ e.executor }}</span>
            </div>
            <span class="text-xs text-gray-400">{{ e.started_at ?? '' }}</span>
          </div>

          <div class="flex items-center gap-6 text-sm text-gray-600">
            <span>总共 {{ e.total }} 条</span>
            <span class="text-green-600">通过 {{ e.passed }}</span>
            <span class="text-red-600">失败 {{ e.failed }}</span>
            <span v-if="e.running > 0" class="text-blue-600">执行中 {{ e.running }}</span>
          </div>

          <div class="mt-3 h-2 bg-gray-200 rounded-full overflow-hidden">
            <div class="h-full bg-green-500" :style="{ width: `${(e.passed / e.total) * 100}%` }"></div>
          </div>
        </div>

        <div v-if="executions.length === 0" class="text-center py-12 text-gray-400 text-sm">
          暂无执行记录
        </div>
      </div>
    </div>
  </div>
</template>
