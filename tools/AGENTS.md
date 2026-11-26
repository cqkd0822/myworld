# tools/

> L2 | Parent: ../AGENTS.md

成员表

build-tracks.mjs: 把原始 GPX 编译成 D1 种子与精简 GPX。
build-browser-geo.mjs: 把 src/geo.mjs 与 src/raw.js 打包成浏览器模块。
sync-r2-gpx.mjs: 上传/校验本地 GPX 到 R2 bucket `myworld-gpx`。
bump-cache.mjs: 更新静态资源缓存版本。
push.mjs: GitHub 推送兜底工具。

法则：本目录是离线工具，不进 Worker 运行时。
[PROTOCOL]: Update this header on change, then check AGENTS.md
