<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ArrowLeft, Save, Play, FileCode, FolderOpen, Loader2 } from 'lucide-vue-next'
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

  lcWrapper = new LanguageClientWrapper(languageClientConfig)
  await lcWrapper.start()
  lspConnected.value = true
  statusText.value = 'LSP 已连接'

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

  // 自动保存：监听文档变化，防抖 1.5 秒后保存
  try {
    let saveTimer: any = null
    vscode.workspace.onDidChangeTextDocument((e: any) => {
      if (!e.document.uri.path.includes('.py')) return
      if (saveTimer) clearTimeout(saveTimer)
      saveTimer = setTimeout(async () => {
        try {
          await fetch(`/api/projects/${projectId}/scripts/${scriptId}/content`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: e.document.getText() }),
          })
          statusText.value = `已自动保存 ${new Date().toLocaleTimeString()}`
        } catch (err) {
          console.error('自动保存失败', err)
        }
      }, 1500)
    })
  } catch (e) {
    console.error('自动保存监听失败', e)
  }

  statusText.value = 'basedpyright 已连接'
}

function switchScript(id: string) {
  router.push(`/project/${projectId}/scripts/${id}/edit`)
}

async function runScript() {
  running.value = true
  showOutput.value = true
  runOutput.value = ''
  try {
    const res = await fetch(`/api/projects/${projectId}/scripts/${scriptId}/run`, { method: 'POST' })
    const data = await res.json()
    runOutput.value = [
      data.stdout ? `$ 输出:\n${data.stdout}` : '',
      data.stderr ? `\n$ 错误:\n${data.stderr}` : '',
      `\n$ 退出码: ${data.returncode}`,
    ].filter(Boolean).join('\n')
  } catch (e: any) {
    runOutput.value = '运行失败: ' + e.message
  } finally {
    running.value = false
  }
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
  <div class="flex-1 flex flex-col bg-white overflow-hidden">
    <div class="h-11 bg-gray-100 border-b border-gray-200 flex items-center px-4 gap-3">
      <button @click="router.push(`/project/${projectId}/scripts`)" class="flex items-center gap-1.5 text-sm text-gray-600 hover:text-gray-900">
        <ArrowLeft class="w-4 h-4" />
        返回
      </button>
      <div class="w-px h-4 bg-gray-300"></div>
      <div class="flex items-center gap-2 text-sm text-gray-700">
        <FileCode class="w-4 h-4 text-blue-600" />
        {{ currentScript?.name || '加载中...' }}
      </div>
      <div class="flex items-center gap-1.5 text-xs text-gray-500 ml-2">
        <Loader2 class="w-3 h-3 animate-spin" v-if="!lspConnected" />
        <span class="w-2 h-2 rounded-full" :class="lspConnected ? 'bg-green-500' : 'bg-gray-300'"></span>
        {{ statusText }}
      </div>
      <div class="ml-auto flex items-center gap-2">
        <button class="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-gray-300 rounded hover:bg-gray-200">
          <Save class="w-4 h-4" />
          保存
        </button>
        <button @click="runScript" class="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 text-white rounded hover:bg-blue-700" :disabled="running">
          <Loader2 v-if="running" class="w-4 h-4 animate-spin" />
          <Play v-else class="w-4 h-4" />
          {{ running ? '运行中...' : '运行' }}
        </button>
      </div>
    </div>

    <div class="flex-1 flex overflow-hidden">
      <div class="w-56 bg-gray-50 border-r border-gray-200 flex flex-col">
        <div class="px-4 py-2 text-xs font-medium text-gray-500 border-b border-gray-200">资源管理器</div>
        <div class="flex-1 overflow-auto p-2">
          <div class="flex items-center gap-2 px-2 py-1 text-xs text-gray-600 mb-1">
            <FolderOpen class="w-3.5 h-3.5 text-gray-400" />
            scripts/
          </div>
          <div class="ml-4 space-y-0.5">
            <button
              v-for="s in scripts"
              :key="s.id"
              @click="switchScript(s.id)"
              class="w-full flex items-center gap-1.5 px-2 py-1 rounded text-xs text-left transition-colors"
              :class="s.id === scriptId ? 'bg-blue-100 text-blue-700' : 'text-gray-600 hover:bg-gray-100'"
            >
              <FileCode class="w-3 h-3" />
              {{ s.name }}
            </button>
          </div>
        </div>
      </div>

      <div class="flex-1 flex flex-col min-w-0">
        <div ref="editorContainer" class="flex-1 min-w-0"></div>
        <div v-if="showOutput" class="h-48 bg-gray-900 border-t border-gray-700 flex flex-col">
          <div class="flex items-center justify-between px-3 py-1 bg-gray-800">
            <span class="text-xs text-gray-300 font-medium">运行输出</span>
            <button @click="showOutput = false" class="text-gray-400 hover:text-white text-xs">关闭</button>
          </div>
          <pre class="flex-1 overflow-auto p-3 text-xs text-green-400 font-mono">{{ runOutput }}</pre>
        </div>
      </div>
    </div>
  </div>
</template>
