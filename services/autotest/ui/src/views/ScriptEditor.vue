<script setup lang="ts">
import { computed, ref, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ArrowLeft, Save, Play, FileCode, FolderOpen, Loader2, ShieldCheck, CheckCircle2, XCircle, Braces } from 'lucide-vue-next'
import * as vscode from 'vscode'
import { configureDefaultWorkerFactory } from 'monaco-languageclient/workerFactory'
import { conf as pyConf } from 'monaco-editor/languages/definitions/python/python.js'
import { MonacoVscodeApiWrapper, type MonacoVscodeApiConfig } from 'monaco-languageclient/vscodeApiWrapper'
import { LanguageClientWrapper, type LanguageClientConfig, LcWebSocket } from 'monaco-languageclient/lcwrapper'
import { EditorApp, type EditorAppConfig } from 'monaco-languageclient/editorApp'

const route = useRoute()
const router = useRouter()
const projectId = route.params.projectId as string
const scriptId = route.params.scriptId as string

const scripts = ref<any[]>([])
const currentScript = ref<any>(null)
const workspaceUri = ref('')
const statusText = ref('初始化编辑器...')
const lspConnected = ref(false)
const running = ref(false)
const runOutput = ref('')
const showOutput = ref(false)
const editorContainer = ref<HTMLDivElement | null>(null)

// 编辑器脏标记：「保存」按钮和自动保存共用，避免以为存了其实没存
const dirty = ref(false)
const saving = ref(false)
// 静态闸门（后端 compile / 首行 @target 校验）的结果
const gating = ref(false)
const gateFailures = ref<string[]>([])
const gateChecked = ref(false)
// 闸门跑过且没通过 → 运行置灰；闸门没跑过不拦（不然新脚本连跑都跑不了）
const blockRun = computed(() => gateChecked.value && gateFailures.value.length > 0)
// 最后一次运行的完整结果：status / failure / duration / execution_id 都要能看见，
// 只留 stdout 会把「通过还是失败」这个最要紧的信息藏起来
type RunResult = {
  status?: string
  status_label?: string
  success?: boolean
  returncode?: number
  duration_ms?: number
  execution_id?: number
  run_id?: string
  // 执行器给字符串（"AssertionError: xxx"），事件回放给对象（{type,message,line}）
  failure?: string | { type?: string; message?: string; line?: number } | null
  stdout?: string
  stderr?: string
}
const runResult = ref<RunResult | null>(null)

let lcWrapper: LanguageClientWrapper | null = null
let editorApp: EditorApp | null = null

let apiStarted: Promise<void> | null = null

async function ensureApiStarted() {
  if (!apiStarted) {
    const vscodeApiConfig: MonacoVscodeApiConfig = {
      $type: 'extended',
      viewsConfig: { $type: 'EditorService' },
      userConfiguration: {
        json: JSON.stringify({
          'workbench.colorTheme': 'Default Light Modern',
          'editor.fontSize': 14,
          'editor.tabSize': 4,
          'editor.insertSpaces': true,
          'editor.minimap.enabled': true,
          'editor.semanticHighlighting.enabled': true,
        'editor.renderWhitespace': 'all',
        }),
      },
      monacoWorkerFactory: configureDefaultWorkerFactory,
      advanced: {
        enforceSemanticHighlighting: true,
      },
      extensions: [
        {
          config: {
            name: 'python-lang',
            displayName: 'Python Language',
            publisher: 'local',
            version: '1.0.0',
            engines: { vscode: '^1.0.0' },
            contributes: {
              languages: [{
                id: 'python',
                aliases: ['Python', 'py'],
                extensions: ['.py', '.pyw'],
                configuration: './language-configuration.json',
              }],
            },
          },
          filesOrContents: new Map([
            ['/language-configuration.json', JSON.stringify(pyConf)],
          ]),
        },
      ],
    }
    const apiWrapper = new MonacoVscodeApiWrapper(vscodeApiConfig)
    apiStarted = apiWrapper.start()
  }
  return apiStarted
}

async function loadScripts() {
  try {
    const res = await fetch(`/api/projects/${projectId}/scripts`)
    const data = await res.json()
    scripts.value = data.scripts || []
    workspaceUri.value = data.workspace_uri || ''
  } catch (e) {
    console.error('加载脚本失败', e)
  }
}

async function initEditor() {
  const script = scripts.value.find(s => s.id === scriptId)
  currentScript.value = script

  let text = ''
  try {
    const res = await fetch(`/api/projects/${projectId}/scripts/${scriptId}/content`)
    const data = await res.json()
    text = data.content
  } catch (e) {
    console.error('获取脚本内容失败', e)
  }

  statusText.value = '正在初始化...'
  await nextTick()

  // 严格按 README 顺序：apiWrapper.start() → lcWrapper.start() → editorApp.start()
  await ensureApiStarted()

  const isDev = import.meta.env.DEV
  const wsUrl = isDev
    ? `ws://${window.location.hostname}:4000/ws/lsp/python/${projectId}`
    : `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws/lsp/python/${projectId}`

  const languageClientConfig: LanguageClientConfig = {
    languageId: 'python',
    connection: {
      options: {
        $family: 'WebSocket',
        webSocketUrl: wsUrl,
        realization: () => new LcWebSocket(),
      },
    },
    clientOptions: {
      documentSelector: ['python'],
      middleware: {
        // 吞掉所有诊断（波浪线），只保留语法高亮/补全/hover
        handleDiagnostics: () => {},
      },
      workspaceFolder: {
        index: 0,
        name: 'workspace',
        uri: vscode.Uri.file('/workspace'),
      },
    },
  }

  // LSP 是加分项，不是编辑器的前提：网关没装 basedpyright（便携包就是这样）时
  // 连接会失败或一直挂着，不能让它把整个编辑器堵在「正在初始化」。
  lcWrapper = new LanguageClientWrapper(languageClientConfig)
  try {
    await Promise.race([
      lcWrapper.start(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('LSP 连接超时')), 6000)),
    ])
    lspConnected.value = true
    statusText.value = 'LSP 已连接'
  } catch (e) {
    lspConnected.value = false
    statusText.value = `无 LSP（${(e as Error).message}）· 编辑/保存/运行不受影响`
  }

  // codeUri 和 README 一致：/workspace/xxx.py，不带 file://，不设 enforceLanguageId
  const codeUri = `/workspace/scripts/${script?.name || 'untitled.py'}`

  const editorAppConfig: EditorAppConfig = {
    codeResources: {
      modified: {
        text,
        uri: codeUri,
        enforceLanguageId: 'python',
      },
    },
    editorOptions: {
      'semanticHighlighting.enabled': true,
      'renderWhitespace': 'all',
      'renderValidationDecorations': 'off',
      automaticLayout: true,
    },
  }

  editorApp = new EditorApp(editorAppConfig)
  await editorApp.start(editorContainer.value!)

  // 等待 document 出现在 workspace，然后手动发 didOpen
  await new Promise(r => setTimeout(r, 2000))
  try {
    const docs = vscode.workspace.textDocuments
    for (const doc of docs) {
      if (doc.uri.path.includes('.py')) {
        const client = lcWrapper?.getLanguageClient()
        if (client) {
          client.sendNotification('textDocument/didOpen', {
            textDocument: {
              uri: doc.uri.toString(),
              languageId: 'python',
              version: doc.version,
              text: doc.getText(),
            },
          })
        }
      }
    }
  } catch (e) {
    console.error('didOpen error', e)
  }

  // 自动保存：挂 Monaco 的 model 事件，不依赖 LSP（没有 langserver 时
  // didChangeTextDocument 根本不会来，改完等于没存）
  const monacoEditor = editorApp?.getEditor()
  if (monacoEditor) {
    let saveTimer: any = null
    monacoEditor.onDidChangeModelContent(() => {
      dirty.value = true
      if (saveTimer) clearTimeout(saveTimer)
      saveTimer = setTimeout(() => void saveNow(), 1500)
    })
  }

  if (lspConnected.value) statusText.value = 'basedpyright 已连接'
}

function switchScript(id: string) {
  router.push(`/project/${projectId}/scripts/${id}/edit`)
}

const PYTEST_TEMPLATE = `def test_case_placeholder():
    \"\"\"一句话说明这条用例要证明什么。\"\"\"
    # 1. 前置：构造输入 / 准备数据
    # 2. 操作：调用被测接口或界面动作
    result = None
    # 3. 断言：写具体值，别留 assert True
    assert result is not None, "把断言写具体"
`

// 取正文只走 Monaco 实例：vscode.window.activeTextEditor 依赖 language client，
// 没有 LSP 时它是空的，会让「保存」「模板」全部失效。
function editorText(): string {
  return editorApp?.getEditor()?.getModel()?.getValue() ?? ''
}

/** 手动保存：自动保存是 1.5 秒防抖，改了立刻要落盘时用它，失败必须吼出来。 */
async function saveNow() {
  const content = editorText()
  if (!content) {
    statusText.value = '编辑器还没就绪，取不到内容'
    return
  }
  saving.value = true
  try {
    const res = await fetch(`/api/projects/${projectId}/scripts/${scriptId}/content`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    dirty.value = false
    statusText.value = `已保存 ${new Date().toLocaleTimeString()}`
  } catch (e: any) {
    statusText.value = `保存失败：${e?.message || e}`
  } finally {
    saving.value = false
  }
}

/** 静态闸门：先落盘再校验，否则校验的是旧内容。 */
async function runGate() {
  gating.value = true
  gateChecked.value = false
  try {
    await saveNow()
    const res = await fetch(`/api/projects/${projectId}/scripts/${scriptId}/gate`, { method: 'POST' })
    const data = await res.json()
    if (!res.ok) throw new Error(data?.detail || `HTTP ${res.status}`)
    gateFailures.value = data.failures || []
    gateChecked.value = true
    statusText.value = gateFailures.value.length ? `闸门：${gateFailures.value.length} 项未通过` : '闸门通过'
  } catch (e: any) {
    gateFailures.value = [`校验失败：${e?.message || e}`]
    gateChecked.value = true
    statusText.value = '闸门校验失败'
  } finally {
    gating.value = false
  }
}

function insertTemplate() {
  const monacoEditor = editorApp?.getEditor()
  const model = monacoEditor?.getModel()
  const position = monacoEditor?.getPosition()
  if (!monacoEditor || !model || !position) {
    statusText.value = '编辑器还没就绪，无法插入模板'
    return
  }
  monacoEditor.executeEdits('insert-pytest-template', [
    {
      range: {
        startLineNumber: position.lineNumber,
        startColumn: position.column,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      },
      text: PYTEST_TEMPLATE,
      forceMoveMarkers: true,
    },
  ])
  monacoEditor.focus()
  dirty.value = true
  statusText.value = '已插入 pytest 模板'
}

async function runScript() {
  running.value = true
  showOutput.value = true
  runOutput.value = ''
  runResult.value = null
  try {
    // 跑之前先落盘：否则跑的是上一次保存的版本，结果和眼前代码对不上
    await saveNow()
    const res = await fetch(`/api/projects/${projectId}/scripts/${scriptId}/run`, { method: 'POST' })
    const data = await res.json()
    if (!res.ok) throw new Error(data?.detail || `HTTP ${res.status}`)
    runResult.value = {
      status: data.status,
      status_label: data.status_label,
      success: data.success,
      returncode: data.returncode,
      duration_ms: data.duration_ms,
      execution_id: data.execution_id,
      run_id: data.run_id,
      failure: data.failure || null,
      stdout: data.stdout || '',
      stderr: data.stderr || '',
    }
    runOutput.value = [
      data.stdout ? `$ 输出:\n${data.stdout}` : '',
      data.stderr ? `\n$ 错误:\n${data.stderr}` : '',
      `\n$ 退出码: ${data.returncode}`,
    ].filter(Boolean).join('\n')
    statusText.value = `运行结束：${data.status_label || data.status || (data.success ? '通过' : '失败')}`
  } catch (e: any) {
    runOutput.value = '运行失败: ' + (e?.message || e)
    statusText.value = '运行失败'
  } finally {
    running.value = false
  }
}

// failure 两种形状（字符串 / 对象）统一成 {type, line, message}，模板只认一种
function failureView(): { type: string; line?: number; message: string } | null {
  const raw = runResult.value?.failure
  if (!raw) return null
  if (typeof raw === 'string') {
    const match = raw.match(/^([A-Za-z_][\w.]*(?:Error|Exception|Exit)):\s*([\s\S]*)$/)
    return match ? { type: match[1], message: match[2] } : { type: 'Error', message: raw }
  }
  return { type: raw.type || 'Error', line: raw.line, message: raw.message || '' }
}

function resultTone(): string {
  const status = runResult.value?.status_label || runResult.value?.status
  if (status === '通过') return 'bg-success-soft text-success border-success-line'
  if (status === '失败' || status === '异常') return 'bg-danger-soft text-danger border-danger-line'
  return 'bg-surface-2 text-fg-3 border-line'
}

onMounted(async () => {
  try {
    await loadScripts()
    await initEditor()
  } catch (e) {
    console.error('编辑器初始化失败', e)
    statusText.value = '初始化失败：' + (e instanceof Error ? e.message : JSON.stringify(e))
  }
})

onBeforeUnmount(() => {
  // vscode service 自动清理
})
</script>

<template>
  <div class="flex-1 flex flex-col bg-surface overflow-hidden">
    <div class="h-11 bg-surface-3 border-b border-line flex items-center px-4 gap-3">
      <button @click="router.push(`/project/${projectId}/scripts`)" class="flex items-center gap-1.5 text-sm text-fg-3 hover:text-fg">
        <ArrowLeft class="w-4 h-4" />
        返回
      </button>
      <div class="w-px h-4 bg-gray-300"></div>
      <div class="flex items-center gap-2 text-sm text-fg-2">
        <FileCode class="w-4 h-4 text-accent" />
        {{ currentScript?.name || '加载中...' }}
      </div>
      <span
        v-if="currentScript?.assertion_state === 'skeleton'"
        class="text-xs px-2 py-0.5 rounded border border-warn text-warn"
        title="自动生成的骨架：执行时只会跳过，绿色不代表验过；补上断言后这里会变成「真断言」"
      >骨架（未验）</span>
      <span
        v-else-if="currentScript?.assertion_state === 'asserted'"
        class="text-xs px-2 py-0.5 rounded border border-success text-success"
        :title="`${currentScript.assert_count} 条可判定断言`"
      >真断言 {{ currentScript.assert_count }}</span>
      <span
        v-if="currentScript?.case_missing"
        class="text-xs px-2 py-0.5 rounded border border-warn text-warn"
        title="生成这条脚本的用例已经被删除（例如资料缺口导致跳过用例）；重新设计用例后请确认是否重新生成脚本"
      >关联用例已删除</span>
      <div class="flex items-center gap-1.5 text-xs text-muted ml-2">
        <Loader2 class="w-3 h-3 animate-spin" v-if="!lspConnected" />
        <span class="w-2 h-2 rounded-full" :class="lspConnected ? 'bg-green-500' : 'bg-gray-300'"></span>
        {{ statusText }}
      </div>
      <div class="ml-auto flex items-center gap-2">
        <button
          class="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-line-strong rounded hover:bg-surface-4"
          :disabled="gating"
          @click="runGate"
        >
          <Loader2 v-if="gating" class="w-4 h-4 animate-spin" />
          <ShieldCheck v-else class="w-4 h-4" />
          校验
        </button>
        <button
          class="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-line-strong rounded hover:bg-surface-4"
          @click="insertTemplate"
        >
          <Braces class="w-4 h-4" />
          模板
        </button>
        <button
          class="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-line-strong rounded hover:bg-surface-4"
          :disabled="saving"
          @click="saveNow"
        >
          <Loader2 v-if="saving" class="w-4 h-4 animate-spin" />
          <Save v-else class="w-4 h-4" />
          保存
          <span v-if="dirty" class="w-1.5 h-1.5 rounded-full bg-amber-500" title="有未保存改动"></span>
        </button>
        <button
          class="flex items-center gap-1.5 px-3 py-1.5 bg-accent-solid text-white rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          :disabled="running || blockRun"
          :title="blockRun ? '静态闸门未通过，先修问题再运行' : '运行这条脚本'"
          @click="runScript"
        >
          <Loader2 v-if="running" class="w-4 h-4 animate-spin" />
          <Play v-else class="w-4 h-4" />
          {{ running ? '运行中...' : '运行' }}
        </button>
      </div>
    </div>

    <div class="flex-1 flex overflow-hidden">
      <div class="w-56 bg-surface-2 border-r border-line flex flex-col">
        <div class="px-4 py-2 text-xs font-medium text-muted border-b border-line">资源管理器</div>
        <div class="flex-1 overflow-auto p-2">
          <div class="flex items-center gap-2 px-2 py-1 text-xs text-fg-3 mb-1">
            <FolderOpen class="w-3.5 h-3.5 text-muted-2" />
            scripts/
          </div>
          <div class="ml-4 space-y-0.5">
            <button
              v-for="s in scripts"
              :key="s.id"
              @click="switchScript(s.id)"
              class="w-full flex items-center gap-1.5 px-2 py-1 rounded text-xs text-left transition-colors"
              :class="s.id === scriptId ? 'bg-accent-soft text-accent' : 'text-fg-3 hover:bg-surface-3'"
            >
              <FileCode class="w-3 h-3" />
              <span class="truncate">{{ s.name }}</span>
              <span
                v-if="s.case_missing"
                class="ml-auto shrink-0 px-1 rounded border border-warn text-warn"
                title="关联用例已被删除：脚本仍可执行，但结果无法对回任何一条需求"
              >孤儿</span>
            </button>
          </div>
        </div>
      </div>

      <div class="flex-1 flex flex-col min-w-0">
        <div ref="editorContainer" class="flex-1 min-w-0"></div>
        <div v-if="showOutput" class="h-56 bg-gray-900 border-t border-gray-700 flex flex-col">
          <div class="flex items-center gap-2 px-3 py-1 bg-gray-800">
            <span class="text-xs text-muted-2 font-medium">运行结果</span>
            <span
              v-if="runResult"
              class="text-xs px-2 py-0.5 rounded border"
              :class="resultTone()"
            >{{ runResult.status_label || runResult.status || (runResult.success ? '通过' : '失败') }}</span>
            <span v-if="runResult?.duration_ms != null" class="text-xs text-muted-2">{{ Math.round(runResult.duration_ms) }} ms</span>
            <span v-if="runResult?.returncode != null" class="text-xs text-muted-2">exit {{ runResult.returncode }}</span>
            <span v-if="runResult?.execution_id" class="text-xs text-muted">#{{ runResult.execution_id }}</span>
            <button @click="showOutput = false" class="ml-auto text-muted-2 hover:text-white text-xs">关闭</button>
          </div>
          <div v-if="failureView()" class="px-3 py-2 text-xs text-red-300 border-b border-gray-700">
            失败原因：<span class="font-mono">{{ failureView()!.type }}</span>
            <span v-if="failureView()!.line"> · line {{ failureView()!.line }}</span>
            <div class="mt-1 whitespace-pre-wrap text-red-200">{{ failureView()!.message }}</div>
          </div>
          <pre class="flex-1 overflow-auto p-3 text-xs text-green-400 font-mono">{{ runOutput || '（还没有输出）' }}</pre>
        </div>
        <div v-if="gateChecked" class="border-t border-line bg-surface px-3 py-2">
          <div class="flex items-center gap-2 text-xs font-medium" :class="gateFailures.length ? 'text-danger' : 'text-success'">
            <XCircle v-if="gateFailures.length" class="w-3.5 h-3.5" />
            <CheckCircle2 v-else class="w-3.5 h-3.5" />
            静态闸门{{ gateFailures.length ? `：${gateFailures.length} 项未通过` : '：通过' }}
          </div>
          <ul v-if="gateFailures.length" class="mt-1 space-y-0.5">
            <li v-for="(f, i) in gateFailures" :key="i" class="text-xs text-danger">· {{ f }}</li>
          </ul>
        </div>
      </div>
    </div>
  </div>
</template>
