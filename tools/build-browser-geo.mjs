#!/usr/bin/env node
/**
 * 把 src/geo.mjs 与 src/raw.js 编译成浏览器可用的普通 <script>。
 *
 * 为什么需要这一步：Worker 免费档每次调用只有 10 ms CPU，而最长那条轨迹
 * （五台山逆朝 14162 点）的抽稀+剖面要算 30 ms 左右——在边缘算必然被掐死。
 * 所以几何计算放在浏览器：Worker 只把 track_raw 的原始点发过去，
 * 抽稀 / 海拔剖面 / GCJ-02 纠偏全在前端做（手机上一次约几十毫秒，
 * 和加载腾讯地图 GL 的开销比可以忽略）。
 *
 * 算法只有一份源码（src/geo.mjs / src/raw.js），Node 构建、浏览器共用，
 * 避免前后端两套实现慢慢跑偏。这里只做「去掉 export 关键字 + 包 IIFE」
 * 的机械转换，不改任何逻辑。
 *
 * 用法：node tools/build-browser-geo.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const TARGETS = [
  {
    src: 'src/geo.mjs',
    out: 'assets/js/geo.js',
    ns: 'geo',
    exports: [
      'wgs84ToGcj02', 'parseGpx', 'parseWaypoints', 'flatten', 'haversine',
      'simplify', 'simplifySegments', 'smoothSegments', 'smoothElevation',
      'trackStats', 'elevationProfile', 'centerAndZoom', 'toMapPaths',
      'waypointsToMap', 'writeGpx',
    ],
  },
  {
    src: 'src/raw.js',
    out: 'assets/js/raw.js',
    ns: 'raw',
    exports: ['RAW_VERSION', 'COORD_SCALE', 'ELE_SCALE', 'gzipToB64', 'gunzipFromB64', 'sha1B64', 'encodeSegment', 'decodeSegment', 'packSegment', 'unpackParts'],
  },
];

for (const t of TARGETS) {
  const code = readFileSync(join(ROOT, t.src), 'utf8');
  // 只去掉行首的 export 关键字；模块里没有 import，所以无需处理依赖
  const body = code
    .split('\n')
    .map((line) => (line.startsWith('export ') ? line.slice('export '.length) : line))
    .join('\n');

  const out =
    `/**\n * ⚠ 生成文件，勿手改。源：${t.src}\n` +
    ` * 生成：node tools/build-browser-geo.mjs\n` +
    ` * 浏览器端与 Node 构建共用同一套几何/编码算法（见源文件头注释）。\n */\n` +
    `(function () {\n` +
    body +
    `\n  const M = (window.MYWORLD = window.MYWORLD || {});\n` +
    `  M.${t.ns} = { ${t.exports.join(', ')} };\n` +
    `})();\n`;

  writeFileSync(join(ROOT, t.out), out, 'utf8');
  console.log(`✓ ${t.out}（${(out.length / 1024).toFixed(1)} KB，源 ${t.src}）`);
}
