import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createServer } from '../services/search/src/server.js'

let runtime
let baseUrl
let dir

async function request(method, route, body, headers = {}) {
  const response = await fetch(new URL(route, baseUrl), {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined
  })
  return { status: response.status, body: await response.json() }
}

test('HTTP search API reads per-version published generations and filters by query-time permission', async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'doc-search-http-'))
  runtime = await createServer({ dbPath: path.join(dir, 'search.db'), indexRoot: path.join(dir, 'indexes') })
  await new Promise((resolve) => runtime.server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${runtime.server.address().port}`

  for (const version of ['v1', 'v2']) {
    const { status } = await request('POST', '/api/admin/sections', {
      docId: 'payment-api', docTitle: '支付接口', version, current: version === 'v2',
      sectionId: 'refund', title: version === 'v2' ? '退款接口' : '退款接口（旧版）',
      apiName: 'POST /payments/refundPayment', errorCode: 'PAY_402_DECLINED',
      bodyHtml: '<p>退款接口 refundPayment 返回 PAY_402_DECLINED 表示银行拒绝。</p>',
      urlPath: `/${version}/payments`, anchor: 'refund', ordinal: 1,
      status: 'published', isPublic: false, allowPrincipals: ['support']
    })
    assert.equal(status, 200)
    let build = await request('POST', '/api/admin/index/build', { version })
    assert.equal(build.status, 200)
    const finish = await request('POST', '/api/admin/index/finalize', { generationId: build.body.generationId })
    assert.equal(finish.status, 200)
  }

  let denied = await request('GET', '/api/search/v1/snippets?q=refundPayment&version=v1', null, {
    'x-user-id': 'guest'
  })
  assert.equal(denied.status, 200)
  assert.equal(denied.body.hits.length, 0)

  let v1 = await request('GET', '/api/search/v1/snippets?q=PAY_402_DECLINED&version=v1&fields=errorCode,apiName', null, {
    'x-user-id': 'agent', 'x-user-groups': 'support'
  })
  let v2 = await request('GET', '/api/search/v1/snippets?q=PAY_402_DECLINED&version=v2&fields=errorCode,apiName', null, {
    'x-user-id': 'agent', 'x-user-groups': 'support'
  })
  assert.equal(v1.body.hits[0].version, 'v1')
  assert.equal(v2.body.hits[0].version, 'v2')
  assert.equal(v1.body.hits[0].versionState, 'historical')
  assert.equal(v2.body.hits[0].versionState, 'current')

  const revoke = await request('POST', '/api/admin/permissions/temporary', {
    docId: 'payment-api', version: 'v2', sectionId: 'refund',
    principal: 'agent', effect: 'deny'
  })
  assert.equal(revoke.status, 200)
  v2 = await request('GET', '/api/search/v1/snippets?q=PAY_402_DECLINED&version=v2', null, {
    'x-user-id': 'agent', 'x-user-groups': 'support'
  })
  assert.equal(v2.body.hits.length, 0)

  const building = await request('GET', '/api/search/v1/snippets?q=unused&version=v9')
  assert.equal(building.status, 503)
  assert.equal(building.body.error.code, 'INDEX_NOT_READY')
})

afterEach(async () => {
  await new Promise((resolve) => runtime?.server.close(resolve))
  if (dir) await rm(dir, { recursive: true, force: true })
})
