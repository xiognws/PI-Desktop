import { createMemoryHistory, createRouter, createWebHistory } from 'vue-router'

// 面板形态下页面是 file:// 打开的：HTML5 history 的 pushState/replaceState 在
// file:// 文档上直接抛 SecurityError，整个 app 挂不上去 → 面板白屏。
// 由后端托管（http/https）时保留普通 history，深链接照旧可用。
// file:// 文档的 origin 是 null，pushState / replaceState 一律抛 SecurityError —
// hash history 初始化时也会 replaceState，同样会炸。面板里没有地址栏，用内存路由。
const overHttp = /^https?:$/.test(window.location.protocol)

const router = createRouter({
  history: overHttp ? createWebHistory() : createMemoryHistory(),
  routes: [
    {
      path: '/',
      name: 'Home',
      component: () => import('@/views/Home.vue'),
    },
    {
      path: '/project/:projectId',
      component: () => import('@/views/ProjectLayout.vue'),
      children: [
        {
          path: '',
          // 字符串 redirect 不会替换 :projectId（vue-router 按字面量处理），
          // 点项目卡会跳到字面路径 /project/:projectId/cases → 无匹配 → 空白页。
          redirect: (to) => `/project/${to.params.projectId}/runs`,
        },
        {
          path: 'runs',
          name: 'Runs',
          component: () => import('@/views/Runs.vue'),
        },
        {
          path: 'executions',
          name: 'Executions',
          component: () => import('@/views/Executions.vue'),
        },
        {
          // 人工卡点独立成页：审批不该只在某个 run 的展开区里才看得到。
          path: 'approvals',
          name: 'Approvals',
          component: () => import('@/views/Approvals.vue'),
        },
        {
          // 执行详情必须带 id：执行记录页点一行就进这里看事件流与用例结果。
          path: 'executions/:id',
          name: 'ExecutionDetail',
          component: () => import('@/views/ExecutionDetail.vue'),
        },
        {
          path: 'bugs',
          name: 'Defects',
          component: () => import('@/views/Defects.vue'),
        },
        {
          path: 'knowledge',
          name: 'Knowledge',
          component: () => import('@/views/Knowledge.vue'),
        },
        {
          path: 'requirements',
          name: 'RequirementUpload',
          component: () => import('@/views/RequirementUpload.vue'),
        },
        {
          path: 'cases',
          name: 'Cases',
          component: () => import('@/views/Cases.vue'),
        },
        {
          path: 'scripts',
          name: 'Scripts',
          component: () => import('@/views/Scripts.vue'),
        },
        {
          path: 'scripts/:scriptId/edit',
          name: 'ScriptEditor',
          component: () => import('@/views/ScriptEditor.vue'),
        },
        {
          path: 'reports',
          name: 'Reports',
          component: () => import('@/views/Reports.vue'),
        },
      ],
    },
    {
      path: '/:pathMatch(.*)*',
      name: 'NotFound',
      redirect: '/',
    },
  ],
})

// 项目路由保护：URL 里出现字面占位符（:projectId）或空参数时回 Home，
// 避免带着不存在的 project 撞后端各 /api/projects/{id}/... 端点。
router.beforeEach((to) => {
  const pid = to.params?.projectId
  if (typeof pid === 'string' && (pid === ':projectId' || pid.trim() === '')) {
    return { path: '/' }
  }
  return true
})

export default router
