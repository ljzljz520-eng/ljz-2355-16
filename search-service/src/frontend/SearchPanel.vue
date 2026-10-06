<script setup>
// Documentation search panel.
// - typed highlights (field/api/error/text) rendered safely from segments
// - current vs historical results get explicit badges; links carry the exact
//   version + anchor so a click lands on the matching chapter version
// - distinguishes "index not ready" / "no index" from a genuine empty result
import { ref, computed, shallowRef } from 'vue';
import { SearchClient } from './search-client.js';
import { renderSegmentsToFragment, versionBadge } from './render.js';

const props = defineProps({
  apiBase: { type: String, default: '/api' },
  principals: { type: Array, default: () => [] },
});

const q = ref('');
const version = ref('current');
const includeHistorical = ref(false);
const state = shallowRef({ status: 'idle', results: [] });
const loading = ref(false);
const cursor = ref(null);
const firstCursor = ref(null);
const client = new SearchClient(props.apiBase, { principals: props.principals });
let seq = 0;

const isEmpty = computed(
  () => state.value.status === 'ok' && state.value.total === 0
);
const isNotReady = computed(() =>
  ['not_ready', 'no_index'].includes(state.value.status)
);

async function run(append = false) {
  if (!q.value.trim()) {
    state.value = { status: 'idle', results: [] };
    return;
  }
  loading.value = true;
  const my = ++seq;
  const res = await client.search({
    q: q.value,
    version: version.value,
    includeHistorical: includeHistorical.value,
    limit: 10,
    cursor: append ? cursor.value : undefined,
  });
  if (my !== seq) return; // a newer request superseded this one
  loading.value = false;
  if (append && res.status === 'ok') {
    res.results = [...state.value.results, ...res.results];
    cursor.value = res.nextCursor;
  } else {
    cursor.value = res.nextCursor || null;
    firstCursor.value = cursor.value;
  }
  state.value = res;
}

function onInput() {
  cursor.value = null;
  run(false);
}

// Render snippet safely into an element ref via DOM nodes (no innerHTML).
function paint(el, segments) {
  if (!el) return;
  el.replaceChildren(renderSegmentsToFragment(segments || [], document));
}
</script>

<template>
  <div class="doc-search">
    <div class="doc-search__bar">
      <input
        v-model="q"
        @input="onInput"
        type="search"
        placeholder="搜索字段、接口名或错误码…"
        aria-label="文档搜索"
      />
      <select v-model="version" @change="onInput">
        <option value="current">当前版本</option>
        <option value="all">全部版本</option>
      </select>
      <label class="doc-search__hist">
        <input type="checkbox" v-model="includeHistorical" @change="onInput" />
        包含历史版本
      </label>
    </div>

    <div v-if="loading" class="doc-search__hint">检索中…</div>

    <div v-else-if="isNotReady" class="doc-search__hint doc-search__hint--warn">
      {{ state.message || '索引尚未就绪' }}
    </div>

    <div v-else-if="state.status === 'error'" class="doc-search__hint doc-search__hint--error">
      {{ state.code === 'STALE_CURSOR' ? '结果已更新，请重新检索' : '搜索失败：' + state.code }}
    </div>

    <div v-else-if="isEmpty" class="doc-search__hint">
      已在<b>当前索引</b>中检索，暂无匹配（不是索引未完成）。
    </div>

    <ul v-else-if="state.status === 'ok'" class="doc-search__list">
      <li v-for="r in state.results" :key="r.generation + r.sectionId" class="doc-search__item">
        <a :href="r.url" class="doc-search__link">
          <div class="doc-search__title">
            {{ r.title }}
            <span
              class="doc-search__badge"
              :class="versionBadge(r).kind === 'current' ? 'is-current' : 'is-history'"
            >{{ versionBadge(r).label }}</span>
          </div>
          <p class="doc-search__snippet" :ref="(el) => paint(el, r.snippet.segments)"></p>
          <div class="doc-search__meta">{{ r.deepLink.slug }} · #{{ r.deepLink.anchor }}</div>
        </a>
      </li>
    </ul>

    <button
      v-if="state.status === 'ok' && cursor"
      class="doc-search__more"
      @click="run(true)"
    >
      加载更多
    </button>
  </div>
</template>

<style scoped>
.doc-search__bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.doc-search__bar input[type='search'] { flex: 1; min-width: 220px; padding: 8px 12px; }
.doc-search__list { list-style: none; margin: 12px 0 0; padding: 0; }
.doc-search__item { border: 1px solid var(--vp-c-divider, #e5e7eb); border-radius: 8px; margin-bottom: 10px; }
.doc-search__link { display: block; padding: 10px 14px; text-decoration: none; color: inherit; }
.doc-search__title { font-weight: 600; display: flex; align-items: center; gap: 8px; }
.doc-search__snippet { margin: 6px 0; line-height: 1.6; font-size: 14px; }
.doc-search__meta { font-size: 12px; opacity: 0.65; }
.doc-search__badge { font-size: 12px; padding: 1px 8px; border-radius: 999px; font-weight: 500; }
.doc-search__badge.is-current { background: #ecf5ff; color: #1d6fff; }
.doc-search__badge.is-history { background: #f4f4f5; color: #909399; }
.doc-search__hint { padding: 12px; color: #606266; }
.doc-search__hint--warn { background: #fdf6ec; color: #b88230; border-radius: 8px; }
.doc-search__hint--error { background: #fef0f0; color: #c45656; border-radius: 8px; }
.doc-search__more { margin-top: 8px; }
:deep(mark.search-hl-field) { background: #d9ecff; color: #0a4fa0; }
:deep(mark.search-hl-api) { background: #e1f3d8; color: #2f7d32; }
:deep(mark.search-hl-error) { background: #fde2e2; color: #c45656; }
:deep(mark.search-hl-text) { background: #faecd8; color: #9c6b1d; }
</style>
