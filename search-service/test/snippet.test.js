import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareViews, buildSnippet } from '../src/snippet/snippet.js';
import { escapeHtml } from '../src/text/html-view.js';
import { textAnalyze, codeAnalyze } from '../src/text/analyzers.js';

// Build matches on the NORM view, mirroring how the engine creates them.
function matchesFor(views, query) {
  const out = [];
  const terms = query.split(/\s+/);
  for (const term of terms) {
    const fromCode = /[A-Za-z0-9_]/.test(term);
    const toks = fromCode ? codeAnalyze(views.norm).tokens : textAnalyze(views.norm).tokens;
    for (const t of toks) {
      if (t.shadow) continue;
      if (t.term.toLowerCase() === term.toLowerCase()) {
        out.push({ start: t.start, end: t.end, type: fromCode ? 'api' : 'text' });
      }
    }
  }
  return out;
}

test('片段中的 HTML 被转义，原样 <script> 不会注入', () => {
  const raw = '<p>安全文本 <script>alert(1)</script> 后续内容</p>';
  const views = prepareViews(raw);
  assert.ok(!views.stripped.includes('<script>'));
  const snip = buildSnippet(views, [], { radius: 50 });
  assert.ok(!snip.html.includes('<script>'), snip.html);
  assert.ok(snip.html.includes('安全文本'), snip.html);
});

test('高亮 <mark> 包裹匹配，且不截断多字节词', () => {
  const raw = '<p>调用 getUserProfile 获取用户资料😀</p>';
  const views = prepareViews(raw);
  const m = matchesFor(views, 'getuserprofile');
  assert.ok(m.length > 0);
  const snip = buildSnippet(views, m, { radius: 50 });
  assert.match(snip.html, /<mark class="hl-api"[^>]*>getUserProfile<\/mark>/);
  // emoji kept intact somewhere in text segments
  const plain = snip.segments.map((s) => s.text).join('');
  assert.ok(plain.includes('😀'), plain);
  // no dangling surrogate halves (each high surrogate must be paired)
  for (let i = 0; i < plain.length; i++) {
    const code = plain.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = plain.charCodeAt(i + 1);
      assert.ok(low >= 0xdc00 && low <= 0xdfff, 'high surrogate must be paired');
      i++;
    } else {
      assert.ok(!(code >= 0xdc00 && code <= 0xdfff), 'no orphan low surrogate');
    }
  }
});

test('错误码/接口/字段三类高亮类型区分', () => {
  const raw = '<div>字段 user_id，接口 getUserProfile，错误码 E4001</div>';
  const views = prepareViews(raw);
  const mk = (word, type) => {
    const toks = codeAnalyze(views.norm).tokens.filter((t) => !t.shadow && t.term === word);
    return toks.map((t) => ({ start: t.start, end: t.end, type }));
  };
  const matches = [
    ...mk('e4001', 'error'),
    ...mk('getuserprofile', 'api'),
    ...mk('user_id', 'field'),
  ];
  const snip = buildSnippet(views, matches, { radius: 60 });
  assert.ok(snip.html.includes('hl-error'));
  assert.ok(snip.html.includes('hl-api'));
  assert.ok(snip.html.includes('hl-field'));
});

test('合并重叠区间：高优先级类型（错误码）胜出', () => {
  const raw = '<p>E4001 与其它文字重叠测试</p>';
  const views = prepareViews(raw);
  const toks = codeAnalyze(views.norm).tokens.filter((t) => !t.shadow && t.term === 'e4001');
  const matches = [
    { start: toks[0].start, end: toks[0].end, type: 'text' },
    { start: toks[0].start, end: toks[0].end, type: 'error' },
  ];
  const snip = buildSnippet(views, matches, { radius: 40 });
  const marked = snip.segments.filter((s) => s.marked);
  assert.equal(marked.length, 1);
  assert.equal(marked[0].type, 'error');
});

test('窗口选择在匹配附近，且映射的 anchor 位于原文码点范围内', () => {
  const raw = '<section>' + '前缀'.repeat(40) + ' 目标词命中 ' + '后缀'.repeat(40) + '</section>';
  const views = prepareViews(raw);
  const toks = textAnalyze(views.norm).tokens.filter((t) => t.term === '目标' || t.term === '命中');
  const snip = buildSnippet(views, toks.map((t) => ({ start: t.start, end: t.end, type: 'text' })), {
    radius: 20,
  });
  const plain = snip.segments.map((s) => s.text).join('');
  assert.ok(plain.includes('目标') && plain.includes('命中'), plain);
  // anchor raw range valid and maps back into source without splitting emoji
  assert.ok(snip.anchor.rawStart >= 0 && snip.anchor.rawEnd <= Array.from(raw).length);
});

test('escapeHtml 转义所有危险字符', () => {
  assert.equal(escapeHtml(`<a href="x'&">`), '&lt;a href=&quot;x&#39;&amp;&quot;&gt;');
});
