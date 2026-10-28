<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { Play, RefreshCw, Check, RotateCcw, Square, AlertTriangle } from 'lucide-vue-next'

const route = useRoute()
const projectId = route.params.projectId as string

type Stage = {
  stage: string
  attempt: number
  status: string
  error?: string | null
  output_json?: any
  started_at?: string | null
  finished_at?: string | null
}
type Pipeline = {
  id: string
  requirement_filename?: string
  status: string
  current_stage: string
  checkpoint_policy: string
  target_url?: string
  created_at?: string
  finished_at?: string | null
}
type State = { pipeline: Pipeline; stages: Stage[]; agent_calls: any[] }

const STAGE_LABELS: Record<string, string> = {
  analyze: '需求分析',
  design: '用例设计',
  author: '脚本工程',
  gate: '静态闸门',
  execute: '脚本执行',
  judge: '结果判定',
  repair: '脚本修复',
  report: '结果收集',
}
const STATUS_LABELS: Record<string, string> = {
  running: '进行中',
  waiting: '待确认',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
  pending: '未开始',
  skipped: '跳过',
  superseded: '已被重跑替换',
}
const POLICY_LABELS: Record<string, string> = {
  analyze: '仅需求分析后确认',
  analyze_author: '需求分析 + 脚本生成后确认',
  auto: '全自动（不暂停）',
}

const pipelines = ref<Pipeline[]>([])
const selectedId = ref('')
const detail = ref<State | null>(null)
const requirements = ref<{ filename: string }[]>([])
const form = ref({ requirementFilename: '', targetUrl: '', checkpointPolicy: 'analyze' })
type Schedule = {
  id: string
  name: string
  requirement_filename: string
  target_url?: string
  kind: 'daily' | 'interval'
  at_time?: string
  interval_minutes?: number
  enabled: number
  next_run_at?: string
  last_run_at?: string
  last_pipeline_id?: string
}
const schedules = ref<Schedule[]>([])
const scheduleForm = ref({
  name: '夜间回归',
  kind: 'daily' as 'daily' | 'interval',
  atTime: '02:00',
  intervalMinutes: 60,
})
const busy = ref(false)
const message = ref('')

let timer: number | undefined

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    headers: { 'content-type': 'application/json' },
    ...init,
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error((body as any)?.detail || `HTTP ${response.status}`)
  return body as T
}

async function loadList() {
  const body = await json<{ pipelines: Pipeline[] }>(`/projects/${projectId}/pipelines`)
  pipelines.value = body.pipelines || []
  if (!selectedId.value && pipelines.value.length) {
    selectedId.value = pipelines.value[0].id
    await loadDetail()
  }
}

async function loadDetail() {

  // 首次进入时列表刚加载完，selectedId 可能还没落；直接回退到第一条，避免空白
  const id = selectedId.value || pipelines.value[0]?.id || ''
  if (!id) {
    detail.value = null
    return
  }
  if (selectedId.value !== id) selectedId.value = id
  detail.value = await json<State>(`/projects/${projectId}/pipelines/${id}`)
}

async function loadSchedules() {
  const body = await json<{ schedules: Schedule[] }>(`/projects/${projectId}/schedules`)
  schedules.value = body.schedules || []
}

async function createSchedule() {
  message.value = ''
  try {
    await json(`/projects/${projectId}/schedules`, {
      method: 'POST',
      body: JSON.stringify({
        name: scheduleForm.value.name,
        requirementFilename: form.value.requirementFilename,
        targetUrl: form.value.targetUrl,
        kind: scheduleForm.value.kind,
        atTime: scheduleForm.value.atTime,
        intervalMinutes: scheduleForm.value.intervalMinutes,
      }),
    })
    await loadSchedules()
    message.value = '计划已创建；到点后插件会自动用「全自动」策略启动流水线'
  } catch (error) {
    message.value = String((error as Error).message || error)
  }
}

async function toggleSchedule(row: Schedule) {
  try {
    await json(`/projects/${projectId}/schedules/${row.id}`, {
      method: 'PUT',
      body: JSON.stringify({ enabled: !row.enabled }),
    })
    await loadSchedules()
  } catch (error) {
    message.value = String((error as Error).message || error)
  }
}

async function fireSchedule(row: Schedule) {
  try {
    const fired = await json<{ pipeline: { id: string } }>(`/projects/${projectId}/schedules/${row.id}/fire`, {
      method: 'POST',
      body: '{}',
    })
    selectedId.value = fired.pipeline.id
    await refresh()
    message.value = `已按计划启动 ${fired.pipeline.id}`
  } catch (error) {
    message.value = String((error as Error).message || error)
  }
}

async function removeSchedule(row: Schedule) {
  try {
    await json(`/projects/${projectId}/schedules/${row.id}`, { method: 'DELETE' })
    await loadSchedules()
  } catch (error) {
    message.value = String((error as Error).message || error)
  }
}

async function loadRequirements() {
  const body = await json<{ requirements: { filename: string }[] }>(
    `/projects/${projectId}/requirements`,
  )
  requirements.value = body.requirements || []
  const known = requirements.value.some((item) => item.filename === form.value.requirementFilename)
  if (!known && requirements.value.length) {
    form.value.requirementFilename = requirements.value[0].filename
  }
}

async function refresh() {
  try {
    // 顺序请求：并发打同一个后端时，浏览器侧出现过请求悬挂（detail/requirements
    // 永不 settle），串行后稳定。三个请求都是毫秒级，串行代价可忽略。
    await loadList()
    if (selectedId.value) await loadDetail()
    await loadRequirements()
    await loadSchedules()
  } catch (error) {
    message.value = String((error as Error).message || error)
  }
}

// 列表首次到达时自动选中第一条并取详情（放在 watch 里，避免与首帧渲染抢时序）
watch(pipelines, async (list) => {
  if (!selectedId.value && list.length) {
    selectedId.value = list[0].id
    try {
      await loadDetail()
    } catch (error) {
      message.value = String((error as Error).message || error)
    }
  }
})

async function start() {
  busy.value = true
  message.value = ''
  try {
    const created = await json<State>(`/projects/${projectId}/pipelines`, {
      method: 'POST',
      body: JSON.stringify({
        requirementFilename: form.value.requirementFilename,
        targetUrl: form.value.targetUrl,
        checkpointPolicy: form.value.checkpointPolicy,
      }),
    })
    selectedId.value = created.pipeline.id
    await refresh()
    message.value = '流水线已创建，桌面端插件会推进它（每 2.5s 检查一次）'
  } catch (error) {
    message.value = String((error as Error).message || error)
  } finally {
    busy.value = false
  }
}

async function act(action: 'approve' | 'retry' | 'cancel') {
  if (!selectedId.value) return
  try {
    await json(`/projects/${projectId}/pipelines/${selectedId.value}/${action}`, { method: 'POST', body: '{}' })
    await refresh()
  } catch (error) {
    message.value = String((error as Error).message || error)
  }
}

const reportText = ref('')
async function openReport() {
  if (!selectedId.value) return
  try {
    const body = await json<{ markdown: string }>(`/projects/${projectId}/pipelines/${selectedId.value}/report`)
    reportText.value = body.markdown || ''
  } catch (error) {
    message.value = String((error as Error).message || error)
  }
}

const stageRows = computed(() => detail.value?.stages.filter((row) => row.status !== 'superseded') ?? [])
const waiting = computed(() => detail.value?.pipeline.status === 'waiting')
const live = computed(() => ['running', 'waiting'].includes(detail.value?.pipeline.status || ''))

function stageClass(status: string) {
  if (status === 'done') return 'text-green-600'
  if (status === 'failed') return 'text-red-600'
  if (status === 'running') return 'text-blue-600'
  if (status === 'cancelled') return 'text-gray-500'
  return 'text-gray-400'
}

onMounted(async () => {
  await refresh()
  timer = window.setInterval(refresh, 2500)
})
onUnmounted(() => {
  if (timer) window.clearInterval(timer)
})
</script>

<template>
  <div class="flex-1 overflow-auto p-6">
    <div class="max-w-5xl space-y-5">
      <header class="flex items-center justify-between">
        <div>
          <h2 class="text-lg font-semibold text-gray-900">测试流水线</h2>
          <p class="text-xs text-gray-500 mt-1">
            需求分析 → 用例设计 → 脚本工程 → 静态闸门 → 脚本执行 → 结果判定 → 脚本修复 → 结果收集；模型来自桌面端当前会话，规则由平台强制
          </p>
        </div>
        <button class="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-gray-300 rounded-lg hover:bg-gray-50" @click="refresh">
          <RefreshCw class="w-3.5 h-3.5" /> 刷新
        </button>
      </header>

      <!-- 新建 -->
      <section class="border border-gray-200 rounded-xl p-4 bg-white space-y-3">
        <div class="grid grid-cols-3 gap-3">
          <label class="text-xs text-gray-600 space-y-1">
            <span>需求文档</span>
            <select v-model="form.requirementFilename" class="w-full border border-gray-300 rounded-lg px-2 py-1.5 text-sm">
              <option value="">（未选择）</option>
              <option v-for="item in requirements" :key="item.filename" :value="item.filename">{{ item.filename }}</option>
            </select>
          </label>
          <label class="text-xs text-gray-600 space-y-1">
            <span>被测应用地址（e2e 用）</span>
            <input v-model="form.targetUrl" placeholder="http://127.0.0.1:4000" class="w-full border border-gray-300 rounded-lg px-2 py-1.5 text-sm" />
          </label>
          <label class="text-xs text-gray-600 space-y-1">
            <span>确认策略</span>
            <select v-model="form.checkpointPolicy" class="w-full border border-gray-300 rounded-lg px-2 py-1.5 text-sm">
              <option value="analyze">仅需求分析后确认</option>
              <option value="analyze_author">需求分析 + 脚本生成后确认</option>
              <option value="auto">全自动（不暂停）</option>
            </select>
          </label>
        </div>
        <div class="flex items-center gap-3">
          <button
            class="flex items-center gap-1.5 px-3 py-1.5 text-xs text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50"
            :disabled="busy || !form.requirementFilename"
            @click="start"
          >
            <Play class="w-3.5 h-3.5" /> 开始流水线
          </button>
          <span v-if="message" class="text-xs text-gray-600">{{ message }}</span>
        </div>
      </section>

      <!-- 定时计划：到点由插件自动用 auto 策略启动，跑完会汇报 -->
      <section class="border border-gray-200 rounded-xl p-4 bg-white space-y-3">
        <div class="flex items-center justify-between">
          <div>
            <h3 class="text-sm font-medium text-gray-900">定时计划</h3>
            <p class="text-xs text-gray-500 mt-0.5">到点自动启动（固定全自动策略，不暂停）；跑完会把结果汇报到桌面端</p>
          </div>
          <span class="text-xs text-gray-400">{{ schedules.length }} 条</span>
        </div>

        <div class="grid grid-cols-[1.2fr_1fr_1fr_1.4fr_auto] gap-2 items-end">
          <label class="text-xs text-gray-600 space-y-1">
            <span>名称</span>
            <input v-model="scheduleForm.name" class="w-full border border-gray-300 rounded-lg px-2 py-1.5 text-sm" />
          </label>
          <label class="text-xs text-gray-600 space-y-1">
            <span>类型</span>
            <select v-model="scheduleForm.kind" class="w-full border border-gray-300 rounded-lg px-2 py-1.5 text-sm">
              <option value="daily">每天定时</option>
              <option value="interval">固定间隔</option>
            </select>
          </label>
          <label v-if="scheduleForm.kind === 'daily'" class="text-xs text-gray-600 space-y-1">
            <span>时间</span>
            <input v-model="scheduleForm.atTime" placeholder="02:00" class="w-full border border-gray-300 rounded-lg px-2 py-1.5 text-sm" />
          </label>
          <label v-else class="text-xs text-gray-600 space-y-1">
            <span>间隔（分钟）</span>
            <input v-model.number="scheduleForm.intervalMinutes" type="number" min="5" class="w-full border border-gray-300 rounded-lg px-2 py-1.5 text-sm" />
          </label>
          <div class="text-xs text-gray-500 pb-2">
            用上面选择的需求文档{{ form.requirementFilename ? `（${form.requirementFilename}）` : '（先选需求）' }}
          </div>
          <button
            class="px-3 py-1.5 text-xs text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50"
            :disabled="!form.requirementFilename"
            @click="createSchedule"
          >
            添加计划
          </button>
        </div>

        <table class="w-full text-xs">
          <thead class="text-gray-400">
            <tr>
              <th class="text-left font-normal py-1">计划</th>
              <th class="text-left font-normal">规则</th>
              <th class="text-left font-normal">下次运行</th>
              <th class="text-left font-normal">上次</th>
              <th class="text-left font-normal">状态</th>
              <th class="text-right font-normal">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in schedules" :key="row.id" class="border-t border-gray-50">
              <td class="py-1.5 text-gray-800">{{ row.name }}</td>
              <td class="text-gray-500">{{ row.kind === 'daily' ? `每天 ${row.at_time}` : `每 ${row.interval_minutes} 分钟` }}</td>
              <td class="text-gray-500">{{ row.next_run_at || '—' }}</td>
              <td class="text-gray-500">{{ row.last_run_at || '—' }}</td>
              <td :class="row.enabled ? 'text-green-600' : 'text-gray-400'">{{ row.enabled ? '启用' : '停用' }}</td>
              <td class="text-right space-x-2">
                <button class="text-blue-600 hover:underline" @click="fireSchedule(row)">立即运行</button>
                <button class="text-gray-600 hover:underline" @click="toggleSchedule(row)">{{ row.enabled ? '停用' : '启用' }}</button>
                <button class="text-red-600 hover:underline" @click="removeSchedule(row)">删除</button>
              </td>
            </tr>
            <tr v-if="!schedules.length"><td colspan="6" class="py-2 text-gray-400">还没有计划任务</td></tr>
          </tbody>
        </table>
      </section>

      <div class="grid grid-cols-[260px_1fr] gap-4">
        <!-- 列表 -->
        <aside class="border border-gray-200 rounded-xl bg-white overflow-hidden">
          <div class="px-3 py-2 text-xs text-gray-500 border-b border-gray-100">历史流水线</div>
          <button
            v-for="item in pipelines"
            :key="item.id"
            class="w-full text-left px-3 py-2 border-b border-gray-50 hover:bg-gray-50"
            :class="item.id === selectedId ? 'bg-blue-50' : ''"
            @click="selectedId = item.id; loadDetail()"
          >
            <div class="flex items-center justify-between text-xs">
              <span class="text-gray-800">{{ item.requirement_filename || '未命名需求' }}</span>
              <span :class="item.status === 'failed' ? 'text-red-600' : item.status === 'waiting' ? 'text-amber-600' : 'text-gray-500'">
                {{ STATUS_LABELS[item.status] || item.status }}
              </span>
            </div>
            <div class="text-[11px] text-gray-400 mt-0.5">{{ item.id }} · {{ POLICY_LABELS[item.checkpoint_policy] }}</div>
          </button>
          <div v-if="!pipelines.length" class="px-3 py-6 text-xs text-gray-400 text-center">还没有流水线</div>
        </aside>

        <!-- 详情 -->
        <section class="border border-gray-200 rounded-xl bg-white p-4 space-y-4">
          <div v-if="!detail" class="text-xs text-gray-400">选择左侧一条流水线查看阶段</div>
          <template v-else>
            <div class="flex items-center justify-between">
              <div class="text-sm text-gray-900">
                {{ detail.pipeline.id }}
                <span class="ml-2 text-xs text-gray-500">{{ STATUS_LABELS[detail.pipeline.status] }} · 当前 {{ STAGE_LABELS[detail.pipeline.current_stage] || detail.pipeline.current_stage }}</span>
              </div>
              <div class="flex items-center gap-2">
                <button v-if="waiting" class="flex items-center gap-1 px-2.5 py-1 text-xs text-white bg-green-600 rounded-lg hover:bg-green-700" @click="act('approve')">
                  <Check class="w-3.5 h-3.5" /> 确认继续
                </button>
                <button v-if="waiting" class="flex items-center gap-1 px-2.5 py-1 text-xs border border-gray-300 rounded-lg hover:bg-gray-50" @click="act('retry')">
                  <RotateCcw class="w-3.5 h-3.5" /> 重跑本段
                </button>
                <button v-if="live" class="flex items-center gap-1 px-2.5 py-1 text-xs border border-gray-300 rounded-lg hover:bg-gray-50" @click="act('cancel')">
                  <Square class="w-3.5 h-3.5" /> 取消
                </button>
              </div>
            </div>

            <div v-if="detail.pipeline.status === 'failed'" class="flex items-start gap-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              <AlertTriangle class="w-4 h-4 flex-shrink-0" />
              <div>
                <div class="font-medium">流水线失败，未生成任何“通过”结论</div>
                <div class="mt-0.5">{{ stageRows.filter((r) => r.error).map((r) => `${STAGE_LABELS[r.stage] || r.stage}: ${r.error}`).join(' | ') }}</div>
              </div>
            </div>

            <div class="space-y-2">
              <div v-for="row in stageRows" :key="`${row.stage}-${row.attempt}`" class="border border-gray-100 rounded-lg px-3 py-2">
                <div class="flex items-center justify-between text-xs">
                  <span class="text-gray-800">{{ STAGE_LABELS[row.stage] || row.stage }} <span class="text-gray-400">#{{ row.attempt }}</span></span>
                  <span :class="stageClass(row.status)">{{ STATUS_LABELS[row.status] || row.status }}</span>
                </div>
                <div v-if="row.stage === 'design' && row.output_json?.cases" class="text-[11px] text-gray-500 mt-1">
                  生成用例 {{ row.output_json.cases.length }} 条：{{ row.output_json.cases.map((c: any) => c.title).join('、') }}
                </div>
                <div v-if="row.stage === 'author' && row.output_json?.scripts" class="text-[11px] text-gray-500 mt-1">
                  生成脚本 {{ row.output_json.scripts.length }} 个：{{ row.output_json.scripts.map((s: any) => `${s.name}[${s.language}]`).join('、') }}
                </div>
                <div v-if="row.stage === 'gate' && row.output_json" class="text-[11px] mt-1" :class="row.output_json.ok ? 'text-green-600' : 'text-red-600'">
                  闸门：{{ row.output_json.ok ? '通过' : (row.output_json.failures || []).join('；') }}
                </div>
                <div v-if="row.stage === 'execute' && row.output_json?.executions" class="text-[11px] text-gray-500 mt-1">
                  执行 {{ row.output_json.executions.length }} 个脚本：{{ row.output_json.executions.map((e: any) => `${e.scriptName}→${e.status}${e.executionId ? ` #${e.executionId}` : ''}`).join('、') }}
                </div>
                <div v-if="row.stage === 'judge' && row.output_json?.counts" class="text-[11px] mt-1" :class="row.output_json.counts.fail || row.output_json.counts.error ? 'text-red-600' : 'text-green-600'">
                  判定：通过 {{ row.output_json.counts.pass }} / 失败 {{ row.output_json.counts.fail }} / 异常 {{ row.output_json.counts.error }} / 取消 {{ row.output_json.counts.cancelled }}
                </div>
                <div v-if="row.stage === 'repair' && row.output_json?.patched" class="text-[11px] text-gray-500 mt-1">
                  修复 {{ row.output_json.patched.length }} 个脚本：{{ row.output_json.patched.map((p: any) => `${p.scriptName}（${p.note}）`).join('、') }}
                </div>
                <div v-if="row.stage === 'report' && detail.pipeline.status === 'done'" class="text-[11px] mt-1">
                  <button class="text-blue-600 underline" @click="openReport">查看报告</button>
                </div>
                <div v-if="row.error" class="text-[11px] text-red-600 mt-1">{{ row.error }}</div>
              </div>
            </div>

            <div v-if="reportText">
              <div class="text-xs text-gray-500 mb-1">测试报告</div>
              <pre class="text-[11px] whitespace-pre-wrap bg-gray-50 border border-gray-200 rounded-lg p-3 max-h-80 overflow-auto">{{ reportText }}</pre>
            </div>

            <div>
              <div class="text-xs text-gray-500 mb-1">模型调用账本（{{ detail.agent_calls.length }} 次）</div>
              <table class="w-full text-[11px]">
                <thead class="text-gray-400">
                  <tr><th class="text-left font-normal py-1">阶段</th><th class="text-left font-normal">模型</th><th class="text-left font-normal">tokens</th><th class="text-left font-normal">采纳</th></tr>
                </thead>
                <tbody>
                  <tr v-for="(call, index) in detail.agent_calls" :key="index" class="border-t border-gray-50">
                    <td class="py-1 text-gray-700">{{ STAGE_LABELS[call.stage] || call.stage }}</td>
                    <td class="text-gray-500">{{ call.model_key }}</td>
                    <td class="text-gray-500">{{ call.tokens_in }}+{{ call.tokens_out }}</td>
                    <td :class="call.accepted ? 'text-green-600' : 'text-red-600'">{{ call.accepted ? '是' : (call.reason || '否') }}</td>
                  </tr>
                  <tr v-if="!detail.agent_calls.length"><td colspan="4" class="py-2 text-gray-400">还没有模型调用</td></tr>
                </tbody>
              </table>
            </div>
          </template>
        </section>
      </div>
    </div>
  </div>
</template>
