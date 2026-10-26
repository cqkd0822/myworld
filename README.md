# MyWorld · 行程记录

个人行程记录站：**航班 / 铁路 / 徒步轨迹**三类数据。
2026-10 起架构升级为：**Cloudflare Worker 单项目承载站点 + API，D1 为数据真源**。

> 当前规模：100 段航班（2015–2026）· 54 段铁路 · 62 条轨迹（徒步/越野）。
> 站点入口：<https://myworld.tw2d9fp8ht.workers.dev>（站点与 API 同域）

---

## 架构

```
Cloudflare Worker 「myworld」            Cloudflare D1 「myworld」
 ├─ /            站点静态资源              ├─ flights      航班（含 note 备注）
 │   (Workers Static Assets,              ├─ rail         铁路
 │    仓库根目录 + .assetsignore)         ├─ rail_voided  未成行原票
 ├─ /api/flights        ┐                  ├─ tracks       轨迹元数据+统计
 ├─ /api/rail           │  只读接口，       ├─ track_raw    原始轨迹点(唯一几何真源)
 ├─ /api/rail-voided    │  返回与旧明文     └─ meta         发布元信息
 ├─ /api/tracks         │  数组同构的 JSON
 └─ /api/tracks/:id/raw   原始点下发；抽稀/剖面在**浏览器**算
```

- **数据真源 = D1**。仓库里**不再有明文行程数组**（旧 `assets/data/{flights,rail,tracks}.js` 已退役）。
- 前端启动时异步 `fetch /api/*`（同域、4 秒超时）；形状与旧数组同构，视图层零改动。
- **几何只存一份**：`track_raw` 里是原始点的紧凑编码（1e-6 度增量整数 + 0.1 m 海拔 +
  秒级时间增量，gzip+base64；61 条合计 0.74 MB，最大单行 70 KB）。抽稀 paths 与海拔剖面
  是**构建产物**，既不落库也不在边缘算（Workers 免费档每次调用只有 10 ms CPU，最长那条
  轨迹要算约 30 ms）：`/api/tracks/:id/raw` 把原始点原样下发（ETag + immutable），
  前端用同一份算法源码（`src/geo.mjs` → `assets/js/geo.js`）本地抽稀、算剖面，
  桌面实测最长一条 11 ms。61/61 条浏览器重算结果与全精度 GPX 直接算**逐字节一致**，
  所以库里没有第二份几何。编码与精度论证见 `src/raw.js`。
- 列表接口只取元数据：`/api/tracks` 响应约 34 KB，几何**进详情页才拉**（9~15 KB/条）。
- Service Worker：`/api/*` network-first（数据要新鲜）、静态 cache-first（装过一次断网可看）。
- **GitHub 的角色**：代码 + 原始 GPX 存档（`tools/source/`）+ 种子 SQL + 精简 GPX（`gpx/` 供下载）。
- **R2 暂搁置**：开通需 Dashboard 绑付款方式；等大对象（原始 GPX/截图）需要时再迁。

## 网络限制（必读）

部分公司网络对出站做深度识别：`*.workers.dev` 与 SSH(22/443) 都会被 reset/超时，
HTTPS 正常。因此**本机公司 Wi-Fi 打不开站点属网络问题**，手机热点正常；
彻底解决＝给 Worker 绑自定义域名（待办）。

## 本地开发

双击 `index.html` **已不支持**（数据在服务端）。用一体式本地环境：

```bash
# 首次：建本地库并灌种子（状态目录必须放仓库外，否则 assets 监听无限 reload）
P=/tmp/wrangler-persist
npx wrangler d1 execute myworld --local --persist-to $P --file=schema.sql
npx wrangler d1 execute myworld --local --persist-to $P --file=seed.sql
npx wrangler d1 execute myworld --local --persist-to $P --file=seed-tracks.sql
npx wrangler d1 execute myworld --local --persist-to $P --file=seed-raw.sql
npx wrangler dev --persist-to $P        # 站点 + API + 本地 D1，http://localhost:8787
```

凭据只放本地 `.env`（已 gitignore、600 权限）：`CLOUDFLARE_API_TOKEN` 等，**不要提交**。

## 新增 / 修改数据

| 数据 | 当前做法 |
|---|---|
| 轨迹 | 原始 GPX 放 `tools/source/` → `MANIFEST` 加一行 → `node tools/build-tracks.mjs` 生成 `seed-tracks.sql`（元数据+统计）与 `seed-raw.sql`（原始点）→ 依次 `wrangler d1 execute myworld --remote --file=...` 入库；精简 GPX 自动写 `gpx/` |
| 改统计/抽稀口径 | 构建期改 `MANIFEST` 的 `toleranceM` / `eleThresholdM` → 重跑 build → 重灌两份种子（边缘 10 ms CPU 扛不住万点级全量重算，不放服务端） |
| 改几何算法 | 只改 `src/geo.mjs` / `src/raw.js`，然后 `node tools/build-browser-geo.mjs` 重新生成浏览器包，再 `node tools/bump-cache.mjs` |
| 航班 / 铁路 | 直接改 D1（Dashboard 控制台或 `wrangler d1 execute`）；`seed.sql` 只是历史种子。/admin 上传+视觉抽取在做 |
| 航班备注 | `flights.note` 列，页面卡片自动显示（如「华夏基石出差」） |
| 城市词典 | `assets/data/airports.js`（仍打包，改完跑 `node tools/bump-cache.mjs`） |

## 数据口径

| 项 | 口径 |
|---|---|
| 准点率 | **全站统一 A15**：到达不晚于计划 +15 分钟。只有一个数字，不再有严格/宽松两套 |
| 飞行里程 | 城市间**直线距离**（下界）。实际航路见下文「实际航程」 |
| 轨迹距离 | 原始点间距累加，未平滑（平滑会在发卡弯抄近道，实测少算 8%） |
| 累计爬升 | 海拔阈值 10 米过滤抖动 |
| 移动时间/速度 | 相邻点间隔 >10 分钟视为休息整段剔除；跨天/过夜徒步用这个算速度 |
| 时间戳 | GPX 为 UTC，页面按本地时区显示；徒步日期按 UTC+8 归日 |

### 实际航程（待办讨论）

直线距离是有意保留的下界口径。若要「实际航程」：FlightAware AeroAPI 等可按
航班号+日期查实际飞行距离，但 2015–2026 历史国内航班覆盖不全且收费；
更务实的是展示「估算航路 = 直线 × 系数」或只对新行程接 API。见 Roadmap。

## 缓存与发布

- 静态资源 URL 带 `?v=<assets 内容 sha256 前 8 位>`：改完资源跑 `node tools/bump-cache.mjs`。
- 部署：`npx wrangler deploy`（Worker 托管站点+API）。旧 Cloudflare Pages 副本待删除。

## Roadmap

> 2026-10-12：登录与上传入库两册 PRD 落在 [`docs/prd/`](docs/prd/README.md)，含平台免费档硬约束核对、数据模型、接口契约与验收标准。

- [ ] 绑自定义域名（绕开公司网对 workers.dev 的封锁）
- [ ] 删除另一账号下的旧 Pages 副本
- [ ] 多用户登录与权限 —— 方案已写：[docs/prd/auth.md](docs/prd/auth.md)（待评审）
- [ ] /admin：GPX/截图上传 → 解析/视觉抽取 → 草稿确认 → 写 D1 —— 方案已写：[docs/prd/ingest.md](docs/prd/ingest.md)（待评审）
- [ ] R2（开通后）：原始 GPX / 截图 / 生成物
- [ ] nightly cron：D1 快照镜像 commit 回 GitHub（恢复 git diff 审计）
- [x] 几何只存一份：`track_raw` 为唯一真源，渲染几何在浏览器现算（2026-10）
- [ ] 实际航程口径（AeroAPI 或系数估算）
- [ ] og:url / og:image（需要最终域名）
