<script setup lang="ts">
import ThemeSwitch from '@/components/theme-switch.vue'
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { Plus } from 'lucide-vue-next'
import Badge from '@/components/Badge.vue'
import EmptyState from '@/components/EmptyState.vue'

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

// 重命名 / 删除：删除是「移进回收目录」，但仍然要用户把项目名打对才放行。
const renameTarget = ref<any>(null)
const renameName = ref('')
const deleteTarget = ref<any>(null)
const deleteConfirmText = ref('')
const inlineMessage = ref('')

function openRename(p: any) {
  renameTarget.value = p
  renameName.value = p.name || ''
  inlineMessage.value = ''
}

async function submitRename() {
  const target = renameTarget.value
  if (!target) return
  const name = renameName.value.trim()
  if (!name) {
    inlineMessage.value = '项目名不能为空'
    return
  }
  try {
    const res = await fetch(`/api/projects/${target.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(body?.detail || `HTTP ${res.status}`)
    inlineMessage.value = `已改名为「${name}」`
    renameTarget.value = null
    await loadProjects()
  } catch (e: any) {
    inlineMessage.value = e?.message || '改名失败'
  }
}

function openDelete(p: any) {
  deleteTarget.value = p
  deleteConfirmText.value = ''
  inlineMessage.value = ''
}

async function submitDelete() {
  const target = deleteTarget.value
  if (!target) return
  try {
    const res = await fetch(
      `/api/projects/${target.id}?confirm=${encodeURIComponent(deleteConfirmText.value.trim())}`,
      { method: 'DELETE' },
    )
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(body?.detail || `HTTP ${res.status}`)
    inlineMessage.value = body?.message || '项目已移入回收目录'
    deleteTarget.value = null
    await loadProjects()
  } catch (e: any) {
    inlineMessage.value = e?.message || '删除失败'
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
  <div class="min-h-screen bg-surface-2">
    <header class="flex h-14 items-center justify-between border-b border-line bg-surface px-6">
      <div class="flex items-center gap-2">
        <span class="text-[14px] font-medium text-fg">自动化测试平台</span>
        <span class="text-[12px] text-muted-2">ECU / 座舱</span>
      </div>
      <div class="flex items-center gap-4">
        <ThemeSwitch />
        <span class="flex h-7 w-7 items-center justify-center rounded-[6px] bg-surface-3 text-[12px] text-fg">测</span>
      </div>
    </header>

    <div class="mx-auto max-w-[1000px] px-8 py-9">
      <header class="flex items-start justify-between gap-4">
        <div>
          <h1 class="text-[24px] font-medium leading-8 text-fg">测试工作台</h1>
          <p class="mt-1 text-[13px] text-muted">一个项目一条链路：资料 → 知识库 → 用例 → 脚本 → 执行 → 报告。</p>
        </div>
        <button
          class="flex h-9 items-center gap-2 rounded-[8px] bg-accent-solid px-3 text-[13px] text-white hover:bg-accent"
          @click="createDialogOpen = true"
        >
          <Plus class="h-4 w-4" /> 新建项目
        </button>
      </header>

      <!-- 读数：三个数并排，用分隔线而不是三张卡片 -->
      <div class="mt-6 grid grid-cols-3 divide-line rounded-[12px] border border-line bg-surface divide-x">
        <div class="px-5 py-4">
          <p class="text-[12px] text-muted">项目</p>
          <p class="num mt-1 text-[24px] leading-7 text-fg">{{ stats.totalProjects }}</p>
        </div>
        <div class="px-5 py-4">
          <p class="text-[12px] text-muted">用例</p>
          <p class="num mt-1 text-[24px] leading-7 text-fg">{{ stats.totalCases }}</p>
        </div>
        <div class="px-5 py-4">
          <p class="text-[12px] text-muted">执行次数</p>
          <p class="num mt-1 text-[24px] leading-7 text-fg">{{ stats.totalExecutions }}</p>
        </div>
      </div>

      <h2 class="mt-8 text-[13px] font-medium text-fg">我的项目</h2>

      <div class="mt-3 overflow-hidden rounded-[12px] border border-line bg-surface">
        <button
          v-for="p in projects"
          :key="p.id"
          class="grid w-full grid-cols-1 items-center gap-3 border-b border-line-soft px-5 py-3 text-left last:border-b-0 hover:bg-surface-2 lg:grid-cols-[1fr_120px_120px_120px_auto]"
          @click="enterProject(p.id)"
        >
          <div class="min-w-0">
            <p class="truncate text-[14px] text-fg">{{ p.name }}</p>
            <p class="truncate text-[12px] text-muted">{{ p.description }}</p>
          </div>
          <Badge tone="neutral">{{ p.type }}</Badge>
          <span class="num text-[12px] text-muted">{{ p.case_count }} 用例</span>
          <span class="num text-[12px] text-muted">{{ p.execution_count }} 次执行</span>
          <span class="flex items-center justify-end gap-3" @click.stop>
            <span class="num text-[12px] text-muted-2">{{ p.last_active }}</span>
            <button class="text-[12px] text-muted hover:text-fg" @click="openRename(p)">重命名</button>
            <button class="text-[12px] text-muted hover:text-danger" @click="openDelete(p)">删除</button>
          </span>
        </button>

        <EmptyState
          v-if="!projects.length"
          class="m-5"
          title="还没有项目"
          hint="点右上「新建项目」，一个项目对应一套资料、用例和脚本"
        />
      </div>

      <p v-if="inlineMessage" class="mt-3 text-[12px] text-muted">{{ inlineMessage }}</p>

      <!-- 重命名 -->
      <div v-if="renameTarget" class="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
        <div class="w-96 rounded-[12px] border border-line bg-surface p-6">
          <h3 class="text-[15px] font-medium text-fg">重命名项目</h3>
          <input v-model="renameName" type="text" class="mt-3 h-9 w-full rounded-[8px] border border-line bg-surface px-2 text-[13px] text-fg" />
          <p class="mono mt-2 text-[12px] text-muted-2">项目 id（{{ renameTarget.id }}）不变，只改显示名。</p>
          <div class="mt-5 flex gap-3">
            <button class="h-9 flex-1 rounded-[8px] border border-line text-[13px] text-fg hover:bg-surface-3" @click="renameTarget = null">取消</button>
            <button class="h-9 flex-1 rounded-[8px] bg-accent-solid text-[13px] text-white hover:bg-accent" @click="submitRename">保存</button>
          </div>
        </div>
      </div>

      <!-- 删除确认 -->
      <div v-if="deleteTarget" class="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
        <div class="w-[440px] rounded-[12px] border border-line bg-surface p-6">
          <h3 class="text-[15px] font-medium text-fg">删除「{{ deleteTarget.name }}」？</h3>
          <p class="mt-2 text-[13px] leading-6 text-muted">
            项目里的需求、用例、脚本、执行记录和报告都会一起移出列表。目录不会被真正删除，而是移到 workspace 的
            <code class="mono text-[12px]">.trash/</code> 下，需要时可以捡回来。
          </p>
          <label class="mono mt-3 block text-[12px] text-muted">
            输入项目 id 确认：{{ deleteTarget.id }}
          </label>
          <input
            v-model="deleteConfirmText"
            type="text"
            class="mono mt-1 h-9 w-full rounded-[8px] border border-line bg-surface px-2 text-[12px] text-fg"
            :placeholder="deleteTarget.id"
          />
          <div class="mt-5 flex gap-3">
            <button class="h-9 flex-1 rounded-[8px] border border-line text-[13px] text-fg hover:bg-surface-3" @click="deleteTarget = null">取消</button>
            <button
              :disabled="deleteConfirmText.trim() !== deleteTarget.id"
              class="h-9 flex-1 rounded-[8px] bg-danger text-[13px] text-white hover:opacity-90 disabled:opacity-40"
              @click="submitDelete"
            >确认删除</button>
          </div>
        </div>
      </div>

      <!-- 新建项目 -->
      <div v-if="createDialogOpen" class="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
        <div class="w-96 rounded-[12px] border border-line bg-surface p-6">
          <h3 class="text-[15px] font-medium text-fg">新建项目</h3>
          <div class="mt-3 space-y-3">
            <div>
              <label class="block text-[12px] text-muted">项目名称</label>
              <input v-model="newProject.name" type="text" class="mt-1 h-9 w-full rounded-[8px] border border-line bg-surface px-2 text-[13px] text-fg placeholder:text-muted-2" placeholder="比如：深蓝 S7 ECU 测试" />
            </div>
            <div>
              <label class="block text-[12px] text-muted">项目描述</label>
              <textarea v-model="newProject.description" rows="3" class="mt-1 w-full rounded-[8px] border border-line bg-surface px-2 py-1.5 text-[13px] text-fg placeholder:text-muted-2" placeholder="这个项目测什么"></textarea>
            </div>
            <div>
              <label class="block text-[12px] text-muted">项目类型</label>
              <select v-model="newProject.type" class="mt-1 h-9 w-full rounded-[8px] border border-line bg-surface px-2 text-[13px] text-fg">
                <option value="ECU">ECU 动力域</option>
                <option value="座舱">座舱域</option>
              </select>
            </div>
          </div>
          <div class="mt-5 flex gap-3">
            <button class="h-9 flex-1 rounded-[8px] border border-line text-[13px] text-fg hover:bg-surface-3" @click="createDialogOpen = false">取消</button>
            <button class="h-9 flex-1 rounded-[8px] bg-accent-solid text-[13px] text-white hover:bg-accent" @click="createProject">创建</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
