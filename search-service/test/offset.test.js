import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSlice, codePointLength, cpToUtf16 } from '../src/text/codepoints.js';
import { mapFromTransform, identityMap, OffsetMap } from '../src/text/offset-map.js';
import { stripHtml, scanSegments } from '../src/text/html-view.js';
import { textAnalyze, codeAnalyze, normalizeView } from '../src/text/analyzers.js';

test('cpSlice 不会截断多字节字符（emoji 代理对）', () => {
  const s = 'a😀b中'; // cp: a,😀,b,中 (4 cp) ; utf16 length 1+2+1+1=5
  assert.equal(s.length, 5);
  assert.equal(codePointLength(s), 4);
  assert.equal(cpSlice(s, 1, 2), '😀');
  assert.equal(cpSlice(s, 0, 4), s);
  assert.equal(cpSlice(s, 3, 4), '中');
  assert.equal(cpToUtf16(s, 1), 1); // emoji starts at utf16 idx1
  assert.equal(cpToUtf16(s, 3), 4); // 中 at utf16 idx4
});

test('规范化映射：NFKC 展开（ﬁ 连字）偏移可还原', () => {
  const raw = 'abﬁcd'; // ﬁ (U+FB01) NFKC -> 'fi' (expands 1->2)
  const { text, map } = normalizeView(raw);
  assert.equal(text, 'abficd');
  // target 'fi' occupies target cp 2..4 and maps back to source cp 2..3
  const r = map.mapRange(2, 4);
  assert.deepEqual(r, { start: 2, end: 3 });
  // slicing ORIGINAL source via the mapped range yields the ligature, intact
  assert.equal(cpSlice(raw, r.start, r.end), 'ﬁ');
});

test('小写化/规范化后的 token 偏移不能直接用于原文，必须经映射', () => {
  const raw = 'HELLO 世界';
  const { tokens, normMap } = textAnalyze(raw);
  const hello = tokens.find((t) => t.term === 'hello');
  assert.equal(hello.start, 0);
  assert.equal(hello.end, 5);
  // These are NORM offsets; mapping them yields the raw HELLO span, not sliced
  const rawRange = normMap.mapRange(hello.start, hello.end);
  assert.equal(cpSlice(raw, rawRange.start, rawRange.end), 'HELLO');
});

test('HTML 剥离映射：标签不进入视图，映射回原文保持多字节边界', () => {
  const raw = '<p>错误</p><b>码😀</b>';
  const { text, map } = stripHtml(raw);
  assert.equal(text, '错误码😀');
  assert.equal(codePointLength(text), 4);
  // locate 码😀 in stripped cp 2..4 -> maps into raw, emoji intact
  const r = map.mapRange(2, 4);
  const slice = cpSlice(raw, r.start, r.end);
  assert.ok(slice.includes('码'), slice);
  assert.ok(slice.includes('😀'), slice);
  // no surrogate half left dangling
  assert.equal(codePointLength(slice), Array.from(slice).length);
});

test('script/style/注释内容被整体丢弃，不会被索引或出现在片段', () => {
  const raw =
    '正文 <script>evil("E9999 秘密")</script><style>.x{}</style><!-- E8888 -->可见😀';
  const { text } = stripHtml(raw);
  assert.ok(!text.includes('E9999'), text);
  assert.ok(!text.includes('秘密'), text);
  assert.ok(!text.includes('E8888'), text);
  assert.ok(text.includes('正文'), text);
  assert.ok(text.includes('可见😀'), text);
});

test('实体解码：&nbsp; &#x4e2d; 收缩为单码点且映射正确', () => {
  const raw = 'a&nbsp;b&#x4e2d;c';
  const { text, map } = stripHtml(raw);
  assert.equal(text, 'a b中c');
  // 中 at stripped idx3
  const idx = Array.from(text).indexOf('中');
  const r = map.mapRange(idx, idx + 1);
  assert.equal(cpSlice(raw, r.start, r.end), '&#x4e2d;');
});

test('代码分析器保留完整标识符与 camelCase 子部分，且偏移码点安全', () => {
  const view = 'getUserProfile E4001';
  const { tokens } = codeAnalyze(view);
  const full = tokens.find((t) => t.term === 'getUserProfile');
  assert.ok(full);
  assert.equal(view.slice(full.start, full.end), 'getUserProfile');
  // subparts
  const profile = tokens.find((t) => t.term === 'Profile' && t.kind === 'part');
  assert.ok(profile);
  assert.equal(view.slice(profile.start, profile.end), 'Profile');
  // E4001 full present; noisy lone 'E' subpart dropped
  assert.ok(tokens.some((t) => t.term === 'E4001'));
  assert.ok(!tokens.some((t) => t.kind === 'part' && t.term === 'E'));
});

test('多字节标识符周围的代码偏移不会破坏字符', () => {
  const view = '调用 getUserName 接口😀';
  const { tokens } = codeAnalyze(view);
  const name = tokens.find((t) => t.term === 'getUserName');
  assert.ok(name);
  // slice by utf16 indices derived from cp indices must equal identifier
  const arr = Array.from(view);
  assert.equal(arr.slice(name.start, name.end).join(''), 'getUserName');
});

test('OffsetMap.compose 链式映射 norm->stripped->raw', () => {
  const raw = '<b>HELLO</b>';
  const stripped = stripHtml(raw);
  const norm = normalizeView(stripped.text);
  const composed = norm.map.compose(stripped.map);
  // norm cp 0..5 -> raw HELLO
  const r = composed.mapRange(0, 5);
  assert.equal(cpSlice(raw, r.start, r.end), 'HELLO');
});
