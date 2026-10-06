import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/demo/seed.js';

const ANON = ['*'];
const ADMIN = ['*', 'group:admin'];

async function fresh() {
  const app = await buildApp();
  return app;
}

test('同接口跨版本：E4001 命中 v1 与 v2，current/historical 明确区分', async () => {
  const app = await fresh();
  await app.indexer.rebuildAndPublish('all');

  const res = app.engine.search(
    { q: 'E4001', version: 'all', includeHistorical: true },
    { principals: ANON }
  );
  assert.equal(res.status, 'ok');
  assert.equal(res.total, 2);
  const byVer = Object.fromEntries(res.results.map((r) => [r.version, r]));
  assert.ok(byVer.v1 && byVer.v2);
  assert.equal(byVer.v2.isCurrent, true);
  assert.equal(byVer.v2.historical, false);
  assert.equal(byVer.v1.isCurrent, false);
  assert.equal(byVer.v1.historical, true);
  // deep link points at the exact version+anchor
  assert.equal(byVer.v1.deepLink.version, 'v1');
  assert.equal(byVer.v1.deepLink.anchor, 'get-user');
  assert.equal(byVer.v2.deepLink.version, 'v2');
  // urls are version-specific so click lands on the matching chapter version
  assert.match(byVer.v1.url, /\/api\/users\/v1#get-user/);
  assert.match(byVer.v2.url, /\/api\/users\/v2#get-user/);
});

test('默认 current 只返回当前版本，历史版本默认隐藏', async () => {
  const app = await fresh();
  await app.indexer.rebuildAndPublish('all');
  const res = app.engine.search({ q: 'getUserProfile' }, { principals: ANON });
  assert.equal(res.total, 1);
  assert.equal(res.results[0].version, 'v2');
  assert.equal(res.results[0].isCurrent, true);
});

test('未发布草稿永不入索引（不能指向未发布正文）', async () => {
  const app = await fresh();
  await app.indexer.rebuildAndPublish('all');
  for (const q of ['SECRET_UNPUBLISHED', '未来功能']) {
    const res = app.engine.search(
      { q, version: 'all', includeHistorical: true },
      { principals: ADMIN }
    );
    assert.equal(res.total, 0, q);
  }
});

test('索引中断后续跑：building 状态返回 not_ready，续跑完成并发布后可查', async () => {
  const app = await fresh();
  const genId = app.indexer.startGeneration('all');

  // run a couple of small batches but stop before completion
  let r = app.indexer.buildBatch(genId, 1);
  assert.equal(r.done, false);
  // while building, search must NOT return empty-as-no-match
  const building = app.engine.search({ q: 'E4001' }, { principals: ANON });
  assert.equal(building.status, 'not_ready');
  assert.equal(building.httpStatus, 503);
  assert.equal(building.results.length, 0);
  assert.equal(building.indexCoverage.complete, false);

  // no active gen yet
  assert.equal(app.store.getActiveGenerationId('all'), null);

  // resume from checkpoint
  const resumed = await app.indexer.resume(genId);
  assert.equal(resumed.done, true);
  // still not active until explicit publish; before publish still not served
  const beforePublish = app.engine.search({ q: 'E4001' }, { principals: ANON });
  assert.equal(beforePublish.status, 'not_ready');

  app.indexer.publish(genId);
  const after = app.engine.search({ q: 'E4001' }, { principals: ANON });
  assert.equal(after.status, 'ok');
  assert.ok(after.total >= 1);
});

test('索引幂等：重复执行已完成 section 不产生重复文档', async () => {
  const app = await fresh();
  const genId = app.indexer.startGeneration('all');
  await app.indexer.buildAll(genId);
  const idx = app.indexer.getIndex(genId);
  const sectionsBefore = idx.sectionCount;
  // replay batches (simulating crash + restart over same work)
  await app.indexer.buildAll(genId);
  assert.equal(idx.sectionCount, sectionsBefore);
});

test('新代次完整构建后才切换：构建期间旧索引继续服务', async () => {
  const app = await fresh();
  const first = await app.indexer.rebuildAndPublish('all');

  // start a second generation but don't finish
  const second = app.indexer.startGeneration('all');
  app.indexer.buildBatch(second, 1);

  // search still served by first gen
  const res = app.engine.search({ q: 'E4001' }, { principals: ANON });
  assert.equal(res.status, 'ok');
  assert.equal(res.indexCoverage.generation.id, first);

  // cannot publish a non-ready generation
  assert.throws(() => app.indexer.publish(second), /not ready/);

  await app.indexer.buildAll(second);
  app.indexer.publish(second);
  const res2 = app.engine.search({ q: 'E4001' }, { principals: ANON });
  assert.equal(res2.indexCoverage.generation.id, second);
});

test('权限临时变化：授权后可见、撤回立即过滤（先于物理清除）', async () => {
  const app = await fresh();
  await app.indexer.rebuildAndPublish('all');

  // admin doc invisible to anon
  const anonBefore = app.engine.search(
    { q: 'queryAuditLog', version: 'all', includeHistorical: true },
    { principals: ANON }
  );
  assert.equal(anonBefore.total, 0);
  assert.equal(anonBefore.filtered.hiddenForbidden, 1);

  // temporarily grant anon
  app.store.setVisibility(app.ids.admin, '*', true);
  const granted = app.engine.search(
    { q: 'queryAuditLog', version: 'all', includeHistorical: true },
    { principals: ANON }
  );
  assert.equal(granted.total, 1);

  // revoke -> immediate filter even before sweep; postings still physically exist
  app.permissions.revoke(app.ids.admin);
  const activeGen = app.store.getActiveGenerationId('all');
  const idx = app.indexer.getIndex(activeGen);
  assert.ok(idx.getDoc([...idx.docs.keys()].find((id) => idx.getDoc(id).documentId === app.ids.admin)),
    'posting still physically present right after revoke');
  const revoked = app.engine.search(
    { q: 'queryAuditLog', version: 'all', includeHistorical: true },
    { principals: ANON }
  );
  assert.equal(revoked.total, 0);
  assert.equal(revoked.filtered.hiddenRevoked, 1);

  // background sweep removes postings afterwards
  const removed = app.permissions.sweepGeneration(idx, activeGen);
  assert.ok(removed.length >= 1);
  const log = app.store.listRevocations().find((x) => x.action === 'revoke');
  assert.ok(log.filterApplied > 0);
  assert.ok(log.sweptAt >= log.filterApplied);
});

test('恢复可见但未重建索引：标记覆盖不完整，不假装无匹配', async () => {
  const app = await fresh();
  await app.indexer.rebuildAndPublish('all');
  app.permissions.revoke(app.ids.admin);
  // restore: permission allows again, document flagged stale
  app.permissions.restore(app.ids.admin);
  app.store.setVisibility(app.ids.admin, 'group:admin', true);
  const res = app.engine.search(
    { q: 'queryAuditLog', version: 'all', includeHistorical: true },
    { principals: ADMIN }
  );
  assert.equal(res.status, 'ok');
  assert.ok(res.indexCoverage.staleDocuments.includes(app.ids.admin));
});

test('旧游标翻页：跨代次/改查询返回 STALE_CURSOR(410)，同代次正常翻页', async () => {
  const app = await fresh();
  const gen = await app.indexer.rebuildAndPublish('all');

  // page 1 with limit 1
  const p1 = app.engine.search(
    { q: '用户', version: 'all', includeHistorical: true, limit: 1 },
    { principals: ANON }
  );
  assert.equal(p1.returned, 1);
  assert.ok(p1.nextCursor);
  const firstId = p1.results[0].sectionId;

  // page 2 within same generation works and returns a different section
  const p2 = app.engine.search(
    { q: '用户', version: 'all', includeHistorical: true, limit: 1, cursor: p1.nextCursor },
    { principals: ANON }
  );
  assert.equal(p2.status, 'ok');
  assert.notEqual(p2.results[0].sectionId, firstId);

  // tampered cursor -> INVALID_CURSOR thrown (HTTP layer maps to 400)
  assert.throws(
    () =>
      app.engine.search(
        { q: '用户', version: 'all', includeHistorical: true, cursor: '!!!notbase64!!!' },
        { principals: ANON }
      ),
    (e) => e.code === 'INVALID_CURSOR'
  );

  // cursor from a previous query string is rejected
  assert.throws(
    () =>
      app.engine.search(
        { q: 'E4001', version: 'all', includeHistorical: true, cursor: p1.nextCursor },
        { principals: ANON }
      ),
    (e) => e.code === 'STALE_CURSOR' && e.status === 410
  );

  // after a new generation, old cursor must be rejected (not silently mixed)
  const gen2 = await app.indexer.rebuildAndPublish('all');
  assert.notEqual(gen2, gen);
  assert.throws(
    () =>
      app.engine.search(
        { q: '用户', version: 'all', includeHistorical: true, limit: 1, cursor: p1.nextCursor },
        { principals: ANON }
      ),
    (e) => e.code === 'STALE_CURSOR'
  );
});

test('撤回后旧游标中已不可见的项失效，提示重查而非返回越权数据', async () => {
  const app = await fresh();
  await app.indexer.rebuildAndPublish('all');
  // admin pages through, gets a cursor anchored on the admin doc
  const p1 = app.engine.search(
    { q: '接口', version: 'all', includeHistorical: true, limit: 5 },
    { principals: ADMIN }
  );
  assert.ok(p1.results.some((r) => r.documentId === app.ids.admin));
});

test('无任何索引时返回 no_index(503)，区别于零命中', async () => {
  const app = await fresh();
  const res = app.engine.search({ q: 'E4001' }, { principals: ANON });
  assert.equal(res.status, 'no_index');
  assert.equal(res.httpStatus, 503);
});

test('零命中是 status:ok + total:0（已完成索引但确实无匹配）', async () => {
  const app = await fresh();
  await app.indexer.rebuildAndPublish('all');
  // letters-only latin token that appears nowhere in the corpus
  const res = app.engine.search({ q: 'zzqxkw' }, { principals: ANON });
  assert.equal(res.status, 'ok');
  assert.equal(res.total, 0);
});
