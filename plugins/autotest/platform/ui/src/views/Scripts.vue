<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Plus, Code2, Play } from 'lucide-vue-next'

const route = useRoute()
const router = useRouter()
const projectId = route.params.projectId as string

const scripts = ref<any[]>([])

async function loadScripts() {
  try {
    const res = await fetch(`/api/projects/${projectId}/scripts`)
    const data = await res.json()
    scripts.value = data.scripts || []
  } catch (e) {
    console.error('加载脚本失败', e)
  }
}

onMounted(() => {
  loadScripts()
})

function openEdit(s: any) {
  router.push(`/project/${projectId}/scripts/${s.id}/edit`)
}
</script>

<template>
  <div class="flex-1 flex flex-col overflow-hidden">
    <div class="bg-white border-b border-gray-200 px-6 py-3">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-3">
          <h2 class="text-base font-medium text-gray-900">测试脚本</h2>
          <span class="text-sm text-gray-400">共 {{ scripts.length }} 个</span>
        </div>
        <button class="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-gray-200 rounded-lg hover:bg-gray-50">
          <Plus class="w-4 h-4" />
          新建脚本
        </button>
      </div>
    </div>

    <div class="flex-1 overflow-auto bg-white">
      <div class="p-6 grid grid-cols-3 gap-4">
        <div v-for="s in scripts" :key="s.id" class="bg-gray-50 rounded-lg border border-gray-200 p-5 hover:shadow-md transition-shadow">
          <div class="flex items-center gap-2 mb-3">
            <Code2 class="w-5 h-5 text-blue-600" />
            <span class="font-medium text-gray-900 text-sm">{{ s.name }}</span>
          </div>
          <p class="text-xs text-gray-500 mb-2">关联用例：{{ s.case_id || '未关联' }}</p>
          <div class="flex items-center justify-between">
            <span class="text-xs px-2 py-0.5 rounded"
              :class="s.status === '就绪' ? 'bg-green-50 text-green-600' : 'bg-yellow-50 text-yellow-600'">
              {{ s.status }}
            </span>
            <span class="text-xs text-gray-400">{{ s.language }}</span>
          </div>
          <div class="mt-4 flex gap-2">
            <button @click="openEdit(s)" class="flex-1 px-3 py-1.5 text-xs border border-gray-200 rounded hover:bg-gray-100">编辑</button>
            <button class="flex-1 px-3 py-1.5 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 flex items-center justify-center gap-1">
              <Play class="w-3 h-3" />
              运行
            </button>
          </div>
        </div>

        <div v-if="scripts.length === 0" class="col-span-3 text-center py-12 text-gray-400 text-sm">
          暂无测试脚本，点击右上角"新建脚本"创建
        </div>
      </div>
    </div>
  </div>
</template>
