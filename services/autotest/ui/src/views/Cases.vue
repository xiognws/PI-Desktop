<script setup lang="ts">
import { computed, ref, onMounted, watch, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Plus, ListChecks, X, Upload, Download, Trash2, Play, List, Network, Star } from 'lucide-vue-next'
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
  loadScripts()
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
async function copyCase(id: string) {
  const c = cases.value.find(c => c.id === id)
  if (!c) return
  try {
    const res = await fetch(`/api/projects/${projectId}/cases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `${c.name} (副本)`,
        module: c.module || '',
        precondition: c.precondition || '',
        steps: c.steps || '',
        expected: c.expected || '',
        type: c.type || '正向',
        priority: c.priority || '中',
        tags: c.tags || [],
      }),
    })
    if (!res.ok) throw new Error(`${res.status}`)
    const created = await res.json()
    cases.value.unshift(created)
  } catch (e) {
    console.error('复制用例失败', e)
    alert('复制失败')
  }
}

// 执行用例：走 /cases/{id}/run，后端跑它关联的脚本并把结果回写到用例状态。
// 以前这个按钮没有后端，用户只能去脚本页逐个跑。
const runningIds = ref<string[]>([])

async function runCase(id: string) {
  if (runningIds.value.includes(id)) return
  runningIds.value.push(id)
  try {
    const res = await fetch(`/api/projects/${projectId}/cases/${id}/run`, {
      method: 'POST',
    })
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}))
      throw new Error(detail.detail || `${res.status} ${res.statusText}`)
    }
    await loadCases()
  } catch (e) {
    console.error('执行用例失败', e)
    alert(`执行失败：${(e as Error).message}`)
  } finally {
    runningIds.value = runningIds.value.filter(x => x !== id)
  }
}

async function runSelected() {
  for (const id of [...selectedIds.value]) {
    await runCase(String(id))
  }
  selectedIds.value = []
}

async function deleteSelected() {
  if (!confirm(`确定删除选中的 ${selectedIds.value.length} 条用例？`)) return
  for (const id of [...selectedIds.value]) {
    await deleteCase(String(id))
  }
  selectedIds.value = []
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

// 筛选在前端做：/cases 没有查询参数，项目内用例是几百条量级，为一个视图
// 加一套筛选协议不值当。
const visibleCases = computed(() =>
  cases.value.filter((c) => {
    if (filters.value.module && (c.module || '') !== filters.value.module) return false
    if (filters.value.priority && c.priority !== filters.value.priority) return false
    if (filters.value.status && c.status !== filters.value.status) return false
    if (filters.value.type && c.type !== filters.value.type) return false
    return true
  }),
)
const activeFilterCount = computed(() => Object.values(filters.value).filter(Boolean).length)
// 下拉选项来自真实用例，而不是写死的几个模块名
const moduleOptions = computed(() => Array.from(new Set(cases.value.map(c => c.module).filter(Boolean))))
const typeOptions = computed(() => Array.from(new Set(cases.value.map(c => c.type).filter(Boolean))).sort())

function clearFilters() {
  filters.value = { module: '', priority: '', status: '', type: '' }
}

function applyFilters() {
  filterOpen.value = false
}

// 批量改优先级：PUT 是整行更新，所以按行把原值带上再覆盖 priority。
const batchBusy = ref(false)

async function setSelectedPriority(priority: string) {
  if (!selectedIds.value.length) return
  batchBusy.value = true
  try {
    for (const id of [...selectedIds.value]) {
      const row = cases.value.find(c => c.id === id)
      if (!row) continue
      const res = await fetch(`/api/projects/${projectId}/cases/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...row, priority }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      row.priority = priority
    }
  } catch (e) {
    alert(`批量改优先级失败：${(e as Error).message}`)
  } finally {
    batchBusy.value = false
  }
}

// 批量导出选中用例
function exportSelected() {
  if (selectedIds.value.length === 0) {
    alert('请先选择要导出的用例')
    return
  }
  const selected = cases.value.filter(c => selectedIds.value.includes(c.id))
  downloadJson(selected, '测试用例导出.json')
}

// 导出全部
function exportAll() {
  if (cases.value.length === 0) {
    alert('当前项目还没有用例')
    return
  }
  downloadJson(cases.value, '测试用例全部.json')
}

function downloadJson(payload: unknown, filename: string) {
  const data = JSON.stringify(payload, null, 2)
  const blob = new Blob([data], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

// 导入：接受上面导出的 JSON 数组，逐条 POST /cases。
// 同名用例跳过而不是覆盖 —— 导入整批时覆盖会让已有用例内容被静默替换。
const importOpen = ref(false)
const importFile = ref<HTMLInputElement>()
const importing = ref(false)
const importResult = ref('')

async function onImportPick(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  importing.value = true
  importResult.value = ''
  let created = 0
  let skipped = 0
  let failed = 0
  try {
    const rows = JSON.parse(await file.text())
    if (!Array.isArray(rows)) throw new Error('文件内容不是用例数组')
    const existing = new Set(cases.value.map(c => c.name))
    for (const row of rows) {
      const name = String(row?.name ?? row?.title ?? '').trim()
      if (!name) {
        failed += 1
        continue
      }
      if (existing.has(name)) {
        skipped += 1
        continue
      }
      const res = await fetch(`/api/projects/${projectId}/cases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          module: row.module ?? row.module_id ?? '',
          precondition: row.precondition ?? '',
          steps: row.steps ?? '',
          expected: row.expected ?? '',
          type: row.type ?? row.case_type ?? '正向',
          priority: row.priority ?? '中',
          tags: Array.isArray(row.tags) ? row.tags : [],
        }),
      })
      if (res.ok) {
        created += 1
        existing.add(name)
      } else {
        failed += 1
      }
    }
    await loadCases()
    importResult.value = `新增 ${created} 条，跳过重名 ${skipped} 条，失败 ${failed} 条`
  } catch (e) {
    importResult.value = `导入失败：${(e as Error).message}`
  } finally {
    importing.value = false
    if (importFile.value) importFile.value.value = ''
  }
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

/** 用例的依据（doc/quote/numbers + grounding 等级）：后端以 JSON 文本存在 evidence 列。 */
const caseEvidence = computed(() => {
  const raw = (selectedCase.value as any)?.evidence
  if (!raw) return null
  if (typeof raw === 'object') return raw as { grounding?: string; evidence?: any }
  try {
    return JSON.parse(raw) as { grounding?: string; evidence?: any }
  } catch {
    return null
  }
})
const selectedCase = ref<any>(null)

// 这条用例的历次执行。`execution_cases` 只记「脚本带 case_id 的执行」，所以空
// 列表不一定代表没跑过 —— 文案要说清楚，否则会被当成数据丢了。
const caseHistory = ref<any[]>([])
const caseHistoryStats = ref<{ total: number; passed: number } | null>(null)
const historyLoading = ref(false)

async function loadCaseHistory(caseId: string | number) {
  historyLoading.value = true
  try {
    const res = await fetch(`/api/projects/${projectId}/cases/${caseId}/executions?limit=10`)
    if (!res.ok) throw new Error(`${res.status}`)
    const data = await res.json()
    caseHistory.value = data.history || []
    caseHistoryStats.value = { total: data.total ?? 0, passed: data.passed ?? 0 }
  } catch (e) {
    caseHistory.value = []
    caseHistoryStats.value = null
    console.error('获取用例执行历史失败', e)
  } finally {
    historyLoading.value = false
  }
}

async function openDetail(c: any) {
  // 先显示列表里的基本信息
  selectedCase.value = { ...c }
  drawerOpen.value = true
  caseHistory.value = []
  caseHistoryStats.value = null
  void loadCaseHistory(c.id)

  // 然后从后端获取完整详情
  try {
    const res = await fetch(`/api/projects/${projectId}/cases/${c.id}`)
    const data = await res.json()
    selectedCase.value = { ...c, ...data }
  } catch (e) {
    console.error('获取用例详情失败', e)
  }
}

function resultClass(result: string) {
  if (result === '通过') return 'bg-success-soft text-success'
  if (result === '失败' || result === '错误') return 'bg-danger-soft text-danger'
  if (result === '已跳过') return 'bg-surface-3 text-muted'
  return 'bg-warn-soft text-warn'
}

function openExecution(executionId: number) {
  drawerOpen.value = false
  router.push(`/project/${projectId}/executions/${executionId}`)
}

const reviewStatusMap: Record<string, { label: string; class: string }> = {
  '待评审': { label: '待评审', class: 'bg-warn-soft text-warn' },
  '已通过': { label: '已通过', class: 'bg-success-soft text-success' },
  '已拒绝': { label: '已拒绝', class: 'bg-danger-soft text-danger' },
}

// 后端返回 review_status（snake_case），弹层原来直接读 reviewStatus，undefined
// 时 `reviewStatusMap[undefined].class` 会把整个抽屉渲染打断。
function reviewOf(c: any) {
  const raw = c?.review_status ?? c?.reviewStatus ?? '待评审'
  return reviewStatusMap[raw] ?? { label: raw, class: 'bg-surface-3 text-fg-3' }
}

// 步骤/预期在库里是一行一个的文本（工作流生成时把 list 拍平了），老数据可能是
// 数组对象。统一成字符串数组给弹层渲染。
function detailSteps(c: any): string[] {
  const steps = c?.steps
  if (Array.isArray(steps)) {
    return steps.map((s: any) =>
      typeof s === 'string' ? s : `${s.action ?? s.step ?? ''}${s.expected ? ` → 预期：${s.expected}` : ''}`,
    )
  }
  return String(steps || '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
}

// 用例 → 脚本：scripts.case_id 新数据指向用例 id，老数据存的是用例标题，两种都认。
const scripts = ref<any[]>([])
async function loadScripts() {
  try {
    const res = await fetch(`/api/projects/${projectId}/scripts`)
    const data = await res.json()
    scripts.value = data.scripts || []
  } catch {
    scripts.value = []
  }
}

function scriptsForCase(c: any) {
  if (!c) return []
  const id = String(c.id || '')
  const name = String(c.name || c.title || '')
  return scripts.value.filter(s => s.case_id === id || s.case_id === name)
}

const router = useRouter()
function openScript(scriptId: string) {
  router.push(`/project/${projectId}/scripts/${scriptId}/edit`)
}

const typeMap: Record<string, string> = {
  '正向': 'bg-accent-soft text-accent',
  '反向': 'bg-orange-50 text-orange-600',
  '边界': 'bg-purple-50 text-purple-600',
  '异常': 'bg-danger-soft text-danger',
}

// 脑图：用真实用例按 module 分组渲染。
// 旧版是一棵写死的发动机样例树（冷启动/燃油/点火/诊断），和 cases 无关，
// 切到脑图看到的是与当前项目毫无关系的假数据。现在树根是项目，第二层是
// cases 里真实出现过的 module，叶子是用例标题。
function buildMindMap() {
  const byModule = new Map<string, { id: string; topic: string }[]>()
  for (const c of cases.value) {
    const module = (c.module || '').trim() || '未分组'
    if (!byModule.has(module)) byModule.set(module, [])
    byModule.get(module)!.push({ id: String(c.id), topic: c.name || '(未命名用例)' })
  }
  return {
    meta: { name: '测试用例脑图', author: 'Pi-Workspace', version: '1.0' },
    format: 'node_tree',
    data: {
      id: 'root',
      topic: `用例 (${cases.value.length})`,
      'background-color': '#8b5cf6',
      'foreground-color': '#ffffff',
      children: [...byModule.entries()].map(([module, leaves]) => ({
        id: `mod-${module}`,
        topic: `${module} (${leaves.length})`,
        children: leaves,
      })),
    },
  }
}

// 初始化脑图
function initMindMap() {
  if (jm) return
  const mindData = buildMindMap()

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
    <div class="bg-surface border-b border-line px-6 py-3">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-3">
          <h2 class="text-base font-medium text-fg">测试用例</h2>
          <span class="text-sm text-muted-2">
            共 {{ cases.length }} 条<template v-if="activeFilterCount">（筛选后 {{ visibleCases.length }} 条）</template>
          </span>
          <span v-if="selectedIds.length > 0" class="text-sm text-accent">已选 {{ selectedIds.length }} 条</span>
          <span class="text-xs text-muted-2" title="写用例的依据来自「知识库」：先把项目资料分解入库，Agent 检索到的就是那些原文">
            依据「知识库」中已入库的项目资料
          </span>
        </div>
        <div class="flex items-center gap-2">
          <!-- 视图切换 -->
          <div class="flex items-center border border-line rounded-lg overflow-hidden mr-2">
            <button @click="viewMode = 'list'"
              class="p-2"
              :class="viewMode === 'list' ? 'bg-accent-soft text-accent' : 'text-muted-2 hover:bg-surface-2'">
              <List class="w-4 h-4" />
            </button>
            <button @click="viewMode = 'tree'"
              class="p-2"
              :class="viewMode === 'tree' ? 'bg-accent-soft text-accent' : 'text-muted-2 hover:bg-surface-2'">
              <Network class="w-4 h-4" />
            </button>
          </div>

          <!-- 批量操作 -->
          <template v-if="selectedIds.length > 0">
            <button @click="runSelected" class="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-success-line text-success rounded-lg hover:bg-success-soft">
              <Play class="w-4 h-4" />
              批量执行
            </button>
            <button @click="exportSelected" class="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-accent-line text-accent rounded-lg hover:bg-accent-soft">
              <Download class="w-4 h-4" />
              导出选中
            </button>
            <select
              :value="''"
              :disabled="batchBusy"
              @change="setSelectedPriority(($event.target as HTMLSelectElement).value); ($event.target as HTMLSelectElement).value = ''"
              class="px-2 py-1.5 text-sm border border-line rounded-lg disabled:opacity-50"
            >
              <option value="">批量改优先级…</option>
              <option value="高">高</option>
              <option value="中">中</option>
              <option value="低">低</option>
            </select>
            <button @click="deleteSelected" class="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-danger-line text-danger rounded-lg hover:bg-danger-soft">
              <Trash2 class="w-4 h-4" />
              批量删除
            </button>
          </template>
          <button @click="importOpen = true" class="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-line rounded-lg hover:bg-surface-2">
            <Upload class="w-4 h-4" />
            导入
          </button>
          <button @click="exportAll" class="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-line rounded-lg hover:bg-surface-2">
            <Download class="w-4 h-4" />
            导出
          </button>
          <button @click="filterOpen = !filterOpen" class="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-line rounded-lg hover:bg-surface-2">
            <ListChecks class="w-4 h-4" />
            筛选
          </button>

          <!-- 筛选面板 -->
          <div v-if="filterOpen" class="absolute right-0 top-full mt-2 w-64 bg-surface border border-line rounded-lg shadow-lg p-4 z-50">
            <h3 class="text-sm font-medium text-fg mb-3">筛选条件</h3>
            <div class="space-y-3">
              <div>
                <label class="text-xs text-muted">模块</label>
                <select v-model="filters.module" class="w-full mt-1 px-2 py-1 text-sm border border-line rounded">
                  <option value="">全部</option>
                  <option v-for="m in moduleOptions" :key="m" :value="m">{{ m }}</option>
                </select>
              </div>
              <div>
                <label class="text-xs text-muted">优先级</label>
                <select v-model="filters.priority" class="w-full mt-1 px-2 py-1 text-sm border border-line rounded">
                  <option value="">全部</option>
                  <option value="高">高</option>
                  <option value="中">中</option>
                  <option value="低">低</option>
                </select>
              </div>
              <div>
                <label class="text-xs text-muted">状态</label>
                <select v-model="filters.status" class="w-full mt-1 px-2 py-1 text-sm border border-line rounded">
                  <option value="">全部</option>
                  <option value="已通过">已通过</option>
                  <option value="未执行">未执行</option>
                  <option value="失败">失败</option>
                </select>
              </div>
              <div>
                <label class="text-xs text-muted">类型</label>
                <select v-model="filters.type" class="w-full mt-1 px-2 py-1 text-sm border border-line rounded">
                  <option value="">全部</option>
                  <option v-for="t in typeOptions" :key="t" :value="t">{{ t }}</option>
                </select>
              </div>
              <div class="flex gap-2">
                <button @click="clearFilters" class="flex-1 py-1.5 text-sm border border-line rounded hover:bg-surface-2">
                  清空
                </button>
                <button @click="applyFilters" class="flex-1 py-1.5 text-sm bg-accent-solid text-white rounded hover:bg-blue-700">
                  应用筛选
                </button>
              </div>
            </div>
          </div>
          <button @click="createDialogOpen = true" class="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-line rounded-lg hover:bg-surface-2">
            <Plus class="w-4 h-4" />
            新建用例
          </button>
        </div>
      </div>
    </div>

    <!-- 列表视图 -->
    <div v-if="viewMode === 'list'" class="flex-1 overflow-auto">
      <div class="bg-surface min-h-full">
        <table class="w-full">
          <thead class="bg-surface-2 border-b border-line">
            <tr>
              <th class="w-10 px-4 py-3"></th>
              <th class="text-left px-4 py-3 text-xs font-medium text-muted">用例名称</th>
              <th class="text-left px-4 py-3 text-xs font-medium text-muted">模块</th>
              <th class="text-left px-4 py-3 text-xs font-medium text-muted">类型</th>
              <th class="text-left px-4 py-3 text-xs font-medium text-muted">标签</th>
              <th class="text-left px-4 py-3 text-xs font-medium text-muted">优先级</th>
              <th class="text-left px-4 py-3 text-xs font-medium text-muted">执行状态</th>
              <th class="text-left px-4 py-3 text-xs font-medium text-muted">操作</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-line-soft">
            <tr v-for="c in visibleCases" :key="c.id" class="hover:bg-surface-2">
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
                  class="text-muted-2 hover:text-yellow-500"
                >
                  <Star :class="c.favorite ? 'fill-yellow-400 text-yellow-400' : ''" class="w-4 h-4" />
                </button>
              </td>
              <td class="px-4 py-3 text-sm text-fg cursor-pointer" @click="openDetail(c)">{{ c.name }}</td>
              <td class="px-4 py-3 text-sm text-muted">{{ c.module }}</td>
              <td class="px-4 py-3">
                <span class="inline-block px-2 py-0.5 text-xs rounded" :class="typeMap[c.type]">{{ c.type }}</span>
              </td>
              <td class="px-4 py-3">
                <div class="flex flex-wrap gap-1">
                  <span v-for="tag in c.tags" :key="tag" class="inline-block px-2 py-0.5 text-xs bg-surface-3 text-fg-3 rounded">{{ tag }}</span>
                </div>
              </td>
              <td class="px-4 py-3">
                <span class="inline-block px-2 py-0.5 text-xs rounded"
                  :class="c.priority === '高' ? 'bg-danger-soft text-danger' : c.priority === '中' ? 'bg-warn-soft text-warn' : 'bg-surface-3 text-fg-3'">
                  {{ c.priority }}
                </span>
              </td>
              <td class="px-4 py-3">
                <span class="inline-block px-2 py-0.5 text-xs rounded"
                  :class="c.status === '已通过' ? 'bg-success-soft text-success' : c.status === '失败' ? 'bg-danger-soft text-danger' : 'bg-surface-3 text-fg-3'">
                  {{ c.status }}
                </span>
              </td>
              <td class="px-4 py-3 text-sm">
                <button class="text-accent hover:underline mr-2" @click="openDetail(c)">详情</button>
                <button
                  class="text-success hover:underline mr-2 disabled:opacity-50"
                  :disabled="runningIds.includes(c.id)"
                  @click="runCase(c.id)">
                  {{ runningIds.includes(c.id) ? '执行中…' : '执行' }}
                </button>
                <button class="text-muted hover:text-accent mr-2" @click="copyCase(c.id)">复制</button>
                <button class="text-muted hover:text-danger" @click="deleteCase(c.id)">删除</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 脑图视图 -->
    <div v-else class="flex-1 overflow-auto p-6">
      <div id="jsmind_container" class="bg-surface rounded-lg border border-line" style="width: 100%; height: 600px;"></div>
    </div>

    <!-- 右侧详情抽屉 -->
    <Transition name="slide">
      <div v-if="drawerOpen && selectedCase" class="absolute right-0 top-0 bottom-0 w-96 bg-surface border-l border-line shadow-xl flex flex-col z-10">
        <div class="h-14 border-b border-line flex items-center justify-between px-4">
          <h3 class="font-medium text-fg">用例详情</h3>
          <button @click="drawerOpen = false" class="p-1 rounded hover:bg-surface-3 text-muted-2">
            <X class="w-5 h-5" />
          </button>
        </div>

        <div class="flex-1 overflow-auto p-4 space-y-6">
          <div>
            <h4 class="text-sm font-medium text-fg mb-2">{{ selectedCase.name }}</h4>
            <div class="flex gap-2 mb-4 flex-wrap">
              <span class="text-xs px-2 py-0.5 rounded bg-accent-soft text-accent">{{ selectedCase.module }}</span>
              <span class="text-xs px-2 py-0.5 rounded" :class="typeMap[selectedCase.type]">{{ selectedCase.type }}场景</span>
              <span class="text-xs px-2 py-0.5 rounded bg-danger-soft text-danger">{{ selectedCase.priority }}优先级</span>
              <span class="text-xs px-2 py-0.5 rounded" :class="reviewOf(selectedCase).class">{{ reviewOf(selectedCase).label }}</span>
            </div>
          </div>

          <div>
            <h4 class="text-sm font-medium text-fg mb-2">前置条件</h4>
            <div class="text-sm text-fg-3 whitespace-pre-line bg-surface-2 rounded-lg p-3">
              {{ selectedCase.precondition }}
            </div>
          </div>

          <div>
            <h4 class="text-sm font-medium text-fg mb-2">测试步骤</h4>
            <div class="space-y-3">
              <div v-for="(line, index) in detailSteps(selectedCase)" :key="index" class="flex gap-3">
                <div class="w-6 h-6 rounded-full bg-accent-soft text-accent flex items-center justify-center text-xs font-medium flex-shrink-0">
                  {{ index + 1 }}
                </div>
                <div class="flex-1">
                  <p class="text-sm text-fg whitespace-pre-line">{{ line }}</p>
                </div>
              </div>
              <div v-if="!detailSteps(selectedCase).length" class="text-sm text-muted-2">还没有步骤</div>
            </div>
          </div>

          <div>
            <h4 class="text-sm font-medium text-fg mb-2">
              关联脚本
              <span class="text-xs text-muted-2 font-normal">{{ scriptsForCase(selectedCase).length }} 个</span>
            </h4>
            <div class="space-y-2">
              <div
                v-for="s in scriptsForCase(selectedCase)"
                :key="s.id"
                class="flex items-center gap-2 bg-surface-2 rounded-lg px-3 py-2"
              >
                <span class="flex-1 text-sm text-fg font-mono truncate">{{ s.name }}</span>
                <span class="text-xs px-2 py-0.5 rounded bg-surface border border-line text-muted">{{ s.status }}</span>
                <button class="text-xs text-accent hover:underline" @click="openScript(s.id)">打开</button>
              </div>
              <div v-if="!scriptsForCase(selectedCase).length" class="text-sm text-muted-2">
                还没有脚本。让 Agent 跑一次 script-author，或在「脚本」页新建。
              </div>
            </div>
          </div>

          <div>
            <h4 class="text-sm font-medium text-fg mb-2">
              依据
              <span
                v-if="caseEvidence"
                class="text-xs font-normal ml-1 px-1.5 py-0.5 rounded"
                :class="caseEvidence.grounding === 'strong'
                  ? 'bg-success-soft text-success border border-success-line'
                  : caseEvidence.grounding === 'weak'
                    ? 'bg-warn-soft text-warn border border-warn-line'
                    : 'bg-surface-3 text-muted border border-line'"
              >{{ caseEvidence.grounding === 'strong' ? '有原文与参数' : caseEvidence.grounding === 'weak' ? '仅条款原文' : '无依据（模板）' }}</span>
            </h4>
            <div v-if="caseEvidence?.evidence" class="text-sm text-fg-2 space-y-1">
              <div class="text-xs text-muted">《{{ caseEvidence.evidence.doc }}》</div>
              <div class="text-xs bg-surface-2 border border-line rounded p-2 leading-relaxed">
                {{ caseEvidence.evidence.quote }}
              </div>
              <div v-if="caseEvidence.evidence.numbers?.length" class="text-xs text-muted">
                原文参数：{{ caseEvidence.evidence.numbers.join('、') }}
              </div>
            </div>
            <div v-else class="text-xs text-muted-2">
              这条用例是按功能点名套模板生成的，去「项目资料」把相关资料分解入库后重新生成，会带上原文条款与阈值。
            </div>
          </div>

          <div>
            <h4 class="text-sm font-medium text-fg mb-2">
              执行历史
              <span v-if="caseHistoryStats" class="text-xs text-muted-2 font-normal">
                {{ caseHistoryStats.passed }}/{{ caseHistoryStats.total }} 通过
              </span>
            </h4>
            <div v-if="historyLoading" class="text-sm text-muted-2">加载中…</div>
            <div v-else-if="caseHistory.length" class="space-y-1">
              <button
                v-for="h in caseHistory"
                :key="`${h.execution_id}-${h.started_at}`"
                class="w-full text-left flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-surface-2"
                @click="openExecution(h.execution_id)"
              >
                <span class="text-xs px-2 py-0.5 rounded flex-shrink-0" :class="resultClass(h.result)">{{ h.result }}</span>
                <span class="flex-1 text-sm text-fg truncate">{{ h.name }}</span>
                <span v-if="h.duration_ms != null" class="text-xs text-muted-2 flex-shrink-0">{{ Math.round(h.duration_ms) }} ms</span>
                <span class="text-xs text-muted-2 flex-shrink-0">{{ h.started_at }}</span>
              </button>
              <p v-for="h in caseHistory.filter(x => x.error_message)" :key="`err-${h.execution_id}`" class="ml-3 text-xs text-danger truncate">
                #{{ h.execution_id }}: {{ h.error_message }}
              </p>
            </div>
            <div v-else class="text-sm text-muted-2">
              还没有可关联的执行记录（只有带用例 id 的脚本执行会记在这里）。
            </div>
          </div>

          <div>
            <h4 class="text-sm font-medium text-fg mb-2">版本历史</h4>
            <div class="space-y-2">
              <div v-for="v in selectedCase.versions" :key="v.version" class="flex gap-3 text-sm">
                <span class="font-mono text-accent flex-shrink-0">{{ v.version }}</span>
                <div class="flex-1">
                  <p class="text-fg">{{ v.changes }}</p>
                  <p class="text-xs text-muted-2 mt-0.5">{{ v.time }} · {{ v.author }}</p>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="border-t border-line p-4 flex gap-2">
          <button @click="drawerOpen = false" class="flex-1 px-3 py-2 text-sm border border-line rounded-lg hover:bg-surface-2">关闭</button>
          <button
            :disabled="runningIds.includes(selectedCase.id)"
            @click="runCase(String(selectedCase.id))"
            class="flex-1 px-3 py-2 bg-accent-solid text-white rounded-lg hover:bg-blue-700 disabled:opacity-50">
            {{ runningIds.includes(selectedCase.id) ? '执行中…' : '执行' }}
          </button>
        </div>
      </div>
    </Transition>

    <!-- 新建用例对话框 -->
    <div v-if="createDialogOpen" class="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div class="bg-surface rounded-lg p-6 w-96">
        <h3 class="text-lg font-medium text-fg mb-4">新建测试用例</h3>
        <div class="space-y-4">
          <div>
            <label class="block text-sm text-fg-2 mb-1">用例名称</label>
            <input v-model="newCase.name" type="text" class="w-full px-3 py-2 border border-line rounded-lg text-sm" placeholder="比如：发动机启动后转速稳定测试" />
          </div>
          <div>
            <label class="block text-sm text-fg-2 mb-1">所属模块</label>
            <select v-model="newCase.module" class="w-full px-3 py-2 border border-line rounded-lg text-sm">
              <option value="发动机控制">发动机控制</option>
              <option value="变速箱控制">变速箱控制</option>
              <option value="电池管理">电池管理</option>
            </select>
          </div>
          <div>
            <label class="block text-sm text-fg-2 mb-1">用例类型</label>
            <select v-model="newCase.type" class="w-full px-3 py-2 border border-line rounded-lg text-sm">
              <option value="正向">正向</option>
              <option value="反向">反向</option>
              <option value="边界">边界</option>
              <option value="异常">异常</option>
            </select>
          </div>
          <div>
            <label class="block text-sm text-fg-2 mb-1">优先级</label>
            <select v-model="newCase.priority" class="w-full px-3 py-2 border border-line rounded-lg text-sm">
              <option value="高">高</option>
              <option value="中">中</option>
              <option value="低">低</option>
            </select>
          </div>
        </div>
        <div class="flex gap-3 mt-6">
          <button @click="createDialogOpen = false" class="flex-1 px-4 py-2 border border-line rounded-lg text-sm hover:bg-surface-2">取消</button>
          <button @click="createCase" class="flex-1 px-4 py-2 bg-accent-solid text-white rounded-lg text-sm hover:bg-blue-700">创建</button>
        </div>
      </div>
    </div>

    <!-- 导入用例对话框 -->
    <div v-if="importOpen" class="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div class="bg-surface rounded-lg p-6 w-96">
        <h3 class="text-lg font-medium text-fg mb-4">导入测试用例</h3>
        <p class="text-xs text-muted mb-4">
          选择「导出」生成的 JSON 数组。同名用例会被跳过，不会覆盖已有内容。
        </p>
        <input
          ref="importFile"
          type="file"
          accept="application/json,.json"
          :disabled="importing"
          class="w-full text-sm"
          @change="onImportPick"
        />
        <p v-if="importResult" class="text-xs text-fg-3 mt-3">{{ importResult }}</p>
        <div class="flex gap-3 mt-6">
          <button
            @click="importOpen = false; importResult = ''"
            class="flex-1 px-4 py-2 border border-line rounded-lg text-sm hover:bg-surface-2">
            关闭
          </button>
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
