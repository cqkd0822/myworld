#!/usr/bin/env node
/**
 * git push 兜底通道 —— 针对本机公司出口的一个已知故障模式：
 * github.com 的读操作（ls-remote / fetch）正常，但 git-receive-pack 的
 * POST 会被中途掐断（"the remote end hung up unexpectedly"），SSH 22/443
 * 也被 reset。而 api.github.com 的 REST POST 能通过。
 *
 * 通道顺序：
 *   1. 正常 `git push`（子进程 cwd 固定 /tmp，遵守本机 AGENTS 的推送铁律）
 *   2. 失败/被杀 → GitHub REST API 逐提交复刻：blob → tree → commit → PATCH ref
 *
 * 用法：
 *   node tools/push.mjs            # 推 main：先 git push，失败自动走 API
 *   node tools/push.mjs <branch>   # 指定分支
 *   node tools/push.mjs --api      # 跳过 git push，强制走 API（调试/已知被掐时）
 *
 * 约束（有意为之，保持简单）：
 * - 只支持**快进**推送已存在的远端分支：不 force、不建新分支、不推 merge 提交
 * - 每个复刻提交的 SHA 都与本地逐位比对，任何不一致立即中止——远端要么
 *   与本地完全同 SHA，要么保持原状，绝不产生分叉历史
 * - 凭据走 `git credential fill`（osxkeychain），不落盘、不打印、不进环境变量
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SAFE_CWD = '/tmp'; // 本机铁律：git push 的进程 cwd 必须在仓库外
const args = process.argv.slice(2);
const forceApi = args.includes('--api');
const branch = args.filter((a) => !a.startsWith('--'))[0] || 'main';

const log = (s) => console.log(s);
const die = (s) => {
  console.error(`✘ ${s}`);
  process.exit(1);
};

/** git 子进程统一出口（cwd=/tmp）。失败返回 {ok:false,...}，不抛异常。 */
function git(gitArgs, { input, encoding = 'utf8', check = true } = {}) {
  const r = spawnSync('git', gitArgs, { cwd: SAFE_CWD, encoding, input, timeout: 120_000 });
  const ok = r.status === 0 && !r.signal;
  if (check && !ok) die(`git ${gitArgs.join(' ')} 失败（${r.signal || `exit ${r.status}`}）：${(r.stderr || r.stdout || '').toString().trim()}`);
  return { ok, out: (r.stdout || '').toString(), err: (r.stderr || '').toString(), signal: r.signal };
}

// ---------- 仓库与凭据 ----------
const remoteUrl = git(['-C', ROOT, 'remote', 'get-url', 'origin']).out.trim();
const m = remoteUrl.match(/github\.com[/:]([^/]+)\/([^#?]+)/);
if (!m) die(`origin 不是 GitHub HTTPS 远端：${remoteUrl}`);
const [owner, repoRaw] = [m[1], m[2]];
const repo = repoRaw.replace(/\.git$/, '');

const cred = git(['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n', check: false });
const token = (cred.out.match(/^password=(.+)$/m) || [])[1]?.trim();
if (!token) die('osxkeychain 里没有 github.com 凭据；先手动成功 push 一次让 git 存住，或用 gh 登录。');

// ---------- REST API ----------
async function api(method, path, body) {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'myworld-push-fallback',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    die(`API ${method} /${path} → HTTP ${res.status}：${text.slice(0, 300)}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

function lsRemote() {
  const r = git(['-C', ROOT, 'ls-remote', 'origin', `refs/heads/${branch}`], { check: false });
  if (!r.ok) die(`ls-remote 失败：${r.err.trim()}`);
  return r.out.trim().split('\t')[0] || '';
}

// ---------- 提交元数据（用 cat-file 原始解析，保证 SHA 可复现） ----------
function tzToIso(epoch, tz) {
  const d = new Date(Number(epoch) * 1000);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const sign = tz[0];
  const [oh, om] = [Number(tz.slice(1, 3)), Number(tz.slice(3, 5))];
  const local = new Date(d.getTime() + (sign === '+' ? 1 : -1) * (oh * 60 + om) * 60000);
  const p = (n) => pad(n);
  return (
    `${local.getUTCFullYear()}-${p(local.getUTCMonth() + 1)}-${p(local.getUTCDate())}` +
    `T${p(local.getUTCHours())}:${p(local.getUTCMinutes())}:${p(local.getUTCSeconds())}` +
    `${tz.slice(0, 3)}:${tz.slice(3, 5)}`
  );
}

function parseWho(line) {
  const m = line.match(/^(.*?) <(.*)> (\d+) ([+-]\d{4})$/);
  if (!m) die(`无法解析署名行：${line}`);
  return { name: m[1], email: m[2], date: tzToIso(m[3], m[4]) };
}

function commitMeta(sha) {
  const raw = git(['-C', ROOT, 'cat-file', 'commit', sha]).out;
  const head = raw.slice(0, raw.indexOf('\n\n'));
  const message = raw.slice(raw.indexOf('\n\n') + 2); // 原始消息字节（含结尾换行）
  const h = {};
  const parents = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) h.tree = line.slice(5);
    else if (line.startsWith('parent ')) parents.push(line.slice(7));
    else if (line.startsWith('author ')) h.author = parseWho(line.slice(7));
    else if (line.startsWith('committer ')) h.committer = parseWho(line.slice(10));
    // gpgsig 等多行头忽略：本仓库提交未签名
  }
  return { sha, tree: h.tree, parents, author: h.author, committer: h.committer, message };
}

/** 相对第一父提交的变更（A/M/D；C/R 按新路径整体入库）。 */
function changedFiles(sha) {
  const r = git(['-C', ROOT, 'diff-tree', '--no-commit-id', '--name-status', '-r', '-z', sha]);
  const fields = r.out.split('\0').filter((x) => x !== '');
  const out = [];
  for (let i = 0; i < fields.length; ) {
    const status = fields[i][0];
    if (status === 'C' || status === 'R') {
      out.push({ status: 'A', path: fields[i + 2] });
      i += 3;
    } else {
      out.push({ status, path: fields[i + 1] });
      i += 2;
    }
  }
  return out;
}

function readAt(sha, path, mode) {
  if (mode === '120000') die(`暂不支持符号链接：${path}`);
  const buf = spawnSync('git', ['-C', ROOT, 'show', `${sha}:${path}`], {
    cwd: SAFE_CWD, encoding: 'buffer', timeout: 60_000,
  });
  if (buf.status !== 0) die(`读 ${sha}:${path} 失败`);
  return buf.stdout;
}

/** 在远端复刻一个提交（parentTree 为其第一父提交在远端的 tree）。 */
async function replicateCommit(meta, parentTree) {
  const items = [];
  for (const f of changedFiles(meta.sha)) {
    if (f.status === 'D') {
      items.push({ path: f.path, mode: '100644', type: 'blob', sha: null });
      continue;
    }
    const ls = git(['-C', ROOT, 'ls-tree', meta.sha, '--', f.path]).out;
    const em = ls.match(/^(\d+) blob ([0-9a-f]+)\t/);
    if (!em) die(`${meta.sha} 里找不到 ${f.path}`);
    const blob = await api('POST', 'git/blobs', {
      content: readAt(meta.sha, f.path, em[1]).toString('base64'),
      encoding: 'base64',
    });
    items.push({ path: f.path, mode: em[1], type: 'blob', sha: blob.sha });
  }
  const tree = items.length
    ? await api('POST', 'git/trees', { base_tree: parentTree, tree: items })
    : { sha: parentTree };
  if (tree.sha !== meta.tree) die(`tree 不一致：远端 ${tree.sha} ≠ 本地 ${meta.tree}，中止（远端未动）`);
  const created = await api('POST', 'git/commits', {
    message: meta.message,
    tree: tree.sha,
    parents: meta.parents,
    author: meta.author,
    committer: meta.committer,
  });
  if (created.sha !== meta.sha) {
    die(`提交 SHA 不一致：远端 ${created.sha} ≠ 本地 ${meta.sha}，中止（远端未动）`);
  }
  log(`  ✓ 复刻 ${meta.sha.slice(0, 8)} ${meta.message.split('\n')[0].slice(0, 50)}`);
  return { sha: created.sha, tree: tree.sha };
}

// ---------- 主流程 ----------
const localSha = git(['-C', ROOT, 'rev-parse', branch]).out.trim();
const remoteSha = lsRemote();
if (remoteSha === localSha) {
  log(`✓ ${branch} 已是最新（${localSha.slice(0, 8)}），无需推送`);
  process.exit(0);
}
if (!remoteSha) die(`远端不存在 refs/heads/${branch}；新分支请手动推送一次建立`);
const anc = spawnSync('git', ['-C', ROOT, 'merge-base', '--is-ancestor', remoteSha, localSha], {
  cwd: SAFE_CWD, timeout: 30_000,
});
if (anc.status !== 0) die(`不是快进（远端 ${remoteSha.slice(0, 8)} 不是本地 ${localSha.slice(0, 8)} 的祖先）；请先 fetch/rebase`);

if (!forceApi) {
  log(`→ 尝试常规 git push origin ${branch} …`);
  const push = git(['-C', ROOT, 'push', 'origin', branch], { check: false });
  if (push.ok && lsRemote() === localSha) {
    log(`✓ git push 成功，远端 ${branch} = ${localSha.slice(0, 8)}`);
    process.exit(0);
  }
  log(`⚠ git push 未成功（${push.signal || `exit ${push.status}`}：${(push.err || push.out).trim().slice(0, 160)}）`);
  log('→ 切换 GitHub REST API 兜底通道');
} else {
  log('→ 按参数跳过 git push，直接走 API 兜底通道');
}

const commits = git(['-C', ROOT, 'rev-list', '--reverse', `${remoteSha}..${localSha}`]).out
  .trim().split('\n').filter(Boolean);
if (commits.length === 0) die('没有待推提交（不一致来自本地分支指针？）');
if (commits.some((c) => commitMeta(c).parents.length > 1)) {
  die('待推提交中含 merge 提交，API 复刻未实现，请手动处理');
}

let parentTree = (await api('GET', `git/commits/${remoteSha}`)).tree.sha;
for (const c of commits) {
  const r = await replicateCommit(commitMeta(c), parentTree);
  parentTree = r.tree;
}
await api('PATCH', `git/refs/heads/${branch}`, { sha: localSha, force: false });
const finalSha = lsRemote();
if (finalSha !== localSha) die(`校验失败：远端 ${finalSha.slice(0, 8)} ≠ 本地 ${localSha.slice(0, 8)}`);
log(`✓ API 通道推送成功：远端 ${branch} = ${localSha.slice(0, 8)}（${commits.length} 个提交，SHA 逐位一致）`);
