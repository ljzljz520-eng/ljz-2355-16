// Demo/test seed: two versions of the same documents, one private doc,
// declared field/api/error annotations, and HTML-heavy bodies (CJK + emoji).

import { RelationalStore, resetIds } from '../store/memory-store.js';
import { PermissionService } from '../security/permissions.js';
import { Indexer } from '../index/indexer.js';
import { SearchEngine } from '../index/search-engine.js';

export async function buildApp() {
  resetIds();
  const store = new RelationalStore();
  const permissions = new PermissionService(store);
  const indexer = new Indexer(store, permissions, { batchSize: 2 });
  const engine = new SearchEngine(store, indexer, permissions);

  // ---- public docs: users API v1 and v2 (same interface across versions) ----
  const users = store.createDocument({ slug: 'api/users' });
  store.setVisibility(users, '*', true);

  const v1 = store.addVersion(users, { label: 'v1', title: '用户接口 v1', status: 'published' });
  store.addSection(v1, {
    anchor: 'get-user',
    title: 'getUser 查询用户',
    ordinal: 0,
    body:
      '<h1>getUser 查询用户</h1><p>调用 <code>getUserProfile</code> 方法获取用户资料。</p>' +
      '<p>当用户不存在时返回错误码 <b>E4001</b>，字段 <code>user_id</code> 必填。</p>' +
      '<p>返回数据包含 nickname 与 email 字段，支持中文姓名张三😀。</p>',
    fields: [{ name: 'user_id', start: null }],
    apis: [{ name: 'getUserProfile', start: null }],
    errors: [{ code: 'E4001', start: null }],
  });
  store.addSection(v1, {
    anchor: 'delete-user',
    title: 'deleteUser 删除用户',
    ordinal: 1,
    body: '<p>deleteUser 删除指定用户，失败时返回 <code>ERR_FORBIDDEN</code>。</p>',
    apis: [{ name: 'deleteUser', start: null }],
    errors: [{ code: 'ERR_FORBIDDEN', start: null }],
  });

  const v2 = store.addVersion(users, { label: 'v2', title: '用户接口 v2', status: 'published' });
  store.addSection(v2, {
    anchor: 'get-user',
    title: 'getUser 查询用户 v2',
    ordinal: 0,
    body:
      '<h1>getUser 查询用户 v2</h1><p>在 v2 中 <code>getUserProfile</code> 增加了分页参数 <code>page_size</code>。</p>' +
      '<p>错误码 <b>E4001</b> 仍然表示用户不存在，新增 <b>E4002</b> 表示参数非法。</p>' +
      '<script>var x="不应被索引 E9999";</script><p>多字节示例：错误信息「用户资料不存在」。</p>',
    fields: [{ name: 'page_size', start: null }],
    apis: [{ name: 'getUserProfile', start: null }],
    errors: [{ code: 'E4001', start: null }, { code: 'E4002', start: null }],
  });

  // ---- internal doc, visible only to group:admin ----
  // No public row => default deny for everyone except the admin group.
  const admin = store.createDocument({ slug: 'internal/audit' });
  store.setVisibility(admin, 'group:admin', true);
  const av = store.addVersion(admin, { label: 'v1', title: '内部审计接口', status: 'published' });
  store.addSection(av, {
    anchor: 'audit-log',
    title: 'queryAuditLog',
    ordinal: 0,
    body: '<p>内部接口 queryAuditLog 仅供管理员调用，错误码 <b>E5000</b>。</p>',
    apis: [{ name: 'queryAuditLog', start: null }],
    errors: [{ code: 'E5000', start: null }],
  });

  // ---- draft (unpublished) version: must never be searchable ----
  store.addVersion(users, { label: 'v3-draft', title: '用户接口 v3 草稿', status: 'draft' });
  const draft = store.getVersionByLabel(users, 'v3-draft');
  store.addSection(draft.id, {
    anchor: 'future',
    title: '未发布的未来功能',
    ordinal: 0,
    body: '<p>SECRET_UNPUBLISHED 不应出现在任何搜索结果中。</p>',
  });

  // v2 is the newest published version => current; v1 becomes historical.
  store.publishVersion(v2);

  return { store, permissions, indexer, engine, ids: { users, admin, v1, v2, av } };
}
