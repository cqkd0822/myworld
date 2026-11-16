# PRD 04 · 大事记

> 上游：[方案总览](README.md) · 前置：[PRD 01 用户登录与权限](auth.md) · 相关：[PRD 02 上传与识别入库](ingest.md) · 视觉约束：[对齐规格](../design/alignment-spec.md)
> 状态：**待评审** · 本文件只做设计，不含实现

## 1. 目标与范围

给 MyWorld 增加「自己写大事记」的能力：

- 把人生/旅行/工作中的关键节点写成结构化记录，**直接写入 Cloudflare D1**（托管 SQLite）；
- 公开站点多一个「大事记」时间线视图，和航班、铁路、足迹并列为第 5 个主 tab；
- 记录可以关联已有航班/铁路/轨迹，让「事件 → 证据行程」可互相跳转；
- 阶段一先用现有 `ADMIN_TOKEN` 通道写入；未来接 PRD 01 的 owner/member 权限后，同一张表可平滑升级为多用户归属。

### 非目标（本轮明确不做）

| 不做 | 理由 |
|---|---|
| 图片/附件 | R2 暂搁置；D1 存图吃 500 MB 配额，且会引入内容审核/隐私面。P2 再接 R2 |
| 富文本编辑器 | 事件说明应以可读、可版本追踪为重；P0 用受限 Markdown 纯文本 |
| 评论/协作/点赞 | 这是个人记录，不是社交系统 |
| 自动从行程生成事件 | 自动摘要容易伪造记忆；先保留「人写，行程只做证据」 |
| 全文搜索引擎 | D1 LIKE + 降序分页在千级记录内够用；无需引入额外索引服务 |
| 事件级权限（公开/私密逐条控制） | 会把缓存和统计搞复杂。P0 假定大事记全部公开；如需私密字段，P1 一起接 owner_id 后再评估 |

## 2. 数据模型

### 2.1 设计原则

- **事件是第一等实体**，不要塞进 `flights.note` 或 `tracks.note`：note 只描述单段行程，大事记描述跨行程、跨时间的人生节点；
- **关联关系单独建表**，而不是在 `chronicles` 里放三个可空列（flight_id/rail_id/track_id）：
  - 一条「第一次进藏」可以同时关联 2 个航班 + 1 条轨迹，单独表可以表达多对多；
  - 未来加「关联城市/相册/文章」时，不需要继续给主表加宽；
  - 删除航班/铁路/轨迹时不级联删除事件，只把关联行清掉，事件本身仍是有效记忆。
- **软删除 + created/updated 时间戳**：这是记忆型数据，宁可可恢复，不做物理 DELETE；
- **版本不改**：P0 只保留 updated_at，不做完整版本历史；需要审计时先走 `audit_log` 规划。

### 2.2 `migrations/007_chronicles.sql` 草案

```sql
-- 大事记：人工撰写的人生/旅行/工作关键节点。
-- date/date_to 的精度见 PRD §6：YYYY / YYYY-MM / YYYY-MM-DD 三种合法格式，
-- 不存伪日期；排序时按年份、月份、日降序，缺月日视为当期最早。
CREATE TABLE IF NOT EXISTS chronicles (
  id            TEXT PRIMARY KEY,             -- 短 slug，如 2015-first-flight
  occurred_at   TEXT NOT NULL,                -- YYYY / YYYY-MM / YYYY-MM-DD
  occurred_to   TEXT,                         -- 可空；范围事件结束日期，同上三种精度
  title         TEXT NOT NULL,
  body          TEXT NOT NULL DEFAULT '',     -- 受限 Markdown，纯文本存储
  category      TEXT NOT NULL DEFAULT 'life', -- life/travel/work/milestone/other
  importance    INTEGER NOT NULL DEFAULT 2,   -- 1=普通 2=重要 3=重大；仅影响视觉权重
  place         TEXT,                         -- 自由文本地名；P0 不绑坐标，避免维护词典
  source        TEXT,                         -- 手写来源/出处说明
  is_hidden     INTEGER NOT NULL DEFAULT 0,   -- 软删除/临时隐藏；1=公开 API 不返回
  owner_id      INTEGER,                      -- P0 预留为 NULL；接 PRD 01 后必填
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chronicles_date ON chronicles(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_chronicles_category ON chronicles(category);

-- 事件 ↔ 行程/轨迹 多对多关联。
-- entity_type: flight / rail / track；entity_id 分别对应三张表主键。
-- 不加 FOREIGN KEY：D1 对跨表多态外键本来无法表达；删除行程时由应用先清关联再删主行。
CREATE TABLE IF NOT EXISTS chronicle_links (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  chronicle_id TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('flight','rail','track')),
  entity_id   TEXT NOT NULL,                  -- flight/rail 为数字字符串，track 为 slug
  note        TEXT DEFAULT '',                -- 例如「去程」「越野赛当天的轨迹」
  created_at  TEXT NOT NULL,
  UNIQUE (chronicle_id, entity_type, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_chronicle_links_chronicle
  ON chronicle_links(chronicle_id);
CREATE INDEX IF NOT EXISTS idx_chronicle_links_entity
  ON chronicle_links(entity_type, entity_id);
```

### 2.3 字段取舍

| 字段 | 取舍 |
|---|---|
| `id` 用文本 slug | URL 可读、可分享；生成规则 `YYYY-slug`，重名加 `-2`。比 UUID 更适合个人站，不暴露写入量 |
| `occurred_at` 存三种精度 | 不把「只知道 2015 年」伪造成 `2015-01-01`；渲染时如实显示「2015」 |
| `importance` 只做 1–3 | 记忆是主观的，5 星/10 分会制造无意义焦虑；只影响左侧时间轴视觉强度 |
| `place` 自由文本 | 现有城市/机场词典面向行程，不含人生事件；P0 不做坐标与地图渲染 |
| `owner_id` 预留 | P0 你一个人写，`NULL=公开/默认所有者`；接登录后补迁移设默认 1 |
| 不存 `views/likes` | 大事记是记录不是内容运营 |
| 不存图片 | 见非目标；将来 R2 开通后加 `media` 表，而不是改主表 |

## 3. 写入通道与鉴权

### 3.1 阶段一：ADMIN_TOKEN（可先上线）

沿用现有 Worker 的管理壳子：

```
POST /api/admin/chronicles
PUT  /api/admin/chronicles/:id
DELETE /api/admin/chronicles/:id
```

- 请求头必须带 `x-admin-token: <ADMIN_TOKEN>`；
- 没配置 `ADMIN_TOKEN` 时一律 401，延续「宁可不可用，也不能裸奔」；
- 写操作不进 Service Worker 缓存，响应 `cache-control: private, no-store`；
- 成功后使 `/api/chronicles` 的列表 ETag 变化，前端用现有 SWR 机制自动刷新。

**边界**：ADMIN_TOKEN 是「全权令牌」，适合只有你一个人录入。它无法区分「谁能写谁的事件」，也不适合发给同事。只要第二个人开始写，就必须切到 PRD 01 的会话方案。

### 3.2 阶段二：多用户归属

接 PRD 01 后：

- `chronicles.owner_id` 必须从会话取，**永远不信请求体 owner_id**；
- owner/member 写自己的；viewer 只读；
- 匿名访问只返回 `owner.public_read=1` 的 owner 的事件，逻辑与航班/铁路/轨迹一致；
- `chronicle_links` 只能关联自己可见的实体，防止用链接 ID 探测别人的私有行程；
- 写操作写 `audit_log`，字段与 ingest PRD 一致。

**迁移注意**：在启用多用户前先执行一条 `UPDATE chronicles SET owner_id=1 WHERE owner_id IS NULL`，再把列改为 `NOT NULL`。不要一上来就把列设死，避免 P0 数据无法迁移。

## 4. API 契约

公开读接口与现有 `/api/*` 风格一致：数组、降序、轻元数据；详情不需要单独拉正文，列表一次性下发即可（千级以内体积可控）。

### 4.1 公开读

| 方法 | 路径 | 返回 |
|---|---|---|
| GET | `/api/chronicles` | 事件数组，按 occurred_at/date/id 降序；默认排除 `is_hidden=1`；带 links 摘要 |
| GET | `/api/chronicles/:id` | 单个事件 + 完整 links；404 处理 is_hidden 与不存在一致 |

列表元素形状（草案）：

```json
{
  "id": "2026-first-100k-race",
  "occurredAt": "2026-03-21",
  "occurredTo": null,
  "title": "完成第一场 100 公里越野赛",
  "body": "……",
  "category": "milestone",
  "importance": 3,
  "place": "江西 · 萍乡",
  "source": "完赛证书",
  "links": [
    { "type": "track", "id": "2026-03-21-...", "name": "武功山两日穿越", "note": "当天轨迹" },
    { "type": "rail",  "id": "57", "name": "G1510 黄山北 → 杭州东", "note": "返程" }
  ],
  "createdAt": "2026-11-16T10:00:00.000Z",
  "updatedAt": "2026-11-16T10:00:00.000Z"
}
```

- `links` 在公开列表里只带 `type/id/name/note`，不带行程完整统计，避免响应膨胀；
- ETag 由 `MAX(updated_at) + COUNT(*) + links 指纹` 组成，写后自动失效缓存；
- `cache-control: public, max-age=300`，与既有列表一致。

### 4.2 管理写（阶段一）

| 方法 | 路径 | 输入 | 行为 |
|---|---|---|---|
| POST | `/api/admin/chronicles` | event + links | 校验 slug/日期/标题；事务写主表和 links |
| PUT | `/api/admin/chronicles/:id` | 完整对象 | 事务替换：先 update 主表，delete 旧 links，再 insert 新 links |
| DELETE | `/api/admin/chronicles/:id` | — | 软删除 `is_hidden=1`；不物理删除 |

**校验规则**：

- `occurred_at/occurred_to` 必须匹配 `YYYY`、`YYYY-MM`、`YYYY-MM-DD`；后者不得早于前者；
- `title` 1–120 字；`body` ≤20,000 字；`category` 白名单；`importance` 1–3；
- `links` ≤32 条；`entity_type` 白名单；`entity_id` 必须存在对应表；
- `id` 只允许 `[a-z0-9-]`，1–80 字符，且不能与现存/隐藏事件冲突；
- Markdown 允许段落、粗体、斜体、链接、无序列表、引用；图片/HTML/脚本一律拒绝或转义。

### 4.3 错误格式

```json
{ "ok": false, "error": "occurred_to 早于 occurred_at" }
```

保持 Worker 现有简洁风格；不做 field-level errors。表单端拿到中文错误直接展示。

## 5. 前端信息架构

### 5.1 导航与路由

- 主导航从 4 个 tab 变 5 个：`概览 / 飞行 / 铁路 / 足迹 / 大事记`；
- 新路由：
  - `#/chronicles`：时间线列表；
  - `#/chronicle/:id`：事件详情；
- `app.js` 的 `TABS` 增加 key `chronicles`；路由解析在 `/^#\/chronicles/` 分支处理；
- 事件详情标题格式：`事件标题 · 大事记 · MyWorld`；
- 不新增独立 `chronicles.html`，继续复用单页静态架构。

### 5.2 列表视图：时间线

```
E1                 E2
│  2026 ──────────────────────────────  12 条
│
│  03-21  ● 完成第一场 100 公里越野赛       milestone
│          江西萍乡 · 关联 1 条轨迹
│  02-10  ○ 换工作到杭州
...
```

- 年份组头沿用现有 `year-head` 吸顶体系；
- 左侧时间轴用 4px 网格：普通事件圆点 8px，重要/重大事件分别 10/12px，不引入新尺寸；
- 日期列使用 `font-variant-numeric: tabular-nums`，精度不足时只显示 `2026-03` 或 `2026`；
- 分类用现有 tag（20px 高、6px 圆角），重要性通过圆点/边线强度表达，不加五颜六色新色相；
- 搜索支持标题/正文/地点；chips 支持 `全部/life/travel/work/milestone/other`；
- 桌面 ≥1000px 落 R4 双列卡片：左列时间轴，右列正文摘要，列宽 512 + gap 16；
- 手机复用 M1 单条 chips 横滚、控制簇吸顶，时间轴缩为 12px 左轴，不挤压正文。

### 5.3 详情视图

- 顶部：日期（含范围）+ 标题 + category tag + place；
- 正文按受限 Markdown 渲染（浏览器端纯函数，不用 Worker 算）；
- 「相关行程」区域按 flight/rail/track 分组：
  - rail 显示 `G1510 黄山北 → 杭州东 · 2026-10-31`；
  - track 显示名称、距离、爬升，并链接 `#/track/:id`；
  - flight 显示航班号、机场、日期；
- 底部 `返回大事记` 使用现有 ghost button；主操作 48px 行高；
- 不放编辑按钮：P0 编辑入口在独立管理页（见 5.4），公开详情保持只读。

### 5.4 录入入口（阶段一）

- 新建 `admin.html` 时，在表单区增加「大事记」类型；
- 若暂不做完整 admin 页，可以先做一个极简 `chronicle-admin.html`：
  - 表单字段：slug（可自动生成）、日期/结束日期、标题、分类、重要度、地点、正文、关联实体；
  - 关联实体用三个搜索框（航班/铁路/轨迹）选择，不要求手填 ID；
  - token 只在内存中，不写 localStorage；
  - 保存成功后提示并打开 `#/chronicles`。
- 该页面本身公开可下载，但所有写请求都带 token 才能执行。

## 6. 数据口径与边界

| 主题 | 口径 |
|---|---|
| 日期精度 | 只存真实已知精度；排序键由 Worker/前端把 `YYYY` 归一为 `YYYY-00`、`YYYY-MM` 保持原值，渲染不显示伪月/伪日 |
| 时间 | 事件不带具体时刻。人生节点通常只有日期；需要时刻时写进 body |
| 正文 | 受限 Markdown 纯文本；服务端存储原文，渲染在浏览器；禁止 HTML/脚本/外链图片 |
| 链接 | Markdown 链接只允许 `https:`，文本长度 ≤200 字符 |
| 关联 | 多对多；同一实体可被多个事件关联；删除行程不删事件 |
| 隐藏 | `is_hidden=1` 从公开 API/前端/统计移除；管理接口仍可见可恢复 |
| 统计 | 首页暂不把大事记计入 hero 总量；只加一个小计 `大事记 N 条`，避免「轨迹里程/票价」这类口径混入 |
| 语言 | 标题/正文中文优先；不做 i18n |
| ID 稳定性 | slug 一旦发布不改；确需改名时保留旧 slug 301/前端别名映射，P1 再做 |

## 7. 迁移与部署顺序

1. 提交 `migrations/007_chronicles.sql`；
2. 本地 `wrangler d1 execute myworld --local --file=migrations/007_chronicles.sql`；
3. 线上先执行 migration，再部署 Worker（旧 Worker 只是不认识新表，不受影响）；
4. 初始数据先通过 `wrangler d1 execute --remote` 或管理 API 手工导入；
5. 前端 `/api/chronicles` 接入现有启动加载与 SWR；
6 `README.md` 的表结构/API 图更新为 8 张表 + 新路由。

> 编号说明：现有 migrations 到 `006_rail_times.sql`，下一个是 `007_chronicles.sql`。PRD 01/02 草案中提到 auth/ingest 的未来编号应在实际实施时统一重排，避免 `006` 冲突；本 PRD 以当前仓库实际文件为准。

## 8. 验证清单

- [ ] 日期三精度排序：`2026`、`2026-03`、`2026-03-21` 混排后顺序正确，页面不显示伪日期；
- [ ] 范围事件渲染 `2025-12-28 至 2026-01-02`；
- [ ] 新建事件 + 3 条关联后，列表/详情/被关联轨迹详情都能互相跳转；
- [ ] 删除一条轨迹后，事件仍在，links 少一条，无 500；
- [ ] `is_hidden=1` 时公开 API 返回不含该行，管理接口仍能恢复；
- [ ] Markdown XSS 用 `<script>`、`javascript:` 链接、图片语法各打一发，输出均为纯文本/被拒绝；
- [ ] 无 token/错 token 写入返回 401，且没有 D1 写行；
- [ ] 写入后列表 ETag 改变，前端 focus/刷新能拿到新数据；
- [ ] `/api/health` 增加 chronicles 计数，且 README 数字一致；
- [ ] 390×844 与 1440×900 截图通过：E1/E2 边缘、4pt 间距、20/32/40 控件高度、11/12/13/15/17/20 字阶全部不回归；
- [ ] 手机横滚 chips、年份组头吸顶、详情主操作 48px 可点。

## 9. 分期实施建议

| 阶段 | 范围 | 不做 | 估时 |
|---|---|---|---|
| **P0 最小闭环** | 007 迁移 + 公开列表/详情 + ADMIN_TOKEN CRUD + 极简录入页 + 主 tab 时间线 | 图片、多人、编辑版本 | 1 天 |
| **P1** | 接 PRD 01 会话与 owner_id；admin 页统一；轨迹/航班/铁路详情反向显示「相关大事记」 | 自动生成事件 | 0.5–1 天（依赖 auth） |
| **P2** | R2 图片附件、私密事件、导入导出 JSON、事件地图（place 坐标化）、RSS/年度回顾 | 社交功能 | 按需 |

## 10. 需要用户确认的问题

- **Q1 内容边界**：大事记只记旅行/运动，还是也允许工作与人生节点？分类白名单按 `life/travel/work/milestone/other` 可以吗？
- **Q2 首页位置**：新增第 5 个主 tab，还是先放在概览页的一个 section（导航更克制）？推荐主 tab。
- **Q3 公开性**：所有事件默认公开吗？要不要 P0 就加 `is_hidden` 管理隐藏？
- **Q4 正文格式**：接受受限 Markdown 吗？如果只写短句，纯文本更简单，但长叙事可读性差。
- **Q5 日期精度**：需要支持「只知道年份/月份」的模糊日期吗？推荐支持，且不伪造成完整日期。
- **Q6 关联关系**：一条事件需要关联多条航班/铁路/轨迹吗？推荐支持多对多。
- **Q7 录入口**：P0 先做独立极简 `chronicle-admin.html`，还是等 auth/admin 一起做统一后台？前者能当天上线，后者更整齐。
