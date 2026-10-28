<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import {
  Cpu,
  Plus,
  Search,
  FileText,
  ListChecks,
  PlayCircle,
  TrendingUp,
  Clock,
  Moon,
  Sun,
  Bell,
} from 'lucide-vue-next'

const router = useRouter()

// 全局搜索
const globalSearch = ref('')
const searchOpen = ref(false)
function onSearchBlur() {
  setTimeout(() => searchOpen.value = false, 200)
}
const searchResults = ref([
  { id: 1, title: '发动机启动后转速应稳定在 800±50rpm', type: '测试用例', project: '长安深蓝 S7 ECU 测试' },
  { id: 2, title: '冷启动脚本_发动机.py', type: '测试脚本', project: '长安深蓝 S7 ECU 测试' },
  { id: 3, title: '发动机模块回归测试报告', type: '测试报告', project: '长安深蓝 S7 ECU 测试' },
])

// 深色模式
const darkMode = ref(false)
function toggleDarkMode() {
  darkMode.value = !darkMode.value
  document.documentElement.classList.toggle('dark', darkMode.value)
}

// 通知中心
const notificationsOpen = ref(false)
const notifications = ref([
  { id: 1, title: '发动机模块回归测试完成', desc: '通过率 83.3%，1 条失败', time: '10 分钟前', read: false },
  { id: 2, title: 'AI 已生成 5 条新用例', desc: '来自需求文档：怠速稳定性要求', time: '1 小时前', read: false },
  { id: 3, title: '测试计划执行完成', desc: '座舱蓝牙周回归测试已完成', time: '昨天', read: true },
])

// 统计数据（全部来自 /api/projects 的真实字段）
const stats = ref({
  totalProjects: 0,
  totalCases: 0,
  totalExecutions: 0,
})

// 项目列表
const projects = ref<any[]>([])

// 新建项目对话框
const createDialogOpen = ref(false)
const newProject = ref({
  name: '',
  description: '',
  type: 'ECU',
})

async function loadProjects() {
  try {
    const res = await fetch('/api/projects')
    const data = await res.json()
    projects.value = data.projects || []
    // 更新统计
    stats.value.totalProjects = projects.value.length
    stats.value.totalCases = projects.value.reduce((sum: number, p: any) => sum + (p.case_count || 0), 0)
    stats.value.totalExecutions = projects.value.reduce((sum: number, p: any) => sum + (p.execution_count || 0), 0)
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
        <span class="font-semibold text-gray-900">AI 测试平台</span>
      </div>
      <div class="flex items-center gap-4">
        <!-- 全局搜索 -->
        <div class="relative">
          <Search class="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            v-model="globalSearch"
            type="text"
            placeholder="搜索用例、脚本、报告..."
            class="w-64 pl-9 pr-4 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-blue-500"
            @focus="searchOpen = true"
            @blur="onSearchBlur"
          />
          <!-- 搜索结果下拉 -->
          <div v-if="searchOpen && globalSearch" class="absolute top-full mt-1 w-96 bg-white border border-gray-200 rounded-lg shadow-lg z-50 max-h-80 overflow-auto">
            <div class="px-4 py-2 text-xs text-gray-500 border-b">搜索结果</div>
            <div v-for="item in searchResults" :key="item.id" class="px-4 py-2 hover:bg-gray-50 cursor-pointer">
              <div class="text-sm text-gray-900">{{ item.title }}</div>
              <div class="text-xs text-gray-500">{{ item.type }} · {{ item.project }}</div>
            </div>
          </div>
        </div>
        <router-link to="/tasks" class="text-sm text-gray-500 hover:text-gray-700">任务</router-link>
        <router-link to="/knowledge" class="text-sm text-gray-500 hover:text-gray-700">知识库</router-link>
        <router-link to="/environments" class="text-sm text-gray-500 hover:text-gray-700">环境</router-link>
        <router-link to="/logs" class="text-sm text-gray-500 hover:text-gray-700">日志</router-link>
        <router-link to="/mcp" class="text-sm text-gray-500 hover:text-gray-700">插件</router-link>
        <router-link to="/settings" class="text-sm text-gray-500 hover:text-gray-700">设置</router-link>

        <!-- 深色模式切换 -->
        <button @click="toggleDarkMode" class="p-2 rounded-lg hover:bg-gray-100">
          <Moon v-if="!darkMode" class="w-5 h-5 text-gray-500" />
          <Sun v-else class="w-5 h-5 text-yellow-500" />
        </button>

        <!-- 通知中心 -->
        <div class="relative">
          <button @click="notificationsOpen = !notificationsOpen" class="p-2 rounded-lg hover:bg-gray-100 relative">
            <Bell class="w-5 h-5 text-gray-500" />
            <span v-if="notifications.some(n => !n.read)" class="absolute top-1 right-1 w-2 h-2 bg-red-500 rounded-full"></span>
          </button>
          <Transition name="fade">
            <div v-if="notificationsOpen" class="absolute right-0 top-10 w-80 bg-white border border-gray-200 rounded-lg shadow-xl z-20">
              <div class="p-3 border-b border-gray-100 flex items-center justify-between">
                <h3 class="font-medium text-gray-900 text-sm">通知</h3>
                <span class="text-xs text-blue-600 cursor-pointer hover:underline">全部已读</span>
              </div>
              <div class="max-h-80 overflow-auto">
                <div v-for="n in notifications" :key="n.id" class="p-3 border-b border-gray-50 hover:bg-gray-50" :class="{ 'bg-blue-50/50': !n.read }">
                  <div class="flex items-center gap-2">
                    <span v-if="!n.read" class="w-1.5 h-1.5 bg-blue-500 rounded-full"></span>
                    <span class="text-sm font-medium text-gray-900">{{ n.title }}</span>
                  </div>
                  <p class="text-xs text-gray-500 mt-1 ml-3.5">{{ n.desc }}</p>
                  <p class="text-xs text-gray-400 mt-1 ml-3.5">{{ n.time }}</p>
                </div>
              </div>
            </div>
          </Transition>
        </div>

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
