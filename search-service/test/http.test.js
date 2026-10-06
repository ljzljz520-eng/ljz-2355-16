import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/api/http.js';
import { buildApp } from '../src/demo/seed.js';

let server, base, app;

before(async () => {
  app = await buildApp();
  server = createServer(app.engine);
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

async function get(path, headers = {}) {
  const res = await fetch(base + path, { headers });
  return { status: res.status, body: await res.json() };
}

test('health', async () => {
  const { status, body } = await get('/api/health');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
});

test('无索引时 503 no_index（不返回空 200 冒充无匹配）', async () => {
  const { status, body } = await get('/api/search?q=E4001');
  assert.equal(status, 503);
  assert.equal(body.status, 'no_index');
});

test('发布后 200 返回类型化片段与版本信息', async () => {
  await app.indexer.rebuildAndPublish('all');
  const { status, body } = await get(
    '/api/search?q=E4001&version=all&includeHistorical=true'
  );
  assert.equal(status, 200);
  assert.equal(body.status, 'ok');
  assert.ok(body.total >= 2);
  const r = body.results[0];
  assert.ok(r.snippet.html.includes('hl-error'));
  assert.ok(r.deepLink && r.deepLink.anchor);
  const cur = body.results.find((x) => x.isCurrent);
  assert.equal(cur.version, 'v2');
});

test('x-principals 头控制可见性：匿名 403 级过滤、管理员可见', async () => {
  const anon = await get('/api/search?q=queryAuditLog&version=all&includeHistorical=true');
  assert.equal(anon.body.total, 0);
  assert.equal(anon.body.filtered.hiddenForbidden, 1);

  const admin = await get('/api/search?q=queryAuditLog&version=all&includeHistorical=true', {
    'x-principals': 'group:admin',
  });
  assert.equal(admin.body.total, 1);
});

test('翻页：游标连续，篡改返回 400，跨代次返回 410', async () => {
  const p1 = await get('/api/search?q=' + encodeURIComponent('用户') + '&version=all&includeHistorical=true&limit=1');
  assert.ok(p1.body.nextCursor);
  const p2 = await get('/api/search?q=' + encodeURIComponent('用户') + '&version=all&includeHistorical=true&limit=1&cursor=' + p1.body.nextCursor);
  assert.equal(p2.status, 200);
  assert.notEqual(p2.body.results[0].sectionId, p1.body.results[0].sectionId);

  const bad = await get('/api/search?q=x&cursor=!!!garbage!!!');
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'INVALID_CURSOR');

  // rebuild -> old cursor stale
  await app.indexer.rebuildAndPublish('all');
  const stale = await get('/api/search?q=' + encodeURIComponent('用户') + '&version=all&includeHistorical=true&cursor=' + p1.body.nextCursor);
  assert.equal(stale.status, 410);
  assert.equal(stale.body.code, 'STALE_CURSOR');
});

test('撤回立即生效（无需重建），结果即时过滤', async () => {
  app.permissions.revoke(app.ids.users);
  const r = await get('/api/search?q=E4001&version=all&includeHistorical=true');
  assert.equal(r.body.total, 0);
  assert.ok(r.body.filtered.hiddenRevoked >= 1);
  // restore for other tests
  app.permissions.restore(app.ids.users);
  app.store.setVisibility(app.ids.users, '*', true);
});

test('构建新代次时旧活动索引继续服务；无活动代次且构建中才 503', async () => {
  const oldActive = app.store.getActiveGenerationId('all');
  // start a new generation but don't finish: previous active keeps serving
  const gen = app.indexer.startGeneration('all');
  app.indexer.buildBatch(gen, 1); // incomplete
  const served = await get('/api/search?q=E4001');
  assert.equal(served.status, 200);
  assert.equal(served.body.indexCoverage.generation.id, oldActive);

  // a fresh app with NO active generation returns 503 while building
  const app2 = await buildApp();
  const server2 = createServer(app2.engine);
  await new Promise((res) => server2.listen(0, res));
  const b2 = `http://127.0.0.1:${server2.address().port}`;
  const g2 = app2.indexer.startGeneration('all');
  app2.indexer.buildBatch(g2, 1);
  const nr = await fetch(b2 + '/api/search?q=E4001').then((x) => x.json());
  assert.equal(nr.status, 'not_ready');
  server2.close();

  // finish & publish the first new generation; it then takes over
  await app.indexer.buildAll(gen);
  app.indexer.publish(gen);
  const ok = await get('/api/search?q=E4001');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.indexCoverage.generation.id, gen);
});
