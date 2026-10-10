#!/usr/bin/env node
/**
 * 缓存版本号自动化。
 *
 * index.html 里每个静态资源都带 ?v=xxx。之前这个 xxx 是手改的
 * （20261010a 这种），忘改就会让浏览器一直用旧文件。
 *
 * 这里改成：对 assets/ 下全部文件的内容做 sha256，取前 8 位当版本号，
 * 一次性替换 index.html 里所有 ?v=。内容不变版本号就不变（缓存继续命中），
 * 内容一变版本号必变（缓存必然失效）。
 *
 * 用法：node tools/bump-cache.mjs   （改完资源后、提交前跑一次）
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else files.push(p);
  }
})(join(ROOT, 'assets'));

const hash = createHash('sha256');
for (const f of files) hash.update(readFileSync(f));
const v = hash.digest('hex').slice(0, 8);

const idx = join(ROOT, 'index.html');
const before = readFileSync(idx, 'utf8');
const after = before.replace(/\?v=[0-9a-zA-Z]+/g, `?v=${v}`);

if (after === before) {
  console.log(`?v=${v} 已是一致的，index.html 未改动（${files.length} 个资源文件参与哈希）`);
} else {
  writeFileSync(idx, after);
  console.log(`?v= 已更新为 ${v}（${files.length} 个资源文件参与哈希）`);
}
