<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Plus, Code2, Play } from 'lucide-vue-next'

const route = useRoute()
const router = useRouter()
const projectId = route.params.projectId as string

const scripts = ref<any[]>([])
const runningIds = ref<string[]>([])
const message = ref('')
const error = ref('')

async function loadScripts() {
  try {
    const res = await fetch(`/api/projects/${projectId}/scripts`)
    const data = await res.json()
    scripts.value = data.scripts || []
  } catch (e) {
    console.error('加载脚本失败', e)
  }
}

// 运行脚本：走 /scripts/{id}/run?background=true，执行行随后在「执行」页出现。
// 这个按钮以前没有 @click，脚本卡片上写着「运行」却点不动。
async function runScript(s: any) {
  if (runningIds.value.includes(s.id)) return
  runningIds.value.push(s.id)
  message.value = ''
  error.value = ''
  try {
    const res = await fetch(
      `/api/projects/${projectId}/scripts/${s.id}/run?background=true`,
      { method: 'POST' },
    )
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}))
      throw new Error(detail.detail || `${res.status} ${res.statusText}`)
    }
    message.value = `${s.name} 已开始执行，进度见「执行」页`
    await loadScripts()
  } catch (e) {
    error.value = `执行失败：${(e as Error).message}`
  } finally {
    runningIds.value = runningIds.value.filter(x => x !== s.id)
  }
}

// 新建脚本：建一个空脚本并直接进编辑器。名称按已有数量递增，避免重名覆盖。
async function createScript() {
  const name = `script_${scripts.value.length + 1}.py`
  try {
    const res = await fetch(`/api/projects/${projectId}/scripts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, language: 'python', content: '' }),
    })
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
    const created = await res.json()
    router.push(`/project/${projectId}/scripts/${created.id}/edit`)
  } catch (e) {
    error.value = `新建脚本失败：${(e as Error).message}`
  }
}

onMounted(() => {
  loadScripts()
})

function openEdit(s: any) {
  router.push(`/project/${projectId}/scripts/${s.id}/edit`)
}

// ---- 门禁：脚本没过 gate 不许执行 ----------------------------------------
// 后端有 /scripts/{id}/check（静态检查）和 /scripts/{id}/gate（门禁判定），
// 但界面上没有入口，等于「未过门禁不得执行」这条硬约束只写在工具里。这里把
// 两个动作放出来，并把结果记在卡片上；gate 没过时「运行」直接置灰。

type GateState = { state: 'idle' | 'checking' | 'gating' | 'ok' | 'fail'; detail: string }
const gates = ref<Record<string, GateState>>({})

function gateOf(id: string): GateState {
  return gates.value[id] ?? { state: 'idle', detail: '' }
}

async function checkScript(s: any) {
  gates.value[s.id] = { state: 'checking', detail: '检查中…' }
  try {
    const res = await fetch(`/api/projects/${projectId}/scripts/${s.id}/check`, { method: 'POST' })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(body?.detail || `HTTP ${res.status}`)
    const count = Number(body?.errorCount ?? body?.errors?.length ?? 0)
    const firstError = (body?.errors || [])[0]
    const unavailable = body?.unavailable ? `（${body.unavailable}）` : ''
    gates.value[s.id] = {
      state: count > 0 ? 'fail' : 'ok',
      detail: count > 0
        ? `${count} 处问题：${typeof firstError === 'string' ? firstError : JSON.stringify(firstError)}`
        : `静态检查通过${unavailable}`,
    }
  } catch (e) {
    gates.value[s.id] = { state: 'fail', detail: `检查失败：${(e as Error).message}` }
  }
}

async function runGate(s: any) {
  gates.value[s.id] = { state: 'gating', detail: '判定中…' }
  try {
    const res = await fetch(`/api/projects/${projectId}/scripts/${s.id}/gate`, { method: 'POST' })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(body?.detail || `HTTP ${res.status}`)
    const ok = body?.ok === true
    const failures = (body?.failures || []) as unknown[]
    gates.value[s.id] = {
      state: ok ? 'ok' : 'fail',
      detail: ok ? '门禁通过，可以执行' : `门禁未过：${failures.map(f => (typeof f === 'string' ? f : JSON.stringify(f))).join('；')}`,
    }
    await loadScripts()
  } catch (e) {
    gates.value[s.id] = { state: 'fail', detail: `门禁失败：${(e as Error).message}` }
  }
}

function gateClass(id: string) {
  const state = gateOf(id).state
  if (state === 'ok') return 'bg-green-50 text-green-600'
  if (state === 'fail') return 'bg-red-50 text-red-600'
  if (state === 'checking' || state === 'gating') return 'bg-blue-50 text-blue-600'
  return 'bg-gray-100 text-gray-500'
}

function gateLabel(id: string) {
  const state = gateOf(id).state
  if (state === 'ok') return '门禁通过'
  if (state === 'fail') return '门禁未过'
  if (state === 'checking') return '检查中…'
  if (state === 'gating') return '判定中…'
  return '未过门禁'
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
        <button @click="createScript" class="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-gray-200 rounded-lg hover:bg-gray-50">
          <Plus class="w-4 h-4" />
          新建脚本
        </button>
      </div>
    </div>

    <p v-if="message" class="px-6 py-2 text-xs text-green-600 bg-green-50 border-b border-green-100">{{ message }}</p>
    <p v-if="error" class="px-6 py-2 text-xs text-red-600 bg-red-50 border-b border-red-100">{{ error }}</p>

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
            <span class="text-xs px-2 py-0.5 rounded" :class="gateClass(s.id)">{{ gateLabel(s.id) }}</span>
            <span class="text-xs text-gray-400">{{ s.language }}</span>
          </div>
          <p v-if="gateOf(s.id).detail" class="mt-2 text-xs leading-relaxed"
            :class="gateOf(s.id).state === 'fail' ? 'text-red-600' : 'text-gray-500'">
            {{ gateOf(s.id).detail }}
          </p>
          <div class="mt-4 flex gap-2">
            <button @click="openEdit(s)" class="flex-1 px-3 py-1.5 text-xs border border-gray-200 rounded hover:bg-gray-100">编辑</button>
            <button
              :disabled="gateOf(s.id).state === 'checking' || gateOf(s.id).state === 'gating'"
              @click="checkScript(s)"
              class="px-3 py-1.5 text-xs border border-gray-200 rounded hover:bg-gray-100 disabled:opacity-50">
              校验
            </button>
            <button
              :disabled="gateOf(s.id).state === 'checking' || gateOf(s.id).state === 'gating'"
              @click="runGate(s)"
              class="px-3 py-1.5 text-xs border border-gray-200 rounded hover:bg-gray-100 disabled:opacity-50">
              过门禁
            </button>
            <button
              :disabled="runningIds.includes(s.id) || gateOf(s.id).state === 'fail'"
              :title="gateOf(s.id).state === 'fail' ? '门禁未过，先修脚本再过门禁' : ''"
              @click="runScript(s)"
              class="flex-1 px-3 py-1.5 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-1">
              <Play class="w-3 h-3" />
              {{ runningIds.includes(s.id) ? '执行中…' : '运行' }}
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
