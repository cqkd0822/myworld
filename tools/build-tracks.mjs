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
 * 为什么不先平滑再算距离：实测 TOR330 那条 337 公里的赛道，5 点滑动平均
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
 *                抖动丢弃。10 米是个稳妥的默认值：TOR330 用 10 米算出
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
  },
  {
    id: 'tor330-2026',
    file: 'TOR330-CERT-2026.gpx',
    name: 'TOR des Géants 330',
    date: '2026-09',
    region: '意大利 · 奥斯塔谷',
    kind: 'course',
    color: '#D9482F',
    toleranceM: 12,
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
    },
    center,
    paths,
    profile,
    waypoints,
  });

  console.log(
    `✓ ${item.name}  原始 ${rawFlat.length} 点 / ${(statSync(abs).size / 1024).toFixed(0)} KB` +
      ` → 抽稀 ${shownPoints} 点` +
      `   距离 ${stats.distanceKm.toFixed(2)} km` +
      `   爬升 ${Math.round(stats.ascentM)} m（阈值 ${item.eleThresholdM} m）` +
      `   海拔 ${Math.round(stats.minEle)}~${Math.round(stats.maxEle)} m` +
      (durationSec ? `   用时 ${Math.floor(durationSec / 3600)}h${Math.round((durationSec % 3600) / 60)}m` : '   无时间戳'),
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
