<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { Upload, RefreshCw } from 'lucide-vue-next'
import Badge from '@/components/Badge.vue'
import EmptyState from '@/components/EmptyState.vue'

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
  <div class="flex-1 overflow-auto bg-surface-2">
    <div class="mx-auto w-full max-w-[1000px] px-8 py-7">
      <header class="flex items-start justify-between gap-4">
        <div>
          <h1 class="text-[20px] font-medium text-fg">项目资料</h1>
          <p class="mt-1 text-[13px] text-muted">
            上传需求文档、接口说明、协议表 → 分解入库知识库 → 写用例时按知识库检索原文当依据。
          </p>
        </div>
        <button
          class="flex h-9 items-center gap-2 rounded-[8px] border border-line bg-surface px-3 text-[13px] text-fg hover:bg-surface-3"
          @click="load"
        >
          <RefreshCw class="h-4 w-4" /> 刷新
        </button>
      </header>

      <!-- 三段式：现在是第几步一眼可见，用文字而不是圆圈数字 -->
      <ol class="mt-5 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[12px] border border-line bg-surface px-5 py-3 text-[12px]">
        <li class="text-fg">① 上传项目资料</li>
        <li class="text-muted-2">→</li>
        <li :class="requirements.length ? 'text-fg' : 'text-muted-2'">② 分解入库知识库</li>
        <li class="text-muted-2">→</li>
        <li :class="requirements.some(i => archivedChunks(i.filename) !== null) ? 'text-fg' : 'text-muted-2'">③ 按知识库写用例</li>
        <li v-if="archiveResult" class="num ml-auto text-muted-2">
          入库 {{ archiveResult.imported }} · 跳过 {{ archiveResult.skipped }} · 失败 {{ archiveResult.failed }}
        </li>
      </ol>

      <!-- 上传区 -->
      <div class="mt-5 rounded-[12px] border border-line bg-surface p-6">
        <input ref="fileInput" type="file" class="hidden" multiple accept=".pdf,.docx,.xlsx,.md,.txt" @change="onPick" />
        <div
          class="cursor-pointer rounded-[8px] border border-dashed px-6 py-10 text-center transition-colors"
          :class="dragging ? 'border-accent bg-accent-soft' : 'border-line-strong hover:border-accent'"
          @click="fileInput?.click()"
          @dragover.prevent="dragging = true"
          @dragleave.prevent="dragging = false"
          @drop.prevent="onDrop"
        >
          <Upload class="mx-auto h-6 w-6 text-muted-2" />
          <p class="mt-3 text-[13px] text-fg">
            {{ uploading ? `上传中 ${progress.done}/${progress.total}…` : '点击或拖拽文件到这里，可一次多个' }}
          </p>
          <p class="mt-1 text-[12px] text-muted-2">
            支持 PDF / Word / Excel / Markdown / 纯文本。上传只归档原文，第 ② 步才切分入库。
          </p>
        </div>
        <div class="mt-3 flex items-center gap-4 text-[12px]">
          <span v-if="message" class="text-success">{{ message }}</span>
          <span v-if="error" class="text-danger">{{ error }}</span>
        </div>
      </div>

      <!-- 已上传 -->
      <section class="mt-5 overflow-hidden rounded-[12px] border border-line bg-surface">
        <div class="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-5 py-2">
          <h2 class="text-[13px] font-medium text-fg">已上传资料</h2>
          <span class="num text-[12px] text-muted-2">{{ requirements.length }} 个文件</span>
          <button
            class="ml-auto h-8 rounded-[8px] border border-line px-3 text-[12px] text-fg hover:bg-surface-3 disabled:opacity-40"
            :disabled="archiving || !requirements.length"
            title="把这些资料切分进项目知识库；写用例时检索的就是知识库"
            @click="archiveToKnowledge"
          >{{ archiving ? '入库中…' : '分解入库知识库' }}</button>
        </div>

        <div
          v-for="item in requirements"
          :key="item.id"
          class="state-bar border-b border-line-soft px-5 py-3 last:border-b-0 hover:bg-surface-2"
          :data-tone="archivedChunks(item.filename) !== null ? 'success' : 'neutral'"
        >
          <div class="flex items-center gap-3">
            <span class="min-w-0 flex-1 truncate text-[13px] text-fg">{{ item.filename }}</span>
            <Badge
              v-if="archivedChunks(item.filename) !== null"
              tone="success"
              :title="`已切分为 ${archivedChunks(item.filename)} 块进入知识库`"
            >已入库 {{ archivedChunks(item.filename) }} 块</Badge>
            <Badge v-else tone="neutral" title="还没分解入库：点右上「分解入库知识库」后，写用例才能检索到这份资料">未入库</Badge>
            <span class="text-[12px] text-muted-2">{{ item.status }}</span>
            <button class="text-[12px] text-muted hover:text-danger" @click="removeRequirement(item)">删除</button>
          </div>
          <p class="num mt-1 text-[12px] text-muted-2">{{ sizeText(item.size) }} · {{ item.created_at }}</p>
        </div>

        <EmptyState
          v-if="!requirements.length"
          class="m-5"
          title="还没有项目资料"
          hint="把需求文档、协议表拖到上面的框里，再从第 ② 步入库"
        />
      </section>
    </div>
  </div>
</template>
