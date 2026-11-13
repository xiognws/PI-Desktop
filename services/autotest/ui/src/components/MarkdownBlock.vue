<script setup lang="ts">
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { computed } from 'vue'

/**
 * 报告正文渲染。
 *
 * 正文是 Agent 生成的 Markdown —— 属于外部输入，所以「先转 HTML 再消毒」两步都
 * 不能省：marked 只负责方言（表格、任务列表），DOMPurify 负责把脚本、事件属性、
 * javascript: 链接全部剥掉，最后才交给 v-html。
 */
const props = defineProps<{ source: string }>()

const html = computed(() => {
  const raw = marked.parse(props.source || '', { gfm: true, breaks: true, async: false })
  return DOMPurify.sanitize(raw as string, {
    USE_PROFILES: { html: true },
    // 报告里不该出现内联样式与 target/rel 之外的属性；URIs 只放行常规协议。
    ALLOWED_URI_REGEXP: /^(?:https?|mailto|tel):/i,
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe', 'object', 'embed'],
    FORBID_ATTR: ['style', 'srcset', 'formaction'],
  })
})
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html -- 上面已消毒 -->
  <div class="md-body" v-html="html" />
</template>

<style scoped>
.md-body {
  font-size: 13px;
  line-height: 1.7;
  color: var(--fg-2);
  word-break: break-word;
}
.md-body :deep(h1),
.md-body :deep(h2),
.md-body :deep(h3),
.md-body :deep(h4) {
  font-weight: 600;
  color: var(--fg);
  margin: 1.2em 0 0.5em;
  line-height: 1.35;
}
.md-body :deep(h1) { font-size: 1.35em; }
.md-body :deep(h2) { font-size: 1.2em; }
.md-body :deep(h3) { font-size: 1.05em; }
.md-body :deep(p) { margin: 0.55em 0; }
.md-body :deep(ul),
.md-body :deep(ol) { margin: 0.55em 0; padding-left: 1.4em; }
.md-body :deep(ul) { list-style: disc; }
.md-body :deep(ol) { list-style: decimal; }
.md-body :deep(li) { margin: 0.2em 0; }
.md-body :deep(li > input[type='checkbox']) { margin-right: 0.4em; }
.md-body :deep(code) {
  background: var(--surface-3);
  border-radius: 4px;
  padding: 0.1em 0.35em;
  font-size: 0.92em;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.md-body :deep(pre) {
  background: var(--surface-2);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 0.7em 0.9em;
  overflow-x: auto;
  margin: 0.7em 0;
}
.md-body :deep(pre code) { background: transparent; padding: 0; font-size: 0.9em; }
.md-body :deep(blockquote) {
  border-left: 3px solid var(--line-strong);
  padding-left: 0.8em;
  color: var(--fg-3);
  margin: 0.7em 0;
}
.md-body :deep(table) {
  border-collapse: collapse;
  width: 100%;
  margin: 0.8em 0;
  font-size: 0.95em;
  display: block;
  overflow-x: auto;
}
.md-body :deep(th),
.md-body :deep(td) {
  border: 1px solid var(--line);
  padding: 0.35em 0.6em;
  text-align: left;
  vertical-align: top;
}
.md-body :deep(th) { background: var(--surface-2); font-weight: 600; }
.md-body :deep(a) { color: var(--accent); text-decoration: underline; }
.md-body :deep(hr) { border: 0; border-top: 1px solid var(--line); margin: 1.2em 0; }
.md-body :deep(img) { max-width: 100%; }
</style>
