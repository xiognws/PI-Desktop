<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Plus, Play } from 'lucide-vue-next'
import Badge from '@/components/Badge.vue'
import EmptyState from '@/components/EmptyState.vue'

const route = useRoute()
const router = useRouter()
const projectId = route.params.projectId as string

const scripts = ref<any[]>([])
const runningIds = ref<string[]>([])
const message = ref('')
const error = ref('')
// 断言覆盖：骨架脚本执行也是绿的，所以「多少个脚本真在验」要单独显示
const coverage = ref({ asserted: 0, skeleton: 0 })

async function loadScripts() {
  try {
    const res = await fetch(`/api/projects/${projectId}/scripts`)
    const data = await res.json()
    scripts.value = data.scripts || []
    coverage.value = { asserted: data.asserted_total ?? 0, skeleton: data.skeleton_total ?? 0 }
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

function assertionTone(s: any): 'success' | 'warn' | 'neutral' {
  if (s.assertion_state === 'asserted') return 'success'
  if (s.assertion_state === 'skeleton') return 'warn'
  return 'neutral'
}

function assertionLabel(s: any): string {
  if (s.assertion_state === 'asserted') return `真断言 ${s.assert_count}`
  if (s.assertion_state === 'skeleton') return '骨架'
  return '文件缺失'
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
  <div class="flex-1 overflow-auto bg-surface-2">
    <div class="mx-auto w-full max-w-[1200px] px-8 py-7">
      <header class="flex items-start justify-between gap-4">
        <div>
          <h1 class="text-[20px] font-medium text-fg">脚本</h1>
          <p class="mt-1 text-[13px] text-muted">
            每条用例一个 pytest 文件。骨架执行只会跳过，补上断言的脚本才会真的判定。
          </p>
        </div>
        <button
          class="flex h-9 items-center gap-2 rounded-[8px] border border-line bg-surface px-3 text-[13px] text-fg hover:bg-surface-3"
          @click="createScript"
        >
          <Plus class="h-4 w-4" /> 新建脚本
        </button>
      </header>

      <div class="mt-5 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-[12px] border border-line bg-surface px-5 py-3">
        <span class="mono text-[13px] text-fg">{{ scripts.length }}<span class="text-muted"> 个</span></span>
        <span class="mono text-[12px] text-success">真断言 {{ coverage.asserted }}</span>
        <span class="mono text-[12px] text-warn">骨架 {{ coverage.skeleton }}</span>
      </div>

      <p v-if="message" class="mt-3 text-[13px] text-success">{{ message }}</p>
      <p v-if="error" class="mt-3 text-[13px] text-danger">{{ error }}</p>

      <div class="mt-5 overflow-hidden rounded-[12px] border border-line bg-surface">
        <div
          class="hidden grid-cols-[1fr_120px_120px_1fr_auto] gap-4 border-b border-line px-5 py-2 text-[12px] text-muted-2 md:grid"
        >
          <span>脚本</span>
          <span>断言</span>
          <span>门禁</span>
          <span>关联用例</span>
          <span class="text-right">操作</span>
        </div>

        <div
          v-for="s in scripts"
          :key="s.id"
          class="state-bar grid grid-cols-1 items-start gap-4 border-b border-line-soft px-5 py-3 last:border-b-0 md:grid-cols-[1fr_120px_120px_1fr_auto]"
          :data-tone="assertionTone(s) === 'success' ? 'success' : assertionTone(s) === 'warn' ? 'warn' : 'neutral'"
        >
          <div class="min-w-0">
            <p class="mono truncate text-[13px] text-fg">{{ s.name }}</p>
            <p class="mono truncate text-[12px] text-muted-2">{{ s.language }} · {{ s.status }}</p>
          </div>

          <Badge :tone="assertionTone(s)">{{ assertionLabel(s) }}</Badge>

          <div class="min-w-0">
            <span class="text-[12px]" :class="gateOf(s.id).state === 'fail' ? 'text-danger' : 'text-muted'">
              {{ gateLabel(s.id) }}
            </span>
            <p v-if="gateOf(s.id).detail" class="mt-0.5 text-[12px] leading-4 text-muted-2">
              {{ gateOf(s.id).detail }}
            </p>
          </div>

          <div class="min-w-0">
            <p class="mono truncate text-[12px]" :class="s.case_missing ? 'text-warn' : 'text-muted'">
              {{ s.case_id || '未关联' }}
            </p>
            <p v-if="s.case_missing" class="mt-0.5 text-[12px] leading-4 text-warn">
              用例已删除，结果对不回需求；重新设计用例后确认是否重出
            </p>
          </div>

          <div class="flex items-center justify-end gap-1">
            <button
              class="h-8 rounded-[8px] px-2 text-[13px] text-muted hover:bg-surface-3 hover:text-fg"
              @click="openEdit(s)"
            >编辑</button>
            <button
              class="h-8 rounded-[8px] px-2 text-[13px] text-muted hover:bg-surface-3 hover:text-fg disabled:opacity-40"
              :disabled="gateOf(s.id).state === 'checking' || gateOf(s.id).state === 'gating'"
              @click="checkScript(s)"
            >校验</button>
            <button
              class="h-8 rounded-[8px] px-2 text-[13px] text-muted hover:bg-surface-3 hover:text-fg disabled:opacity-40"
              :disabled="gateOf(s.id).state === 'checking' || gateOf(s.id).state === 'gating'"
              @click="runGate(s)"
            >过门禁</button>
            <button
              class="flex h-8 items-center gap-2 rounded-[8px] bg-accent-solid px-3 text-[13px] text-white hover:bg-accent disabled:opacity-40"
              :disabled="runningIds.includes(s.id) || gateOf(s.id).state === 'fail'"
              :title="gateOf(s.id).state === 'fail' ? '门禁未过，先修脚本再过门禁' : ''"
              @click="runScript(s)"
            >
              <Play class="h-3.5 w-3.5" />
              {{ runningIds.includes(s.id) ? '执行中' : '运行' }}
            </button>
          </div>
        </div>

        <EmptyState
          v-if="scripts.length === 0"
          class="m-5"
          title="还没有脚本"
          hint="先到「流水线」第 ⑤ 步生成，或点右上角新建一个空脚本自己写"
        />
      </div>
    </div>
  </div>
</template>
