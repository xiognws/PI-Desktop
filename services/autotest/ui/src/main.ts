import { createApp } from 'vue'
import './style.css'
import App from './App.vue'
import router from './router'

// 面板形态下页面 origin 是插件目录，不是后端；把相对的 /api 请求接到宿主注入的
// 后端地址（renderer/index.html 写入 window.__AUTOTEST_API__）。单独跑 ui/dist
// 时该值为空，行为与原来一致。
const apiBase: string =
  (window as unknown as { __AUTOTEST_API__?: string }).__AUTOTEST_API__ ?? ''

if (apiBase) {
  const originalFetch = window.fetch.bind(window)
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === 'string' && input.startsWith('/api')) {
      return originalFetch(apiBase + input, init)
    }
    return originalFetch(input, init)
  }
}

createApp(App).use(router).mount('#app')
