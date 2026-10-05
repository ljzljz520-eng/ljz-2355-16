<template>
  <div class="doc-search-snippets" :class="{ 'is-open': open }">
    <button class="doc-search-trigger" type="button" @click="toggle">
      <span class="doc-search-icon">⌕</span>
      <span>检索接口 / 错误码</span>
    </button>

    <div v-if="open" class="doc-search-panel" role="dialog" aria-label="文档检索">
      <form class="doc-search-form" @submit.prevent="submitSearch">
        <select v-model="version" aria-label="文档版本">
          <option value="v2">v2 当前</option>
          <option value="v1">v1 历史</option>
        </select>
        <input
          v-model="keyword"
          type="search"
          placeholder="搜索字段、接口名或错误码，例如 createOrder / ORDER_429"
          aria-label="搜索关键词"
        />
        <button type="submit" :disabled="loading">搜索</button>
      </form>

      <div v-if="error" class="doc-search-status is-error">{{ error }}</div>
      <div v-else-if="result?.meta?.cursorStale" class="doc-search-status is-history">
        正在浏览旧代次（{{ result.meta.generationId }}）结果；当前版本已有新索引。
      </div>
      <div v-else-if="result" class="doc-search-status">
        {{ result.meta.version }} · {{ result.meta.generationId }} · {{ result.meta.totalCandidates }} 条候选
        <span v-if="result.meta.buildingGenerationId" class="doc-search-building">
          · 新代次 {{ result.meta.buildingGenerationId }} 正在构建，当前结果来自已发布代次
        </span>
      </div>

      <ul v-if="result?.hits.length" class="doc-search-results">
        <li v-for="hit in result.hits" :key="`${hit.version}-${hit.docId}-${hit.sectionId}`">
          <a :href="hit.url" class="doc-search-link">
            <div class="doc-search-title-row">
              <span class="doc-search-title" v-html="renderMarks(hit.title, hit.highlights.title)"></span>
              <span class="doc-search-state" :class="hit.versionState">
                {{ hit.versionState === 'current' ? '当前' : '历史' }}
              </span>
              <span class="doc-search-version">{{ hit.version }}</span>
            </div>
            <div v-if="hit.apiName" class="doc-search-field api">
              <span>接口</span>
              <code v-html="renderMarks(hit.apiName, hit.highlights.apiName)"></code>
            </div>
            <div v-if="hit.errorCode" class="doc-search-field error">
              <span>错误码</span>
              <code v-html="renderMarks(hit.errorCode, hit.highlights.errorCode)"></code>
            </div>
            <p v-if="hit.snippet" class="doc-search-snippet" v-html="renderMarks(hit.snippet.text, hit.snippet.highlights)"></p>
          </a>
        </li>
      </ul>
      <div v-else-if="searched && !loading" class="doc-search-empty">没有匹配结果</div>

      <div v-if="result" class="doc-search-pager">
        <button type="button" :disabled="!cursorHistory.length" @click="goPrevious">上一页</button>
        <button type="button" :disabled="!result.page.next" @click="goNext">下一页</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { h, ref } from 'vue'

const open = ref(false)
const keyword = ref('')
const version = ref('v2')
const loading = ref(false)
const error = ref('')
const result = ref(null)
const searched = ref(false)
const cursorHistory = ref([])
const currentCursor = ref('')

function toggle() {
  open.value = !open.value
}

async function fetchPage(cursor = '') {
  loading.value = true
  error.value = ''
  try {
    const params = new URLSearchParams({ q: keyword.value, version: version.value, limit: '5' })
    if (cursor) params.set('cursor', cursor)
    const response = await fetch(`/api/search/v1/snippets?${params}`)
    const payload = await response.json()
    if (!response.ok) {
      if (payload.error?.code === 'INDEX_NOT_READY') {
        throw new Error('索引正在新一代次构建中，尚未发布；不能把构建中误报为无匹配。')
      }
      if (payload.error?.code === 'STALE_CURSOR') {
        throw new Error('旧游标已失效，请从第一页重新搜索。')
      }
      throw new Error(payload.error?.message ?? '检索失败')
    }
    result.value = payload
    searched.value = true
  } catch (err) {
    result.value = null
    error.value = err.message
  } finally {
    loading.value = false
  }
}

async function submitSearch() {
  cursorHistory.value = []
  currentCursor.value = ''
  await fetchPage()
}

async function goNext() {
  if (!result.value?.page.next) return
  cursorHistory.value.push(currentCursor.value)
  currentCursor.value = result.value.page.next
  await fetchPage(currentCursor.value)
}

async function goPrevious() {
  currentCursor.value = cursorHistory.value.pop() ?? ''
  await fetchPage(currentCursor.value)
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[ch])
}

function mark(text, range) {
  return h('mark', { class: 'doc-search-mark' }, text)
}

// Ranges are Unicode code-point offsets, not UTF-16 indexes.
function renderMarks(rawValue, ranges = []) {
  const chars = Array.from(String(rawValue ?? ''))
  const merged = [...ranges]
    .filter((range) => range.end > range.start && range.start >= 0 && range.end <= chars.length)
    .sort((a, b) => a.start - b.start)
  const nodes = []
  let cursor = 0
  for (const range of merged) {
    if (range.start < cursor) continue
    if (range.start > cursor) nodes.push(chars.slice(cursor, range.start).join(''))
    nodes.push(mark(chars.slice(range.start, range.end).join(''), range))
    cursor = range.end
  }
  if (cursor < chars.length) nodes.push(chars.slice(cursor).join(''))
  return nodes
}
</script>

<style scoped>
.doc-search-snippets { position: relative; }
.doc-search-trigger {
  align-items: center;
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-2);
  border-radius: 8px;
  padding: 5px 10px;
  display: inline-flex;
  gap: 6px;
  cursor: pointer;
}
.doc-search-icon { font-size: 16px; line-height: 1; }
.doc-search-panel {
  position: absolute;
  right: 0;
  top: 42px;
  width: min(680px, calc(100vw - 24px));
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  box-shadow: 0 18px 48px rgb(0 0 0 / 18%);
  padding: 14px;
  z-index: 1000;
}
.doc-search-form { display: flex; gap: 8px; }
.doc-search-form input { flex: 1; min-width: 0; }
.doc-search-form input, .doc-search-form select, .doc-search-form button {
  border: 1px solid var(--vp-c-divider);
  border-radius: 7px;
  padding: 7px 9px;
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
}
.doc-search-status { margin-top: 10px; font-size: 12px; color: var(--vp-c-text-2); }
.doc-search-status.is-history { color: #a16207; }
.doc-search-status.is-error { color: #b91c1c; }
.doc-search-results { list-style: none; margin: 10px 0 0; padding: 0; max-height: 52vh; overflow: auto; }
.doc-search-results li { border-top: 1px solid var(--vp-c-divider); }
.doc-search-link { display: block; padding: 10px 4px; text-decoration: none; color: inherit; }
.doc-search-link:hover { background: var(--vp-c-bg-soft); border-radius: 8px; }
.doc-search-title-row { display: flex; align-items: center; gap: 8px; }
.doc-search-title { font-weight: 650; color: var(--vp-c-brand); }
.doc-search-state, .doc-search-version {
  font-size: 11px;
  border-radius: 999px;
  padding: 2px 7px;
  background: var(--vp-c-bg-soft);
}
.doc-search-state.current { color: #15803d; background: #dcfce7; }
.doc-search-state.historical { color: #a16207; background: #fef3c7; }
.doc-search-field { display: flex; gap: 8px; margin-top: 5px; font-size: 13px; }
.doc-search-field span { color: var(--vp-c-text-2); min-width: 42px; }
.doc-search-snippet { margin: 7px 0 0; color: var(--vp-c-text-2); font-size: 13px; line-height: 1.6; }
:deep(.doc-search-mark) { background: #fef08a; color: inherit; border-radius: 3px; padding: 0 2px; }
.doc-search-pager { display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px; }
.doc-search-pager button {
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  border-radius: 7px;
  padding: 5px 10px;
  cursor: pointer;
}
.doc-search-empty { padding: 24px; text-align: center; color: var(--vp-c-text-2); }
@media (max-width: 640px) {
  .doc-search-trigger span:last-child { display: none; }
  .doc-search-panel { right: -8px; }
}
</style>
