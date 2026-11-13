<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { FileText, Upload, RefreshCw, ChevronRight, Trash2, BookOpen } from 'lucide-vue-next'

const route = useRoute()
const projectId = route.params.projectId as string

type Requirement = {
  id: string
  filename: string
  size: number | null
  status: string
  created_at: string
}

const requirements = ref<Requirement[]>([])
const uploading = ref(false)
const message = ref('')
const error = ref('')
const fileInput = ref<HTMLInputElement>()
const dragging = ref(false)

// 每份资料在知识库里切了几块：命中说明已经"分解入库"，才能被检索、成为写用例的依据。
const knowledgeChunks = ref<Record<string, number>>({})

async function loadKnowledge() {
  try {
    const response = await fetch(`/api/projects/${projectId}/knowledge/documents`)
    if (!response.ok) return
    const body = await response.json()
    const docs = body.documents ?? body.data?.documents ?? []
    const map: Record<string, number> = {}
    for (const doc of docs) {
      if (doc?.filename) map[String(doc.filename)] = Number(doc.chunk_count ?? 0)
    }
    knowledgeChunks.value = map
  } catch {
    // 入库状态只是提示；查不到就不显示徽标，不影响上传本身
  }
}

function archivedChunks(filename: string): number | null {
  const chunks = knowledgeChunks.value[filename]
  return chunks === undefined ? null : chunks
}

async function load() {
  try {
    const response = await fetch(`/api/projects/${projectId}/requirements`)
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
    const data = await response.json()
    requirements.value = data.requirements ?? []
    error.value = ''
    await loadKnowledge()
  } catch (problem) {
    error.value = String((problem as Error).message ?? problem)
  }
}

// 一次可以传多份：拖进来或选中的文件逐个上传，一份失败不影响其余，
// 最后给一条「成功 N 份 / 失败 M 份」并把失败文件名列出来。
const progress = ref({ done: 0, total: 0 })

async function send(files: File[]) {
  if (!files.length) return
  uploading.value = true
  message.value = ''
  error.value = ''
  progress.value = { done: 0, total: files.length }

  const failed: string[] = []
  for (const file of files) {
    try {
      const body = new FormData()
      body.append('file', file)
      const response = await fetch(`/api/projects/${projectId}/requirements/upload`, {
        method: 'POST',
        body,
      })
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
    } catch (problem) {
      failed.push(`${file.name}：${String((problem as Error).message ?? problem)}`)
    } finally {
      progress.value = { done: progress.value.done + 1, total: files.length }
    }
  }

  const uploaded = files.length - failed.length
  if (uploaded) message.value = `${uploaded} 份已上传`
  if (failed.length) error.value = `${failed.length} 份失败 — ${failed.join('；')}`
  await load()
  uploading.value = false
}

async function onPick(event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  if (!files.length) return
  await send(files)
  if (fileInput.value) fileInput.value.value = ''
}

async function onDrop(event: DragEvent) {
  dragging.value = false
  const files = Array.from(event.dataTransfer?.files ?? [])
  if (files.length) await send(files)
}

// 删除单份需求：只删这份文件和它的记录，不动同目录下其它需求。
async function removeRequirement(item: Requirement) {
  message.value = ''
  error.value = ''
  try {
    const response = await fetch(
      `/api/projects/${projectId}/requirements/${encodeURIComponent(item.filename)}`,
      { method: 'DELETE' },
    )
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(body?.detail || `HTTP ${response.status}`)
    message.value = body?.message || `已删除 ${item.filename}`
    await load()
  } catch (problem) {
    error.value = String((problem as Error).message ?? problem)
  }
}

// 把 specs/ 里已上传的需求切分进项目知识库（Agent 检索时才能命中需求原文）。
const archiving = ref(false)
const archiveResult = ref<{ imported: number; skipped: number; failed: number } | null>(null)

async function archiveToKnowledge() {
  archiving.value = true
  message.value = ''
  error.value = ''
  try {
    const response = await fetch(`/api/projects/${projectId}/knowledge/documents/from-specs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ module: '', tags: '项目资料' }),
    })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(body?.detail || `HTTP ${response.status}`)
    const data = body?.data || {}
    archiveResult.value = {
      imported: (data.imported || []).length,
      skipped: (data.skipped || []).length,
      failed: (data.failed || []).length,
    }
    message.value = body?.summary || `已入库 ${archiveResult.value.imported} 份`
    await load()
  } catch (problem) {
    error.value = String((problem as Error).message ?? problem)
  } finally {
    archiving.value = false
  }
}

function sizeText(bytes: number | null) {
  if (!bytes) return ''
  return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`
}

onMounted(load)
</script>

<template>
  <div class="flex-1 flex flex-col overflow-auto bg-white">
    <div class="p-6">
      <div class="mb-6">
        <h2 class="text-lg font-medium text-gray-900">项目资料</h2>
        <p class="text-sm text-gray-500 mt-1">
          上传需求文档、接口说明、协议表等资料 → 分解入库「知识库」→ 写用例时按知识库检索原文作为依据
        </p>
      </div>

      <!-- 步骤条 -->
      <div class="flex items-center gap-2 mb-6">
        <div class="flex items-center gap-2">
          <div class="w-8 h-8 rounded-full flex items-center justify-center text-sm bg-blue-600 text-white">1</div>
          <span class="text-sm text-gray-900">上传项目资料</span>
        </div>
        <ChevronRight class="w-4 h-4 text-gray-300" />
        <div class="flex items-center gap-2">
          <div class="w-8 h-8 rounded-full flex items-center justify-center text-sm bg-gray-200 text-gray-500">2</div>
          <span class="text-sm text-gray-400">分解入库知识库</span>
        </div>
        <ChevronRight class="w-4 h-4 text-gray-300" />
        <div class="flex items-center gap-2">
          <div class="w-8 h-8 rounded-full flex items-center justify-center text-sm bg-gray-200 text-gray-500">3</div>
          <span class="text-sm text-gray-400">按知识库写用例</span>
        </div>
        <button
          class="ml-auto flex items-center gap-2 px-3 py-1.5 text-sm border border-gray-200 rounded-lg hover:bg-gray-50"
          @click="load"
        >
          <RefreshCw class="w-4 h-4" />
          刷新
        </button>
      </div>

      <!-- 上传区 -->
      <div class="bg-white rounded-lg border border-gray-200 p-8">
        <input ref="fileInput" type="file" class="hidden" multiple accept=".pdf,.docx,.xlsx,.md,.txt" @change="onPick" />
        <div
          class="border-2 border-dashed rounded-lg p-12 text-center transition-colors cursor-pointer"
          :class="dragging ? 'border-blue-500 bg-blue-50/40' : 'border-gray-300 hover:border-blue-400'"
          @click="fileInput?.click()"
          @dragover.prevent="dragging = true"
          @dragleave.prevent="dragging = false"
          @drop.prevent="onDrop"
        >
          <Upload class="w-12 h-12 text-gray-400 mx-auto mb-4" />
          <p class="text-sm text-gray-600 mb-2">
            {{ uploading
              ? `上传中 ${progress.done}/${progress.total}…`
              : '点击或拖拽文件到此处上传（可一次选/拖多个）' }}
          </p>
          <p class="text-xs text-gray-400">支持 PDF / Word(.docx) / Excel(.xlsx) / Markdown / 纯文本，多个文件会逐个上传</p>
        </div>
        <div class="mt-3 flex items-center gap-4 text-sm">
          <span v-if="message" class="text-green-600">{{ message }}</span>
          <span v-if="error" class="text-red-600">{{ error }}</span>
          <span class="text-xs text-gray-400 ml-auto">上传只是归档原文；执行下面第 2 步才会分解进知识库</span>
        </div>
      </div>

      <!-- 已上传 -->
      <div class="flex items-center gap-2 mt-6 mb-3">
        <h3 class="text-sm font-medium text-gray-900">已上传资料</h3>
        <span class="text-xs text-gray-400">{{ requirements.length }} 个文件</span>
        <span v-if="archiveResult" class="text-xs text-gray-500">
          入库 {{ archiveResult.imported }} · 跳过 {{ archiveResult.skipped }} · 失败 {{ archiveResult.failed }}
        </span>
        <button
          class="ml-auto flex items-center gap-2 px-3 py-1.5 text-sm border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50"
          :disabled="archiving || !requirements.length"
          title="把这些资料切分进项目知识库；Agent 写用例时检索的就是知识库"
          @click="archiveToKnowledge"
        >
          <BookOpen class="w-4 h-4" />
          {{ archiving ? '入库中…' : '分解入库知识库' }}
        </button>
      </div>
      <div class="space-y-3">
        <div v-for="item in requirements" :key="item.id" class="bg-gray-50 rounded-lg border border-gray-200 p-4 flex items-center gap-3">
          <FileText class="w-5 h-5 text-gray-400" />
          <div class="min-w-0 flex-1">
            <div class="font-medium text-gray-900 truncate">{{ item.filename }}</div>
            <div class="text-xs text-gray-400 mt-1">{{ sizeText(item.size) }} · {{ item.created_at }}</div>
          </div>
          <span
            v-if="archivedChunks(item.filename) !== null"
            class="text-xs px-2 py-0.5 rounded bg-blue-50 border border-blue-200 text-blue-700"
            :title="`已切分为 ${archivedChunks(item.filename)} 块进入知识库`"
          >已入库 {{ archivedChunks(item.filename) }} 块</span>
          <span
            v-else
            class="text-xs px-2 py-0.5 rounded bg-white border border-gray-200 text-gray-500"
            title="还没分解入库：点右上「分解入库知识库」后，写用例才能检索到这份资料"
          >未入库</span>
          <span class="text-xs px-2 py-0.5 rounded bg-white border border-gray-200 text-gray-600">{{ item.status }}</span>
          <button
            class="p-1 text-gray-400 hover:text-red-600"
            title="删除这份资料"
            @click="removeRequirement(item)"
          ><Trash2 class="w-4 h-4" /></button>
        </div>
        <div v-if="!requirements.length" class="text-center py-10 text-sm text-gray-400 bg-gray-50 rounded-lg border border-gray-200">
          还没有上传项目资料
        </div>
      </div>
    </div>
  </div>
</template>
