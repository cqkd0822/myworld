# PRD 01 · 用户登录与权限

> 上游：[方案总览](README.md) · 下游：[PRD 02 上传与识别入库](ingest.md)
> 状态：**待评审**

## 1. 目标

给 MyWorld 加一套「几个人能用」的身份体系：

- 你（owner）能建号、停用、重置口令、看审计；
- 同事（member）能登录、上传/维护**自己的**行程与轨迹；
- 访客（viewer）能登录只看；
- 不登录的人看到的仍然是**你的公开数据**（站点现状不变，链接照样能分享）。

### 非目标（明确不做）

| 不做 | 理由 |
|---|---|
| 自助注册 | 开放注册 = 陌生人能写库；改为 owner 发邀请链接 |
| 邮件找回密码 | Cloudflare 发件要 Workers Paid；改用 owner 一键生成重置链接 |
| OAuth / 微信 / 企业微信扫码登录 | 小团队不值当，且引入外部依赖 |
| 细粒度权限矩阵（按表、按字段） | 三档角色够用，权限矩阵一旦爆炸就没法维护 |
| 双因子 TOTP | Passkey（M5）本身就是强 MFA，不叠加 |

## 2. 角色模型（三档，不多不少）

| role | 能看 | 能写 | 用户管理 | 说明 |
|---|---|---|---|---|
| `owner` | 全部用户的数据 | 全部数据 | ✅ | 只有你，1 人 |
| `member` | 自己的数据 | 自己的行程/铁路/轨迹 | ❌ | 同事，受每日配额约束 |
| `viewer` | 自己的数据（可能为空） | ❌ | ❌ | 只读，给想看但不录的人 |
| *(匿名)* | `users.public_read=1` 的用户数据 | ❌ | ❌ | 现在的公开站点 |

> 不设 `editor`：「能改别人的但不能删」这种中间态在 4 个人的系统里只会制造误解。owner 想让别人代录，就把那人设成 owner 之外唯一可写自己数据的 member，需要代录时你直接改。

## 3. 认证方案

### 3.1 为什么口令 KDF 必须放浏览器

Workers **免费档每次调用只有 10 ms CPU**。实测口径（Cloudflare 社区多个案例）：PBKDF2-SHA256 十万级迭代要 50–150 ms CPU，240k 迭代会被运行时直接拒绝（"CPU time limit exceeded"）。所以「服务端 PBKDF2」在免费档**跑不起来**。

三条出路：

| 方案 | 可行性 | 结论 |
|---|---|---|
| 服务端低迭代 PBKDF2（1–10k） | 勉强能跑，但抗离线爆破能力差 | ❌ 不拿安全换 CPU |
| 升级 Workers Paid（$5/月，30 s CPU） | 完全可行 | ⏳ 作为将来选项，`users.kdf` 字段预留迁移 |
| **浏览器做 KDF，服务端只做一次快速哈希** | 浏览器没有 CPU 限制，PBKDF2 210k 次约 100–200 ms | ✅ **本方案采用** |

### 3.2 口令方案（pre-hash 模式，安全性论证写在下面）

```
浏览器                                        Worker + D1
──────                                        ───────────
1. 用户输入 password
2. dk = PBKDF2-SHA256(password, salt, 210000, 32B)
3. POST {username, dk}  ───────────────────▶  4. verifier = SHA-256(dk ‖ PEPPER)
                                              5. 恒定时间比对 users.verifier_b64
                                              6. 建会话 → Set-Cookie
```

- `salt`：每用户 16 字节随机，**公开**（登录前先 `GET /api/auth/salt?u=`；用户名不存在时返回一个固定假 salt 并走完整假校验，避免用户名枚举与时序侧信道）。
- `PEPPER`：`AUTH_PWD_PEPPER`，放 `wrangler secret`（本地 `.dev.vars`），**不进仓库、不进 D1**。
- 存库的是 `verifier = SHA-256(dk‖pepper)`，不是 `dk`。

**这样安全吗？** 是。关键在于 `dk` 本身是 32 字节高熵值（PBKDF2 的输出），对它做一次快速哈希**不存在**「低熵口令被离线爆破」的问题 —— 攻击者即使同时拿到 D1 备份和 pepper，也只能对 2^256 空间做暴力枚举。KDF 的 21 万次迭代真正防御的是「人类低熵口令」，而这个计算已经发生在浏览器里了。这就是标准的 pre-hashing 组合（同 Passlib 的 `pbkdf2 + bcrypt`、以及 WebAuthn 里「客户端算、服务端验」的思路）。

**残余风险（要诚实写出来）**：`dk` 等价于「口令等价物」，谁截获 `dk` 谁就能登录。缓解：全程 HTTPS；`dk` 不落盘不进日志；会话 token 与 `dk` 无关且可吊销；改密即吊销全部会话。

**迁移路径**：`users.kdf` 存算法标识（如 `pbkdf2-sha256-browser-210k`）。将来升级到 Paid 后，可以在用户下次登录时把 `dk` 当输入、由服务端再做一次 Argon2id/PBKDF2 并重写 `verifier`，用户无感。

### 3.3 会话

| 项 | 设计 |
|---|---|
| token | `base64url(crypto.getRandomValues(32))`，与口令无关 |
| 存储 | D1 `sessions` 表存 **`SHA-256(token)`**（库被拖走也不能直接 hijack） |
| Cookie | `mw_session=<token>; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`（30 天） |
| 每请求开销 | 1 次 SHA-256（微秒级）+ 1 次 D1 索引查询 → **10 ms CPU 内毫无压力** |
| 滑动续期 | `last_seen_at` 距上次更新 >24 h 才写一次（省 D1 写额度：免费档 100k 行/天） |
| 吊销 | 本人「退出」、owner「踢会话」、改密后清空该用户全部会话 |
| 过期清理 | 登录时顺手 `DELETE FROM sessions WHERE expires_at < now`（不引 cron） |

### 3.4 Passkey（M5 加固，非必需）

WebAuthn 在这个场景里格外合适：**验证只是一次 ECDSA/Ed25519 签名校验，CPU <1 ms**，天然符合免费档限制，而且不存任何口令等价物。做法：已登录用户在 `/admin` 里「添加通行密钥」，之后登录页出现「用通行密钥登录」。需要稳定的域名（origin 绑定），所以排在 M0 绑域名之后。

### 3.5 备选：Cloudflare Access（0 代码过渡方案）

如果目标是「今天就把同事放进来」，可以先不写登录：

- Zero Trust **Free 档 ≤50 用户免费**；在 Workers 面板给 `myworld` 开 Access（可只保护 `/admin` 这个路径，公开站点不受影响）；
- 同事用邮箱一次性验证码登录，Cloudflare 托管登录页与会话；
- Worker 里读 `CF-Access-Authenticated-User-Email`（或用 `ctx.access` / 校验 `CF-Access-JWT-Assertion`）→ 映射到 `users` 表拿 role 与 owner_id。

**代价**：登录页是 Cloudflare 的英文页；身份体系依赖 Zero Trust；`users` 表要以 email 为主键映射；本地 `wrangler dev` 调试要伪造头。
**建议**：只在「域名还没好、但你急着让同事录数据」时用它当脚手架，正式方案仍是 §3.2。两套身份**不要并存**。

## 4. 数据模型（`migrations/005_auth.sql`）

```sql
CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY,
  username       TEXT NOT NULL UNIQUE,        -- 登录名，小写 ASCII
  display_name   TEXT NOT NULL,               -- 页面显示名（可中文）
  email          TEXT,                        -- 仅通知/辨识用，不用于登录
  role           TEXT NOT NULL DEFAULT 'member',   -- owner | member | viewer
  kdf            TEXT NOT NULL DEFAULT 'pbkdf2-sha256-browser-210k',
  salt_b64       TEXT NOT NULL,               -- 16B，公开
  verifier_b64   TEXT,                        -- SHA-256(dk‖pepper)；邀请中为 NULL
  invite_hash    TEXT,                        -- 一次性邀请码的 SHA-256；用完置 NULL
  invite_expires TEXT,
  passkey_cred   TEXT,                        -- M5：WebAuthn credential id（JSON）
  public_read    INTEGER NOT NULL DEFAULT 0,  -- 1 = 匿名可见（你的账号）
  active         INTEGER NOT NULL DEFAULT 1,
  daily_write_quota INTEGER NOT NULL DEFAULT 200,   -- 行/天
  daily_ai_quota    INTEGER NOT NULL DEFAULT 50,    -- 次识别/天
  created_at     TEXT NOT NULL,
  last_login_at  TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,              -- 随机 16B hex，仅用于列表/踢出
  token_hash   TEXT NOT NULL UNIQUE,          -- SHA-256(cookie token)
  user_id      INTEGER NOT NULL,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  ip           TEXT,
  ua           TEXT,
  revoked_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS login_attempts (
  key          TEXT PRIMARY KEY,              -- "u:<username>" 与 "ip:<ip>" 两类
  fails        INTEGER NOT NULL DEFAULT 0,
  first_fail   TEXT,
  locked_until TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      TEXT NOT NULL,
  user_id INTEGER,
  action  TEXT NOT NULL,   -- login.ok | login.fail | logout | pwd.change | flight.create |
                           -- flight.update | flight.delete | rail.* | track.upload |
                           -- extract.run | user.create | user.disable | user.reset | session.revoke
  target  TEXT,            -- 受影响对象，如 "flight:123" / "user:4"
  detail  TEXT,            -- JSON，**必须已脱敏**（不含口令/dk/token/身份证号）
  ip      TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);

-- 配额计数（按天一行，写入极少）
CREATE TABLE IF NOT EXISTS usage_daily (
  user_id  INTEGER NOT NULL,
  day      TEXT NOT NULL,                     -- YYYY-MM-DD (UTC+8)
  writes   INTEGER NOT NULL DEFAULT 0,
  ai_calls INTEGER NOT NULL DEFAULT 0,
  neurons  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
```

> `owner_id` 加在 `flights/rail/tracks` 上的语句写在 [PRD 02 §6](ingest.md) 的 `006_ingest.sql` 里，两个迁移一起上。

## 5. API 契约

统一约定：
- 认证态接口响应一律 `cache-control: private, no-store`（**不能** `public`，否则 SW/CDN 会把 A 的数据缓存给 B）；
- 认证态接口**不发** CORS 头（同源即可；现有 `JSON_HEADERS` 里的 `access-control-allow-origin: *` 要按路径收窄，带凭据的接口绝不能用 `*`）；
- 所有写接口要求 `x-mw-csrf: <token>`（`/api/me` 下发）+ `Origin` 同源校验，双保险叠加 `SameSite=Lax`；
- 错误统一 `{ ok:false, error:'<code>', message:'<中文可读>' }`，HTTP 码：400 参数、401 未认证、403 越权、404、409 冲突（重复）、423 锁定、429 超配额、500。

| 方法 | 路径 | 权限 | 入参 | 出参 |
|---|---|---|---|---|
| GET | `/api/auth/salt?u=` | 公开 | username | `{ salt, kdf, iterations }`（不存在也给假值） |
| POST | `/api/auth/login` | 公开 | `{ username, dk }` | 204 + `Set-Cookie`；失败 401；锁定 423 |
| POST | `/api/auth/logout` | 登录 | — | 204 |
| GET | `/api/me` | 登录 | — | `{ user:{id,username,displayName,role,publicRead}, csrfToken }`；未登录 401 |
| POST | `/api/auth/setup-password` | 持邀请码 | `{ code, dk }` | 204（激活账号并直接登录） |
| POST | `/api/auth/change-password` | 登录 | `{ dkOld, dkNew }` | 204 + 吊销其他会话 |
| GET | `/api/auth/sessions` | 登录 | — | 自己的会话列表（id/created/ip/ua/current） |
| DELETE | `/api/auth/sessions/:id` | 登录（或 owner） | — | 204 |
| GET | `/api/admin/users` | owner | — | 用户列表 + 各自数据量 |
| POST | `/api/admin/users` | owner | `{ username, displayName, email?, role? }` | `{ id, inviteUrl, code }`（**code 只返回这一次**，库里只存 hash） |
| PATCH | `/api/admin/users/:id` | owner | `{ role?, active?, publicRead?, displayName?, dailyWriteQuota?, dailyAiQuota? }` | 204 |
| POST | `/api/admin/users/:id/reset` | owner | — | `{ resetUrl, code }` |
| GET | `/api/admin/audit?limit=&before=` | owner | — | 审计分页 |
| GET | `/api/admin/usage` | owner | — | 近 30 天各人配额用量 |

**开户流程**：owner 在 `/admin.html#users` 填用户名与显示名 → 得到 `https://<域名>/login.html?invite=<code>` → 通过飞书/微信发给同事 → 同事打开设置口令 → 直接登录。邀请码 7 天有效、用一次即失效。

## 6. 页面与交互

| 页面 | 形态 | 要点 |
|---|---|---|
| `login.html` | 新静态页（零框架，与站点同深色风格） | 用户名 + 口令；「用邀请链接设置口令」分支；错误中文提示；锁定倒计时；M5 加 Passkey 按钮与 Turnstile |
| `admin.html` | 新静态页 | 三个 tab：**录入/上传**（PRD 02）、**草稿箱**（PRD 02）、**用户与审计**（本册） |
| `index.html` topbar | 改 | 右上角加「登录」或头像菜单（我的数据 / 录入 / 退出） |
| `assets/js/auth.js` | 新 | `GET /api/me` → 渲染菜单；401 时静默降级为匿名态 |

> `login.html` / `admin.html` 作为**静态资源**是公开可取的（里面没有任何秘密），所有数据都要带会话才拿得到。这样 Worker 保持薄壳，也避免了「HTML 都要走 Worker 渲染」的复杂度。如果你要求连页面本身都不给陌生人看到，就用 §3.5 的 Access 把 `/admin.html`、`/login.html` 路径也保护起来。

## 7. 前端改造点（会踩坑的三处）

1. **`sw.js` 必须改**：现在 `/api/*` 只要 `res.ok` 就 `caches.put`。多用户下 A 的 `/api/flights` 会被缓存，B 在同一浏览器打开就读到 A 的数据 —— 这是**隐私事故**级别的问题。
   修法：只缓存响应头 `cache-control` 含 `public` 的；认证作用域响应服务端一律 `private, no-store`。（SW 的 Cache API 不认 `Vary: Cookie`，只能靠 no-store。）
2. **`app.js` 的 `loadRemote()`**：同源 `fetch` 默认 `credentials:'same-origin'`，cookie 会自动带 ✅；但要区分「401 未登录」与「网络失败」，前者不该显示「加载失败」。
3. **接口数组形状**：`data-utils.js` 按下标解构，新增字段（`owner_id` 等）**不要**塞进公开数组；确需下发的追加在**尾部**。

## 8. 安全清单（实现时逐条打勾）

- [ ] Cookie：`HttpOnly; Secure; SameSite=Lax; Path=/`，30 天，改密即吊销全部会话
- [ ] 服务端存 `SHA-256(token)` 与 `SHA-256(dk‖pepper)`，**绝不**存明文/原值
- [ ] 比对用恒定时间（`crypto.subtle.verify` 或逐字节 XOR 累积），不用 `===`
- [ ] 登录失败限流：`u:<username>` 与 `ip:<ip>` 双维度，5 次失败锁 15 分钟；成功清零；写 `audit_log`
- [ ] 用户名枚举：不存在的用户名也返回 salt、也走一遍假哈希、返回同样的 401 文案与时延量级
- [ ] CSRF：写接口校验 `x-mw-csrf` + `Origin`
- [ ] CORS：去掉认证接口的 `access-control-allow-origin: *`
- [ ] 授权：`owner_id` **只从会话取**，永远不信请求体里的 owner_id；member 改别人数据 → 403
- [ ] 日志/审计脱敏：不记 `dk`、token、口令；行程数据里的身份证号/手机号在写入 `audit_log.detail` 前用正则打码
- [ ] 密钥：`AUTH_PWD_PEPPER`、`SESSION_PEPPER` 走 `wrangler secret put`，本地进 `.dev.vars`（已 gitignore）
- [ ] 邀请码/重置码：只存 hash、7 天过期、一次性
- [ ] 配额：`usage_daily` 超额返回 429，防止一个人烧掉共享的 Workers AI 免费额度

## 9. 验收标准

1. `npx wrangler dev --persist-to /tmp/wrangler-persist` 起本地环境，`tools/test-auth.mjs` 全绿：
   建号 → 邀请码设口令 → 登录 → `/api/me` → 改密（旧会话失效）→ member 改 owner 数据得 403 → 连续 5 次错口令得 423 → 审计表能查到上述每一条。
2. 真机 iPhone Safari + macOS Chrome 各完整走一遍登录/退出，刷新后仍保持登录。
3. **同一浏览器切账号不串数据**：A 登录看列表 → 退出 → B 登录，B 看不到 A 的任何一条（这条专门验 §7.1 的 SW 修复；用 DevTools → Application → Cache Storage 确认没有 `private` 响应被缓存）。
4. 匿名访问 `https://<域名>/` 与改造前**完全一致**（你的 100 段航班、53 段铁路、61 条轨迹照常显示）。
5. 每次登录/写操作的 CPU 时间在 `wrangler dev` 日志里 <10 ms（免费档硬线）。

## 10. 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 免费档 10 ms CPU | 服务端 KDF 不可行 | 浏览器 KDF（§3.1）；`users.kdf` 预留迁移 |
| SW 缓存串号 | 同事之间数据泄露 | §7.1 + 验收 §9.3 专项 |
| `*.workers.dev` 被公司网 reset | 同事打不开 | M0 先绑自定义域名 |
| 口令遗忘且无邮件通道 | 同事被锁 | owner 一键重置链接 |
| pepper 丢失 | 全员无法登录 | pepper 同时存进你的密码管理器；重置流程写成 runbook |
| Access 过渡方案与自建并存 | 两套身份打架 | 只选一套；选 Access 就以 email 映射 users |
