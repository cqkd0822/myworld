#!/usr/bin/env node
/**
 * 把现有 assets/data/*.js 的种子数据灌进 D1。
 *
 * 用法：
 *   node tools/seed-d1.mjs            # 只生成 seed.sql
 *   node tools/seed-d1.mjs --apply    # 生成并用 wrangler 执行到远端 D1
 *
 * 字段顺序与 schema.sql 一致；/api/* 会按同样顺序返回数组，
 * 保证和现在 window.MYWORLD.* 的形状完全同构。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

// 数据文件是浏览器全局脚本，用 window shim 在 Node 里加载
globalThis.window = globalThis.window || {};
for (const f of ['airports.js', 'flights.js', 'rail.js', 'tracks.js', 'site.js']) {
  const code = readFileSync(join(ROOT, 'assets/data', f), 'utf8');
  // eslint-disable-next-line no-new-func
  new Function(code)();
}
const M = globalThis.window.MYWORLD;

const q = (v) => {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  return `'${String(v).replace(/'/g, "''")}'`;
};

const out = [];
// D1 不接受 SQL 文件里的 BEGIN/COMMIT（wrangler 自行批处理），去掉
out.push('DELETE FROM flights; DELETE FROM rail; DELETE FROM rail_voided; DELETE FROM tracks;');

for (const r of M.flights) {
  const [id, date, airline, no, from, to, aircraft, reg, std, sta, ata, cabin, seat, price, delay] = r;
  out.push(
    `INSERT INTO flights VALUES (${id},${q(date)},${q(airline)},${q(no)},${q(from)},${q(to)},${q(aircraft)},${q(reg)},${q(std)},${q(sta)},${q(ata)},${q(cabin)},${q(seat)},${price == null ? 'NULL' : price},${delay == null ? 'NULL' : delay},'');`,
  );
}
for (const r of M.rail) {
  const [id, date, train, from, to, seat, note] = r;
  out.push(`INSERT INTO rail VALUES (${id},${q(date)},${q(train)},${q(from)},${q(to)},${q(seat)},${q(note)});`);
}
for (const r of M.railVoided) {
  const [train, from, to, date, reason] = r;
  out.push(`INSERT INTO rail_voided (train,from_station,to_station,date,reason) VALUES (${q(train)},${q(from)},${q(to)},${q(date)},${q(reason)});`);
}
for (const t of M.tracks) {
  const s = t.stats || {};
  out.push(
    `INSERT INTO tracks VALUES (${q(t.id)},${q(t.name)},${q(t.date)},${q(t.region)},${q(t.kind)},${q(t.color)},` +
      `${q(t.startTime)},${q(t.endTime)},${q(s.distanceKm)},${q(s.ascentM)},${q(s.descentM)},${q(s.minEle)},${q(s.maxEle)},` +
      `${q(s.durationSec)},${q(s.movingTimeSec)},${q(s.movingDistanceKm)},${q(s.movingSpeedKmh)},${q(s.restTimeSec)},` +
      `${q(s.rawPoints)},${q(s.shownPoints)},${q(s.segments)},${q(s.gpx)},${q(s.toleranceM)},${q(s.eleThresholdM)},` +
      `${q(t.center?.lat)},${q(t.center?.lng)},${q(t.center?.zoom)});`,
  );
}
out.push(`INSERT OR REPLACE INTO meta VALUES ('seeded_at', '${new Date().toISOString()}');`);

const sql = out.join('\n') + '\n';
writeFileSync(join(ROOT, 'seed.sql'), sql);
console.log(
  `✓ seed.sql 已生成：flights=${M.flights.length} rail=${M.rail.length} voided=${M.railVoided.length} tracks=${M.tracks.length}（${(sql.length / 1024).toFixed(0)} KB）`,
);

if (process.argv.includes('--apply')) {
  execSync('npx -y wrangler d1 execute myworld --remote --file=seed.sql', { cwd: ROOT, stdio: 'inherit' });
}
