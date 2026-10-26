# MyWorld 多用户 + 上传入库 · 方案总览

> 状态：**待评审**（2026-10-12 起草）
> 分册：[01 用户登录与权限](auth.md) · [02 行程上传与识别入库](ingest.md)

## 0. 一句话

把 MyWorld 从「一个人的只读站」升级成「几个同事能登录、能上传行程/轨迹并**直接落 D1（托管 SQLite）**的小系统」。

## 1. 需求拆解与依赖

| 编号 | 需求 | 分册 | 依赖 |
|---|---|---|---|
| R1 | 用户登录系统（多用户、可给同事用） | [auth.md](auth.md) | 无 |
| R2 | 上传行程（航旅纵横截图 / 12306 截图 / 邮箱行程单）+ GPX → 识别 → 写库 | [ingest.md](ingest.md) | **R1**（写库必须知道「谁写的、记在谁名下」） |

R1 是 R2 的前置：`owner_id` 和会话身份一旦缺席，同事上传的航班会直接混进你的准点率与里程统计里，事后清洗很痛。所以两册一起评审，但**实施顺序是 R1 → R2**。

## 2. 现状与平台硬约束（都是查过文档/实测的，不是猜的）

### 2.1 现有架构

- 单个 Cloudflare Worker `myworld`：静态站点（Workers Assets，仓库根目录）+ `/api/*` 只读接口。
- 数据真源 = **D1 `myworld`**（`de16c23c-…`）：`flights`(100) / `rail`(53) / `rail_voided` / `tracks`(61) / `track_raw`(唯一几何真源, 0.74 MB) / `meta`。
- 写口只有一个**空壳**：`/api/admin/*` 校验 `x-admin-token`（`.dev.vars` 里的 `ADMIN_TOKEN`），然后一律 404 —— 见 `src/worker.js:63`。
- 前端零框架零构建：`assets/js/*.js` 顺序加载，`/api/*` 返回的是**位置数组**，`data-utils.js` 按下标解构（`const [id,date,airline,…] = r`）。
  → **接口扩列只能在数组尾部追加**，否则前端全线错位。
- 重计算全在浏览器：`/api/tracks/:id/raw` 下发原始点，抽稀与海拔剖面用 `src/geo.mjs` 在前端算。

### 2.2 免费档限制（2026-10 核对）

| 项 | Free | Paid | 对本方案的影响 |
|---|---|---|---|
| Workers CPU | **10 ms / 次调用** | 30 s | 密码 KDF、GPX 解析、图片 base64 都**不能**放边缘 |
| Workers 请求数 | 100k / 天（**账号级共享**） | — | 几个人用绰绰有余；但账号下任何**公开无鉴权**的 Worker 都会啃掉这个池子（2026-10-12 发现一个 Dashboard 建的 AI demo worker `delicate-snow-3fe7`，建议删） |
| 请求体 | 100 MB | 100 MB | GPX(≤2.1 MB)/截图 都没问题 |
| 子请求 | 50 / 次 | 1000 | AI 调用 + D1 batch 各算 1，够用 |
| D1 单库 | **500 MB** | 10 GB | 现有 0.8 MB；原始 GPX 全量塞进来是 18 MB（gzip 后约 5 MB）→ 可以，但**建议走 R2** |
| D1 行/字段 | 单行 ≤ 2 MB；单条 SQL ≤ 100 KB；绑定参数 ≤ 100 | 同 | 原始 GPX 走 **绑定参数**，不能拼 SQL 字面量（70 KB base64 拼进 SQL 会顶到 100 KB 上限） |
| D1 读写 | 5M 行读 / **100k 行写** / 天，**2026-09-01 起超额直接失败** | 计费 | 一次轨迹上传写 1+N 行（N=段数），无压力 |
| D1 batch | 事务，失败整体回滚 | 同 | `tracks` + `track_raw` 必须放在**同一个 batch** 里 |
| Workers AI | **10,000 neurons / 天**（$0.011/1000） | 同 + 超额计费 | 一次截图识别约 30–210 neurons（见 §5），免费额度 47–330 次/天。**账号已可用**（2026-10-12 实测：Dashboard 建的 demo worker 带 `AI` binding 正常），且额度是**账号级共享**，所以要按人配额 |
| R2 | 10 GB 存储、**出网免费** | 同 | 归档原始 GPX/截图的正解；**2026-10-12 实测：本账号未开通**，API 返回 `10042 Please enable R2 through the Cloudflare Dashboard`（官方产品页写「no credit card required」，README 旧结论是「要绑付款方式」→ 需去 Dashboard 试一次） |
| Cloudflare Access | **≤50 用户免费** | 按用户计费 | 「今天就能给同事用」的零代码方案 |
| Email Routing | 收件免费，单封 ≤ 25 MiB；**发件要 Paid** | — | 邮箱行程单自动接入的可行性前提 |

> 另：公司网络对 `*.workers.dev` 做深度识别会 reset（README 已记录）。**给同事用之前先绑自定义域名**，否则同事在公司 Wi-Fi 下根本打不开，登录页也白搭。

## 3. 三条设计红线（沿用你已经验证过的架构决定）

1. **重计算不进边缘。** 10 ms CPU 是硬墙：GPX 解析/统计/抽稀/编码、图片缩放与 base64、口令 KDF，全部放浏览器；Worker 只做**校验 + 事务写库 + 转发 AI 请求**。
2. **几何只存一份。** `track_raw` 仍是唯一真源。上传路径必须产出与 `tools/build-tracks.mjs` **逐字节一致**的行 —— 用仓库里现成的 61 条轨迹做黄金对拍（这个仓库本来就有「61/61 逐字节一致」的验证传统）。
3. **识别结果不自动落库。** 一律 `识别 → 草稿 → 人工确认 → 写库`，并留 `intake` 审计记录（谁、何时、什么模型、原文、人工改了什么）。行程数据的下游是准点率/里程/足迹统计，一个错字会污染统计口径。

## 4. 选型建议（★=推荐，待你拍板）

| 决策点 | ★ 推荐 | 备选 | 影响面 |
|---|---|---|---|
| **登录方式** | 自建账号口令（Worker+D1+WebCrypto，**KDF 在浏览器算**）+ 中文登录页 | Cloudflare Access（邮箱验证码，0 代码，≤50 人免费）；Passkey/WebAuthn（第三阶段加固） | 是否引入 Zero Trust 依赖；能否自定义 UI；服务端 CPU 是否够 |
| **数据隔离** | **多租户**：三张行程表加 `owner_id`；匿名访问看 `public_read=1` 的用户（=你），同事只看自己的，你作为 owner 可看全部 | 单数据集共享（谁都能看谁都能改）——同事的航班会混进你的统计，不推荐 | 读接口全部要加作用域；SW 缓存策略要改（否则同一浏览器换账号会串数据） |
| **识别引擎** | **Workers AI**（同账号内调用、不出 Cloudflare、免费额度够用）：截图走 `@cf/qwen/qwen3.8-27b`（中文视觉强）或 `@cf/moondream/moondream3.1-9B-A2B`（OCR/结构化、便宜）；PDF 行程单先 `env.AI.toMarkdown()`（**有文字层时免费且精确**）再抽字段 | 外部 API（OpenAI 等）：质量更稳，但要 key、要出网、公司网可能拦；做成 `EXTRACT_PROVIDER` 可切换 | 成本、准确率、隐私（截图含身份证号） |
| **原始文件归档** | 阶段一只存 `sha256 + 抽取字段 + OCR 文本`，**不存原图**；原始 GPX 走 R2（能开就开） | 原图/原始 GPX 存 D1（gzip+b64）——能跑，但吃 500 MB 单库配额 | 隐私风险、存储成本 |
| **域名** | 先绑自定义域名，再发账号 | 继续用 `*.workers.dev`（同事在公司网打不开） | 可用性、Email Routing、Passkey 的 origin |

## 5. 识别成本估算（免费额度够不够）

neurons = 单价($/M tokens) ÷ 0.011 × 1000。按「图 ~3000 tokens + prompt ~400 + 输出 ~250」估：

| 模型 | 输入价 | 输出价 | 单次约 | 10k 免费额度 ≈ |
|---|---|---|---|---|
| `@cf/meta/llama-3.2-11b-vision-instruct` | $0.049/M | $0.676/M | **~30 neurons** | 330 次/天 |
| `@cf/moondream/moondream3.1-9B-A2B` | $0.30/M | $1.00/M | ~116 neurons | 86 次/天 |
| `@cf/qwen/qwen3.8-27b`（视觉+中文强） | $0.45/M | $3.20/M | ~212 neurons | 47 次/天 |

> ⚠️ 图片 token 化口径各家模型不同，以上是**数量级估算**，M4 第一步就是拿 10 张真实截图实测 neurons 与字段准确率，再定默认模型。
> PDF 行程单若走 `toMarkdown`（文字层提取）→ **免费**，只有图片路径才烧 neurons。

## 6. 里程碑（每步都能单独验收、单独上线）

| 里程碑 | 内容 | 验收标准 | 预估 |
|---|---|---|---|
| **M0** | 决策确认 + 绑自定义域名 + `wrangler secret` 配齐 | 同事在公司网能打开站点 | 0.5 天（等域名） |
| **M1** | 用户体系：`users/sessions/audit_log/login_attempts` 表、`/api/auth/*`、`login.html`、鉴权中间件、`/api/me`、用户管理页（owner 建号/停用/重置） | 本地 `wrangler dev` 能登录、能改密、能踢会话；错误口令 5 次锁 15 分钟；审计表有记录 | 1–1.5 天 |
| **M2** | `owner_id` 迁移 + 读接口按会话作用域 + **手工录入表单**（先不做识别）+ SW 不再缓存 `private` 响应 | 同事登录后只看到自己的数据；手工加一条航班/铁路立刻出现在列表和统计里；同一浏览器切换账号不串数据 | 1 天 |
| **M3** | **GPX 上传**：浏览器解析→统计→抽稀→编码→`POST /api/admin/tracks`→事务写 `tracks`+`track_raw` | 用 `tools/source/` 61 条 GPX 走上传路径，产出的行与 `seed-tracks.sql`/`seed-raw.sql` **逐字节一致**；上传后详情页地图/剖面/下载都正常 | 1 天 |
| **M4** | **识别上传**：截图/PDF → `POST /api/admin/extract` → 草稿表单（可编辑）→ 确认写库；`intake` 审计与去重 | 10 张真实样本：关键字段（航班号/日期/机场/时间、车次/日期/站名）准确率 ≥95%；重复上传同一张图会提示「已识别过」；识别失败能一键转手工 | 1.5–2 天 |
| **M5** | 加固与自动化：Passkey、Email Routing 自动收件建草稿、R2 归档、nightly D1 快照回 GitHub | 转发邮件即生成草稿；仓库里能拿到 `.sqlite` 快照 | 按需 |

## 7. 开放问题（我已按推荐值把方案写死，你确认或直接改）

- **Q1 数据隔离**：同事的行程和你的是**各自独立**（推荐），还是共用一个数据集？不登录的公开页面还要不要能看到你的行程（现状是能）？
- **Q2 登录方式**：自建口令登录（推荐），还是先用 Cloudflare Access 邮箱验证码把同事放进来（0 代码、当天可用）？要不要 Passkey？
- **Q3 识别引擎**：Workers AI（推荐，免费额度内），还是接 OpenAI 之类的外部 API（需要你给 key）？
- **Q4 是否升级 Workers Paid（$5/月）**：升级后服务端可跑 KDF/大计算、D1 单库 10 GB、R2 好开；不升级则按本方案的「重计算在浏览器」路线走。
- **Q5 域名**：手上有没有能用的域名？没有的话 Email Routing（M5）和 Passkey 都要往后放。
- **Q6 同事规模与权限**：几个人？要不要「同事能改自己的、不能改别人的」以外的更细粒度（比如只读访客）？

## 8. 「直接写到 SQLite」= 写到哪

D1 数据库本体**就是一个 SQLite 文件**（Cloudflare 托管、单线程、支持事务）。所以「上传后写 SQLite」在本方案里就是 `env.DB.batch([...])` 一次事务写进 D1，不需要另建库。三种拿到真 `.sqlite` 的方式：

| 场景 | 命令 |
|---|---|
| 本地开发（上传功能端到端联调） | `npx wrangler dev --persist-to /tmp/wrangler-persist` → `/tmp/wrangler-persist/v3/d1/miniflare-D1DatabaseObject/*.sqlite` 可直接用 DB Browser 打开 |
| 线上导出快照 | `npx wrangler d1 export myworld --remote --output myworld-$(date +%F).sqlite` |
| 自动备份（M5） | nightly cron：`export` → commit 回 GitHub（README Roadmap 里已有这条） |

时间旅行：Free 档可回滚 **7 天**内的库状态（Paid 30 天）—— 误删数据的第一道保险，但**不能替代**导出快照。
