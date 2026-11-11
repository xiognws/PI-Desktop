<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { Search, Lightbulb, Upload, FileText, RefreshCw } from 'lucide-vue-next'

const route = useRoute()
const projectId = route.params.projectId as string

type Hit = { title?: string; excerpt?: string; source_ref?: string; score?: number | null; module?: string }
type Doc = { doc_id: string; filename?: string; module?: string; tags?: string; size?: number; chunk_count?: number; created_at?: string }
type Chunk = { title?: string; excerpt?: string; chars?: number; source_ref?: string }

const kw = ref((route.query.q as string) || '')
const kwModule = ref((route.query.module as string) || '')
const kwTags = ref('')
const hits = ref<Hit[]>([])
const docs = ref<Doc[]>([])
const status = ref('')
const busy = ref(false)
const chunkDoc = ref<{ doc: Doc; chunks: Chunk[]; total: number } | null>(null)
const chunkOffset = ref(0)
const CHUNK_PAGE = 50
const fileInput = ref<HTMLInputElement | null>(null)
const uploadModule = ref('')
const uploadTags = ref('')

function shortTime(value?: string) {
  return value ? value.replace('T', ' ').slice(5, 16) : ''
}

// 从左侧「项目结构」点模块进来时，没有关键词也要能看该模块的文档
const visibleDocs = computed(() =>
  kwModule.value ? docs.value.filter(d => (d.module || '未标模块') === kwModule.value) : docs.value,
)

async function searchKnowledge() {
  if (!kw.value.trim()) {
    status.value = '先输入关键词'
    return
  }
  busy.value = true
  try {
    const qs = new URLSearchParams({ q: kw.value.trim(), limit: '20' })
    if (kwModule.value) qs.set('module', kwModule.value)
    if (kwTags.value) qs.set('tags', kwTags.value)
    const res = await fetch(`/api/projects/${projectId}/workflow/knowledge/search?${qs.toString()}`)
    const body = await res.json()
    hits.value = body?.data?.records || []
    status.value = hits.value.length ? `命中 ${hits.value.length} 条` : '没有命中'
  } catch {
    status.value = '检索失败'
  } finally {
    busy.value = false
  }
}

async function loadDocs() {
  try {
    const res = await fetch(`/api/projects/${projectId}/knowledge/documents`)
    const body = await res.json()
    docs.value = body?.data?.documents || []
  } catch {
    status.value = '加载文档库失败'
  }
}

async function upload(files: FileList | null) {
  if (!files || !files.length) return
  busy.value = true
  try {
    const form = new FormData()
    for (const file of Array.from(files)) form.append('files', file)
    form.append('module', uploadModule.value)
    form.append('tags', uploadTags.value)
    form.append('chunk_chars', '1200')
    const res = await fetch(`/api/projects/${projectId}/knowledge/documents/batch`, {
      method: 'POST',
      body: form,
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(body?.detail || `HTTP ${res.status}`)
    const imported = body?.data?.imported?.length ?? 0
    const failed = body?.data?.failed?.length ?? 0
    status.value = imported
      ? `已导入 ${imported} 篇${failed ? `，失败 ${failed} 篇` : ''}`
      : `导入失败：${body?.data?.failed?.[0]?.reason || body?.detail || '未知原因'}`
    await loadDocs()
  } catch (e: any) {
    status.value = e?.message || '上传失败'
  } finally {
    busy.value = false
    if (fileInput.value) fileInput.value.value = ''
  }
}

async function previewChunks(doc: Doc, offset = 0) {
  try {
    const res = await fetch(
      `/api/projects/${projectId}/knowledge/documents/${doc.doc_id}/chunks?offset=${offset}&limit=${CHUNK_PAGE}`,
    )
    const body = await res.json()
    if (!res.ok) throw new Error(body?.detail || `HTTP ${res.status}`)
    chunkOffset.value = offset
    chunkDoc.value = {
      doc,
      chunks: body?.data?.chunks || [],
      total: body?.data?.total || 0,
    }
  } catch (e: any) {
    status.value = e?.message || '读取切分失败'
  }
}

async function removeDoc(doc: Doc) {
  try {
    const res = await fetch(`/api/projects/${projectId}/knowledge/documents/${doc.doc_id}`, { method: 'DELETE' })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(body?.detail || `HTTP ${res.status}`)
    status.value = body?.summary || '已删除'
    if (chunkDoc.value?.doc.doc_id === doc.doc_id) chunkDoc.value = null
    await loadDocs()
  } catch (e: any) {
    status.value = e?.message || '删除失败'
  }
}

function copyHit(hit: Hit) {
  const text = [hit.title, hit.source_ref, hit.excerpt].filter(Boolean).join('\n')
  navigator.clipboard?.writeText(text)
  status.value = '已复制到剪贴板'
}

onMounted(async () => {
  await loadDocs()
  if (kw.value) await searchKnowledge()
})
</script>

<template>
  <div class="flex-1 flex flex-col overflow-auto p-6">
    <div class="flex items-start justify-between mb-6">
      <div>
        <h2 class="text-lg font-medium text-gray-900">知识库</h2>
        <p class="text-sm text-gray-500 mt-1">导入文档后按段落切分，Agent 出用例前先查这里；报告也会归档进来</p>
      </div>
      <div class="flex items-center gap-2">
        <input v-model="uploadModule" class="h-8 w-24 px-2 text-xs border border-gray-200 rounded-lg" placeholder="模块" />
        <input v-model="uploadTags" class="h-8 w-24 px-2 text-xs border border-gray-200 rounded-lg" placeholder="标签" />
        <input ref="fileInput" type="file" multiple class="hidden" @change="upload(($event.target as HTMLInputElement).files)" />
        <button
          class="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-60"
          :disabled="busy"
          @click="fileInput?.click()"
        >
          <Upload class="w-4 h-4" />
          导入文件
        </button>
      </div>
    </div>

    <!-- 检索 -->
    <div class="max-w-6xl">
      <div class="relative mb-2 max-w-xl">
        <Search class="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
        <input
          v-model="kw"
          type="text"
          placeholder="搜索历史经验、用例、修复方案，如 DTC / 0x22"
          class="w-full pl-9 pr-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          @keydown.enter="searchKnowledge"
        />
      </div>
      <div class="flex items-center gap-2 mb-6">
        <input v-model="kwModule" class="h-8 w-36 px-2 text-xs border border-gray-200 rounded-lg" placeholder="限定模块（可选）" />
        <input v-model="kwTags" class="h-8 w-36 px-2 text-xs border border-gray-200 rounded-lg" placeholder="限定标签（可选）" />
        <button
          class="h-8 px-4 text-xs rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-60"
          :disabled="busy"
          @click="searchKnowledge"
        >检索</button>
        <span v-if="status" class="text-xs text-gray-500">{{ status }}</span>
      </div>

      <!-- 检索结果 -->
      <div v-if="hits.length" class="space-y-4 mb-8">
        <div class="flex items-center gap-2">
          <h3 class="text-sm font-medium text-gray-900">检索结果</h3>
          <span class="text-xs text-gray-400">{{ hits.length }} 条</span>
        </div>
        <div v-for="(hit, idx) in hits" :key="idx" class="bg-white rounded-lg border border-gray-200 p-5 hover:border-blue-300">
          <div class="flex items-center gap-2 mb-2">
            <Lightbulb class="w-4 h-4 text-yellow-500" />
            <span class="font-medium text-gray-900">{{ hit.title || hit.source_ref || '未命名段落' }}</span>
            <span v-if="hit.module" class="text-xs px-2 py-0.5 rounded bg-blue-50 text-blue-600">{{ hit.module }}</span>
            <span v-if="hit.score === null || hit.score === undefined" class="text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-500">模糊匹配</span>
            <button class="ml-auto text-xs text-blue-600 hover:underline" @click="copyHit(hit)">复制</button>
          </div>
          <p class="text-sm text-gray-600 mb-3 leading-relaxed">{{ hit.excerpt || '' }}</p>
          <div class="flex items-center justify-between text-xs text-gray-400">
            <span>{{ hit.source_ref || '' }}</span>
            <span v-if="hit.score !== null && hit.score !== undefined">相关度 {{ Number(hit.score).toFixed(3) }}</span>
          </div>
        </div>
      </div>

      <!-- 文档库 -->
      <div class="flex items-center gap-2 mb-3">
        <h3 class="text-sm font-medium text-gray-900">文档库</h3>
        <span class="text-xs text-gray-400">{{ visibleDocs.length }} 篇<span v-if="kwModule">（{{ kwModule }}）</span></span>
        <button class="ml-auto p-1 text-gray-400 hover:text-gray-700" @click="loadDocs"><RefreshCw class="w-3.5 h-3.5" /></button>
      </div>
      <div class="grid grid-cols-2 gap-4">
        <div v-for="doc in visibleDocs" :key="doc.doc_id" class="bg-white rounded-lg border border-gray-200 p-4 flex items-start gap-3">
          <FileText class="w-5 h-5 text-gray-400 flex-shrink-0 mt-0.5" />
          <div class="min-w-0 flex-1">
            <div class="font-medium text-gray-900 truncate">{{ doc.filename || doc.doc_id }}</div>
            <div class="text-xs text-gray-400 mt-1">
              {{ doc.module || '未标模块' }} · {{ doc.chunk_count ?? 0 }} 段 · {{ shortTime(doc.created_at) }}
            </div>
            <div class="flex items-center gap-3 mt-2">
              <button class="text-xs text-blue-600 hover:underline" @click="previewChunks(doc, 0)">查看切分</button>
              <button class="text-xs text-gray-400 hover:text-red-600" @click="removeDoc(doc)">删除</button>
            </div>
          </div>
        </div>
        <div v-if="!visibleDocs.length" class="col-span-2 text-center py-12 text-sm text-gray-400 bg-white rounded-lg border border-gray-200">
          还没有文档，点右上「导入文件」
        </div>
      </div>
    </div>

    <!-- 切分预览 -->
    <div v-if="chunkDoc" class="fixed inset-0 bg-black/30 flex items-center justify-center z-40" @click.self="chunkDoc = null">
      <div class="w-[760px] max-h-[80vh] bg-white rounded-lg shadow-lg flex flex-col">
        <div class="h-11 px-4 flex items-center justify-between border-b border-gray-100">
          <span class="text-sm font-medium text-gray-900">
            {{ chunkDoc.doc.filename || chunkDoc.doc.doc_id }} · {{ chunkDoc.total }} 段
          </span>
          <button class="text-gray-400 hover:text-gray-800" @click="chunkDoc = null">关闭</button>
        </div>
        <div class="flex-1 overflow-auto px-4 py-3 space-y-2">
          <div v-for="(chunk, idx) in chunkDoc.chunks" :key="idx" class="border border-gray-100 rounded">
            <div class="px-3 py-1.5 bg-gray-50 text-xs text-gray-700 flex items-center gap-2">
              <span class="truncate">{{ chunk.title || '未命名段落' }}</span>
              <span class="ml-auto text-gray-400">{{ chunk.chars || 0 }} 字符</span>
            </div>
            <div class="px-3 py-2 text-xs text-gray-600 whitespace-pre-wrap">{{ chunk.excerpt }}</div>
          </div>
        </div>
        <div class="h-11 px-4 flex items-center justify-center gap-3 border-t border-gray-100 text-xs text-gray-600">
          <button
            class="px-2 py-1 border border-gray-200 rounded disabled:opacity-40"
            :disabled="chunkOffset <= 0"
            @click="previewChunks(chunkDoc.doc, Math.max(0, chunkOffset - CHUNK_PAGE))"
          >上一页</button>
          <span>{{ chunkOffset + 1 }} - {{ Math.min(chunkOffset + CHUNK_PAGE, chunkDoc.total) }} / {{ chunkDoc.total }}</span>
          <button
            class="px-2 py-1 border border-gray-200 rounded disabled:opacity-40"
            :disabled="chunkOffset + CHUNK_PAGE >= chunkDoc.total"
            @click="previewChunks(chunkDoc.doc, chunkOffset + CHUNK_PAGE)"
          >下一页</button>
        </div>
      </div>
    </div>
  </div>
</template>
