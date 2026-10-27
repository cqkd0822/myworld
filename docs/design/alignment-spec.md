# 视觉对齐规格 · 改进稿说明与迭代意见

> 状态：**改进稿待评审**（2026-10-27）。配套高保真原型：[prototype.html](prototype.html)
> （本地预览 http://localhost:8787/docs/design/prototype.html，`G` 键叠 4pt 基线网格与双边线，`A` 键看标注）
> 约束：本文与原型**不改动生产代码**；落地需另开实施提交。

## 1. 现状对齐债（实测值，非印象）

量自 `assets/css/style.css`（2026-10-27）：

### 1.1 左边缘家族混乱：一屏出现 4 条文本左边缘

| 元素 | 现状 inset | 实际文本左边缘（wrap=14 起算） |
|---|---|---|
| `.wrap` | `0 14px` | 14（屏幕边） |
| `.section__head` | `margin: 0 2px` | **16** |
| `.year-head` / `.chips` | `padding: … 2px` | **16** |
| `.flight__top/__bottom` `.rail` `.panel` `.stat` | `… 14px` | **28**（卡内） |
| `.hero` | `20px 18px` | **32**（又一条） |
| `.search` | `10px 13px` | 28±1（含边框） |

→ 14 / 16 / 28 / 32 四条左边缘并存，滚动时文本「左右跳」。`.controls` 用 `margin:0 -16px`
出血，但 wrap 是 14px——**出血量与容器 padding 不匹配**（-16 vs 14），现在靠 16-16+14 巧合对齐，属脆弱结构。

### 1.2 垂直节奏不在刻度上

padding/margin 实测出现：`11 / 13 / 15 / 7 / 10 / 18 / 20 / 2 / 8 / 14`（`.flight__top` 11、`.rail` 13、
`.panel` 15、`.chip` 7、`.section__head` margin-bottom 10、`.hero` 20/18…）。4pt 刻度只覆盖其中一半，
其余是「手感值」，相邻组件拼在一起时缝隙不齐。

### 1.3 控件高度三套并存

搜索 ≈40、chip ≈31–32、tag ≈19、`.rail__no` 徽章 ≈24、btn 40——吸顶控制簇里 40/32/19 混排，
垂直居中靠 `align-items` 救，视觉上仍「高低齿」。

### 1.4 数字没有数字的样子

`endpoint__time` 25px、`stat__value` 21px、`.flight__bottom` 11.5px（**半像素字号**）；
未启用 `tabular-nums` → 同列时间/票价因字形宽度不同而左右抖；票价混在 meta 流里，
**卡片之间没有对齐的数值右列**。

### 1.5 圆角家族有孤儿

16 / 12 / 8 / 999 之外还有 tag `5px`、`.rail__no` 用 `--r-sm`(8) 但视觉重量与 tag 同级。

## 2. 对齐系统（改进稿采用的规则）

### 2.1 双边线系统（E1 / E2）

- **E1 = 16px**：屏幕级文本边——section 标题、年份组头、脚注、控件盒外沿、卡片盒外沿。
- **E2 = 32px**（= E1 + 16）：**任何表面内部**的文本边——卡片/面板/输入框/chip 内的文字。
- 全屏只允许这两条左边缘；inline 元素（tag/分隔点）豁免但高度必须上刻度。
- 出血统一 `-16`，与 wrap padding 16 严格互逆（修掉 14/16 不匹配）。

### 2.2 4pt 垂直节奏与高度网格

- 间距刻度：`4 / 8 / 12 / 16 / 24 / 32`；卡内 padding 统一 `16`；组间距 `24`；行间距 `8|12`。
- 控件高度网格：`tag 20 / chip 32 / search·btn 40 / 主操作 48`（差值均为 4 的倍数，混排可光学居中）。
- 行高全部 4 的倍数：`11/16 12/16 13/20 15/24 17/24 20/28 24/32 28/36`。

### 2.3 字型与数字

- 字阶：`11 12 13 15 17 20 24 28`（砍掉 11.5 / 21 / 25）。
  分工（Q4 已决）：**12/16 = 密集正文小字**（ITRA 摘要、卡脚注、tile 脚注、备注）；
  **11/16 = 微标签**（kv key、单位、eyebrow、角标、统计列标签），不再混用。
- 全局 `.num { font-variant-numeric: tabular-nums }`：时间、票价、统计值、计数。
- **镜像对齐**：出发时间左对齐、到达时间右对齐（登机牌惯例）；票价/日期/计数右对齐到
  「右边缘列」（E1-right / E2-right），跨卡片形成连续右列。

### 2.4 圆角与光学

- 圆角家族：`表面 16 / 控件 12 / 小块 8 / tag 6 / chip pill`。
- 光学修正：箭头/飞机图标 `translateY(-0.5px)`；分隔点按文本光学中线居中；
  右对齐数字列补 `padding-right` 使字形右缘与盒内边重合（tabular 下无抖动）。

## 3. 组件级 before → after

| 组件 | before | after（原型帧） |
|---|---|---|
| 控制簇 | 出血 -16 vs wrap 14 不匹配；chip 31px | 出血 -16 互逆；search 40 / chip 32；文本全部落 E2 |
| 航班卡 | 三列挤压、票价在 meta 流里、11.5px | 首行 date·no·airline·tag；body 镜像时间 24/32 tabular；meta 12/16 左 + **票价右列** |
| 铁路卡 | 徽章宽随车次变、备注脚注无边缘约束 | 徽章固定 56 宽（数字居中 tabular）；日期右列；脚注落 E2 |
| 轨迹卡 | 统计三列宽度随内容漂移 | 三列固定网格（1fr×3），跨卡同 x 可比读 |
| 概览 hero | padding 20/18 自成一边 | padding 16 → 文本落 E2；totals 三列固定网格 |
| 详情 kv | 2 列 gap 12/10 不对称 | gap 12/12；值 tabular；桌面 3 列（R4） |

## 4. 迭代意见（分轮，每轮可独立验收/回滚）

| 轮 | 内容 | 风险 | 验收 |
|---|---|---|---|
| **R1** | 本规格落地：token 化（E1/E2、刻度、高度、圆角、字阶）+ 组件 padding/对齐改写；markup 仅加 `num` 类与个别结构 | 低（纯视觉） | 原型 `G` 网格叠在真机上：所有边缘/高度落刻度；四边缘变两边缘 |
| **R2** | 层级与密度：年份组头吸顶（带 tabular 计数右列）；meta 最多两行 + 省略规则；空态插画按 E1 居中 | 低 | 长列表滚动时组头不遮控制簇（z 与 top 计算写死） |
| **R3** | 状态与动效：press `scale(.99)`、focus 环 2px offset 落刻度、skeleton 行高=4pt 倍数、list→detail 用 View Transitions（不支持则无动画）、`prefers-reduced-motion` 全关 | 中 | 动效帧率 ≥55fps（中端机录屏） |
| **R4** | 桌面 ≥1000：1040 内容列 = 卡片双列 gap 16（列宽 512）；kv 三列基线对齐；控制簇横排（search 固定 320 + chips 填充）。**静态帧已入原型（帧 6/7）** | 中 | 1440/1280/1024 三档截图无溢出 |
| **R5**（可选） | 紧凑密度开关（`data-density=compact`：行高降一档、卡 padding 12） | 低 | 开关持久化到 localStorage |

**建议顺序**：R1 → R4 → R2 → R3 → R5（R4 早做是因为双列会放大对齐误差，先修系统再铺桌面）。

## 5. 开放问题 → **已拍板（2026-10-27）**

- Q1 chip padding 16：**改**（接受变宽，chip 文本落 E2）。
- Q2 到达时间镜像右对齐：**采用**。
- Q3 票价独立右列：**采用**。
- Q4 密集正文小字：**12/16**；11/16 仅限微标签（见 §2.3 分工）。
- Q5 桌面静态帧：**补**（原型帧 6/7，演示 R4：1040 列、卡片双列 512+16+512、kv 三列、控制簇横排 search 320）。

## 6. 非目标

- 不改信息架构与数据口径；不换色板（深色 token 原样继承）；不引设计系统依赖；
- 原型中的地图/剖面为占位块（真机实现仍走腾讯 GL 与现有 SVG）。

## 7. 落地状态（2026-10-27，R1–R5 全量，部署 `0cc1e255`）

- **R1** 已落地：tokens 入 `:root`（`--e1/--e2/--sp-*/--h-*/--r-tag/--ctl-h`）；wrap/topbar 16；
  控件高度网格 tag20/chip32/ctl40/btn40/btnrow48/vtoggle 内 28；圆角家族含 tag 6；
  字阶实测清零后仅存 `11 12 13 15 17 20 24`（28 保留给原型/将来 hero）；tabular 选择器清单见 CSS 落地层。
- **R2** 已落地：year-head 吸顶修正为「顶栏 + 控制簇」之下（`--ctl-h: 97px` 写死并注释构成），
  计数右列（markup 顺序改为 年|rule|count）；`.flight__meta` 两行封顶（max-height 32 + overflow hidden），
  票价移出 meta 成白条右缘独立右列；空态 32/0 居中。
- **R3** 已落地：press `scale(.99)`、`:focus-visible` 2px/offset 2、骨架屏 `.skel`(132/88) 替换三处
  「正在加载」文字、View Transitions 包 `view.innerHTML` 交换（reduced-motion 直换）、
  reduced-motion 关 shimmer/形变/过渡。
- **R4** 已落地：≥1000 块内 1040 列、卡片双列 gap 16、kv 3 列、stat 4 列、控制簇横排
  （search 320 + chips 填充）、topbar inner 1040、year-head 回顶栏吸顶、btnrow 行内。
- **R5** 已落地：顶栏密度按钮 `#densityBtn` → `html[data-density]` + localStorage `myworld.density`；
  compact 档 padding 12 / 时间 20/28 / 间隙收紧 / chip 28 / search 36。

### 落地时的三处实测偏差（记录备查）

1. `.st-hours__h`（统计页小时轴）8.5px→11px 后 24 列放不下 → **隔列隐藏**（nth-child(even)），刻度仍对齐。
2. 铁路徽章从「实底色块白字」改为「中性底 + 彩色字」（--d/--c/--ktz 由 background 改 color），
   否则 56×40 固定盒里实底色块与卡面撞色；视觉重量更轻，与 tag 家族统一。
3. `.btn` 由 pill(999)/42 改为 radius 12/40（与原型一致）；详情页主操作经 `.btnrow` 升 48。
