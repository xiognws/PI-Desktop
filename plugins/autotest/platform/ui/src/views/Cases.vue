<script setup lang="ts">
import { ref, onMounted, watch, onUnmounted } from 'vue'
import { useRoute } from 'vue-router'
import { Plus, ListChecks, Brain, X, Upload, Download, Trash2, Play, List, Network, Star } from 'lucide-vue-next'
import 'jsmind/style/jsmind.css'
import jsMind from 'jsmind'

const route = useRoute()
const projectId = route.params.projectId as string

const viewMode = ref<'list' | 'tree'>('list')
let jm: any = null

const cases = ref<any[]>([])

// 从后端加载用例
async function loadCases() {
  try {
    const res = await fetch(`/api/projects/${projectId}/cases`)
    const data = await res.json()
    cases.value = data.cases
  } catch (e) {
    console.error('加载用例失败', e)
  }
}

onMounted(() => {
  loadCases()
  window.addEventListener('keydown', handleKeydown)
})

// 收藏切换
async function toggleFavorite(id: string) {
  const c = cases.value.find(c => c.id === id)
  if (c) {
    c.favorite = !c.favorite
    // 调用后端更新
    try {
      await fetch(`/api/projects/${projectId}/cases/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(c),
      })
    } catch (e) {
      console.error('更新收藏失败', e)
    }
  }
}

// 复制用例
function copyCase(id: string) {
  const c = cases.value.find(c => c.id === id)
  if (c) {
    const newCase = { ...c, id: Date.now().toString(), name: c.name + ' (副本)' }
    cases.value.push(newCase)
  }
}

// 删除用例
async function deleteCase(id: string) {
  if (confirm('确定要删除这条用例吗？')) {
    try {
      await fetch(`/api/projects/${projectId}/cases/${id}`, {
        method: 'DELETE',
      })
      cases.value = cases.value.filter(c => c.id !== id)
    } catch (e) {
      console.error('删除用例失败', e)
      alert('删除失败')
    }
  }
}

// 筛选
const filterOpen = ref(false)
const filters = ref({
  module: '',
  priority: '',
  status: '',
  type: '',
})

function applyFilters() {
  // 后面对接后端筛选
  filterOpen.value = false
}

// 批量导出选中用例
function exportSelected() {
  if (selectedIds.value.length === 0) {
    alert('请先选择要导出的用例')
    return
  }
  const selected = cases.value.filter(c => selectedIds.value.includes(c.id))
  const data = JSON.stringify(selected, null, 2)
  const blob = new Blob([data], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = '测试用例导出.json'
  a.click()
  URL.revokeObjectURL(url)
}

// 快捷键
function handleKeydown(e: KeyboardEvent) {
  // Ctrl + N 新建用例
  if (e.ctrlKey && e.key === 'n') {
    e.preventDefault()
    alert('新建用例')
  }
  // Ctrl + F 搜索
  if (e.ctrlKey && e.key === 'f') {
    e.preventDefault()
    document.querySelector<HTMLInputElement>('input[placeholder*="搜索"]')?.focus()
  }
  // Ctrl + / 切换列表/脑图
  if (e.ctrlKey && e.key === '/') {
    e.preventDefault()
    viewMode.value = viewMode.value === 'list' ? 'tree' : 'list'
  }
}

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeydown)
})

// 新建用例对话框
const createDialogOpen = ref(false)
const newCase = ref({
  name: '',
  module: '发动机控制',
  type: '正向',
  priority: '中',
  tags: [] as string[],
})

async function createCase() {
  if (!newCase.value.name) {
    alert('请输入用例名称')
    return
  }
  try {
    const res = await fetch(`/api/projects/${projectId}/cases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newCase.value),
    })
    const data = await res.json()
    cases.value.unshift(data)
    createDialogOpen.value = false
    newCase.value = { name: '', module: '发动机控制', type: '正向', priority: '中', tags: [] }
  } catch (e) {
    console.error('创建用例失败', e)
    alert('创建失败')
  }
}

// 批量选择
const selectedIds = ref<number[]>([])

function toggleSelect(id: number) {
  const idx = selectedIds.value.indexOf(id)
  if (idx > -1) {
    selectedIds.value.splice(idx, 1)
  } else {
    selectedIds.value.push(id)
  }
}

// 详情抽屉
const drawerOpen = ref(false)
const selectedCase = ref<any>(null)

async function openDetail(c: any) {
  // 先显示列表里的基本信息
  selectedCase.value = { ...c }
  drawerOpen.value = true

  // 然后从后端获取完整详情
  try {
    const res = await fetch(`/api/projects/${projectId}/cases/${c.id}`)
    const data = await res.json()
    selectedCase.value = { ...c, ...data }
  } catch (e) {
    console.error('获取用例详情失败', e)
  }
}

const reviewStatusMap: Record<string, { label: string; class: string }> = {
  '待评审': { label: '待评审', class: 'bg-yellow-50 text-yellow-600' },
  '已通过': { label: '已通过', class: 'bg-green-50 text-green-600' },
  '已拒绝': { label: '已拒绝', class: 'bg-red-50 text-red-600' },
}

const typeMap: Record<string, string> = {
  '正向': 'bg-blue-50 text-blue-600',
  '反向': 'bg-orange-50 text-orange-600',
  '边界': 'bg-purple-50 text-purple-600',
  '异常': 'bg-red-50 text-red-600',
}

// 初始化脑图
function initMindMap() {
  if (jm) return

  const mindData = {
    meta: {
      name: '测试用例脑图',
      author: 'AI Test Platform',
      version: '1.0',
    },
    format: 'node_tree',
    data: {
      id: 'root',
      topic: '发动机控制',
      'background-color': '#8b5cf6',
      'foreground-color': '#ffffff',
      children: [
        {
          id: 'start',
          topic: '启动系统',
          'background-color': '#ef4444',
          'foreground-color': '#ffffff',
          children: [
            { id: '1', topic: '冷启动转速稳定性' },
            { id: '2', topic: '怠速波动测试' },
            { id: '3', topic: '空调怠速补偿' },
          ],
        },
        {
          id: 'fuel',
          topic: '燃油系统',
          'background-color': '#f97316',
          'foreground-color': '#ffffff',
          children: [
            { id: '4', topic: '喷射量精确控制' },
            { id: '5', topic: '急加速加浓补偿' },
          ],
        },
        {
          id: 'ignition',
          topic: '点火系统',
          'background-color': '#3b82f6',
          'foreground-color': '#ffffff',
          children: [
            { id: '6', topic: '点火提前角控制' },
            { id: '7', topic: '爆震传感器调整' },
          ],
        },
        {
          id: 'diag',
          topic: '诊断系统',
          'background-color': '#10b981',
          'foreground-color': '#ffffff',
          children: [
            { id: '8', topic: 'DTC 故障码读取' },
            { id: '9', topic: 'OBD 接口测试' },
          ],
        },
      ],
    },
  }

  const options = {
    container: 'jsmind_container',
    editable: false,
    theme: 'primary',
    mode: 'full',
    view: {
      hmargin: 100,
      vmargin: 50,
      line_width: 2,
      line_color: '#c4b5fd',
    },
    layout: {
      hspace: 40,
      vspace: 25,
      pspace: 15,
    },
    support: {
      scroll: true,
      zoom: true,
    },
  } as const

  setTimeout(() => {
    jm = jsMind.show(options, mindData)
  }, 100)
}

watch(viewMode, (val) => {
  if (val === 'tree') {
    initMindMap()
  }
})
</script>

<template>
  <div class="flex-1 flex flex-col overflow-hidden relative">
    <div class="bg-white border-b border-gray-200 px-6 py-3">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-3">
          <h2 class="text-base font-medium text-gray-900">测试用例</h2>
          <span class="text-sm text-gray-400">共 {{ cases.length }} 条</span>
          <span v-if="selectedIds.length > 0" class="text-sm text-blue-600">已选 {{ selectedIds.length }} 条</span>
        </div>
        <div class="flex items-center gap-2">
          <!-- 视图切换 -->
          <div class="flex items-center border border-gray-200 rounded-lg overflow-hidden mr-2">
            <button @click="viewMode = 'list'"
              class="p-2"
              :class="viewMode === 'list' ? 'bg-blue-50 text-blue-600' : 'text-gray-400 hover:bg-gray-50'">
              <List class="w-4 h-4" />
            </button>
            <button @click="viewMode = 'tree'"
              class="p-2"
              :class="viewMode === 'tree' ? 'bg-blue-50 text-blue-600' : 'text-gray-400 hover:bg-gray-50'">
              <Network class="w-4 h-4" />
            </button>
          </div>

          <!-- 批量操作 -->
          <template v-if="selectedIds.length > 0">
            <button class="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-green-200 text-green-600 rounded-lg hover:bg-green-50">
              <Play class="w-4 h-4" />
              批量执行
            </button>
            <button @click="exportSelected" class="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-blue-200 text-blue-600 rounded-lg hover:bg-blue-50">
              <Download class="w-4 h-4" />
              导出选中
            </button>
            <button class="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-red-200 text-red-600 rounded-lg hover:bg-red-50">
              <Trash2 class="w-4 h-4" />
              批量删除
            </button>
          </template>
          <button class="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-gray-200 rounded-lg hover:bg-gray-50">
            <Upload class="w-4 h-4" />
            导入
          </button>
          <button class="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-gray-200 rounded-lg hover:bg-gray-50">
            <Download class="w-4 h-4" />
            导出
          </button>
          <button @click="filterOpen = !filterOpen" class="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-gray-200 rounded-lg hover:bg-gray-50">
            <ListChecks class="w-4 h-4" />
            筛选
          </button>

          <!-- 筛选面板 -->
          <div v-if="filterOpen" class="absolute right-0 top-full mt-2 w-64 bg-white border border-gray-200 rounded-lg shadow-lg p-4 z-50">
            <h3 class="text-sm font-medium text-gray-900 mb-3">筛选条件</h3>
            <div class="space-y-3">
              <div>
                <label class="text-xs text-gray-500">模块</label>
                <select v-model="filters.module" class="w-full mt-1 px-2 py-1 text-sm border border-gray-200 rounded">
                  <option value="">全部</option>
                  <option value="发动机控制">发动机控制</option>
                  <option value="变速箱控制">变速箱控制</option>
                  <option value="电池管理">电池管理</option>
                </select>
              </div>
              <div>
                <label class="text-xs text-gray-500">优先级</label>
                <select v-model="filters.priority" class="w-full mt-1 px-2 py-1 text-sm border border-gray-200 rounded">
                  <option value="">全部</option>
                  <option value="高">高</option>
                  <option value="中">中</option>
                  <option value="低">低</option>
                </select>
              </div>
              <div>
                <label class="text-xs text-gray-500">状态</label>
                <select v-model="filters.status" class="w-full mt-1 px-2 py-1 text-sm border border-gray-200 rounded">
                  <option value="">全部</option>
                  <option value="已通过">已通过</option>
                  <option value="未执行">未执行</option>
                  <option value="失败">失败</option>
                </select>
              </div>
              <button @click="applyFilters" class="w-full py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700">
                应用筛选
              </button>
            </div>
          </div>
          <button @click="createDialogOpen = true" class="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-gray-200 rounded-lg hover:bg-gray-50">
            <Plus class="w-4 h-4" />
            新建用例
          </button>
          <button class="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">
            <Brain class="w-4 h-4" />
            AI 生成
          </button>
        </div>
      </div>
    </div>

    <!-- 列表视图 -->
    <div v-if="viewMode === 'list'" class="flex-1 overflow-auto">
      <div class="bg-white min-h-full">
        <table class="w-full">
          <thead class="bg-gray-50 border-b border-gray-200">
            <tr>
              <th class="w-10 px-4 py-3"></th>
              <th class="text-left px-4 py-3 text-xs font-medium text-gray-500">用例名称</th>
              <th class="text-left px-4 py-3 text-xs font-medium text-gray-500">模块</th>
              <th class="text-left px-4 py-3 text-xs font-medium text-gray-500">类型</th>
              <th class="text-left px-4 py-3 text-xs font-medium text-gray-500">标签</th>
              <th class="text-left px-4 py-3 text-xs font-medium text-gray-500">优先级</th>
              <th class="text-left px-4 py-3 text-xs font-medium text-gray-500">执行状态</th>
              <th class="text-left px-4 py-3 text-xs font-medium text-gray-500">操作</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-100">
            <tr v-for="c in cases" :key="c.id" class="hover:bg-gray-50">
              <td class="px-4 py-3">
                <input
                  type="checkbox"
                  :checked="selectedIds.includes(c.id)"
                  @change="toggleSelect(c.id)"
                  class="rounded"
                />
              </td>
              <td class="px-4 py-3">
                <button
                  @click.stop="toggleFavorite(c.id)"
                  class="text-gray-300 hover:text-yellow-500"
                >
                  <Star :class="c.favorite ? 'fill-yellow-400 text-yellow-400' : ''" class="w-4 h-4" />
                </button>
              </td>
              <td class="px-4 py-3 text-sm text-gray-900 cursor-pointer" @click="openDetail(c)">{{ c.name }}</td>
              <td class="px-4 py-3 text-sm text-gray-500">{{ c.module }}</td>
              <td class="px-4 py-3">
                <span class="inline-block px-2 py-0.5 text-xs rounded" :class="typeMap[c.type]">{{ c.type }}</span>
              </td>
              <td class="px-4 py-3">
                <div class="flex flex-wrap gap-1">
                  <span v-for="tag in c.tags" :key="tag" class="inline-block px-2 py-0.5 text-xs bg-gray-100 text-gray-600 rounded">{{ tag }}</span>
                </div>
              </td>
              <td class="px-4 py-3">
                <span class="inline-block px-2 py-0.5 text-xs rounded"
                  :class="c.priority === '高' ? 'bg-red-50 text-red-600' : c.priority === '中' ? 'bg-yellow-50 text-yellow-600' : 'bg-gray-100 text-gray-600'">
                  {{ c.priority }}
                </span>
              </td>
              <td class="px-4 py-3">
                <span class="inline-block px-2 py-0.5 text-xs rounded"
                  :class="c.status === '已通过' ? 'bg-green-50 text-green-600' : c.status === '失败' ? 'bg-red-50 text-red-600' : 'bg-gray-100 text-gray-600'">
                  {{ c.status }}
                </span>
              </td>
              <td class="px-4 py-3 text-sm">
                <button class="text-blue-600 hover:underline mr-2" @click="openDetail(c)">详情</button>
                <button class="text-gray-500 hover:text-blue-600 mr-2" @click="copyCase(c.id)">复制</button>
                <button class="text-gray-500 hover:text-red-600" @click="deleteCase(c.id)">删除</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 脑图视图 -->
    <div v-else class="flex-1 overflow-auto p-6">
      <div id="jsmind_container" class="bg-white rounded-lg border border-gray-200" style="width: 100%; height: 600px;"></div>
    </div>

    <!-- 右侧详情抽屉 -->
    <Transition name="slide">
      <div v-if="drawerOpen && selectedCase" class="absolute right-0 top-0 bottom-0 w-96 bg-white border-l border-gray-200 shadow-xl flex flex-col z-10">
        <div class="h-14 border-b border-gray-200 flex items-center justify-between px-4">
          <h3 class="font-medium text-gray-900">用例详情</h3>
          <button @click="drawerOpen = false" class="p-1 rounded hover:bg-gray-100 text-gray-400">
            <X class="w-5 h-5" />
          </button>
        </div>

        <div class="flex-1 overflow-auto p-4 space-y-6">
          <div>
            <h4 class="text-sm font-medium text-gray-900 mb-2">{{ selectedCase.name }}</h4>
            <div class="flex gap-2 mb-4 flex-wrap">
              <span class="text-xs px-2 py-0.5 rounded bg-blue-50 text-blue-600">{{ selectedCase.module }}</span>
              <span class="text-xs px-2 py-0.5 rounded" :class="typeMap[selectedCase.type]">{{ selectedCase.type }}场景</span>
              <span class="text-xs px-2 py-0.5 rounded bg-red-50 text-red-600">{{ selectedCase.priority }}优先级</span>
              <span class="text-xs px-2 py-0.5 rounded" :class="reviewStatusMap[selectedCase.reviewStatus].class">{{ selectedCase.reviewStatus }}</span>
            </div>
          </div>

          <div>
            <h4 class="text-sm font-medium text-gray-900 mb-2">前置条件</h4>
            <div class="text-sm text-gray-600 whitespace-pre-line bg-gray-50 rounded-lg p-3">
              {{ selectedCase.precondition }}
            </div>
          </div>

          <div>
            <h4 class="text-sm font-medium text-gray-900 mb-2">测试步骤</h4>
            <div class="space-y-3">
              <div v-for="s in selectedCase.steps" :key="s.step" class="flex gap-3">
                <div class="w-6 h-6 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center text-xs font-medium flex-shrink-0">
                  {{ s.step }}
                </div>
                <div class="flex-1">
                  <p class="text-sm text-gray-900">{{ s.action }}</p>
                  <p class="text-xs text-gray-500 mt-1">预期：{{ s.expected }}</p>
                </div>
              </div>
            </div>
          </div>

          <div>
            <h4 class="text-sm font-medium text-gray-900 mb-2">版本历史</h4>
            <div class="space-y-2">
              <div v-for="v in selectedCase.versions" :key="v.version" class="flex gap-3 text-sm">
                <span class="font-mono text-blue-600 flex-shrink-0">{{ v.version }}</span>
                <div class="flex-1">
                  <p class="text-gray-900">{{ v.changes }}</p>
                  <p class="text-xs text-gray-400 mt-0.5">{{ v.time }} · {{ v.author }}</p>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="border-t border-gray-200 p-4 flex gap-2">
          <button class="flex-1 px-3 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50">编辑</button>
          <button class="flex-1 px-3 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700">执行</button>
        </div>
      </div>
    </Transition>

    <!-- 新建用例对话框 -->
    <div v-if="createDialogOpen" class="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div class="bg-white rounded-lg p-6 w-96">
        <h3 class="text-lg font-medium text-gray-900 mb-4">新建测试用例</h3>
        <div class="space-y-4">
          <div>
            <label class="block text-sm text-gray-700 mb-1">用例名称</label>
            <input v-model="newCase.name" type="text" class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" placeholder="比如：发动机启动后转速稳定测试" />
          </div>
          <div>
            <label class="block text-sm text-gray-700 mb-1">所属模块</label>
            <select v-model="newCase.module" class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm">
              <option value="发动机控制">发动机控制</option>
              <option value="变速箱控制">变速箱控制</option>
              <option value="电池管理">电池管理</option>
            </select>
          </div>
          <div>
            <label class="block text-sm text-gray-700 mb-1">用例类型</label>
            <select v-model="newCase.type" class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm">
              <option value="正向">正向</option>
              <option value="反向">反向</option>
              <option value="边界">边界</option>
              <option value="异常">异常</option>
            </select>
          </div>
          <div>
            <label class="block text-sm text-gray-700 mb-1">优先级</label>
            <select v-model="newCase.priority" class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm">
              <option value="高">高</option>
              <option value="中">中</option>
              <option value="低">低</option>
            </select>
          </div>
        </div>
        <div class="flex gap-3 mt-6">
          <button @click="createDialogOpen = false" class="flex-1 px-4 py-2 border border-gray-200 rounded-lg text-sm hover:bg-gray-50">取消</button>
          <button @click="createCase" class="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700">创建</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.slide-enter-active,
.slide-leave-active {
  transition: transform 0.3s ease;
}
.slide-enter-from,
.slide-leave-to {
  transform: translateX(100%);
}
</style>
