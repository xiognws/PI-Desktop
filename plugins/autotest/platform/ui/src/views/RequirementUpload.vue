<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { FileText, Upload, RefreshCw } from 'lucide-vue-next'

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

async function load() {
  try {
    const response = await fetch(`/api/projects/${projectId}/requirements`)
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
    const data = await response.json()
    requirements.value = data.requirements ?? []
    error.value = ''
  } catch (problem) {
    error.value = String((problem as Error).message ?? problem)
  }
}

async function onPick(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  uploading.value = true
  message.value = ''
  error.value = ''
  try {
    const body = new FormData()
    body.append('file', file)
    const response = await fetch(`/api/projects/${projectId}/requirements/upload`, {
      method: 'POST',
      body,
    })
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
    message.value = `${file.name} 已上传`
    await load()
  } catch (problem) {
    error.value = String((problem as Error).message ?? problem)
  } finally {
    uploading.value = false
    if (fileInput.value) fileInput.value.value = ''
  }
}

function sizeText(bytes: number | null) {
  if (!bytes) return ''
  return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`
}

onMounted(load)
</script>

<template>
  <div class="flex-1 overflow-auto p-6">
    <div class="max-w-4xl mx-auto">
      <div class="bg-white rounded-lg border border-gray-200 p-6">
        <h2 class="text-base font-medium text-gray-900">需求文档</h2>
        <p class="text-sm text-gray-500 mt-1">
          上传后需求文件与记录留在平台；拆解功能点、生成用例由桌面端的 Agent 通过插件工具完成。
        </p>

        <div class="mt-5 flex items-center gap-3">
          <input ref="fileInput" type="file" class="hidden" accept=".pdf,.doc,.docx,.md,.txt" @change="onPick" />
          <button
            class="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-50"
            :disabled="uploading"
            @click="fileInput?.click()"
          >
            <Upload class="w-4 h-4" />
            {{ uploading ? '上传中…' : '上传需求文档' }}
          </button>
          <button class="flex items-center gap-2 px-3 py-2 rounded-lg border border-gray-200 text-sm text-gray-600 hover:bg-gray-50" @click="load">
            <RefreshCw class="w-4 h-4" />
            刷新
          </button>
          <span v-if="message" class="text-sm text-green-600">{{ message }}</span>
          <span v-if="error" class="text-sm text-red-600">{{ error }}</span>
        </div>
      </div>

      <div class="bg-white rounded-lg border border-gray-200 mt-6">
        <div class="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
          <h3 class="text-sm font-medium text-gray-900">已上传</h3>
          <span class="text-xs text-gray-400">{{ requirements.length }} 个文件</span>
        </div>
        <div v-if="requirements.length === 0" class="px-6 py-10 text-center text-sm text-gray-400">
          还没有上传需求文档
        </div>
        <div v-else class="divide-y divide-gray-100">
          <div v-for="item in requirements" :key="item.id" class="px-6 py-3 flex items-center gap-3">
            <FileText class="w-4 h-4 text-gray-400" />
            <span class="text-sm text-gray-900 flex-1 truncate">{{ item.filename }}</span>
            <span class="text-xs text-gray-400">{{ sizeText(item.size) }}</span>
            <span class="text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-500">{{ item.status }}</span>
            <span class="text-xs text-gray-400">{{ item.created_at }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
