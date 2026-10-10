#!/usr/bin/env node
/**
 * 把 tools/source/ 里的原始 GPX 编译成网站用的轨迹数据。
 *
 * 用法：
 *   node tools/build-tracks.mjs
 *
 * 做四件事：
 *   1. 解析原始 GPX（含多段与航点）
 *   2. 用**原始几何**算距离、爬升（爬升另加海拔阈值过滤）
 *   3. 用原始几何抽稀后画图，另出一份**只平滑海拔**的数据画剖面
 *   4. 输出 assets/data/tracks.js（含坐标、海拔剖面、航点），
 *      以及 gpx/ 下的精简版 GPX 供下载
 *
 * 为什么不先平滑再算距离：实测一条 337 公里的越野赛道（TOR330，2026-10 已下线），5 点滑动平均
 * 会把距离压到 310 公里（少 8%）——平滑在盘山发卡弯处抄了近道。原始 GPS
 * 抖动造成的虚高通常只有 1~2%，比抄近道的低估小得多，所以宁可不平滑。
 *
 * 新增一条轨迹：把 .gpx 丢进 tools/source/，再在下面 MANIFEST 里加一行。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseGpx,
  parseWaypoints,
  flatten,
  smoothElevation,
  simplifySegments,
  trackStats,
  elevationProfile,
  centerAndZoom,
  toMapPaths,
  waypointsToMap,
  writeGpx,
} from './geo.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SOURCE_DIR = join(HERE, 'source');
const GPX_OUT_DIR = join(ROOT, 'gpx');
const DATA_OUT = join(ROOT, 'assets', 'data', 'tracks.js');

/* ------------------------------------------------------------------ */
/* 轨迹清单                                                            */
/* ------------------------------------------------------------------ */

/**
 * toleranceM  —— 抽稀容差（米）。本地短轨迹 3 米足够（肉眼无差别）；
 *                300 公里级的长轨迹用 3 米会产生上万个点，12 米在整条赛道
 *                的尺度下连一个像素都占不到，纯属浪费体积。
 * eleThresholdM —— 累计爬升时的起伏过滤阈值（米）。低于它的高度变化视为
 *                抖动丢弃。10 米是个稳妥的默认值：同一条赛道用 10 米算出
 *                24258 米爬升，与官方公布的约 24000 米吻合。
 */
const MANIFEST = [
  {
    id: '2026-09-05-songhuahu',
    file: '松花湖越野跑30公里组别.gpx',
    name: '松花湖越野跑 30 公里',
    date: '2026-09-05',
    region: '吉林 · 松花湖',
    kind: 'race',
    color: '#1B6FF0',
    toleranceM: 3,
    eleThresholdM: 10,
    // ITRA 官方成绩（athlete 6845683 LEI Ting），2026-10 从 ITRA 页面录入。
    // points 为 null 是因为截图时该值被成绩弹窗挡住，没读到就不编。
    itra: {
      name: 'KAILAS FUGA LAKE SONGHUA NORTHEAST 100 MOUNTAIN RUNNING RACE - 30km',
      points: null,
      perf: 449,
      finishTime: '5:16:01',
      category: '28km/1823m+',
      avgPace: "11'17\"/km",
      equivPace: "06'50\"/km",
      overall: '189/3178',
      gender: '156/1887',
      ageRank: 53,
      dnf: '169/3009',
      femalePct: '41%',
      mountain: 7,
    },
  },
  /* —— 2025 年徒步 32 条：企业微信收件的 GPX，2026-10 批量入库 —— */
  {
    id: '2025-01-11-hangzhou-banshan',
    file: '2025-01-11-hangzhou-banshan.gpx',
    name: '杭州半山公园',
    date: '2025-01-11',
    region: '浙江 · 杭州',
    kind: 'hike',
    color: '#1B6FF0',
    toleranceM: 4,
    eleThresholdM: 10,
  },
  {
    id: '2025-02-04-hangzhou-daicun',
    file: '2025-02-04-hangzhou-daicun.gpx',
    name: '杭州戴村',
    date: '2025-02-04',
    region: '浙江 · 杭州',
    kind: 'hike',
    color: '#D9482F',
    toleranceM: 4,
    eleThresholdM: 10,
  },
  {
    id: '2025-02-09-hangzhou-chaoshan',
    file: '2025-02-09-hangzhou-chaoshan.gpx',
    name: '杭州超山公园',
    date: '2025-02-09',
    region: '浙江 · 杭州',
    kind: 'hike',
    color: '#34d399',
    toleranceM: 4,
    eleThresholdM: 10,
  },
  {
    id: '2025-02-15-ningbo-xiangshan',
    file: '2025-02-15-ningbo-xiangshan.gpx',
    name: '宁波象山',
    date: '2025-02-15',
    region: '浙江 · 宁波',
    kind: 'hike',
    color: '#f5b04d',
    toleranceM: 4,
    eleThresholdM: 10,
  },
  {
    id: '2025-02-23-hangzhou-siwuling',
    file: '2025-02-23-hangzhou-siwuling.gpx',
    name: '杭州寺坞岭',
    date: '2025-02-23',
    region: '浙江 · 杭州',
    kind: 'hike',
    color: '#c084fc',
    toleranceM: 4,
    eleThresholdM: 10,
  },
  {
    id: '2025-03-01-hangzhou-jingshan',
    file: '2025-03-01-hangzhou-jingshan.gpx',
    name: '杭州径山',
    date: '2025-03-01',
    region: '浙江 · 杭州',
    kind: 'hike',
    color: '#38bdf8',
    toleranceM: 4,
    eleThresholdM: 10,
  },
  {
    id: '2025-03-02-hangzhou-wuchaoshan',
    file: '2025-03-02-hangzhou-wuchaoshan.gpx',
    name: '杭州午潮山',
    date: '2025-03-02',
    region: '浙江 · 杭州',
    kind: 'hike',
    color: '#fb7185',
    toleranceM: 4,
    eleThresholdM: 10,
  },
  {
    id: '2025-03-07-shaoxing-shangqing',
    file: '2025-03-07-shaoxing-shangqing.gpx',
    name: '绍兴上青古道',
    date: '2025-03-07',
    region: '浙江 · 绍兴',
    kind: 'hike',
    color: '#a3e635',
    toleranceM: 4,
    eleThresholdM: 10,
  },
  {
    id: '2025-03-09-hangzhou-dongmingshan',
    file: '2025-03-09-hangzhou-dongmingshan.gpx',
    name: '杭州东明山',
    date: '2025-03-09',
    region: '浙江 · 杭州',
    kind: 'hike',
    color: '#f97316',
    toleranceM: 4,
    eleThresholdM: 10,
  },
  {
    id: '2025-04-04-shenzhen-maluanshan',
    file: '2025-04-04-shenzhen-maluanshan.gpx',
    name: '深圳马峦山公园',
    date: '2025-04-04',
    region: '广东 · 深圳',
    kind: 'hike',
    color: '#2dd4bf',
    toleranceM: 4,
    eleThresholdM: 10,
  },
  {
    id: '2025-04-05-shenzhen-dananshan',
    file: '2025-04-05-shenzhen-dananshan.gpx',
    name: '深圳大南山',
    date: '2025-04-05',
    region: '广东 · 深圳',
    kind: 'hike',
    color: '#e879f9',
    toleranceM: 4,
    eleThresholdM: 10,
  },
  {
    id: '2025-04-06-shenzhen-dongxiyong',
    file: '2025-04-06-shenzhen-dongxiyong.gpx',
    name: '深圳东西涌',
    date: '2025-04-06',
    region: '广东 · 深圳',
    kind: 'hike',
    color: '#94a3b8',
    toleranceM: 4,
    eleThresholdM: 10,
  },
  {
    id: '2025-04-11-zhengzhou-shaoshishan',
    file: '2025-04-11-zhengzhou-shaoshishan.gpx',
    name: '郑州少室山',
    date: '2025-04-11',
    region: '河南 · 郑州',
    kind: 'hike',
    color: '#1B6FF0',
    toleranceM: 4,
    eleThresholdM: 10,
  },
  {
    id: '2025-04-18-shenzhen-wutongshan',
    file: '2025-04-18-shenzhen-wutongshan.gpx',
    name: '深圳梧桐山',
    date: '2025-04-18',
    region: '广东 · 深圳',
    kind: 'hike',
    color: '#D9482F',
    toleranceM: 4,
    eleThresholdM: 10,
  },
  {
    id: '2025-04-19-shenzhen-sanshuixian-dnf',
    file: '2025-04-19-shenzhen-sanshuixian-dnf.gpx',
    name: '深圳三水线（中途下撤）',
    date: '2025-04-19',
    region: '广东 · 深圳',
    kind: 'hike',
    color: '#34d399',
    toleranceM: 4,
    eleThresholdM: 10,
  },
  {
    id: '2025-04-26-shaoxing-zoumagang',
    file: '2025-04-26-shaoxing-zoumagang.gpx',
    name: '绍兴走马岗',
    date: '2025-04-26',
    region: '浙江 · 绍兴',
    kind: 'hike',
    color: '#f5b04d',
    toleranceM: 4,
    eleThresholdM: 10,
  },
  {
    id: '2025-05-02-enshi-chaodongyan',
    file: '2025-05-02-enshi-chaodongyan.gpx',
    name: '恩施朝东岩',
    date: '2025-05-02',
    region: '湖北 · 恩施',
    kind: 'hike',
    color: '#c084fc',
    toleranceM: 4,
    eleThresholdM: 10,
  },
  {
    id: '2025-05-02-enshi-chaodongyan-2',
    file: '2025-05-02-enshi-chaodongyan-2.gpx',
    name: '恩施朝东岩 · 第二段',
    date: '2025-05-02',
    region: '湖北 · 恩施',
    kind: 'hike',
    color: '#38bdf8',
    toleranceM: 4,
    eleThresholdM: 10,
  },
  {
    id: '2025-05-03-enshi-qingjiang',
    file: '2025-05-03-enshi-qingjiang.gpx',
    name: '恩施清江古河床',
    date: '2025-05-03',
    region: '湖北 · 恩施',
    kind: 'hike',
    color: '#fb7185',
    toleranceM: 4,
    eleThresholdM: 10,
  },
  {
    id: '2025-05-17-yingtan-longhushan',
    file: '2025-05-17-yingtan-longhushan.gpx',
    name: '鹰潭龙虎山',
    date: '2025-05-17',
    region: '江西 · 鹰潭',
    kind: 'hike',
    color: '#a3e635',
    toleranceM: 4,
    eleThresholdM: 10,
  },
  {
    id: '2025-05-18-fuzhou-dajueshan',
    file: '2025-05-18-fuzhou-dajueshan.gpx',
    name: '抚州大觉山',
    date: '2025-05-18',
    region: '江西 · 抚州',
    kind: 'hike',
    color: '#f97316',
    toleranceM: 4,
    eleThresholdM: 10,
  },
  {
    id: '2025-05-24-pingxiang-wugongshan',
    file: '2025-05-24-pingxiang-wugongshan.gpx',
    name: '萍乡武功山反穿（云顶景区下山）',
    date: '2025-05-24',
    region: '江西 · 萍乡',
    kind: 'hike',
    color: '#2dd4bf',
    toleranceM: 4,
    eleThresholdM: 10,
  },
  {
    id: '2025-06-14-hangzhou-wuyue',
    file: '2025-06-14-hangzhou-wuyue.gpx',
    name: '杭州临安吴越古道',
    date: '2025-06-14',
    region: '浙江 · 杭州',
    kind: 'hike',
    color: '#e879f9',
    toleranceM: 4,
    eleThresholdM: 10,
  },
  {
    id: '2025-06-22-hangzhou-biaoyixian-dnf',
    file: '2025-06-22-hangzhou-biaoyixian-dnf.gpx',
    name: '杭州标毅线（中途下撤）',
    date: '2025-06-22',
    region: '浙江 · 杭州',
    kind: 'hike',
    color: '#94a3b8',
    toleranceM: 4,
    eleThresholdM: 10,
  },
  {
    id: '2025-07-13-hangzhou-yunling',
    file: '2025-07-13-hangzhou-yunling.gpx',
    name: '杭州云岭古道',
    date: '2025-07-13',
    region: '浙江 · 杭州',
    kind: 'hike',
    color: '#1B6FF0',
    toleranceM: 4,
    eleThresholdM: 10,
  },
  {
    id: '2025-07-26-huihang',
    file: '2025-07-26-huihang.gpx',
    name: '徽杭古道',
    date: '2025-07-26',
    region: '皖浙 · 徽杭古道',
    kind: 'hike',
    color: '#D9482F',
    toleranceM: 4,
    eleThresholdM: 10,
  },
  {
    id: '2025-08-03-hangzhou-maling',
    file: '2025-08-03-hangzhou-maling.gpx',
    name: '杭州马岭古道',
    date: '2025-08-03',
    region: '浙江 · 杭州',
    kind: 'hike',
    color: '#34d399',
    toleranceM: 4,
    eleThresholdM: 10,
  },
  {
    id: '2025-08-17-hangzhou-yuhuangshan',
    file: '2025-08-17-hangzhou-yuhuangshan.gpx',
    name: '杭州玉皇山',
    date: '2025-08-17',
    region: '浙江 · 杭州',
    kind: 'hike',
    color: '#f5b04d',
    toleranceM: 4,
    eleThresholdM: 10,
  },
  {
    id: '2025-08-23-hongkong-taimoshan',
    file: '2025-08-23-hongkong-taimoshan.gpx',
    name: '香港大帽山',
    date: '2025-08-23',
    region: '香港',
    kind: 'hike',
    color: '#c084fc',
    toleranceM: 4,
    eleThresholdM: 10,
  },
  {
    id: '2025-08-24-hongkong-wilson',
    file: '2025-08-24-hongkong-wilson.gpx',
    name: '香港卫奕信径',
    date: '2025-08-24',
    region: '香港',
    kind: 'hike',
    color: '#38bdf8',
    toleranceM: 4,
    eleThresholdM: 10,
  },
  {
    id: '2025-08-31-hangzhou-biaoyixian-dnf2',
    file: '2025-08-31-hangzhou-biaoyixian-dnf2.gpx',
    name: '杭州标毅线（二次下撤）',
    date: '2025-08-31',
    region: '浙江 · 杭州',
    kind: 'hike',
    color: '#fb7185',
    toleranceM: 4,
    eleThresholdM: 10,
  },
  {
    id: '2025-09-13-huzhou-zhangli',
    file: '2025-09-13-huzhou-zhangli.gpx',
    name: '湖州章里古道',
    date: '2025-09-13',
    region: '浙江 · 湖州',
    kind: 'hike',
    color: '#a3e635',
    toleranceM: 4,
    eleThresholdM: 10,
  },

  /* —— 2025-09~12 第二批：五台山顺朝两日、军嶂古道越野跑等 9 条（2026-10 入库） —— */
  {
    id: '2025-09-29-xinzhou-wutaishan-1',
    file: '2025-09-29-xinzhou-wutaishan-1.gpx',
    name: '忻州五台山顺朝 · 第一天',
    date: '2025-09-29',
    region: '山西 · 忻州',
    kind: 'hike',
    color: '#38bdf8',
    toleranceM: 4,
    eleThresholdM: 10,
  },
  {
    id: '2025-09-30-xinzhou-wutaishan-2',
    file: '2025-09-30-xinzhou-wutaishan-2.gpx',
    name: '忻州五台山顺朝 · 第二天',
    date: '2025-09-30',
    region: '山西 · 忻州',
    kind: 'hike',
    color: '#fb7185',
    toleranceM: 4,
    eleThresholdM: 10,
  },
  {
    id: '2025-10-07-hangzhou-changle',
    file: '2025-10-07-hangzhou-changle.gpx',
    name: '杭州长乐林场',
    date: '2025-10-07',
    region: '浙江 · 杭州',
    kind: 'hike',
    color: '#a3e635',
    toleranceM: 4,
    eleThresholdM: 10,
  },
  {
    id: '2025-11-15-pingxiang-wugongshan-full',
    file: '2025-11-15-pingxiang-wugongshan-full.gpx',
    name: '萍乡武功山反穿',
    date: '2025-11-15',
    region: '江西 · 萍乡',
    kind: 'hike',
    color: '#f97316',
    toleranceM: 4,
    eleThresholdM: 10,
  },
  {
    id: '2025-11-23-hangzhou-xingmeijian',
    file: '2025-11-23-hangzhou-xingmeijian.gpx',
    name: '杭州富阳杏梅尖',
    date: '2025-11-23',
    region: '浙江 · 杭州',
    kind: 'hike',
    color: '#2dd4bf',
    toleranceM: 4,
    eleThresholdM: 10,
  },
  {
    id: '2025-11-29-hangzhou-biaoyixian',
    file: '2025-11-29-hangzhou-biaoyixian.gpx',
    name: '杭州标毅线',
    date: '2025-11-29',
    region: '浙江 · 杭州',
    kind: 'hike',
    color: '#e879f9',
    toleranceM: 4,
    eleThresholdM: 10,
  },
  {
    id: '2025-12-07-wuxi-junzhang',
    file: '2025-12-07-wuxi-junzhang.gpx',
    name: '无锡军嶂古道越野跑',
    date: '2025-12-07',
    region: '江苏 · 无锡',
    kind: 'run',
    color: '#94a3b8',
    toleranceM: 4,
    eleThresholdM: 10,
    itra: {
      name: 'wuxijunzhang - 14k',
      points: 0,
      perf: 393,
      finishTime: '2:31:42',
      category: '14km/685m+',
      avgPace: "10'50\"/km",
      equivPace: "07'16\"/km",
      overall: '36/273',
      gender: '29/145',
      ageRank: 7,
      dnf: '0/273',
      femalePct: '47%',
      mountain: 5,
    },
  },
  {
    id: '2025-12-14-xuancheng-tiejiangfeng',
    file: '2025-12-14-xuancheng-tiejiangfeng.gpx',
    name: '宣城铁匠峰',
    date: '2025-12-14',
    region: '安徽 · 宣城',
    kind: 'hike',
    color: '#1B6FF0',
    toleranceM: 4,
    eleThresholdM: 10,
  },
  {
    id: '2025-12-31-huangshan-newyear',
    file: '2025-12-31-huangshan-newyear.gpx',
    name: '黄山跨年徒步',
    date: '2025-12-31',
    region: '安徽 · 黄山',
    kind: 'hike',
    color: '#D9482F',
    toleranceM: 4,
    eleThresholdM: 10,
  },

  /* —— 2026 年第三批 19 条：企业微信缓存三次扫描，几何签名去重后入库 —— */
  {
    id: "2026-01-02-shangrao-sanqingshan",
    file: "上饶三清山徒步.gpx",
    name: "上饶三清山",
    date: "2026-01-02",
    region: "江西 · 上饶",
    kind: "hike",
    color: "#D9482F",
    toleranceM: 4,
    eleThresholdM: 10,
  },
  {
    id: "2026-01-03-quzhou-jianglangshan",
    file: "衢州江郎山徒步.gpx",
    name: "衢州江郎山",
    date: "2026-01-03",
    region: "浙江 · 衢州",
    kind: "hike",
    color: "#D9482F",
    toleranceM: 4,
    eleThresholdM: 10,
  },
  {
    id: "2026-01-24-guilin-xingping",
    file: "桂林兴平古镇徒步.gpx",
    name: "桂林兴坪古镇",
    date: "2026-01-24",
    region: "广西 · 桂林",
    kind: "hike",
    color: "#D9482F",
    toleranceM: 4,
    eleThresholdM: 10,
  },
  {
    id: "2026-01-25-guilin-baili",
    file: "桂林百里画廊屠徒步.gpx",
    name: "桂林百里画廊",
    date: "2026-01-25",
    region: "广西 · 桂林",
    kind: "hike",
    color: "#D9482F",
    toleranceM: 4,
    eleThresholdM: 10,
  },
  {
    id: "2026-02-14-dabieshan-cross",
    file: "大别山十字环徒步（中途改道）.gpx",
    name: "大别山十字环",
    date: "2026-02-14",
    region: "安徽 · 六安",
    kind: "hike",
    color: "#D9482F",
    toleranceM: 4,
    eleThresholdM: 10,
  },
  {
    id: "2026-03-08-hangzhou-relo",
    file: "杭州Relo越野跑.gpx",
    name: "杭州 Relo 越野跑",
    date: "2026-03-08",
    region: "浙江 · 杭州",
    kind: "race",
    color: "#1B6FF0",
    toleranceM: 4,
    eleThresholdM: 10,
    // ITRA 赛名 HANGZHOU TRAIL，组别 24km/1405m+ 与 GPX 实测 24.83km/1249m 吻合
    itra: {
      name: "HANGZHOU TRAIL - 25km",
      points: 1,
      perf: 407,
      finishTime: "4:13:38",
      category: "24km/1405m+",
      avgPace: "10'34\"/km",
      equivPace: "06'39\"/km",
      overall: "729/1962",
      gender: "600/1380",
      ageRank: 137,
      dnf: "0/1962",
      femalePct: "30%",
      mountain: 6,
    },
  },
  {
    id: "2026-03-15-pingxiang-wugongshan-2026",
    file: "萍乡武功山反穿（2026年）.gpx",
    name: "萍乡武功山反穿",
    date: "2026-03-15",
    region: "江西 · 萍乡",
    kind: "hike",
    color: "#D9482F",
    toleranceM: 4,
    eleThresholdM: 10,
  },
  {
    id: "2026-03-20-hangzhou-jingshan-2026",
    file: "杭州径山徒步（2026年）.gpx",
    name: "杭州径山",
    date: "2026-03-20",
    region: "浙江 · 杭州",
    kind: "hike",
    color: "#D9482F",
    toleranceM: 4,
    eleThresholdM: 10,
  },
  {
    id: "2026-03-21-shaoxing-xianglu",
    file: "绍兴香炉禅寺徒步.gpx",
    name: "绍兴香炉禅寺",
    date: "2026-03-21",
    region: "浙江 · 绍兴",
    kind: "hike",
    color: "#D9482F",
    toleranceM: 4,
    eleThresholdM: 10,
  },
  {
    id: "2026-03-27-chuanxi-xiaojinshan",
    file: "川西小金山萨武神山攀登.gpx",
    name: "川西小金山",
    date: "2026-03-27",
    region: "四川 · 阿坝",
    kind: "hike",
    color: "#D9482F",
    toleranceM: 4,
    eleThresholdM: 10,
  },
  {
    id: "2026-04-03-chizhou-jiuhuashan",
    file: "池州九华山南北穿越.gpx",
    name: "池州九华山南北穿越",
    date: "2026-04-03",
    region: "安徽 · 池州",
    kind: "hike",
    color: "#D9482F",
    toleranceM: 4,
    eleThresholdM: 10,
  },
  {
    id: "2026-04-12-fuzhou-guling",
    file: "福州鼓岭徒步.gpx",
    name: "福州鼓岭",
    date: "2026-04-12",
    region: "福建 · 福州",
    kind: "hike",
    color: "#D9482F",
    toleranceM: 4,
    eleThresholdM: 10,
  },
  {
    id: "2026-04-18-hangzhou-zhongtai",
    file: "杭州扎进野路子中泰镇越野跑.gpx",
    name: "杭州中泰镇越野跑",
    date: "2026-04-18",
    region: "浙江 · 杭州",
    kind: "race",
    color: "#1B6FF0",
    toleranceM: 4,
    eleThresholdM: 10,
    // ITRA 赛名 SN into the wild trail challenge-hangzhou
    itra: {
      name: "SN into the wild trail challenge-hangzhou - 24km",
      points: 0,
      perf: 415,
      finishTime: "3:36:57",
      category: "23km/1084m+",
      avgPace: "09'25\"/km",
      equivPace: "06'24\"/km",
      overall: "55/297",
      gender: "39/159",
      ageRank: 8,
      dnf: "22/275",
      femalePct: "46%",
      mountain: 5,
    },
  },
  {
    id: "2026-04-26-shaoxing-fuzhishan",
    file: "绍兴覆卮山徒步.gpx",
    name: "绍兴覆卮山",
    date: "2026-04-26",
    region: "浙江 · 绍兴",
    kind: "hike",
    color: "#D9482F",
    toleranceM: 4,
    eleThresholdM: 10,
  },
  {
    id: "2026-05-26-ali-kailash",
    file: "阿里冈仁波齐大环线.gpx",
    name: "阿里冈仁波齐大环线",
    date: "2026-05-26",
    region: "西藏 · 阿里",
    kind: "hike",
    color: "#D9482F",
    toleranceM: 4,
    eleThresholdM: 10,
  },
  {
    id: "2026-06-07-hangzhou-shililangdang",
    file: "杭州十里琅珰徒步.gpx",
    name: "杭州十里琅珰",
    date: "2026-06-07",
    region: "浙江 · 杭州",
    kind: "hike",
    color: "#D9482F",
    toleranceM: 4,
    eleThresholdM: 10,
  },
  {
    id: "2026-06-19-wuhan-jiuzhenshan",
    file: "武汉九真山越野跑.gpx",
    name: "武汉九真山越野跑",
    date: "2026-06-19",
    region: "湖北 · 武汉",
    kind: "race",
    color: "#1B6FF0",
    toleranceM: 4,
    eleThresholdM: 10,
    // ITRA 赛名 SALOMON Wuhan Community Dragon Boat Festival Mountain Trail Race，
    // ITRA 记录的比赛日是 2026-06-20（周六），GPX 文件名日期是 06-19，以 GPX 为准
    itra: {
      name: "SALOMON Trail Running Wuhan Community Dragon Boat Festival Mountain Trail Race - 21km",
      points: 1,
      perf: 423,
      finishTime: "4:22:22",
      category: "21km/1051m+",
      avgPace: "12'29\"/km",
      equivPace: "08'19\"/km",
      overall: "8/34",
      gender: "6/22",
      ageRank: 1,
      dnf: "13/21",
      femalePct: "35%",
      mountain: 5,
    },
  },
  {
    id: "2026-06-26-xinzhou-wutaishan-nichao",
    file: "忻州五台山逆朝.gpx",
    name: "忻州五台山逆朝",
    date: "2026-06-26",
    region: "山西 · 忻州",
    kind: "hike",
    color: "#D9482F",
    toleranceM: 4,
    eleThresholdM: 10,
  },
  {
    id: "2026-08-15-emeishan",
    file: "峨眉山报国寺道金顶.gpx",
    name: "峨眉山报国寺到金顶",
    date: "2026-08-15",
    region: "四川 · 乐山",
    kind: "hike",
    color: "#D9482F",
    toleranceM: 4,
    eleThresholdM: 10,
  },
];

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

const round = (v, d = 2) => {
  const f = 10 ** d;
  return Math.round(v * f) / f;
};

/** ISO8601 时长（秒）。两端时间都缺就返回 null。 */
function durationSeconds(startIso, endIso) {
  if (!startIso || !endIso) return null;
  const a = Date.parse(startIso);
  const b = Date.parse(endIso);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return null;
  return Math.round((b - a) / 1000);
}

/** 把 ISO 时间原样搬进数据文件，页面上再按本地时区格式化。 */
function isoOrNull(v) {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

if (!existsSync(SOURCE_DIR)) {
  console.error(`✗ 找不到原始 GPX 目录：${SOURCE_DIR}`);
  process.exit(1);
}
mkdirSync(GPX_OUT_DIR, { recursive: true });

const tracks = [];
let failures = 0;

for (const item of MANIFEST) {
  const abs = join(SOURCE_DIR, item.file);

  if (!existsSync(abs)) {
    console.error(`✗ 缺少源文件：tools/source/${item.file}`);
    failures += 1;
    continue;
  }

  const xml = readFileSync(abs, 'utf8');
  const rawSegments = parseGpx(xml);
  const rawFlat = flatten(rawSegments);

  if (rawFlat.length < 2) {
    console.error(`✗ 解析不出轨迹点：${item.file}（确认是 GPX，不是 KML / TCX）`);
    failures += 1;
    continue;
  }

  const waypointsRaw = parseWaypoints(xml);

  // 统计口径：原始几何 + 海拔阈值。不平滑，理由见文件头。
  const stats = trackStats(rawSegments, item.eleThresholdM);

  // 展示口径：抽稀后的原始几何。形状必须真实，不能是平滑过的。
  const displayed = simplifySegments(rawSegments, item.toleranceM);
  const paths = toMapPaths(displayed, 5);
  const shownPoints = paths.reduce((n, seg) => n + seg.length, 0);

  // 海拔剖面：经纬度用原始值（x 轴的距离刻度才准），只把海拔抹平一点好看
  const profile = elevationProfile(smoothElevation(rawSegments, 9), 200).map(([d, ele]) => [
    round(d, 3),
    round(ele, 1),
  ]);

  const waypoints = waypointsToMap(waypointsRaw, 5);

  const durationSec = durationSeconds(stats.startTime, stats.endTime);

  // NaN 中心点会静默画到画面外（真机上表现为"地图加载了但什么都没有"），
  // 这种错只能在构建期拦下来。
  const center = centerAndZoom(paths.flat());
  if (![center.lat, center.lng, center.zoom].every(Number.isFinite)) {
    console.error(
      `✗ ${item.name}：中心点/缩放算出了非有限值 ${JSON.stringify(center)}，通常是坐标形状不对`,
    );
    failures += 1;
    continue;
  }

  // 精简 GPX 落盘，供下载 / 导入其他软件
  const gpxName = `${item.id}.gpx`;
  writeFileSync(join(GPX_OUT_DIR, gpxName), writeGpx(item.name, displayed), 'utf8');

  tracks.push({
    id: item.id,
    name: item.name,
    date: item.date,
    region: item.region,
    kind: item.kind,
    color: item.color,
    startTime: isoOrNull(stats.startTime),
    endTime: isoOrNull(stats.endTime),
    stats: {
      distanceKm: round(stats.distanceKm, 2),
      ascentM: Math.round(stats.ascentM),
      descentM: Math.round(stats.descentM),
      minEle: Math.round(stats.minEle),
      maxEle: Math.round(stats.maxEle),
      durationSec,
      rawPoints: rawFlat.length,
      shownPoints,
      segments: rawSegments.length,
      sourceBytes: statSync(abs).size,
      gpx: `gpx/${gpxName}`,
      toleranceM: item.toleranceM,
      eleThresholdM: item.eleThresholdM,
      // 去休息后的近似移动指标（跨天 / 含过夜徒步用它算速度）
      movingTimeSec: stats.movingTimeSec || 0,
      movingDistanceKm: round(stats.movingDistanceKm, 2),
      movingSpeedKmh: round(stats.movingSpeedKmh, 2),
      restTimeSec: stats.restTimeSec || 0,
    },
    center,
    paths,
    profile,
    waypoints,
    // ITRA 成绩（仅越野跑比赛有）：积分/表现/排名/等强配速等，字段见 MANIFEST 注释
    ...(item.itra ? { itra: item.itra } : {}),
  });

  console.log(
    `✓ ${item.name}  原始 ${rawFlat.length} 点 / ${(statSync(abs).size / 1024).toFixed(0)} KB` +
      ` → 抽稀 ${shownPoints} 点` +
      `   距离 ${stats.distanceKm.toFixed(2)} km` +
      `   爬升 ${Math.round(stats.ascentM)} m（阈值 ${item.eleThresholdM} m）` +
      `   海拔 ${Math.round(stats.minEle)}~${Math.round(stats.maxEle)} m` +
      (durationSec ? `   用时 ${Math.floor(durationSec / 3600)}h${Math.round((durationSec % 3600) / 60)}m` : '   无时间戳'),
      (stats.movingSpeedKmh ? `   移动 ${(stats.movingTimeSec / 3600).toFixed(1)}h / ${stats.movingSpeedKmh.toFixed(1)} km/h` : ''),
  );
}

if (tracks.length === 0) {
  console.error('✗ 没有任何轨迹被处理，未写出数据文件。');
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* 写出数据文件                                                        */
/* ------------------------------------------------------------------ */

const json = JSON.stringify(tracks);

const header = `/**
 * 轨迹数据 —— 由 tools/build-tracks.mjs 自动生成，请不要手改。
 *
 * 重新生成：node tools/build-tracks.mjs
 * 源文件在 tools/source/，轨迹清单在该脚本的 MANIFEST 里。
 *
 * 几个字段的口径，避免后面自己看糊涂：
 *   paths      —— 原始几何抽稀后的坐标，已转成 GCJ-02（腾讯地图坐标系）。
 *                 用它画线，形状是对的。
 *   profile    —— [[累计公里, 海拔米], ...]，200 个采样点。距离刻度来自原始
 *                 几何，只有海拔值被轻微抹平过，纯粹为了让曲线别全是毛刺。
 *   stats.distanceKm —— 原始点间距直接累加，未平滑。
 *   stats.ascentM    —— 带海拔阈值过滤（见 eleThresholdM，默认 10 米），
 *                 低于阈值的起伏算高度抖动，不计入爬升。
 *                 爬升这个数在不同工具间天然对不齐，看的时候记得带上阈值口径。
 *   rawPoints  —— 原始记录点数；shownPoints —— 实际发给浏览器的点数。
 *   kind       —— "race" 本人跑过的记录，"course" 赛事官方路线（无时间戳，
 *                 所以 durationSec 为 null，页面不会显示配速）。
 *   itra       —— ITRA 官方成绩（越野跑比赛才有）：points 积分、perf 表现指数、
 *                 equivPace 等强配速、overall/gender/ageRank 排名、mountain 山地指数。
 *                 数据来自 ITRA athlete 6845683（LEI Ting），逐场从页面录入。
 */

window.MYWORLD = window.MYWORLD || {};

window.MYWORLD.tracks = ${json};
`;

writeFileSync(DATA_OUT, header, 'utf8');

const outKb = (Buffer.byteLength(header, 'utf8') / 1024).toFixed(0);
console.log(`\n✓ 已写出 assets/data/tracks.js（${outKb} KB，${tracks.length} 条轨迹）`);
console.log(`✓ 精简 GPX 已写入 gpx/`);

if (failures > 0) {
  console.error(`\n⚠ ${failures} 条轨迹处理失败，请检查上面的报错。`);
  process.exit(1);
}
