# PRD 02 · 行程上传与识别入库

> 上游：[方案总览](README.md) · 前置：[PRD 01 用户登录与权限](auth.md)
> 状态：**待评审**

## 1. 目标

让登录用户在 `/admin.html` 里把四类东西变成 D1（= 托管 SQLite）里的行：

| 输入 | 期望产出 |
|---|---|
| 航旅纵横截图 | `flights` 一行（含 delay 计算） |
| 12306 截图 | `rail` 一行（已退票 → `rail_voided`） |
| 邮箱行程单（PDF / 截图 / EML） | `flights` 一行或多行（往返/联程） |
| GPX 文件 | `tracks` 一行 + `track_raw` N 行（N = trkseg 数） |

**核心原则：识别 ≠ 入库。** 所有识别结果先进 `intake` 草稿，人工在表单里确认/修改后才写行程表。理由：这些字段的下游是准点率、里程、足迹统计，一个错字会长期污染口径；而 OCR 对中文密集小字的错误率不可能到 0。

### 非目标

| 不做 | 理由 |
|---|---|
| 自动抓航旅纵横/12306 账号数据 | 无开放接口；逆向登录违反 ToS，且验证码/风控随时变 |
| 自动读取用户邮箱（IMAP 轮询） | 要存邮箱口令，安全面太大；改用 Email Routing 转发（M5） |
| 识别后不经确认直接落库 | 见上「核心原则」 |
| 在 Worker 里解析 GPX / 缩放图片 | 免费档 10 ms CPU 扛不住（最长一条 GPX 光解析+统计就要几十 ms） |
| 支持 KML / TCX / FIT | 现有 `src/geo.mjs` 只吃 GPX；要加就单独排期 |

## 2. 流水线总览

```
浏览器（重计算，无 CPU 限制）                Worker（薄壳，10 ms CPU）              存储
──────────────────────────                ────────────────────────              ────
[GPX]  parseGpx → trackStats →            校验 → 事务 batch 写          ──▶   tracks
       simplifySegments → centerAndZoom                                        track_raw
       → packSegment(gzip+b64)

[图片] canvas 缩放 → base64 data URI  ──▶  转发 env.AI.run(vision)     ──▶   Workers AI
                                          （不自己 base64，省 CPU）
[PDF]  直接上传字节                   ──▶  env.AI.toMarkdown()（免费）  ──▶   文字层提取

[归一化] 词典补全/日期时间规整/         ◀──  返回原始 JSON 文本
        城市解析（复用 data-utils）
[草稿表单] 人工确认/修改              ──▶  校验 → 事务写库 + intake 状态  ──▶   flights/rail
                                                                            intake/audit_log
```

**为什么 base64 要在浏览器做**：2 MB 截图在 Worker 里 `btoa` 要吃掉几 ms CPU，叠加校验就可能撞 10 ms 线；浏览器做完，Worker 只是把字符串透传给 AI 绑定，CPU 近乎为 0。

## 3. 字段映射（识别的验收标准就是这张表）

### 3.1 航旅纵横「行程详情」截图 → `flights`

| 截图字段 | 样例 | 目标列 | 归一化规则 |
|---|---|---|---|
| 航班号 | `MU5137` | `flight_no` | 去空格、大写 |
| 航空公司 | 中国东方航空 | `airline` | **与库里既有 100 条的写法对齐**（下拉候选 + 允许新增），避免「东航/中国东方航空」两种写法并存 |
| 日期 | `03月21日 周六` / `2026-03-21` | `date` | → `YYYY-MM-DD`；截图无年份时按「不晚于今天且最近的匹配日」推断，并在草稿里标黄要求确认 |
| 出发机场 | 杭州萧山T3 | `from_raw` | **保留原文含航站楼**（`parseAirportName` 会拆城市/机场/航站楼） |
| 到达机场 | 北京首都T2 | `to_raw` | 同上 |
| 计划起飞/到达 | 08:00 / 10:20 | `std` / `sta` | `HH:MM`；跨天写 `HH:MM+1` |
| 实际到达 | 10:35 | `ata` | 同上；未落地则留空 |
| 机型 | 波音738 | `aircraft` | 与既有写法对齐（现库里两种写法混用，见 §11 数据治理） |
| 注册号 | B-1234 | `reg` | 大写、补 `B-` 前缀 |
| 舱位 | 经济舱 | `cabin` | |
| 座位 | 32A | `seat` | |
| 票价 | ¥1180 | `price` | 纯数字；无则 `NULL`（**不要**填 0，0 与「未记录」在统计里必须可区分） |
| 经停/备注 | （经停中卫沙坡头） | `note` | 现库约定：经停写在机场名括号里，`parseAirportName` 已支持 |
| — | 计算 | `delay` | `ata − sta`（分钟，负=提前，跨天要处理）；`ata` 为空则 `NULL` |
| — | 会话 | `owner_id` | **只从会话取**，不信请求体 |
| — | 系统 | `source='upload-umetrip'`, `intake_id`, `created_at` | 便于日后按来源审计/回滚 |

### 3.2 12306 截图 → `rail`（**需要给 rail 扩列**）

| 截图字段 | 样例 | 目标列 | 备注 |
|---|---|---|---|
| 车次 | `G7582` | `train` | 首字母决定车型（`TRAIN_KINDS`） |
| 日期 | 2026-05-01 | `date` | |
| 出发站 / 到达站 | 杭州东 / 上海虹桥 | `from_station` / `to_station` | **不带「站」字**，与现库 53 条一致（`parseStationName` 靠 `stationCity` 别名表解析城市） |
| 出发 / 到达时间 | 08:12 / 09:05 | `std` / `sta` | 🆕 **现表没有这两列** |
| 座位 | 05车12A号 | `seat` | `seatKind()` 已能识别 |
| 票价 | ￥156.0 | `price` | 🆕 **现表没有这列** |
| 乘车人 | 张三 | — | 🆕 多用户下 `owner_id` 已表达归属；**默认不采集**（PII），仅当同一账号要替他人记录时才有意义 → 见开放问题 Q7 |
| 状态 | 已支付 / 已退票 / 候补 | — | 「已退票」→ 引导写 `rail_voided`（现库就是这么记未成行的，如 G6539）；「候补」→ 草稿标黄 |

> 扩列必须**追加在数组尾部**：`/api/rail` 现在返回 `[id,date,train,from,to,seat,note]`，`data-utils.js:307` 按下标解构。新增后为 `[…,note,std,sta,price]`，老前端不受影响，新前端才用。

### 3.3 邮箱行程单 → `flights`

行程单有两种形态，走两条不同（成本差很多）的路：

| 形态 | 处理 | 成本 |
|---|---|---|
| **PDF 且有文字层**（航司/携程出的电子行程单绝大多数是） | `env.AI.toMarkdown(pdf)` 抽文本 → 文本模型或正则抽字段 | `toMarkdown` **免费**（不触发模型） |
| PDF 扫描件 / 图片 | 转视觉模型 | 烧 neurons（约 30–210/次） |
| `.eml` 整封邮件 | 浏览器端简单 MIME 解析 → 拆出附件 → 按附件类型分流 | 免费（M5 再做） |

行程单字段与航旅纵横的差异：

| 行程单字段 | 样例 | 目标列 | 额外处理 |
|---|---|---|---|
| 航段 | `HGH → PEK` | `from_raw` / `to_raw` | 🆕 **三字码 → 中文机场名**：`assets/data/airports.js` 现在只有 `cityCoords`（城市词典）和 `stationCity`（火车站别名），**没有 IATA 码表**，要新增 `iataAirport = { HGH:'杭州萧山', PEK:'北京首都', … }`（先按库里出现过的 ~40 个机场建，遇到新机场时草稿里可手填并回写词典） |
| 日期 | `21MAR26` / `2026-03-21` | `date` | 多格式解析，统一到 `YYYY-MM-DD` |
| 航班 / 承运 | `MU5137` | `flight_no` / `airline` | 代码共享航班（如 `MU1234 / 实际 CA`）→ 记实际承运，`note` 里写销售航班号 |
| 舱位 / 座位 | `Y` / `32A` | `cabin` / `seat` | 单字母舱位码 → 映射到中文（`Y=经济舱`），映射表放前端 |
| 票价 / 税费 | `1180.00 + 50` | `price` | **口径要定**：现库 `price` 记的是裸票价还是含税？见开放问题 Q8 |
| 票号 / 证件号 | `781-12345…` | — | **不采集**（PII，无用途） |
| 多航段 | 往返 / 联程 | 多行 | 一次识别产出 N 条草稿，逐条确认 |

### 3.4 GPX → `tracks` + `track_raw`

**直接复用现有构建管线，一行算法都不重写**：

| 步骤 | 复用的源码 | 现在跑在哪 | 上传后跑在哪 |
|---|---|---|---|
| 解析 GPX / 航点 | `src/geo.mjs` `parseGpx` `parseWaypoints` | Node 构建期 | **浏览器**（`assets/js/geo.js` 已是同一份源码的构建产物） |
| 距离/爬升/移动时长 | `trackStats(segments, eleThresholdM)` | Node | 浏览器 |
| 抽稀 / 中心点 / 剖面 | `simplifySegments` `centerAndZoom` `elevationProfile` | Node | 浏览器 |
| 原始点编码 | `src/raw.js` `packSegment`（gzip+b64+sha1） | Node | 浏览器（`assets/js/raw.js`，`CompressionStream` 两边都有） |
| 写库 | 生成 `INSERT` | `seed-*.sql` + `wrangler d1 execute` | `POST /api/admin/tracks` → `env.DB.batch([...])` |

用户只需补 5 个 GPX 里没有的字段：`name`（默认取文件名去扩展名）、`date`（默认取轨迹首点 UTC+8 日期）、`region`（默认按首点反查城市词典，可空）、`kind`（hike/run/race/course，默认 hike）、`toleranceM`（默认按距离自动：≤50 km → 4 m，>50 km → 12 m）；`eleThresholdM` 固定 10 m（与全站口径一致，不暴露给用户改）。

`id` 生成：`<date>-<slug>`（slug 由 name 转拼音/英文，用户可改），冲突时追加 `-2`。`id` 是 `tracks` 主键也是 `track_raw` 外键，必须稳定且唯一。

**「下载精简 GPX」按钮要改造**：现在 `app.js:938` 直接 `<a href="${s.gpx}">` 指向仓库里的静态文件 `gpx/<id>.gpx`，新上传的轨迹没有这个文件。方案：
1. ✅ **已实施（2026-10-26）**：浏览器**从 `track_raw` 现算重建原始精度 GPX**（`unpackParts(parts,{needTime:true})` → `writeGpx` → Blob），与入库几何逐点一致、统计零失真（Node 端到端对拍：8740/14162 点全保留，距离/爬升/移动时长逐位相同）；主按钮「下载 GPX（原始精度）」，精简版降为备选按钮；**零存储、零边缘 CPU**。起因：用户反馈抽稀 GPX 失真（武功山实测距离 −1.9%、爬升 −2.2%、移动时长口径漂移）；
2. 若开了 R2 —— 上传时把精简 GPX 一并 PUT 到 R2，`gpx_key` 存 R2 key，下载走 Worker 302 到预签名 URL；
3. 仓库里的 `gpx/` 61 个文件保留不动（老链接不断），`tools/build-tracks.mjs` 继续服务「批量重建/改口径」的场景。

**原始 GPX 归档**：仓库 `tools/source/` 有 18 MB（最大单文件 2.1 MB）。
- 能开 R2 → 原件放 R2，`tracks.gpx_key` 指过去（推荐）；
- 不能开 R2 → 阶段一**只存 sha256 + 统计**，原件让用户自己留着；或 gzip 后塞 D1（18 MB → 约 5 MB，占免费档 500 MB 单库配额的 1%，能接受但不优雅）；
- M5 的 nightly 快照可以把原件一起 commit 回 GitHub，恢复「git diff 审计」能力。

## 4. 识别通道细节

### 4.1 模型选择

| 用途 | 首选 | 备选 | 理由 |
|---|---|---|---|
| 中文截图（航旅纵横/12306） | `@cf/qwen/qwen3.8-27b`（视觉、262k 上下文、中文强） | `@cf/moondream/moondream3.1-9B-A2B`（主打 OCR/结构化，$0.30/M 便宜） | Qwen 系对中文密集小字最稳；Moondream 便宜快，适合做默认、Qwen 做「重试升级」 |
| 兜底 | `@cf/meta/llama-3.2-11b-vision-instruct` | — | 最便宜（~30 neurons/次），准确率换成本 |
| PDF 文字层 | `env.AI.toMarkdown()` | — | 免费、精确 |
| 文本 → 结构化字段 | `@cf/meta/llama-3.1-8b-instruct-fp8-fast`（**支持 JSON Mode**） | — | 有文字层时完全不必用视觉模型 |

> ⚠️ **JSON Mode 只支持部分文本模型**（官方列表里是 llama-3.x 8b/70b、deepseek-r1-distill-qwen-32b 等），**视觉模型不在列表内**。所以视觉路径要靠「严格 prompt + 容错解析」：要求只输出 JSON、剥 ```` ```json ```` 围栏、`JSON.parse` 失败就重试一次（换模型或加「只输出 JSON」的更强约束）、再失败就转手工录入。
> 另外视觉模型接受 `image: "data:image/jpeg;base64,…"`（2026 年文档口径），不需要老式的 `number[]`。

### 4.2 Prompt 骨架（要点，不是最终文案）

```
系统：你是行程信息抽取器。只输出一个 JSON 对象，不要解释、不要 Markdown 围栏。
      字段缺失就填 null，**绝不猜测或编造**。
      忽略并不要输出：身份证号、手机号、票号、二维码内容、乘车人姓名。
用户：[图片]
      请按 schema 抽取：{ kind: "flight"|"rail", … }
```

输出 schema（前端做校验与归一化，服务端做类型/长度/枚举硬校验）：

```jsonc
{
  "kind": "flight",              // flight | rail | unknown
  "confidence": 0.0,             // 模型自评，低于阈值时草稿标红
  "flight": {
    "flightNo": "MU5137", "airline": "中国东方航空",
    "date": "2026-03-21",
    "fromRaw": "杭州萧山T3", "toRaw": "北京首都T2",
    "std": "08:00", "sta": "10:20", "ata": "10:35",
    "aircraft": "波音738", "reg": "B-1234",
    "cabin": "经济舱", "seat": "32A", "price": 1180,
    "note": "", "uncertain": ["date"]   // 模型自己不确定的字段，草稿里标黄
  }
}
```

### 4.3 归一化在前端做（复用既有代码）

识别出的原文要过一遍前端归一化，**因为这些逻辑已经写好且被 100 段真实航班验证过**：
- `parseAirportName()` / `parseStationName()`：拆城市/机场/航站楼，校验城市是否在 `cityCoords` 里（不在 → 草稿标红提示「新城市，需要补坐标」，否则航迹图会静默画不出来）；
- `parseClock()` / `parseDate()`：`HH:MM+1`、`YYYY-MM-DD` 合法性；
- `delay` 计算：与全站 **A15 准点口径**一致（到达不晚于计划 +15 分钟）；
- 航司名/机型对齐既有写法（下拉候选来自库里 distinct 值）。

### 4.4 去重与幂等

| 层 | 键 | 行为 |
|---|---|---|
| 文件级 | `source_sha256` | 同一张图/同一个 GPX 再传 → 直接返回上次的 `intake`（省 neurons，也防重复识别） |
| 航班 | `(owner_id, date, flight_no)` | 已有 →提示「3 月 21 日 MU5137 已存在」，给「覆盖 / 合并空字段 / 取消」三选 |
| 铁路 | `(owner_id, date, train)` | 同上 |
| 轨迹 | `(owner_id, id)` + `raw` 内容 sha1 | 同一条 GPX 换名重传也能认出来 |

### 4.5 `intake` 状态机

```
draft ──确认──▶ committed（记 committed_ids，可一键回滚删除）
  │
  ├──放弃──▶ discarded
  └──识别失败──▶ failed（保留原图 hash 与错误，一键转手工录入）
```

草稿保留 90 天，`committed/discarded/failed` 的 `ocr_text` 30 天后清空（隐私，见 §7）。

## 5. 数据模型（`migrations/006_ingest.sql`）

```sql
-- 归属与来源：三张行程表统一加列（SQLite 支持带常量默认值的 ADD COLUMN）
ALTER TABLE flights ADD COLUMN owner_id   INTEGER NOT NULL DEFAULT 1;
ALTER TABLE flights ADD COLUMN source     TEXT    NOT NULL DEFAULT 'seed';  -- seed|manual|upload-umetrip|upload-email
ALTER TABLE flights ADD COLUMN intake_id  TEXT;
ALTER TABLE flights ADD COLUMN created_at TEXT;
ALTER TABLE flights ADD COLUMN updated_at TEXT;
ALTER TABLE flights ADD COLUMN created_by INTEGER;

ALTER TABLE rail ADD COLUMN owner_id   INTEGER NOT NULL DEFAULT 1;
ALTER TABLE rail ADD COLUMN std        TEXT;          -- 🆕 12306 有发车时间
ALTER TABLE rail ADD COLUMN sta        TEXT;          -- 🆕 到达时间
ALTER TABLE rail ADD COLUMN price      REAL;          -- 🆕 票价
ALTER TABLE rail ADD COLUMN source     TEXT NOT NULL DEFAULT 'seed';
ALTER TABLE rail ADD COLUMN intake_id  TEXT;
ALTER TABLE rail ADD COLUMN created_at TEXT;
ALTER TABLE rail ADD COLUMN created_by INTEGER;

ALTER TABLE tracks ADD COLUMN owner_id   INTEGER NOT NULL DEFAULT 1;
ALTER TABLE tracks ADD COLUMN source     TEXT NOT NULL DEFAULT 'build';  -- build|upload
ALTER TABLE tracks ADD COLUMN intake_id  TEXT;
ALTER TABLE tracks ADD COLUMN src_sha1   TEXT;        -- 原始 GPX 指纹，去重用
ALTER TABLE tracks ADD COLUMN created_at TEXT;
ALTER TABLE tracks ADD COLUMN created_by INTEGER;

CREATE INDEX IF NOT EXISTS idx_flights_owner ON flights(owner_id, date);
CREATE INDEX IF NOT EXISTS idx_rail_owner    ON rail(owner_id, date);
CREATE INDEX IF NOT EXISTS idx_tracks_owner  ON tracks(owner_id, date);
CREATE UNIQUE INDEX IF NOT EXISTS uq_flights_owner_day ON flights(owner_id, date, flight_no);
CREATE UNIQUE INDEX IF NOT EXISTS uq_rail_owner_day    ON rail(owner_id, date, train);

CREATE TABLE IF NOT EXISTS intake (
  id            TEXT PRIMARY KEY,
  owner_id      INTEGER NOT NULL,
  created_by    INTEGER NOT NULL,
  created_at    TEXT NOT NULL,
  kind          TEXT NOT NULL,     -- umetrip|rail12306|email-pdf|email-image|email-eml|gpx|manual
  source_name   TEXT,
  source_bytes  INTEGER,
  source_sha256 TEXT NOT NULL,
  source_ref    TEXT,              -- R2 key（若归档了原件）；不存原图时为 NULL
  model         TEXT,              -- @cf/qwen/qwen3.8-27b …
  neurons       INTEGER,
  ms            INTEGER,
  ocr_text      TEXT,              -- toMarkdown / 视觉模型原文（30 天后清空）
  draft_json    TEXT NOT NULL,     -- 归一化后的草稿（人工改过的最终版）
  status        TEXT NOT NULL DEFAULT 'draft',   -- draft|committed|discarded|failed
  committed_ids TEXT,              -- JSON: ["flight:123"]
  error         TEXT
);
CREATE INDEX IF NOT EXISTS idx_intake_owner ON intake(owner_id, created_at);
CREATE INDEX IF NOT EXISTS idx_intake_sha   ON intake(source_sha256);
```

**主键分配**：`flights.id` / `rail.id` 是 `INTEGER PRIMARY KEY`（无 AUTOINCREMENT），插入时不给 id → SQLite 取 `max(rowid)+1`，现有 1..100 的 id 不受影响。注意无 AUTOINCREMENT 时**删除后 id 可能被复用**；行程数据几乎不删，可接受，若要严格单调则在 `meta` 里维护计数器。

## 6. API 契约（全部要求登录 + CSRF 头，`owner_id` 只从会话取）

| 方法 | 路径 | 权限 | 入参 | 出参 |
|---|---|---|---|---|
| POST | `/api/admin/extract` | member+ | `{ kind, fileName, mime, dataUri }` 或 multipart（PDF） | `{ intakeId, draft, warnings[], usage }`；429 超配额 |
| GET | `/api/admin/intake?status=&limit=` | member+ | — | 自己的草稿箱（owner 可加 `?all=1`） |
| GET | `/api/admin/intake/:id` | 本人/owner | — | 草稿详情 |
| PATCH | `/api/admin/intake/:id` | 本人/owner | `{ draftJson }` | 204（保存人工修改） |
| POST | `/api/admin/intake/:id/commit` | 本人/owner | `{ strategy:'create'\|'overwrite'\|'merge' }` | `{ committedIds }`；409 重复且未指定策略 |
| POST | `/api/admin/intake/:id/discard` | 本人/owner | — | 204 |
| POST | `/api/admin/tracks` | member+ | `{ meta, parts:[{part,points,gzip_b64,sha1}] }` | `{ id }`；单行 b64 >1.8 MB → 413 |
| POST | `/api/admin/flights` | member+ | 单个或数组（手工录入直连，不经 intake） | `{ ids }` |
| PATCH | `/api/admin/flights/:id` | 本人/owner | 部分字段 | 204 |
| DELETE | `/api/admin/flights/:id` | 本人/owner | — | 204 |
| POST/PATCH/DELETE | `/api/admin/rail[/:id]` | 同上 | 同上 | 同上 |
| POST | `/api/admin/rail-voided` | member+ | `{ train, from, to, date, reason }` | `{ id }` |
| GET | `/api/tracks/:id/gpx` | 公开 | — | 302 到 R2 预签名 URL，或 404（前端回落为浏览器现算） |

**服务端硬校验清单**（不信任客户端，任何一条不过 → 400 且不写库）：
`date` 匹配 `^\d{4}-\d{2}-\d{2}$` 且是真实日期；`std/sta/ata` 匹配 `^\d{2}:\d{2}(\+1)?$`；`price` 为数字或 null（**不接受 0 当未记录**）；字符串长度上限（airline 32、note 200…）；`kind`/`cabin`/`source` 在枚举内；`track_raw` 每行 `gzip_b64` ≤1.8 MB、`part` 从 0 连续、`sha1` 与内容一致（重算校验，防篡改）；一次 `batch` 内语句数 ≤100（超了分片，但**同一轨迹的 tracks + track_raw 必须在同一个 batch 里**，否则半成品数据）。

**事务性**：`tracks` 1 行 + `track_raw` N 行走一次 `env.DB.batch([...])`。D1 的 batch 是 SQL 事务，中途失败整体回滚 —— 这是「上传到一半断网」不会留下残骸的保证。

## 7. 隐私与合规（多用户后必须写清楚）

12306 与行程单截图**含身份证号、手机号、姓名、票号**。约定：

| 数据 | 处理 |
|---|---|
| 原图 | **默认不存**（只存 `sha256` 做去重）；要存就存 R2，且桶不公开、走预签名 URL |
| 身份证号 / 手机号 | prompt 明确要求忽略；`ocr_text` 落库前再过一遍正则打码（`\d{17}[\dXx]` → 前 6 后 4；`1[3-9]\d{9}` → 前 3 后 4） |
| 票号 / 证件号 | 不入库 |
| 乘车人姓名 | 默认不采集（`owner_id` 已表达归属）→ 开放问题 Q7 |
| `ocr_text` | 保留 30 天自动清空 |
| 审计日志 | `detail` 只记 id 与动作，不记字段原值 |
| 同事的数据 | 默认 `public_read=0`，匿名与彼此都看不到；owner 可见（要在开户时告知） |

## 8. 页面与交互（`/admin.html`）

三个 tab，风格与主站一致（深色、零框架）：

1. **录入 / 上传**
   - 一个大拖拽区：拖进来的文件按扩展名+MIME 自动分流（`.gpx` → GPX 通道；`.pdf` → 行程单通道；图片 → 让用户选「航旅纵横 / 12306 / 其他」，也可自动判）；
   - GPX：解析后**先在浏览器里预览**（距离/爬升/用时/点数/地图缩略），确认元数据 5 个字段 → 提交；解析失败（不是 GPX、点数 <2）当场报错，不发请求；
   - 图片/PDF：上传 → 转圈（视觉模型 5–20 s，要给进度与「取消」）→ 出草稿表单；
   - 表单里**低置信/不确定字段标黄，缺关键字段标红**；航司/机型/机场给下拉候选（来自库里 distinct 值）；
   - 「保存草稿」与「确认入库」两个按钮分开，允许改天再确认。
2. **草稿箱**：`intake` 列表（缩略信息 + 状态 + 时间），可继续编辑、确认、放弃；已入库的显示「已写入 flight:123」并可一键回滚。
3. **数据管理**（owner 额外可见用户与审计，见 PRD 01 §6）：按年/来源筛选，行内编辑、删除；显示各来源计数（seed / manual / upload-*），便于回滚整批。

## 9. 验收标准

| # | 验收项 | 判定 |
|---|---|---|
| A1 | **GPX 黄金对拍** | 用 `tools/source/` 全部 61 个 GPX 走「上传通道」，产出的 `tracks` 行与 `seed-tracks.sql`、`track_raw` 行与 `seed-raw.sql` **逐字节一致**（写 `tools/test-upload-parity.mjs` 自动比） |
| A2 | 上传后展示 | 新轨迹在列表/详情/地图/海拔剖面/统计里全部正常；「下载精简 GPX」可用 |
| A3 | 识别评测集 | 10 张真实样本（航旅纵横 ×5、12306 ×3、行程单 PDF ×2）：关键字段（航班号/日期/机场或站名/时间）准确率 **≥95%**，其余字段 ≥80%，失败可一键转手工 |
| A4 | 去重 | 同一张图重复上传不再调用模型；同一天同航班号二次确认时给出覆盖/合并选择 |
| A5 | 事务 | 上传 14000 点的 GPX（`忻州五台山逆朝.gpx`，2.1 MB）中途 kill 掉 Worker，库里不留半成品 |
| A6 | 配额 | member 超过 `daily_ai_quota` 得 429 且中文提示；`usage_daily` 数字与 Workers AI 面板量级一致 |
| A7 | 边缘 CPU | 每条上传/识别路径在 `wrangler dev` 日志里 CPU <10 ms（AI 等待时间不计入 CPU） |
| A8 | 多用户隔离 | 同事上传的航班不出现在你的统计里；你的公开页面数字与改造前一致 |
| A9 | 免费额度 | 连续 3 天正常使用不触顶：D1 写 <100k 行/天、Workers AI <10k neurons/天、D1 单库 <500 MB |

## 10. 实施顺序（对应总览 M2–M5）

1. **M2 先做手工录入**（`POST /api/admin/flights|rail` + 表单）—— 不含任何 AI，就能让同事开始录数据，也是识别通道的兜底。
2. **M3 GPX 通道** —— 纯确定性逻辑，先拿 A1 黄金对拍建立信心。
3. **M4 识别通道** —— 第一步是**只做评测**：写 `tools/eval-extract.mjs`，拿你的 10 张真实截图跑 3 个模型，比准确率与 neurons，再定默认模型；然后才接 UI。
4. **M5 邮件自动接入 + R2 归档 + 快照备份**。

## 11. 风险与已知数据治理问题

| 风险 | 影响 | 缓解 |
|---|---|---|
| 视觉模型对中文小字出错 | 脏数据进库 | 草稿确认（§1）+ 低置信标红 + 评测集门槛 A3 |
| 手机截图分辨率过高被模型内部缩放 | 小字糊掉、识别率崩 | 浏览器端**不要**过度缩小：长边 ≤2000 px、JPEG q0.92；必要时提供「框选裁剪」再识别 |
| `toMarkdown` 对图片会强制缩到 1280×720 | 密集中文不可读 | **图片不走 `toMarkdown`**，直接调视觉模型；`toMarkdown` 只用于 PDF/HTML |
| JSON Mode 不支持视觉模型 | 输出不是合法 JSON | 剥围栏 + 重试 + 失败转手工（§4.1） |
| 免费 neurons 被一个人刷光 | 其他人当天不能识别 | `daily_ai_quota` + `usage_daily`（PRD 01 §4） |
| D1 免费档写超额直接失败（2026-09-01 起生效） | 上传报错 | 单次上传写行数极少；`usage_daily` 计数 + 429 提前拦 |
| R2 开通可能要绑卡 | 原件无处归档 | 阶段一不存原件；M5 再决定 |
| **现库字段写法不统一**（`aircraft` 混用「波音738/B738」，航司名多种写法） | 识别结果与老数据对不齐，统计口径裂开 | 录入表单给**库里 distinct 值**做下拉候选；M4 顺手做一次字典统一 |
| **`price` 口径未定义**（裸票价 vs 含税） | 票价统计不可比 | 开放问题 Q8，定下来写进 README「数据口径」表 |
| 新城市/新机场不在词典里 | 航迹图静默画不出、里程算不出 | 草稿里强制校验 `cityCoords` 命中，未命中标红并要求先补词典（`assets/data/airports.js`） |

## 12. M5 草图 · 邮箱行程单自动接入

```
你的邮箱 ──转发──▶ trip@<你的域名>
                     │ Cloudflare Email Routing（免费，单封 ≤25 MiB）
                     ▼
              Email Worker（同一个 Worker 加 email() handler）
                     │ 解析附件：PDF → toMarkdown；图片 → 视觉模型
                     ▼
                 intake 草稿（owner_id = 由收件地址/发件人映射）
                     │
                     ▼
        飞书/微信通知你「有 1 条新草稿」→ 打开 /admin.html 确认
```

前提：**自有域名**（Email Routing 不能挂在 `workers.dev` 上）+ 发件人白名单（只认航司/OTA 域名，防陌生人投喂）+ 通知通道（发件要 Paid，所以用飞书 webhook 或 Server酱之类的外部通知，不走邮件）。

## 13. 开放问题（补充总览 Q1–Q6）

- **Q7 乘车人**：一个账号要不要能替他人记录行程（比如你帮同事录、或记录家人）？要的话 `flights/rail` 加 `passenger` 列，否则不加（少一列 PII）。
- **Q8 `price` 口径**：裸票价还是含税总价？现库 100 段航班是哪种？定下来我写进 README 的「数据口径」表，识别与手工录入都按这个口径。
- **Q9 是否接受「同事看得到彼此的数据」**：默认**看不到**（各自私有，你作为 owner 可见）。如果你们其实是一个团队共享行程池（比如出差协调），那数据隔离方案要改成「共享 + 记录创建者」，这是总览 Q1 的另一半。
- **Q10 老数据归属**：现有 100 段航班 / 53 段铁路 / 61 条轨迹全部 `owner_id=1`（你）并保持公开，对吗？
