<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import {
  Cpu,
  Plus,
  FileText,
  ListChecks,
  PlayCircle,
} from 'lucide-vue-next'

const router = useRouter()

// 统计与项目列表：全部来自后端真实数据。
// 计数不再读 project.json 的 case_count / execution_count —— 那两个字段只在
// 建项目时写成 0，之后没有任何回写，首页因此永远显示「0 用例 / 0 次执行」。
// 现在按项目逐个问 /case-stats，由后端从项目库现算。
const stats = ref({
  totalProjects: 0,
  totalCases: 0,
  totalExecutions: 0,
})

const projects = ref<any[]>([])

// 新建项目对话框
const createDialogOpen = ref(false)
const newProject = ref({
  name: '',
  description: '',
  type: 'ECU',
})

type Stats = { case_count: number; execution_count: number }

async function loadProjects() {
  try {
    const res = await fetch('/api/projects')
    const data = await res.json()
    projects.value = data.projects || []
    stats.value.totalProjects = projects.value.length

    const counts = await Promise.all(
      projects.value.map(async (p: any) => {
        try {
          const r = await fetch(`/api/projects/${p.id}/case-stats`)
          if (!r.ok) return { case_count: 0, execution_count: 0 }
          return (await r.json()) as Stats
        } catch {
          return { case_count: 0, execution_count: 0 }
        }
      }),
    )
    stats.value.totalCases = counts.reduce((sum, c) => sum + (c.case_count || 0), 0)
    stats.value.totalExecutions = counts.reduce(
      (sum, c) => sum + (c.execution_count || 0),
      0,
    )
    projects.value = projects.value.map((p: any, i: number) => ({
      ...p,
      case_count: counts[i].case_count,
      execution_count: counts[i].execution_count,
    }))
  } catch (e) {
    console.error('加载项目失败', e)
  }
}

async function createProject() {
  if (!newProject.value.name) return
  try {
    const res = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newProject.value),
    })
    const data = await res.json()
    projects.value.unshift(data)
    createDialogOpen.value = false
    newProject.value = { name: '', description: '', type: 'ECU' }
  } catch (e) {
    console.error('创建项目失败', e)
    alert('创建项目失败')
  }
}

onMounted(() => {
  loadProjects()
})

function enterProject(id: string) {
  router.push(`/project/${id}`)
}
</script>

<template>
  <div class="min-h-screen bg-gray-50">
    <!-- 顶部栏 -->
    <header class="h-14 bg-white border-b border-gray-200 flex items-center justify-between px-6">
      <div class="flex items-center gap-2">
        <Cpu class="w-5 h-5 text-blue-600" />
        <span class="font-semibold text-gray-900">自动化测试平台</span>
      </div>
      <div class="flex items-center gap-4">
        <div class="w-8 h-8 rounded-full bg-blue-600 text-white flex items-center justify-center text-sm">测</div>
      </div>
    </header>

    <div class="max-w-7xl mx-auto p-8">
      <!-- 页面标题 -->
      <div class="mb-8">
        <h1 class="text-2xl font-semibold text-gray-900">我的测试工作台</h1>
        <p class="text-sm text-gray-500 mt-1">ECU / 座舱自动化测试 · 用例、脚本、执行与报告</p>
      </div>

      <!-- 统计卡片 -->
      <div class="grid grid-cols-4 gap-4 mb-8">
        <div class="bg-white rounded-lg border border-gray-200 p-5">
          <div class="flex items-center justify-between mb-2">
            <span class="text-sm text-gray-500">项目数</span>
            <FileText class="w-4 h-4 text-blue-600" />
          </div>
          <div class="text-2xl font-semibold text-gray-900">{{ stats.totalProjects }}</div>
        </div>
        <div class="bg-white rounded-lg border border-gray-200 p-5">
          <div class="flex items-center justify-between mb-2">
            <span class="text-sm text-gray-500">测试用例</span>
            <ListChecks class="w-4 h-4 text-green-600" />
          </div>
          <div class="text-2xl font-semibold text-gray-900">{{ stats.totalCases }}</div>
        </div>
        <div class="bg-white rounded-lg border border-gray-200 p-5">
          <div class="flex items-center justify-between mb-2">
            <span class="text-sm text-gray-500">执行次数</span>
            <PlayCircle class="w-4 h-4 text-orange-600" />
          </div>
          <div class="text-2xl font-semibold text-gray-900">{{ stats.totalExecutions }}</div>
        </div>
      </div>

      <div class="grid grid-cols-1 gap-6">
        <!-- 项目列表 -->
        <div class="col-span-2">
          <div class="flex items-center justify-between mb-4">
            <h2 class="text-base font-medium text-gray-900">我的项目</h2>
            <button @click="createDialogOpen = true" class="flex items-center gap-2 px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">
              <Plus class="w-4 h-4" />
              新建项目
            </button>
          </div>

          <div class="space-y-3">
            <div
              v-for="p in projects"
              :key="p.id"
              @click="enterProject(p.id)"
              class="bg-white rounded-lg border border-gray-200 p-5 cursor-pointer hover:shadow-md transition-shadow"
            >
              <div class="flex items-center justify-between mb-2">
                <div class="flex items-center gap-3">
                  <div :class="['w-10 h-10 rounded-lg flex items-center justify-center text-white', p.color]">
                    <Cpu class="w-5 h-5" />
                  </div>
                  <div>
                    <h3 class="font-medium text-gray-900">{{ p.name }}</h3>
                    <p class="text-xs text-gray-500">{{ p.description }}</p>
                  </div>
                </div>
                <span class="text-xs text-gray-400">{{ p.last_active }}</span>
              </div>
              <div class="flex items-center gap-6 text-sm text-gray-500 pl-13">
                <span>{{ p.type }}</span>
                <span>{{ p.case_count }} 用例</span>
                <span>{{ p.execution_count }} 次执行</span>
              </div>
            </div>
          </div>
        </div>
      </div>
      <!-- 新建项目对话框 -->
      <div v-if="createDialogOpen" class="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
        <div class="bg-white rounded-lg p-6 w-96">
          <h3 class="text-lg font-medium text-gray-900 mb-4">新建项目</h3>
          <div class="space-y-4">
            <div>
              <label class="block text-sm text-gray-700 mb-1">项目名称</label>
              <input v-model="newProject.name" type="text" class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" placeholder="比如：长安深蓝 S7 ECU 测试" />
            </div>
            <div>
              <label class="block text-sm text-gray-700 mb-1">项目描述</label>
              <textarea v-model="newProject.description" class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" rows="3" placeholder="简单描述一下这个项目..."></textarea>
            </div>
            <div>
              <label class="block text-sm text-gray-700 mb-1">项目类型</label>
              <select v-model="newProject.type" class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm">
                <option value="ECU">ECU 动力域</option>
                <option value="座舱">座舱域</option>
              </select>
            </div>
          </div>
          <div class="flex gap-3 mt-6">
            <button @click="createDialogOpen = false" class="flex-1 px-4 py-2 border border-gray-200 rounded-lg text-sm hover:bg-gray-50">取消</button>
            <button @click="createProject" class="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700">创建</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
