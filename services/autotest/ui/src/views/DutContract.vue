<script setup lang="ts">
/**
 * 被测件契约：每个功能点怎么驱动、从哪里读判定。
 *
 * 骨架脚本之所以一直补不上断言，是因为流水线不知道被测件长什么样。这一页把
 * 每一条契约变成可编辑的行，填完直接写回项目库，之后重跑「生成脚本」就能出
 * 带真断言的脚本。异常用例要求对应条目是 raises（断言被测件拒绝）。
 */
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { RefreshCw } from 'lucide-vue-next'
import Badge from '@/components/Badge.vue'
import EmptyState from '@/components/EmptyState.vue'

type Row = {
  function_point: string
  factory: string
  arrange: string
  observe: string
  kind: 'bool' | 'number' | 'contains' | 'raises'
  value: string
  covered: boolean
}

const route = useRoute()
const projectId = route.params.projectId as string

// 占位符的字面量放在脚本里：直接写进模板会被 Vue 当插值去解析
const PH_NUMBER = '{{number}}'
const PH_OVER = '{{over}}'
const PH_UNDER = '{{under}}'

const rows = ref<Row[]>([])
const driver = ref('_support/dut.py')
const imports = ref('Dut, DutError')
const loading = ref(false)
const saving = ref(false)
const message = ref('')
const error = ref('')

const coveredTotal = computed(() => rows.value.filter((row) => row.covered).length)
const missingTotal = computed(() => rows.value.length - coveredTotal.value)

async function api(path: string, init?: RequestInit) {
  const res = await fetch(`/api/projects/${projectId}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body?.detail || `HTTP ${res.status}`)
  return body
}

function rowsFromScaffold(entries: Record<string, unknown>[], coveredPoints: Set<string>): Row[] {
  return entries.map((entry) => {
    const expect = (entry.expect as Record<string, unknown>) || {}
    return {
      function_point: String(entry.function_point || ''),
      factory: String(entry.factory || ''),
      arrange: ((entry.arrange as string[]) || []).join('; '),
      observe: String(entry.observe || ''),
      kind: (String(expect.kind || 'bool') as Row['kind']),
      value: expect.value === undefined ? '' : String(expect.value),
      covered: coveredPoints.has(String(entry.function_point || '')),
    }
  })
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const [scaffold, contract] = await Promise.all([
      api('/workflow/dut-contract/scaffold'),
      api('/workflow/dut-contract'),
    ])
    const existing = (contract.data?.entries || []) as Record<string, unknown>[]
    const coveredPoints = new Set(existing.map((entry) => String(entry.function_point || '')))
    const missing = rowsFromScaffold((scaffold.data?.entries || []) as Record<string, unknown>[], coveredPoints)
    const kept = rowsFromScaffold(existing, coveredPoints)
    rows.value = [...kept, ...missing]
    driver.value = String(contract.data?.driver || scaffold.data?.driver || '_support/dut.py')
    imports.value = ((contract.data?.imports || scaffold.data?.imports || []) as string[]).join(', ')
    message.value = `已接入 ${kept.length} 个功能点，待接入 ${missing.length} 个`
  } catch (problem) {
    error.value = `加载契约失败：${(problem as Error).message}`
  } finally {
    loading.value = false
  }
}

async function save() {
  saving.value = true
  error.value = ''
  message.value = ''
  try {
    const entries = rows.value
      .filter((row) => row.covered || row.factory.trim())
      .map((row) => ({
        function_point: row.function_point,
        factory: row.factory,
        arrange: row.arrange
          .split(';')
          .map((line) => line.trim())
          .filter(Boolean),
        observe: row.observe,
        expect: { kind: row.kind, value: row.kind === 'bool' ? row.value === 'true' : row.value },
      }))
    const body = await api('/workflow/dut-contract', {
      method: 'PUT',
      body: JSON.stringify({
        driver: driver.value,
        imports: imports.value
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean),
        entries,
      }),
    })
    message.value = body.summary || `已保存 ${entries.length} 个功能点的契约`
    await load()
  } catch (problem) {
    error.value = `保存失败：${(problem as Error).message}`
  } finally {
    saving.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="flex-1 overflow-auto bg-surface-2">
    <div class="mx-auto w-full max-w-[1200px] px-8 py-7">
      <header class="flex items-start justify-between gap-4">
        <div>
          <h1 class="text-[20px] font-medium text-fg">被测件契约</h1>
          <p class="mt-1 text-[13px] text-muted">
            每个功能点怎么驱动、从哪里读判定。填完这一页，生成脚本时才会按条款出真断言，而不是骨架。
          </p>
        </div>
        <div class="flex items-center gap-2 pt-1">
          <button
            class="flex h-9 items-center gap-2 rounded-[8px] border border-line bg-surface px-3 text-[13px] text-fg hover:bg-surface-3 disabled:opacity-40"
            :disabled="loading"
            @click="load"
          >
            <RefreshCw class="h-4 w-4" :class="loading ? 'animate-spin' : ''" /> 刷新
          </button>
          <button
            class="h-9 rounded-[8px] bg-accent-solid px-3 text-[13px] text-white hover:bg-accent disabled:opacity-40"
            :disabled="saving"
            @click="save"
          >{{ saving ? '保存中…' : '保存契约' }}</button>
        </div>
      </header>

      <div class="mt-5 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-[12px] border border-line bg-surface px-5 py-3">
        <span class="num text-[13px] text-fg">{{ rows.length }}<span class="text-muted"> 个功能点</span></span>
        <span class="num text-[12px] text-success">已接入 {{ coveredTotal }}</span>
        <span class="num text-[12px]" :class="missingTotal ? 'text-warn' : 'text-muted-2'">待接入 {{ missingTotal }}</span>
        <label class="ml-auto flex items-center gap-2 text-[12px] text-muted">
          被测件模块
          <input v-model="driver" class="mono h-8 w-56 rounded-[8px] border border-line bg-surface px-2 text-[12px] text-fg" />
        </label>
        <label class="flex items-center gap-2 text-[12px] text-muted">
          import
          <input v-model="imports" class="mono h-8 w-44 rounded-[8px] border border-line bg-surface px-2 text-[12px] text-fg" />
        </label>
      </div>

      <p v-if="message" class="mt-3 text-[12px] text-success">{{ message }}</p>
      <p v-if="error" class="mt-3 rounded-[8px] border border-danger-line bg-danger-soft px-4 py-2 text-[12px] text-danger">{{ error }}</p>

      <div class="mt-5 overflow-hidden rounded-[12px] border border-line bg-surface">
        <div class="hidden grid-cols-[1fr_150px_1fr_150px_120px_90px] gap-3 border-b border-line px-4 py-2 text-[12px] text-muted-2 lg:grid">
          <span>功能点</span>
          <span>构造</span>
          <span>驱动（多条用 ; 分隔）</span>
          <span>观测</span>
          <span>期望</span>
          <span>值</span>
        </div>

        <div
          v-for="row in rows"
          :key="row.function_point"
          class="state-bar grid grid-cols-1 items-center gap-3 border-b border-line-soft px-4 py-2.5 last:border-b-0 lg:grid-cols-[1fr_150px_1fr_150px_120px_90px]"
          :data-tone="row.covered ? 'success' : 'neutral'"
        >
          <div class="min-w-0">
            <p class="truncate text-[13px] text-fg">{{ row.function_point }}</p>
            <Badge :tone="row.covered ? 'success' : 'neutral'">{{ row.covered ? '已接入' : '待接入' }}</Badge>
          </div>
          <input v-model="row.factory" class="mono h-8 rounded-[8px] border border-line bg-surface px-2 text-[12px] text-fg" placeholder="AfeSim()" />
          <input v-model="row.arrange" class="mono h-8 rounded-[8px] border border-line bg-surface px-2 text-[12px] text-fg" placeholder="dut.set_voltage(<数值>)" />
          <input v-model="row.observe" class="mono h-8 rounded-[8px] border border-line bg-surface px-2 text-[12px] text-fg" placeholder="dut.voltage" />
          <select v-model="row.kind" class="h-8 rounded-[8px] border border-line bg-surface px-2 text-[12px] text-fg">
            <option value="raises">raises（应被拒绝）</option>
            <option value="bool">bool</option>
            <option value="number">number</option>
            <option value="contains">contains</option>
          </select>
          <input v-model="row.value" class="mono h-8 rounded-[8px] border border-line bg-surface px-2 text-[12px] text-fg" placeholder="DutError" />
        </div>

        <EmptyState
          v-if="!rows.length"
          class="m-5"
          title="还没有功能点"
          hint="先到「流水线」第 ① 步解析需求，功能点出来后再回来填契约"
        />
      </div>

      <p class="mt-3 text-[12px] text-muted-2">
        提示：异常用例要求对应条目是 <span class="mono">raises</span>；条款里没有数值的用例即使有契约也生不出断言（会单独提示）。
        数值类占位符
        <span class="mono">{{ PH_NUMBER }}</span> 取条款里的第一个数值，
        <span class="mono">{{ PH_OVER }}</span> / <span class="mono">{{ PH_UNDER }}</span> 会按阈值算出越界值。
      </p>
    </div>
  </div>
</template>
