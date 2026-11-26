# MyWorld - 个人行程档案站

Cloudflare Workers + D1 + R2 + 静态前端 + GPX 构建脚本。

<directory>
assets/ - 浏览器前端、地图、统计与数据词典
docs/design/ - 视觉规格与高保真原型
docs/prd/ - 产品需求文档
gpx/ - 本地精简 GPX（不入 Git；发布源在 R2 myworld-gpx/gpx/）
migrations/ - D1 数据库迁移
src/ - Worker 与共享几何代码
tools/ - 数据构建、R2 GPX 同步、缓存与发布脚本
</directory>
<config>
wrangler.toml - Worker、D1 与 R2 绑定配置
schema.sql - 本地开发建库脚本
manifest.webmanifest - PWA 元数据
</config>

法则：生产代码、文档与设计稿保持同构；新增模块必须补 L2 与 L3。GPX 原件与精简件只存 R2，不进 Git。
[PROTOCOL]: Update this header on change, then check AGENTS.md
