import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { RelationalStore } from '../services/search/src/store.js'
import { IndexBuilder } from '../services/search/src/index-engine.js'
import { SearchService, SearchError } from '../services/search/src/search.js'
import { analyzeCode, analyzeNatural, htmlToText, normalizeForSearch } from '../services/search/src/text.js'

let dir
let store
let builder
let search

function pointSlice(value, start, end) {
  return Array.from(value).slice(start, end).join('')
}

async function publish(version, overrides = {}) {
  store.upsertSection({
    docId: 'orders-api',
    docTitle: '订单接口',
    version,
    current: version === 'v2',
    sectionId: overrides.sectionId ?? 'create-order',
    title: overrides.title ?? '创建订单',
    apiName: overrides.apiName ?? 'POST /orders/createOrder',
    errorCode: overrides.errorCode ?? 'ORDER_429_RATE_LIMIT',
    bodyHtml: overrides.bodyHtml ?? '<p>创建一个订单，支持幂等键。错误码 ORDER_429_RATE_LIMIT 表示限流。</p>',
    urlPath: overrides.urlPath ?? `/${version}/orders`,
    anchor: overrides.anchor ?? 'create-order',
    ordinal: overrides.ordinal ?? 1,
    status: overrides.status ?? 'published',
    isPublic: overrides.isPublic ?? true,
    allowPrincipals: overrides.allowPrincipals,
    denyPrincipals: overrides.denyPrincipals
  })
}

async function buildAndPublish(version) {
  const id = await builder.buildOrResume(version)
  await builder.finalize(id)
  return id
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'doc-search-'))
  store = await RelationalStore.open(path.join(dir, 'search.db'))
  builder = new IndexBuilder(store, path.join(dir, 'indexes'))
  search = new SearchService(store, path.join(dir, 'indexes'))
})

afterEach(async () => {
  await store.save?.()
  await rm(dir, { recursive: true, force: true })
})

test('natural and code analyzers retain source offsets across multibyte text', () => {
  const source = '错误码😀ORDER_429_RATE_LIMIT'
  const natural = analyzeNatural(source)
  const code = analyzeCode(source)
  for (const token of [...natural, ...code]) {
    const slice = pointSlice(source, token.start, token.end)
    assert.ok(Array.from(slice).length > 0)
    assert.doesNotMatch(slice, /^[\uDC00-\uDFFF]/)
    assert.doesNotMatch(slice, /[\uD800-\uDBFF]$/)
  }
  assert.ok(code.some((token) => token.term === 'order'))
  assert.ok(code.some((token) => token.term === '429'))
  assert.ok(natural.some((token) => token.term === '错误'))

  const { text, map } = normalizeForSearch('ＡBC😀')
  assert.equal(text, 'abc😀')
  // Offsets must point to the original full-width A and the emoji start, not normalized array indexes.
  assert.equal(pointSlice('ＡBC😀', map[0], map[0] + 1), 'Ａ')
  assert.equal(pointSlice('ＡBC😀', map[3], map[3] + 1), '😀')
})

test('same API is distinguished across versions and links to its versioned section', async () => {
  await publish('v1', { current: false, title: '创建订单（旧）', bodyHtml: '<p>旧版 createOrder，仅接受 amount。</p>' })
  await publish('v2', { current: true, title: '创建订单', bodyHtml: '<p>新版 createOrder，支持幂等键和优惠券。</p>' })
  const v1Gen = await buildAndPublish('v1')
  const v2Gen = await buildAndPublish('v2')

  const v1 = await search.search('createOrder', { userId: 'u1' }, { version: 'v1' })
  const v2 = await search.search('createOrder', { userId: 'u1' }, { version: 'v2' })
  assert.equal(v1.hits[0].version, 'v1')
  assert.equal(v2.hits[0].version, 'v2')
  assert.equal(v1.hits[0].versionState, 'historical')
  assert.equal(v2.hits[0].versionState, 'current')
  assert.match(v1.hits[0].url, /^\/v1\/orders#/)
  assert.match(v2.hits[0].url, /^\/v2\/orders#/)
  assert.equal(v1.meta.generationId, v1Gen)
  assert.equal(v2.meta.generationId, v2Gen)
})

test('interrupted build resumes without exposing an unfinished index as zero matches', async () => {
  await publish('v2')
  await publish('v2', {
    sectionId: 'cancel-order',
    title: '取消订单',
    apiName: 'POST /orders/cancelOrder',
    bodyHtml: '<p>取消尚未支付的订单。</p>',
    ordinal: 2
  })

  const generationId = await builder.startGeneration('v2')
  const controller = new AbortController()
  const promise = builder.buildOrResume('v2', { signal: controller.signal })
  controller.abort()
  await assert.rejects(promise, (error) => error.code === 'ABORT_ERR')
  await assert.rejects(
    builder.finalize(generationId),
    (error) => error.code === 'GENERATION_INCOMPLETE'
  )
  await assert.rejects(
    search.search('订单', { userId: 'u1' }, { version: 'v2' }),
    (error) => error.code === 'INDEX_NOT_READY' && error.status === 503
  )

  await builder.buildOrResume('v2')
  await builder.finalize(generationId)
  const result = await search.search('订单', { userId: 'u1' }, { version: 'v2' })
  assert.equal(result.hits.length, 2)
  assert.equal(result.meta.generationStatus, 'ready')
})

test('HTML is not indexed or returned and highlight ranges do not cut multibyte text', async () => {
  await publish('v2', {
    bodyHtml: '<section data-q="secret-token"><b>接口</b>说明：😀 限流时返回 <code>ORDER_429_RATE_LIMIT</code>。<script>const x="secret-token"</script></section>'
  })
  await buildAndPublish('v2')

  const hidden = await search.search('secret-token', { userId: 'u1' }, { version: 'v2' })
  assert.equal(hidden.hits.length, 0)

  const result = await search.search('ORDER_429_RATE_LIMIT', { userId: 'u1' }, { version: 'v2' })
  const hit = result.hits[0]
  assert.ok(hit.snippet)
  assert.doesNotMatch(hit.snippet.text, /<|>|secret-token/)
  for (const range of hit.snippet.highlights) {
    const slice = Array.from(hit.snippet.text).slice(range.start, range.end).join('')
    assert.match(slice, /ORDER|429|LIMIT/)
    const chars = Array.from(hit.snippet.text)
    assert.ok(chars[range.start] !== undefined)
    assert.ok(chars[range.end - 1] !== undefined)
  }
})

test('index ACL is compared with query-time authority and revoke is immediately effective', async () => {
  await publish('v2', {
    sectionId: 'private',
    title: '内部结算接口',
    apiName: 'POST /internal/settleAccount',
    errorCode: 'SETTLE_500_FAILED',
    bodyHtml: '<p>仅财务组可访问，错误码 SETTLE_500_FAILED。</p>',
    isPublic: false,
    allowPrincipals: ['finance']
  })
  await buildAndPublish('v2')

  await assert.equal((await search.search('settleAccount', { userId: 'outsider' }, { version: 'v2' })).hits.length, 0)
  const allowed = await search.search('settleAccount', { userId: 'alice', groups: ['finance'] }, { version: 'v2' })
  assert.equal(allowed.hits[0].sectionId, 'private')

  // Immediate deny, before any background index cleanup.
  store.setTemporaryGrant({
    docId: 'orders-api', version: 'v2', sectionId: 'private',
    principal: 'alice', effect: 'deny', expiresAt: null
  })
  await assert.equal((await search.search('settleAccount', { userId: 'alice', groups: ['finance'] }, { version: 'v2' })).hits.length, 0)

  // Temporary allow is authoritative at query time, while the physical index
  // remains narrower until background cleanup publishes a new generation.
  store.setTemporaryGrant({
    docId: 'orders-api', version: 'v2', sectionId: 'private',
    principal: 'bob', effect: 'allow', expiresAt: null
  })
  const newlyAllowed = await search.search('settleAccount', { userId: 'bob' }, { version: 'v2' })
  assert.equal(newlyAllowed.hits.length, 1)
  assert.equal(newlyAllowed.hits[0].acl.indexed, false)
  assert.equal(newlyAllowed.hits[0].acl.queried, true)
  assert.deepEqual(newlyAllowed.meta.aclMismatches[0], {
    key: 'v2/orders-api/private',
    indexAllowed: false,
    queryAllowed: true
  })
  const refreshResult = await search.refreshStaleAcl('v2', builder)
  assert.equal(refreshResult.refreshed, true)
  const activeRow = store.getActiveGeneration('v2')
  const refreshedIndex = await search.loadGeneration(activeRow)
  const privateDoc = Object.values(refreshedIndex.data.documents)
    .find((doc) => doc.sectionId === 'private')
  assert.ok(privateDoc.allowed.includes('bob'))
  await assert.equal((await search.search('settleAccount', { userId: 'bob' }, { version: 'v2' })).hits.length, 1)
})

test('old cursor pages historical generation and is explicitly separated from current results', async () => {
  const sections = [
    ['alpha', 'Alpha 接口', 'alphaMethod'],
    ['beta', 'Beta 接口', 'betaMethod'],
    ['gamma', 'Gamma 接口', 'gammaMethod']
  ]
  for (const [sectionId, title, apiName] of sections) {
    await publish('v2', { sectionId, title, apiName, bodyHtml: `<p>${title} 的通用说明。</p>`, ordinal: 0 })
  }
  const firstGen = await buildAndPublish('v2')
  const page1 = await search.search('Method', { userId: 'u1' }, { version: 'v2', limit: 2 })
  assert.equal(page1.hits.length, 2)
  assert.ok(page1.page.next)

  // Add and publish another section in a new generation after the client obtained the cursor.
  await publish('v2', {
    sectionId: 'delta', title: 'Delta 接口', apiName: 'deltaMethod',
    bodyHtml: '<p>Delta 接口说明。</p>', ordinal: 0
  })
  const secondGen = await buildAndPublish('v2')
  const page2 = await search.search('Method', { userId: 'u1' }, {
    version: 'v2', limit: 2, cursor: page1.page.next
  })
  assert.equal(page2.meta.generationId, firstGen)
  assert.equal(page2.meta.cursorStale, true)
  assert.equal(page2.meta.isCurrent, false)
  assert.equal(page2.hits[0].sectionId, 'gamma')

  const fresh = await search.search('Method', { userId: 'u1' }, { version: 'v2', generationId: secondGen })
  assert.equal(fresh.meta.generationId, secondGen)
  assert.equal(fresh.meta.isCurrent, true)
  assert.deepEqual(fresh.hits.map((hit) => hit.sectionId).sort(), ['alpha', 'beta', 'delta', 'gamma'])
})


test('revocation during old cursor paging is filtered immediately and cursor boundary is reported stale', async () => {
  const sections = [
    ['alpha', 'Alpha 接口', 'alphaMethod'],
    ['beta', 'Beta 接口', 'betaMethod']
  ]
  for (const [sectionId, title, apiName] of sections) {
    await publish('v2', {
      sectionId, title, apiName,
      bodyHtml: `<p>${title} 的通用说明。</p>`,
      ordinal: 0, isPublic: false, allowPrincipals: ['reader']
    })
  }
  await buildAndPublish('v2')
  const page1 = await search.search('Method', { userId: 'u', groups: ['reader'] }, { version: 'v2', limit: 1 })
  assert.equal(page1.hits[0].sectionId, 'alpha')

  await buildAndPublish('v2')
  // Revoke the boundary item while the client still holds an old-generation cursor.
  store.setTemporaryGrant({
    docId: 'orders-api', version: 'v2', sectionId: 'alpha',
    principal: 'reader', effect: 'deny', expiresAt: null
  })

  await assert.rejects(
    search.search('Method', { userId: 'u', groups: ['reader'] }, {
      version: 'v2', limit: 1, cursor: page1.page.next
    }),
    (error) => error.code === 'STALE_CURSOR' && error.status === 410
  )
})

test('unpublished metadata can be indexed only after publication and never masquerades as no match', async () => {
  await publish('v2', {
    sectionId: 'draft-section',
    title: '尚未发布的撤销接口',
    apiName: 'POST /orders/revokeDraft',
    bodyHtml: '<p>此正文仍处于草稿状态。</p>',
    status: 'draft'
  })
  await buildAndPublish('v2')
  const draft = await search.search('revokeDraft', { userId: 'u1' }, { version: 'v2' })
  assert.equal(draft.hits.length, 0)

  // While building a new generation, query remains on the old generation instead of leaking draft.
  const id = await builder.startGeneration('v2')
  store.upsertSection({
    docId: 'orders-api', docTitle: '订单接口', version: 'v2', current: true,
    sectionId: 'draft-section', title: '尚未发布的撤销接口', apiName: 'POST /orders/revokeDraft',
    errorCode: '', bodyHtml: '<p>此正文仍处于草稿状态。</p>',
    urlPath: '/v2/orders', anchor: 'draft-section', ordinal: 1, status: 'published', isPublic: true
  })
  await store.save()
  const old = await search.search('revokeDraft', { userId: 'u1' }, { version: 'v2' })
  assert.equal(old.hits.length, 0)
  assert.equal(old.meta.buildingGenerationId, id)
  await builder.buildOrResume('v2')
  await builder.finalize(id)
  const published = await search.search('revokeDraft', { userId: 'u1' }, { version: 'v2' })
  assert.equal(published.hits[0].sectionId, 'draft-section')
})

test('htmlToText maps entities and ignores attributes', () => {
  const converted = htmlToText('<p data-x="hello">错误 &amp; 代码</p>')
  assert.equal(converted.text, '错误 & 代码')
  assert.equal(converted.map.length, Array.from('错误 & 代码').length)
})
