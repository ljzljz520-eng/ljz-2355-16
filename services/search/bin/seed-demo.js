#!/usr/bin/env node
import path from 'node:path'
import { RelationalStore } from '../src/store.js'
import { IndexBuilder } from '../src/index-engine.js'

const dbPath = process.env.SEARCH_DB ?? 'data/search.db'
const indexRoot = process.env.SEARCH_INDEX_ROOT ?? 'data/indexes'
const store = await RelationalStore.open(path.resolve(dbPath))
const builder = new IndexBuilder(store, path.resolve(indexRoot))

const sections = [
  {
    version: 'v1', current: false, sectionId: 'create-order',
    title: '创建订单（旧版）', apiName: 'POST /orders/createOrder',
    errorCode: 'ORDER_400_BAD_REQUEST',
    bodyHtml: '<p>旧版 createOrder 仅接受 amount。错误码 <code>ORDER_400_BAD_REQUEST</code>。</p>',
    urlPath: '/v1/orders', anchor: 'create-order', ordinal: 1
  },
  {
    version: 'v2', current: true, sectionId: 'create-order',
    title: '创建订单', apiName: 'POST /orders/createOrder',
    errorCode: 'ORDER_429_RATE_LIMIT',
    bodyHtml: '<p>新版 createOrder 支持幂等键、优惠券和多字节提示😀。错误码 <code>ORDER_429_RATE_LIMIT</code> 表示限流。</p>',
    urlPath: '/v2/orders', anchor: 'create-order', ordinal: 1
  },
  {
    version: 'v2', current: true, sectionId: 'cancel-order',
    title: '取消订单', apiName: 'POST /orders/cancelOrder',
    errorCode: 'ORDER_409_STATE_CONFLICT',
    bodyHtml: '<p>cancelOrder 只能取消未支付订单，冲突时返回 ORDER_409_STATE_CONFLICT。</p>',
    urlPath: '/v2/orders', anchor: 'cancel-order', ordinal: 2
  },
  {
    version: 'v2', current: true, sectionId: 'internal-settlement',
    title: '内部结算', apiName: 'POST /internal/settleAccount',
    errorCode: 'SETTLE_500_FAILED',
    bodyHtml: '<p>仅财务组可访问，失败时返回 SETTLE_500_FAILED。</p>',
    urlPath: '/v2/internal', anchor: 'settle-account', ordinal: 3,
    isPublic: false, allowPrincipals: ['finance']
  }
]

for (const section of sections) {
  store.upsertSection({ docId: 'orders-api', docTitle: '订单接口', status: 'published', ...section })
}
await store.save()

for (const version of ['v1', 'v2']) {
  const generationId = await builder.buildOrResume(version)
  await builder.finalize(generationId)
  console.log(`${version} published index generation: ${generationId}`)
}
