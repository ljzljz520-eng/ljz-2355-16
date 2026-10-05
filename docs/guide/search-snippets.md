# 检索片段服务

检索服务为文档站提供分版本全文搜索、接口名/错误码加权、安全高亮片段、游标翻页、关系库权限回查和索引代次发布。

## 快速启动

```bash
# 1. 初始化 SQLite（sql.js/WASM）关系库并构建 v1、v2 两个示例代次
npm run search:seed

# 2. 启动接口，默认 http://127.0.0.1:5180
npm run search:start

# 3. 启动文档站，VitePress 开发服务器会代理 /api/search
SEARCH_ORIGIN=http://127.0.0.1:5180 npm run docs:dev
```

运行测试：

```bash
npm run test:search
```

## 检索 API

```http
GET /api/search/v1/snippets?q=ORDER_429&version=v2&limit=10&cursor=<base64url>
X-User-Id: alice
X-User-Groups: finance,partner
```

参数：

| 参数 | 说明 |
| --- | --- |
| `q` | 关键词。多个空格分组，每组至少命中一个变体。 |
| `version` | 文档版本，例如 `v1`、`v2`。接口按版本读取已发布代次。 |
| `fields` | `title,apiName,errorCode,body`，默认全部。 |
| `cursor` | 上一页返回的不透明游标。游标绑定版本、查询词和索引代次。 |
| `generationId` | 显式读取当前或历史 ready/stale 代次。 |

错误码：

| HTTP | code | 场景 |
| --- | --- | --- |
| 400 | `EMPTY_QUERY` / `INVALID_CURSOR` | 参数为空或游标损坏。 |
| 410 | `STALE_CURSOR` | 查询词、代次或页边界失效。 |
| 410 | `GENERATION_UNAVAILABLE` | 历史代次文件已清除。 |
| 503 | `INDEX_NOT_READY` | 该版本没有已发布索引；构建中不会冒充“无匹配”。 |

## 结果与高亮

返回的正文片段是从 HTML 转成的纯文本，不会包含标签、属性或 `<script>` 内容。高亮范围使用 **Unicode 码点偏移**：

```json
{
  "title": "创建订单",
  "apiName": "POST /orders/createOrder",
  "errorCode": "ORDER_429_RATE_LIMIT",
  "versionState": "current",
  "url": "/v2/orders#create-order",
  "highlights": {
    "errorCode": [{ "start": 6, "end": 9 }]
  },
  "snippet": {
    "field": "body",
    "text": "……错误码 ORDER_429_RATE_LIMIT 表示限流。",
    "start": 18,
    "end": 83,
    "highlights": [{ "start": 22, "end": 37 }]
  },
  "acl": { "indexed": true, "queried": true }
}
```

前端必须按 `Array.from(str)` 拆分后应用范围，不能直接使用 UTF-16 `slice`，否则可能截坏 emoji 或增补平面文字。服务端从不直接返回高亮 HTML；Vue 组件用文本节点和 `<mark>` 渲染，避免片段注入。

## 分析器与偏移映射

- 自然语言：拉丁词整体匹配；中文按重叠二元组分词，例如“错误码”产生“错误”“误码”。
- 代码标识符：`getUserProfile` 同时产生整体规范化形式和 `get`、`user`、`profile`；错误码保留数字片段和分隔后的词段。
- 规范化（NFKC、小写）后的偏移不能直接用于原文。`HTML → 纯文本 → 规范化文本 → token` 每一步都维护偏移映射，最终 token 范围映射回纯文本码点。
- `bodySourceMap` 保留纯文本到原 HTML 的码点映射，支持后续点击定位和更复杂的原文回查。

## 分版本与代次发布

关系库中的核心表：

- `documents`、`document_versions`：文档和版本，版本标记当前/历史。
- `sections`：章节正文、接口名、错误码、URL/anchor、发布状态和内容哈希。
- `section_grants`：用户/用户组 allow、deny 和临时授权过期时间。
- `index_generations`：building、ready、failed、stale 代次及索引文件位置。
- `build_checkpoints`：章节级分片和哈希，支持中断续跑。
- `active_generations`：每个版本当前对外服务的代次指针。

发布流程：

1. 在新的 generation 目录写入章节分片和 checkpoint；旧 active generation 继续服务。
2. 构建期间正文或权限变化会导致 finalize 哈希不一致，并返回 `GENERATION_INCOMPLETE`。
3. 所有已发布章节齐全后写入不可变 `index.json`，再在关系库事务中切换 active 指针。
4. 元数据先更新但新代次未发布时，搜索仍读取旧正文；draft/未发布正文不会被新结果指向。
5. 旧游标继续读取它所属的历史代次，响应 `meta.cursorStale=true`、`meta.isCurrent=false`，新搜索默认读取当前代次。

## 权限：索引内存与查询时回查

索引保存 ACL 快照，作用是物理收窄候选并暴露后台清理状态；每次查询仍以关系库为权威：

1. 根据倒排表取得候选。
2. 比较 `doc.isPublic/doc.allowed` 得到的索引权限与关系库实时权限。
3. 回查章节仍为 published，再执行 allow/deny、组权限和临时授权。
4. 只返回 `acl.queried=true` 的结果；撤回无需等待重建即可立即过滤。
5. `meta.aclMismatches` 标记索引和关系库不一致的候选。后台调用权限刷新构建新一代次，完成后切换并清除旧 active 索引权限快照。

```http
POST /api/admin/permissions/temporary
{ "docId":"orders-api", "version":"v2", "sectionId":"internal-settlement",
  "principal":"alice", "effect":"deny", "expiresAt":"2026-10-05T12:00:00.000Z" }

POST /api/admin/permissions/refresh
{ "version":"v2" }
```

## 中断续跑

构建接口可重复调用：

```bash
curl -X POST http://127.0.0.1:5180/api/admin/index/build \
  -H 'content-type: application/json' -d '{"version":"v2"}'

curl -X POST http://127.0.0.1:5180/api/admin/index/finalize \
  -H 'content-type: application/json' -d '{"generationId":"gen-..."}'
```

已存在且内容/ACL 哈希一致的章节分片会跳过；缺失或过期的分片重新写入。finalize 前不会激活任何半成品索引。
