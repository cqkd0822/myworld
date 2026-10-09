# MyWorld · 行程记录

个人行程记录站：**航班 / 铁路 / 徒步轨迹** 三类数据，纯静态、零依赖、零构建。

> 数据总量：100 段航班（2015–2026）+ 47 段铁路 + 2 条轨迹。
> 全部内容序列化后不到 130 KB，整个仓库（含 2 份原始 GPX）约 5 MB。

---

## 为什么是纯静态，而不是 Astro / Next

- **没有后端要连**。行程是低频写入、只读展示，静态文件是最优解。
- **没有数据库要装**。数据就是两个 JS 文件，`git diff` 能直接看到改了哪段行程。
- **没有构建要等**。`git push` 之后托管方不需要跑任何东西，也不会因为
  依赖升级突然构建失败。
- **离线可用**。双击 `index.html` 就能看（地图底图除外，那需要网络）。

代价是：数据文件是手维护的 JS 数组。对这个量级（一年几十段）这是
**更省事**的选择，不是妥协——见下文「新增一段行程」。

---

## 目录结构

```
index.html                  单页应用外壳（hash 路由，四页：概览/飞行/铁路/足迹）
favicon.svg
manifest.webmanifest        加到手机主屏幕时的图标与配色
assets/
  css/style.css             全部样式，移动端优先
  js/data-utils.js          机场/车站名解析、里程/时长计算、汇总统计
  js/map.js                 腾讯地图 + 离线轨迹轮廓 + 海拔剖面图
  js/routemap.js            航迹图：飞行/铁路的航旅纵横风格轨迹地图
  js/app.js                 路由与四个视图的渲染
  data/site.js              站点标题、腾讯地图 key、仓库地址
  data/airports.js          城市坐标表（估算直线里程用，兼做城市词典）+ 站名别名表
  data/flights.js           航班数据 ★ 手维护
  data/rail.js              铁路数据 + 退改签原票 ★ 手维护
  data/tracks.js            轨迹数据（脚本生成，勿手改）
gpx/                        抽稀后的 GPX，供页面「下载」按钮
tools/
  geo.mjs                   坐标转换 / 抽稀 / 统计的公共实现
  build-tracks.mjs          把 tools/source/*.gpx 编译成 assets/data/tracks.js
  source/*.gpx              原始 GPX（手表/赛事导出的原始文件）
```

---

## 航迹图

「飞行」和「铁路」两个页面右上角可以切到**航迹图**：深色玻璃面板 + 大圆弧航线 +
城市光点，底部是统计条和年份时间轴。也可以直接用 `#/flights/map`、`#/rail/map`
这样的链接直达。

几个实现上的决定：

- **航线是大圆弧**，用球面插值算出来的，不是贝塞尔曲线装饰——北京到广州
  那道弧是真实的航向。
- **同一对城市之间的往返会合并成一条线**，线的粗细按飞行次数分三档。
- **底图用腾讯地图**（合规要求，见下）。坐标系在构建期已经转过 GCJ-02。
- **底图挂了也能看**：先画一张离线的深色 SVG 航线图，地图 API 因为
  key 白名单、断网等原因起不来时，它还在。

### 想要深色底图（航旅纵横那种）

默认是官方浅色底图。腾讯的个性化样式必须**绑定到 key** 才能用，没绑定就填编号
只会让底图整片返灰（实测）：

1. 打开[腾讯位置服务控制台](https://lbs.qq.com/dev/console/application/mine)
2. 应用与样式 → 个性化样式 → 挑一个深色模板（墨渊 / 黑色极简 / 微信深色）
3. 绑定到本站用的那个 key
4. 在 `assets/data/site.js` 里把 `mapStyleId` 改成对应编号（比如 `'style1'`）

改完刷新即可，城市名的文字颜色会自动跟着切成浅色。

---

## 日常使用

### 新增一段航班

打开 `assets/data/flights.js`，照着文件头的字段说明**追加一行**即可：

```js
[101, "2026-11-20", "厦门航空", "MF8xxx", "杭州萧山T3", "重庆江北T3",
 "空客321", "B1234", "08:00", "10:20", "10:15", "经济舱(Y)", "45C", 620, -5],
```

不需要改别处——排序、年份分组、统计、航线热度都是运行时算的。
几点约定：

- 日期用 `YYYY-MM-DD`；跨日到达的时间末尾加 `+1`，例如 `"00:43+1"`。
- 机场名要能被城市词典识别（`airports.js` 里的 key 是城市名，
  用**最长前缀**切分，「鄂尔多斯伊金霍洛T2」能正确拆出城市「鄂尔多斯」）。
  遇到新城市，先在 `airports.js` 里补一行坐标，否则这一段算不出里程。
- 票价没记录就写 `null`，页面上会显示「票价未记录」，不会算进合计。

### 新增一段铁路

`assets/data/rail.js` 追加一行，字段说明在文件头。
退票/改签的原票加到 `railVoided`，它们不会计入行程数。

### 新增一条轨迹

```bash
# 1. 原始 GPX 放进来
cp 你的轨迹.gpx tools/source/

# 2. 在 tools/build-tracks.mjs 的 MANIFEST 里加一条
#    （id、文件名、名称、日期、地区、颜色、抽稀容差、海拔阈值）

# 3. 重新生成
node tools/build-tracks.mjs
```

脚本会自动做坐标纠偏、抽稀、算距离/爬升/配速，并输出
`assets/data/tracks.js` 和 `gpx/xxx.gpx`。

---

## 数据口径（避免以后自己看糊涂）

| 项 | 口径 |
|---|---|
| 飞行里程 | 城市间**直线距离**。民航实际航路比直线长 5%~15%，所以这是下界 |
| 轨迹距离 | 原始点间距直接累加，**未平滑**。实测平滑会在盘山发卡弯处抄近道（TOR330 被少算 8%） |
| 累计爬升 | 带海拔阈值过滤（默认 10 米）。不同工具的爬升数天然对不齐，比较时要带上口径 |
| 轨迹形状 | 抽稀后的原始几何。显示与统计是两条路径：统计用原始几何，画图用抽稀几何 |
| 坐标系 | GPX 是 WGS-84，腾讯地图是 GCJ-02。转换在**构建期**完成（逐点判断境内外），页面里不再纠偏 |

---

## 本地预览

直接双击 `index.html` 就能看（轨迹轮廓、海拔剖面、全部列表都正常，
只有地图底图需要网络）。

要起本地服务的话：

```bash
python -m http.server 8000
# 打开 http://127.0.0.1:8000/
```

---

## 部署

任意静态托管都能直接用，把仓库根目录当网站根目录即可：

- **GitHub Pages**：Settings → Pages → Source 选 `main` / `(root)`。
  注意：GitHub 免费账号**只有公开仓库**能用 Pages，私有仓库需要 Pro。
- **Cloudflare Pages**：构建命令留空，输出目录填 `/`。
- **Vercel / Netlify**：同样零配置。

---

## ⚠️ 两个安全注意点

1. **腾讯地图 key 是前端可见的**。这是所有浏览器端地图 API 的固有性质，
   不是配置失误。防护手段是在 [腾讯位置服务控制台](https://lbs.qq.com/dev/console/application/mine)
   给这个 key **配置域名白名单**（只允许你自己的域名调用），并把产品类型
   限定为 JavaScript API GL、设置配额上限。key 换了只改 `assets/data/site.js`。
2. **推送用 SSH Deploy Key，不用 Personal Access Token**。
   Deploy key 只对一个仓库生效，比 PAT 的作用域小得多。

   密钥对在本机 `~/.ssh/myworld_deploy`（私钥）和 `~/.ssh/myworld_deploy.pub`
   （公钥）。**私钥永远不要提交、不要外发**——仓库里没有任何它的痕迹。
   公钥要贴到 GitHub 仓库的 Settings → Deploy keys，并勾上 **Allow write access**，
   否则只能拉不能推。

   本仓库的 `.git/config` 里已经配好了指向这把私钥：

   ```bash
   git config core.sshCommand "ssh -i ~/.ssh/myworld_deploy -o IdentitiesOnly=yes"
   ```

   `IdentitiesOnly=yes` 是必要的：不加的话 SSH 会先把 agent 里的其他密钥
   挨个试一遍，多仓库多密钥时容易串号、也会触发 GitHub 的失败次数限制。

   验证是否接通（成功时会打印 `Hi cqkd0822/myworld! You've successfully
   authenticated`，且**不会**给你 shell）：

   ```bash
   ssh -T -i ~/.ssh/myworld_deploy git@github.com
   ```

   如果网络封了 22 端口，GitHub 在 443 上也有同一个 SSH 服务，换这个：

   ```bash
   ssh -T -i ~/.ssh/myworld_deploy -p 443 git@ssh.github.com
   ```

   要换机器时，把 `myworld_deploy`（私钥）安全地拷过去，或重新生成一对、
   在 GitHub 上把旧的删掉。同一把公钥**不能**添加到两个仓库
   （GitHub 会报 `Key is already in use`），每个仓库各生成一对。
