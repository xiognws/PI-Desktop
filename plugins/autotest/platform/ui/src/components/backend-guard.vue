<script setup>
/**
 * 后端离线守卫：轮询 /api/health，失败 ≥3 次（~45s 窗口）判定后端离线，
 * 铺全屏遮罩 + "重启后端" 按钮（调 /api/backend/restart，后端 spawn
 * scripts/run-backend.bat 幂等拉起）；恢复后自动刷新页面。
 *
 * 版本感知：/api/health 返回的 version 与本前端构建指纹（VITE_BACKEND_MIN_VERSION）
 * 不一致时提示刷新 —— 防"新后端 + 旧前端 JS"错位。
 */
import { ref, onMounted, onBeforeUnmount } from 'vue'

const POLL_MS = 15000
const FAIL_THRESHOLD = 3
const MIN_VERSION = import.meta.env.VITE_BACKEND_MIN_VERSION || ''

const offline = ref(false)
const restarting = ref(false)
const restartError = ref('')
const versionMismatch = ref(false)

let failCount = 0
let timer = null

const fetchHealth = async () => {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 4000)
    const res = await fetch('/api/health', { signal: ctrl.signal })
    clearTimeout(t)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const body = await res.json()
    if (body.status === 'ok') {
      if (MIN_VERSION && body.version && body.version < MIN_VERSION) {
        versionMismatch.value = true
      }
      if (failCount > 0) {
        // 从离线恢复：刷新页面拿新状态
        window.location.reload()
        return
      }
      failCount = 0
    }
  } catch {
    failCount += 1
    if (failCount >= FAIL_THRESHOLD) offline.value = true
  }
}

const restart = async () => {
  restarting.value = true
  restartError.value = ''
  try {
    const res = await fetch('/api/backend/restart', { method: 'POST' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    // 已触发 spawn，等 run-backend.bat 就绪后轮询会自动恢复并刷新
  } catch (e) {
    restartError.value =
      '无法触达重启接口（后端进程可能已完全退出）。' +
      '请重新运行 scripts\\start-autotest.bat'
  } finally {
    restarting.value = false
  }
}

onMounted(() => {
  fetchHealth()
  timer = setInterval(fetchHealth, POLL_MS)
})
onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
})
</script>

<template>
  <div>
    <!-- 版本不匹配横幅（后端比前端新，提示刷新） -->
    <div v-if="versionMismatch" class="bt-banner">
      后端版本（比本页面构建更新）已变更，请
      <button class="bt-banner-btn" @click="window.location.reload()">刷新页面</button>
    </div>

    <!-- 离线全屏遮罩 -->
    <div v-if="offline" class="bt-overlay">
      <div class="bt-card">
        <div class="bt-icon">⚠</div>
        <h2>后端离线</h2>
        <p>无法连接本地测试平台后端（127.0.0.1:4000）。</p>
        <button class="bt-btn" :disabled="restarting" @click="restart">
          {{ restarting ? '正在拉起…' : '重启后端' }}
        </button>
        <p v-if="restartError" class="bt-err">{{ restartError }}</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.bt-banner {
  position: sticky;
  top: 0;
  z-index: 9000;
  background: #f59e0b;
  color: #1f2937;
  text-align: center;
  padding: 6px 12px;
  font-size: 13px;
}
.bt-banner-btn {
  background: #1f2937;
  color: #fff;
  border: none;
  border-radius: 4px;
  padding: 2px 10px;
  cursor: pointer;
  margin: 0 4px;
}
.bt-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  background: rgba(15, 23, 42, 0.92);
  display: flex;
  align-items: center;
  justify-content: center;
}
.bt-card {
  background: #fff;
  border-radius: 12px;
  padding: 36px 48px;
  text-align: center;
  max-width: 420px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4);
}
.bt-icon {
  font-size: 40px;
  margin-bottom: 8px;
}
.bt-card h2 {
  margin: 0 0 8px;
  color: #0f172a;
}
.bt-card p {
  color: #64748b;
  font-size: 14px;
  margin: 0 0 20px;
}
.bt-btn {
  background: #2563eb;
  color: #fff;
  border: none;
  border-radius: 8px;
  padding: 10px 28px;
  font-size: 15px;
  cursor: pointer;
}
.bt-btn:disabled {
  opacity: 0.6;
  cursor: wait;
}
.bt-err {
  margin-top: 14px !important;
  color: #dc2626 !important;
  font-size: 12px !important;
}
</style>
