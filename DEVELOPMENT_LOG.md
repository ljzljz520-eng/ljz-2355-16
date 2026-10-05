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

## 4. 检索片段服务实现记录（2026-10）

### 4.1 架构
- 使用 sql.js（WASM SQLite）实现关系库，表覆盖文档/版本/章节/授权/索引代次/checkpoint/active 指针。
- 索引按版本和 generation 落盘：章节分片先写入 `generations/<id>/shards`，全部通过哈希校验后再写不可变 `index.json` 并切换 active pointer。
- HTTP 服务提供搜索、章节写入、临时权限、后台 ACL 刷新、索引构建与 finalize 接口。

### 4.2 偏移与分析
- 明确区分 HTML UTF-16 原文、纯文本、规范化文本和 token 偏移。
- 最终高亮偏移采用 Unicode 码点，前端使用 `Array.from` 切分，避免 emoji/增补平面被截坏。
- 自然语言使用拉丁整词和 CJK bigram；代码标识符保留整词并拆出 camelCase、snake_case、数字片段。

### 4.3 发布与权限
- 构建中的 generation 不提供服务；无已发布索引时返回 503 `INDEX_NOT_READY`，不把未完成构建伪装成空结果。
- draft 章节不进入发布索引；正文更新后新一代次未切换前仍只返回旧正文。
- 查询时始终回查关系库，撤回立即生效；索引保存 ACL 快照用于物理收窄和后台清理，刷新后切换新一代次。

### 4.4 测试
- 新增 10 个 Node 内置 test 用例：多字节偏移、跨版本、中断续跑、HTML 片段、权限变化、旧游标、未发布章节和 HTTP API。
- `npm run docs:build` 验证 VitePress 集成，导航中新增检索片段面板。
