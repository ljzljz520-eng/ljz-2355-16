# 文档站检索片段服务（Doc Search Snippet Service）

为 VitePress 文档站提供**带类型高亮、分版本、权限安全**的检索片段后端与前端组件。零运行时依赖，使用 Node 内置 `node:test`。

## 运行

```bash
cd search-service
npm test          # 38 项自动化测试
npm start         # 启动演示服务 http://127.0.0.1:5174
```

示例：

```bash
# 当前版本检索错误码
curl 'http://127.0.0.1:5174/api/search?q=E4001'

# 跨当前+历史版本
curl 'http://127.0.0.1:5174/api/search?q=getUserProfile&version=all&includeHistorical=true'

# 内部文档（需权限）
curl 'http://127.0.0.1:5174/api/search?q=queryAuditLog&version=all&includeHistorical=true' \
  -H 'x-principals: group:admin'
```

## 需求到实现的映射

| 需求 | 实现位置 |
| :--- | :--- |
| 前端高亮字段、接口名、错误码 | `src/frontend/SearchPanel.vue`、`render.js`；类型由 `inverted-index` 依据声明标注 + 错误码形态判定（`field/api/error/text` 四色） |
| 搜索 API 读取分版本索引 | `search-engine.resolveGeneration()` 按版本作用域解析活动代次，回退 `all` |
| 关系库管理可见性与索引发布代次 | `src/store/schema.sql`（SQLite 参考 DDL）+ `memory-store.js`（同构内存实现） |
| 规范化/分词偏移不能直接当原文字符位置 | `src/text/offset-map.js` 两级 `OffsetMap`（raw→stripped→norm），全部位置以**码点**表示 |
| 高亮不截坏多字节文本 | `codepoints.js` 码点切片 + 代理对配对校验（`test/offset.test.js`、`snippet.test.js`） |
| 代码标识符与自然语言不同分析规则 | `analyzers.js`：`textAnalyze`（NFKC+小写+CJK unigram/bigram）与 `codeAnalyze`（完整标识符/路径/camelCase/snake/错误码） |
| 索引先在新代次构建再切换 | `indexer.js`：`building → ready → active`，仅 `ready` 可 `publish()`，活动指针原子切换 |
| 元数据更新与入索引不指向未发布正文 | 仅 `listPublishedVersions()` 的章节入索引；草稿永不入库（测试断言 `SECRET_UNPUBLISHED` 不可检索） |
| 比较索引内存权限与查询时回查权限 | `permissions.js`：`indexPermission`（非权威快照）对比 `queryPermission`（每次检索的权威回查） |
| 撤回后立即过滤及后台清除 | `revoke()` 写即时撤回集合（检索立即隐藏）；`sweepGeneration()` 异步物理删除；`revocation_log` 记录两阶段时间 |
| 未索引完成不冒充无匹配 | 构建中/就绪未发布→`503 not_ready`；无任何代次→`503 no_index`；真正零命中才是 `200 total:0` |
| 当前与历史结果区分 | 结果含 `isCurrent/historical/version`，链接 `/{slug}/{version}#{anchor}` 精确定位章节版本 |
| 旧游标翻页 | 签名键集游标绑定 `genId+q+version`；跨代次/改查询/锚点失效→`410 STALE_CURSOR`；损坏→`400 INVALID_CURSOR` |

## 偏移正确性（核心不变量）

```
raw HTML ──stripHtml──▶ stripped 纯文本 ──normalizeView──▶ norm 文本
  cp(raw)                 cp(stripped)                     cp(norm)
                  OffsetMap(stripped→raw)   OffsetMap(norm→stripped)
```

- 倒排表中每个词项都记录其在 **norm 视图**的码点区间；
- 片段窗口在 norm 视图选出，再依次映射回 stripped（用于展示切片）与 raw（用于章节锚点）；
- 展示文本从 **stripped 视图**切出并 HTML 转义，因此原文标签永不进入渲染；
- NFKC 可能发生长度变化（如连字 `ﬁ`→`fi`），HTML 剥离会丢弃标签——映射的**哨兵值**精确记录“最后一个保留码点之后”的源位置，避免把尾标签切进结果。

## 片段与 HTML 安全

- `<script>/<style>/<head>/<template>` 内容与注释被整体丢弃，不进索引也不进片段；
- 实体（`&nbsp;`、`&#x4e2d;` …）解码为单码点并保留映射；
- 前端默认用 `DocumentFragment` + `textContent` 渲染，服务端另提供已转义的 `snippet.html`。

## HTTP 接口

`GET /api/search`

| 参数 | 说明 |
| :--- | :--- |
| `q` | 查询词（字段/接口/错误码/自然语言） |
| `version` | `current`（默认）/ `all` / 具体版本标签如 `v1` |
| `includeHistorical` | `true` 时同时返回历史版本 |
| `limit` | 1–50，默认 10 |
| `cursor` | 上一页 `nextCursor` |
| 半径 | `radius` 片段窗口半径（码点） |

请求头 `x-principals: a,b` 声明调用方身份（演示用；生产应从会话/令牌解析）。匿名恒含 `*`。

响应中：

- `status`: `ok` / `not_ready` / `no_index` / `error`
- `results[].snippet.html` 与 `segments`（高亮片段）
- `results[].deepLink`（slug、版本、锚点、raw 码点区间）
- `results[].isCurrent / historical / version / generation`
- `indexCoverage`（代次、是否完整、恢复但未重建的文档）
- `filtered.hiddenRevoked / hiddenForbidden`（即时撤回与权限过滤计数）

## 目录结构

```
search-service/
├── src/
│   ├── text/        codepoints · offset-map · html-view · analyzers
│   ├── snippet/     snippet.js（窗口选择/类型合并/转义渲染）
│   ├── index/       inverted-index · indexer · search-engine
│   ├── store/       schema.sql · memory-store.js
│   ├── security/    permissions.js（索引时 vs 查询时、撤回/清扫）
│   ├── api/         http.js
│   ├── frontend/    SearchPanel.vue · search-client.js · render.js
│   ├── demo/        seed.js
│   └── server.js
└── test/            offset · snippet · service · frontend · http
```

## 生产化说明

- 将 `memory-store.js` 的仓库接口替换为按 `schema.sql` 建立的 SQLite/Postgres 实现即可持久化；
- 索引重建可由定时任务或文档发布事件触发，仍遵循“构建完再切换”；
- 即时撤回集合可放入共享缓存（如 Redis）以支持多实例；后台清扫可转为任务队列；
- 权限头应替换为真实鉴权中间件。
