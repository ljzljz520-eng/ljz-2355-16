import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderSegmentsToHtml,
  escapeText,
  versionBadge,
} from '../src/frontend/render.js';

// Minimal DOM shim verifying the node-based renderer never parses HTML.
class FakeNode {
  constructor(tag) {
    this.tagName = tag ? tag.toUpperCase() : '#text';
    this.children = [];
    this.className = '';
    this.dataset = {};
    this._text = '';
  }
  set textContent(v) {
    this._text = v;
    this.children = [];
  }
  get textContent() {
    return this._text;
  }
  appendChild(c) {
    this.children.push(c);
    return c;
  }
}
const fakeDocument = {
  createDocumentFragment: () => new FakeNode('fragment'),
  createElement: (t) => new FakeNode(t),
  createTextNode: (t) => {
    const n = new FakeNode(null);
    n._text = t;
    return n;
  },
};

test('renderSegmentsToHtml 转义片段中的 HTML，注入脚本不执行', () => {
  const segments = [
    { text: '正常 ', marked: false, type: null },
    { text: '<img src=x onerror=alert(1)>', marked: true, type: 'api' },
  ];
  const html = renderSegmentsToHtml(segments);
  assert.ok(!html.includes('<img'), html);
  assert.ok(html.includes('&lt;img'), html);
  assert.match(html, /<mark class="search-hl-api"[^>]*>.*&lt;img/);
});

test('node 渲染路径使用 textContent，原文标记按类型上色', async () => {
  const { renderSegmentsToFragment } = await import('../src/frontend/render.js');
  const segments = [
    { text: '错误码 ', marked: false, type: null },
    { text: 'E4001', marked: true, type: 'error' },
  ];
  const frag = renderSegmentsToFragment(segments, fakeDocument);
  const mark = frag.children.find((c) => c.tagName === 'MARK');
  assert.equal(mark.className, 'search-hl-error');
  assert.equal(mark.textContent, 'E4001');
  // text node carries the literal prefix, never parsed
  const txt = frag.children.find((c) => c.tagName === '#text');
  assert.equal(txt.textContent, '错误码 ');
});

test('escapeText 处理引号与尖括号', () => {
  assert.equal(escapeText(`"&'<>`), '&quot;&amp;&#39;&lt;&gt;');
});

test('versionBadge 明确区分当前版与历史版', () => {
  assert.equal(versionBadge({ isCurrent: true, version: 'v2' }).kind, 'current');
  assert.equal(versionBadge({ isCurrent: false, version: 'v1' }).kind, 'historical');
  assert.match(versionBadge({ isCurrent: false, version: 'v1' }).label, /v1/);
});
