<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { Calendar, Play, Plus, Clock } from 'lucide-vue-next'

const route = useRoute()
const projectId = route.params.projectId as string

const plans = ref<any[]>([])

async function loadPlans() {
  try {
    const res = await fetch(`/api/projects/${projectId}/plans`)
    const data = await res.json()
    plans.value = data.plans || []
  } catch (e) {
    console.error('加载计划失败', e)
  }
}

onMounted(() => {
  loadPlans()
})

// 新建计划对话框
const createDialogOpen = ref(false)
const newPlan = ref({
  name: '',
  description: '',
  cron: '0 8 * * *',
})

async function createPlan() {
  if (!newPlan.value.name) {
    alert('请输入计划名称')
    return
  }
  try {
    const res = await fetch(`/api/projects/${projectId}/plans`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newPlan.value),
    })
    const data = await res.json()
    plans.value.unshift(data)
    createDialogOpen.value = false
    newPlan.value = { name: '', description: '', cron: '0 8 * * *' }
  } catch (e) {
    console.error('创建计划失败', e)
    alert('创建失败')
  }
}
</script>

<template>
  <div class="flex-1 flex flex-col overflow-auto bg-white">
    <div class="p-6">
      <div class="flex items-center justify-between mb-6">
        <div>
          <h2 class="text-lg font-medium text-gray-900">测试计划</h2>
          <p class="text-sm text-gray-500 mt-1">配置定时执行计划，自动回归测试</p>
        </div>
        <button @click="createDialogOpen = true" class="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700">
          <Plus class="w-4 h-4" />
          新建计划
        </button>
      </div>

      <div class="grid grid-cols-2 gap-4">
        <div v-for="p in plans" :key="p.id" class="bg-gray-50 rounded-lg border border-gray-200 p-5">
          <div class="flex items-center justify-between mb-3">
            <h3 class="font-medium text-gray-900">{{ p.name }}</h3>
            <span class="text-xs px-2 py-0.5 rounded"
              :class="p.status === 'enabled' ? 'bg-green-50 text-green-600' : 'bg-gray-100 text-gray-500'">
              {{ p.status === 'enabled' ? '已启用' : '已停用' }}
            </span>
          </div>
          <p class="text-sm text-gray-500 mb-4">{{ p.description }}</p>

          <div class="space-y-2 text-sm text-gray-600 mb-4">
            <div class="flex items-center gap-2">
              <Clock class="w-4 h-4 text-gray-400" />
              <span class="text-xs text-gray-500">{{ p.cron === '手动' ? '手动触发' : `定时：${p.cron}` }}</span>
            </div>
            <div class="flex items-center gap-2">
              <Calendar class="w-4 h-4 text-gray-400" />
              <span class="text-xs text-gray-500">{{ p.last_run }}</span>
            </div>
          </div>

          <div class="flex items-center justify-between pt-3 border-t border-gray-100">
            <span class="text-sm text-gray-500">{{ p.case_count }} 条用例 · {{ p.last_result }}</span>
            <button class="flex items-center gap-1.5 text-sm text-blue-600 hover:underline">
              <Play class="w-4 h-4" />
              立即执行
            </button>
          </div>
        </div>
      </div>

      <div v-if="plans.length === 0" class="text-center py-12 text-gray-400 text-sm">
        暂无测试计划，点击右上角"新建计划"创建
      </div>
    </div>

    <!-- 新建计划对话框 -->
    <div v-if="createDialogOpen" class="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div class="bg-white rounded-lg p-6 w-96">
        <h3 class="text-lg font-medium text-gray-900 mb-4">新建测试计划</h3>
        <div class="space-y-4">
          <div>
            <label class="block text-sm text-gray-700 mb-1">计划名称</label>
            <input v-model="newPlan.name" type="text" class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" placeholder="比如：发动机模块每日回归测试" />
          </div>
          <div>
            <label class="block text-sm text-gray-700 mb-1">计划描述</label>
            <textarea v-model="newPlan.description" class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" rows="3" placeholder="简单描述一下这个计划..."></textarea>
          </div>
          <div>
            <label class="block text-sm text-gray-700 mb-1">定时规则 (cron 表达式)</label>
            <input v-model="newPlan.cron" type="text" class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm font-mono" placeholder="0 8 * * *" />
            <p class="text-xs text-gray-400 mt-1">格式：分 时 日 月 周，比如每天 8 点：0 8 * * *</p>
          </div>
        </div>
        <div class="flex gap-3 mt-6">
          <button @click="createDialogOpen = false" class="flex-1 px-4 py-2 border border-gray-200 rounded-lg text-sm hover:bg-gray-50">取消</button>
          <button @click="createPlan" class="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700">创建</button>
        </div>
      </div>
    </div>
  </div>
</template>
