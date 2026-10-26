# PRD 03 · 前端体验与性能优化

> 上游：[方案总览](README.md) · 状态：**待评审**（2026-10-26 起草，只规划未动手）
> 范围：`index.html` / `assets/js/*.js` / `assets/css/style.css` / `sw.js` / `src/worker.js` 的缓存头
> 不含：新业务功能（登录/上传在 [PRD 01](auth.md)/[PRD 02](ingest.md)）、后端数据模型

## 0. 现状盘点（先承认做得对的，优化不能弄坏它们）

| 项 | 现状 | 评价 |
|---|---|---|
| 体积 | JS 合计 209 KB raw / **gzip ≈45 KB**（app 17.1 + stats 9.3 + routemap 9.2 + 其余）；CSS 9.7 KB gz | 零框架零构建，这个体积很健康 |
| 加载 | 9 个 `<script defer>`（顺序即依赖）；腾讯地图 GL **按需注入**（`map.js:163`）；换页销毁地图实例防 WebGL 泄漏 | ✅ 保持 |
| 路由 | hash 路由 + `state` 保留各 tab 筛选/视图 | ✅ 保持 |
| 搜索 | 委托 `input` 事件 + **输入法 composition 保护**（`app.js:1276-1282`），重渲染后恢复焦点与光标 | ✅ 思路对，但见 F1 |
| 离线 | SW：静态 cache-first、`/api/*` network-first 回落缓存；断网可看 | ⚠️ 见 F3 |
| 无障碍 | 有 `:focus-visible` 焦点环（`style.css:2063`）、`prefers-reduced-motion`、safe-area | ⚠️ 语义属性几乎为空，见 F6 |
| 状态 | 空态文案齐全（`app.js:683/729/759/833/846`）；boot 有错误屏 | ⚠️ 见 F2 |

## 1. 问题清单与改法

> 优先级：P0 = 体验缺陷（该修）；P1 = 感知性能/完整度（值得修）；P2 = 锦上添花（你挑）。
> 每条给证据行号，方便你逐条核对。

### P0 · 体验缺陷

**F1 搜索/筛选时页面跳回顶部**
- 现象：在列表页搜索框每敲一个字、或点年份/航司 chip，视口跳回页顶，刚滚到的位置丢失。
- 证据：`applySearchQuery`（`app.js:1254-1263`）→ `render()` → 无条件 `window.scrollTo({top:0})`（`app.js:1074`）。代码恢复了输入焦点与光标，但没恢复滚动位置。
- 影响：100 段航班滚到 2019 年再搜「CA」，直接弹回顶部；中文输入连打时尤其烦。
- 改法：给 `render()` 加「原因」参数——**路由/tab/子视图切换**才 scrollTo(0)；**搜索与 chip 筛选**保留 `scrollY`（重渲染后 `scrollTo(0, prevY)`）。
- 验收：列表滚到中部 → 输入关键词 → 视口不动、光标不丢；点「飞行/铁路/足迹」切 tab 仍回顶部。
- 工作量：0.5 h。

**F2 「加载失败」被伪装成「没有数据」**
- 现象：`/api/*` 任一请求非 200 或超时（公司网掐 workers.dev 时必现），页面渲染成空列表 + 「这个筛选条件下没有记录」/「还没有轨迹…」，用户以为数据没了。
- 证据：`loadRemote()` 失败返回 `false` 不抛错（`app.js:69-95`），`boot()` 照常 `initDatas()+render()`（`app.js:1289-1292`）；只有 JS 抛异常才走错误屏。SW 离线回落旧缓存时同样**无任何提示**。
- 改法：全局 `dataState = 'ok' | 'stale' | 'failed'`；`failed` 时顶部红条「行程数据加载失败（网络？），当前显示为空」+ 重试按钮；`stale`（用了 SW 缓存）时灰条「离线/缓存数据，更新于 xx」，点击可强制刷新。
- 验收：DevTools 把 `/api/*` 设为 offline/blocked 打开 → 看到红条而非空列表；断网用缓存 → 看到灰条。
- 工作量：1 h。

### P1 · 感知性能与完整度

**F3 二次打开仍等网络：SW 改 stale-while-revalidate + API 加 ETag**
- 现象：回访用户打开站点仍要等 4 个 `/api` 请求落地才首渲（`boot` 在 `app.js:1289` await 全部 fetch）；SW 对 `/api/*` 是 network-first（`sw.js`），有缓存也先等网络。
- 证据：`src/worker.js:37` 只有 `cache-control: public, max-age=300`，**列表接口没有 ETag**（只有 `track_raw` 有，`worker.js:174`）。
- 改法：① SW 的 `/api/*` 改 SWR——命中缓存**立即返回**、后台 fetch 更新缓存；② Worker 给 4 个列表接口加 ETag（内容 sha，CPU 微秒级）→ 后台再验证走 304 省流量；③ 后台更新完成用 `postMessage` 通知页面，数据有变才静默重渲染；④ `visibilitychange`/focus 时主动 refetch 一次（你刚上传完回到页面能立刻看到）。
- 取舍：首屏可能短暂显示几分钟前的旧数据（有 F2 的灰条兜底提示）。
- 验收：二次打开 4 个视图 **<100 ms** 出内容；上传一条铁路后切回页面 ≤1 次 focus 内出现；DevTools Network 看到 304。
- 工作量：2 h（sw.js + worker.js + app.js 三处）。

**F4 浏览器标题恒定**
- 现象：`document.title` 永远是「MyWorld · 行程记录」；`app.js:1064` 只改了页内 `#topTitle`。多标签切换、书签、复制链接分享都分不清页面。
- 改法：`render()` 里按路由同步 title：`#/track/:id` → 「武功山两日穿越（萍乡进宜春出）· 足迹 · MyWorld」；`#/flights` → 「飞行 · MyWorld」；首页保持现状。
- 验收：切 tab/进详情，标签页标题跟随；回首页复原。
- 工作量：0.5 h。

**F5 地图域名 preconnect**
- 现象：概览页城市地图几乎每个会话都用，但 `map.qq.com` 的 DNS+TLS 要到首次 mount 才开始（`map.js:163`）。
- 改法：`index.html` 加 `<link rel="preconnect" href="https://map.qq.com" crossorigin>` + `<link rel="dns-prefetch" href="https://map.qq.com">`。
- 验收：DevTools Network 里 gljs 请求的 DNS/Connect 阶段 ≈0。
- 工作量：5 min。

**F6 无障碍语义补齐（纯加属性，零视觉变化）**
- 证据：`app.js` 里 `aria-` 出现 **0 次**；`role="tablist"` 有了（`app.js:338`）但子按钮缺 `role="tab"`/`aria-selected`；tabbar 链接缺 `aria-current="page"`（`app.js:1004-1006`）；三个搜索框只有 placeholder 没有 `aria-label`（`app.js:675/721/822`）；列表条数变化无 `aria-live`。
- 改法：上述属性补齐；结果计数 `<h2 class="section__title">` 加 `aria-live="polite"`。
- 验收：VoiceOver 读 tab 能听到「当前页」；读搜索框有名称；切换筛选会播报条数。
- 工作量：1 h。

**F7 桌面端别再浪费一半屏幕（视觉改动最大，要你选风格）**
- 证据：内容列 `max-width:680px`（`style.css:85/102/1483`）；`@media(min-width:700px)` 只把 tabbar 变胶囊、地图加高（`1179/1481/2040`）。1440px 屏幕上两侧各空 ~380px。
- 改法（选项 A，推荐）：新增 `@media(min-width:1000px)`：内容列放宽到 **1040px**；概览 kv 卡 4 列、详情 kv 3 列、统计卡 2 列；列表卡改横向信息排布（日期 | 航线 | 座位/舱位 | 票价 一行）；tabbar 保持胶囊。
- 备选 B：维持 680 单列（现状，移动端一致、零风险）；备选 C：左列表右详情双栏（改动大，本轮不做）。
- 验收：1440×900 与 390×844 两种宽度下逐 tab 截图对比，无溢出/无换行错乱；移动端回归不变。
- 工作量：3–4 h（含两轮视觉微调）。

### P2 · 锦上添花（挑着做）

| # | 项 | 说明 | 工作量 |
|---|---|---|---|
| F8 | `stats.js`+`routemap.js` 按需加载 | 两者 gzip 共 18.4 KB 总是随首屏加载，但只在对应子视图用；仿 `map.js` 做 promise 化按需注入 | 1.5 h |
| F9 | 概览角标「数据更新于 x 天前」 | `meta` 表目前只有 `seeded_at=2026-10-12`（**上传入库后并不会更新它**——ingest 管道写库时应顺带 upsert `published_at`，本项依赖该小改）；过渡方案取各表 `MAX(created_at)` | 1 h |
| F10 | 离线/上线切换提示 | `navigator.onLine` + `online/offline` 事件，与 F2 的横幅复用 | 0.5 h |
| F11 | og:image 分享卡 | 在 Roadmap，依赖自定义域名；本轮只挂关联不排期 | — |
| F12 | ~~SW 更新 toast~~ | **建议不做**：navigate 是 network-first，下次刷新自动用新版，toast 只制造噪音 | 0 |

## 2. 非目标（这轮不碰）

- 不引框架/构建链（零构建是本仓库地基，`file://` 双击可跑要保留）；
- 不换 history 路由（静态托管友好）；不做虚拟列表（百级数据量不需要）；
- 不做浅色主题（深色是产品调性）；不做 i18n；
- 不动数据口径与统计算法（stats.js 的数一个不改）。

## 3. 实施顺序与总量

| 批次 | 内容 | 估时 |
|---|---|---|
| 批 1（P0） | F1 滚动保持、F2 加载态横幅 | 1.5 h |
| 批 2（P1 快赢） | F4 title、F5 preconnect、F6 aria | 1.5 h |
| 批 3（P1 性能） | F3 SWR + ETag + focus 重取 | 2 h |
| 批 4（P1 视觉） | F7 桌面布局（按你选的风格） | 3–4 h |
| 批 5（P2 可选） | F8/F9/F10 按勾选 | 0–3 h |

合计 **≈1.5–2 个工作日**。每批独立提交+部署+可回滚；批 4 单独一个提交方便你看 diff 截图。

## 4. 开放问题（等你确认）

- **Q1（F7 风格）**：桌面布局选 A（放宽 1040 + 网格多列，推荐）/ B（维持 680 单列）/ C（双栏，本轮不做）？
- **Q2（F3 新鲜度）**：接受 SWR「先显示缓存、后台更新」吗（可能短暂旧几分钟，有灰条提示 + focus 自动重取）？还是保守点只加 ETag、保持 network-first？
- **Q3（P2 勾选）**：F8 按需加载 / F9 更新角标 / F10 离线提示，哪些进这轮？
- **Q4（F4 标题格式）**：「轨迹名 · 足迹 · MyWorld」这种三段式可以吗？还是只要「轨迹名 · MyWorld」？
- **Q5（F1 边界）**：chip/年份筛选也保留滚动（和搜索一致），还是只有搜索保留、chip 切换回顶部？我倾向**都保留**（它们都是「在同一页里收窄结果」）。

## 5. 确认记录与实施状态（2026-10-26）

用户确认：**全部实施**，开放问题按推荐值——Q1=A（≥1000px 放宽 1040 + 多列）、Q2=SWR、
Q3=F8+F9+F10、Q4=三段式标题、Q5=搜索与 chip 均保留滚动。另追加需求：**手机视图重设计**。

### 5.1 手机重设计规格（新增范围）

| # | 改动 | 前后对比 |
|---|---|---|
| M1 | 列表控制簇：搜索框在上 + **单条 chips 横向滚动条**（维度间用竖线分隔，label 行退役），整簇吸顶在顶栏下 | 航班页控制区 ~220px → ~96px，滚长列表时筛选始终在手边 |
| M2 | 航班卡：准点 tag 上移首行右对齐；中间列只留航线细线；**城市+机场合并一行**（城市加粗 + 机场 muted）；历时/里程下移 meta 行 | 390px 下「鄂尔多斯伊金霍洛 T2」这类长机场名不再把三列挤碎 |
| M3 | 铁路卡：日期右对齐进路线行；**备注改脚注行**（12px muted 全文） | 长备注（改签说明带票价时刻）不再碎成三四行 tag 芯片 |
| M4 | 节奏与触控：年份组头收紧；chip ≥30px / btn ≥40px；详情页主操作手机上给足宽度 | 触控达标 |
| M5 | `netbar` 状态横幅（F2/F10 共用）：失败红条+重试、断网/缓存琥珀条+刷新 | 「加载失败」不再伪装成「没有数据」 |
| M6 | 概览 hero 加「记录截至 YYYY-MM-DD」角标（F9，取三表最大日期，无需 schema 改动） | 数据新鲜度一眼可见 |

实现约束：base（mobile-first）样式一行不改，全部覆盖/新增追加在 style.css 尾部；
桌面规则只存在于 `@media (min-width:1000px)` 块内（1040 列、卡片 2 列 grid、kv 3 列、
stat 4 列、地图 460px），手机视口匹配不到 → 零回归风险。

### 5.2 实施清单（已完成，部署版本 `1d35e3c1`）

- 批 1：F1 滚动保持（render 加 reason，`keep` 不回顶）、F2 netbar
- 批 2：F4 三段式 title、F5 preconnect map.qq.com、F6 aria（tab aria-current / tab role+aria-selected / 搜索 aria-label / 计数 aria-live）
- 批 3：F3 SW stale-while-revalidate + Worker 四列表接口 ETag（304 实测通过）+ focus/visibility 静默重取 + SW postMessage（api-updated 静默重渲 / api-cache 挂横幅）
- 批 4：M1–M4 手机重设计 + F7 桌面档
- 批 5：F8 stats.js/routemap.js 按需注入（首屏 −18.4 KB gz）、F9 角标、F10 online/offline
- F11（og:image）挂 Roadmap 未做；F12 按建议不做

### 5.3 待真机验收（公司网打不开 workers.dev，需手机热点）

1. 列表滚到中部搜索 → 视口不动、光标不丢；切 tab 仍回顶；
2. 控制簇吸顶、chips 单条横滚不换行；航班/铁路卡新排版无溢出；
3. 二次打开秒出内容；上传后切回 ≤ 一次 focus 内刷新；
4. 断网打开 → 琥珀条；接口全挂 → 红条+重试；
5. iPad 横屏 / 桌面 ≥1000px → 1040 列 + 双列卡片；手机竖屏回归无差异。
