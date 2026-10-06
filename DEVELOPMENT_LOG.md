# 项目开发记录：基于 VitePress 的 Element Plus 风格文档系统

## 1. 核心思考与规划

### 1.1 需求本质分析
用户需求的核心在于构建一个不仅能看（文档），还能跑（组件示例），且长得像 Element Plus 的系统。关键技术挑战在于：
- **Markdown 与 Vue 的融合**：如何让 Markdown 中的代码块既能作为源码展示，又能作为实时组件运行。
- **自动化**：减少开发者的重复工作，实现“写一个 Vue 文件，出一份 Demo 文档”。

### 1.2 技术选型
- **基础引擎**：VitePress 1.x（目前最先进的 Vue 文档工具）。
- **Demo 方案**：采用 `markdown-it-container` 拦截 `::: demo` 块，配合 Vite 的 `import.meta.glob` 实现动态渲染。
- **样式方案**：Sass + CSS Variables，便于定制 Element 风格。

## 2. 执行过程记录

### 第一阶段：基础搭建
1. 初始化项目，安装 `vitepress`, `vue`, `sass`。
2. 配置多语言结构（zh/en），设置侧边栏和导航栏基础路由。

### 第二阶段：核心组件开发
1. 开发 `VpDemo.vue`：模仿 Element Plus 的代码卡片，包含预览区、描述区和折叠代码区。
2. 开发 `VpApi.vue`：用于展示组件参数，使用 Element 标志性的表格样式。

### 第三阶段：自动化插件实现
1. 编写 Markdown 插件逻辑：
   - 监听 `::: demo` 容器。
   - 从容器内容中提取 Vue 示例文件路径。
   - 读取文件源码，通过 `markdown-it` 再次渲染为代码块。
   - 渲染自定义组件 `<demo-xxx />`。
2. 实现自动注册：在 `theme/index.ts` 中利用 `glob` 自动扫码并注册所有示例。

### 第四阶段：问题排查与修复
1. **ESM 冲突**：修复了 `package.json` 中 `type` 字段冲突导致的启动失败。
2. **解析报错**：修复了 Markdown 与 Vue 模板混合时由于换行符导致的 Token 偏移错误。
3. **本地搜索**：在配置文件中一键开启内置本地搜索。

## 3. 设计亮点
- **零手动注册**：开发者只需在 `examples/` 文件夹下添加 `.vue` 文件，即可在任何 Markdown 中引用，极大提升了开发效率。
- **极致还原**：不仅是颜色，在代码折叠交互、API 表格间距等细节上均贴合 Element Plus 规范。

## 4. 检索片段服务（search-service）

### 4.1 需求拆解
在 VitePress 本地搜索之外，新增一个独立的**检索片段服务**，核心难点：
- 高亮偏移在「HTML 剥离 → NFKC 规范化/小写」两级视图变换后必须能还原到原文；
- 分版本索引 + 代次发布（先构建后切换）+ 关系库可见性；
- 索引时权限快照与查询时回查的取舍，撤回立即生效；
- 不把“索引未完成”伪装成“无匹配”。

### 4.2 关键设计
1. **码点安全 + OffsetMap**：所有词项位置均为某一视图的 code point 偏移；`codepoints.js` 提供码点切片，`offset-map.js` 维护 norm→stripped→raw 两级映射，并修正了“尾标签导致哨兵值越界”的问题，保证 emoji/CJK 不被截坏。
2. **双分析器**：自然语言（NFKC+小写、CJK unigram/bigram）与代码标识符（完整路径、camelCase/snake 拆分、错误码正则）；过滤 `E4001` 中单字母 `E` 的噪声。
3. **片段管线**：在 norm 视图选窗口，映射回 stripped 切片并转义；`<script>/<style>/注释` 整体丢弃；重叠区间按 error>api>field>text 合并。
4. **代次模型**：`building→ready→active`，仅 ready 可发布，活动指针原子切换；构建期旧索引继续服务；草稿永不入库。
5. **权限双时刻**：索引时快照非权威，查询时回查关系库为唯一闸门；撤回写即时集合先隐藏，后台 sweep 再物理删除并记录两阶段时间。
6. **状态语义**：构建中/就绪未发布→503 not_ready，无代次→503 no_index，真零命中才 200+total:0；恢复未重建的文档以 `indexCoverage.staleDocuments` 标注。
7. **签名键集游标**：绑定代次+查询+版本，跨代次/改查询/锚点失效→410 STALE_CURSOR，损坏→400 INVALID_CURSOR。

### 4.3 交付物
- `search-service/src/`：text / snippet / index / store（含 schema.sql）/ security / api / frontend / demo。
- `search-service/test/`：38 项 node:test 测试，覆盖跨版本、索引中断续跑、片段含 HTML、权限临时变化、旧游标翻页等。
- 前端 `SearchPanel.vue` 已复制进 VitePress 主题并新增 `docs/guide/search-service.md`，`docs:build` 通过。

### 4.4 踩坑记录
- 初版用 UTF-16 语义做 indexOf/哨兵值，导致多字节与尾标签边界错误；统一改为码点数组扫描后解决。
- sweep 误把 generationId 当 documentId 传入 removeDocument，导致物理清除为空。
- 代码分析器曾把 `->` 的 `-` 当标识符、把 `E4001` 拆出噪声单字母 `E`，分别用“起始必须是词字符”“子部分长度≥2”修复。
