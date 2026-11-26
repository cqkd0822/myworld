#!/usr/bin/env node
/**
 * [INPUT]: depends on local GPX files in gpx/ and tools/source/, and on Cloudflare credentials in .env.
 * [OUTPUT]: provides a CLI that uploads GPX files and a sha256 manifest to the myworld-gpx R2 bucket.
 * [POS]: the R2 migration tool for public simplified GPX and private original GPX; it does not touch D1 or the Worker.
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
import { createHash } from 'node:crypto';
import { execFile as execFileCb, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, readdirSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const execFile = promisify(execFileCb);
const ROOT = join(HERE, '..');
const BUCKET = 'myworld-gpx';
const ENV_FILE = join(ROOT, '.env');
const TARGETS = [
  { localDir: join(ROOT, 'gpx'), prefix: 'gpx/' },
  { localDir: join(ROOT, 'tools', 'source'), prefix: 'source/' },
];

function loadEnv() {
  const env = { ...process.env };
  if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN) {
    const text = readFileSync(ENV_FILE, 'utf8');
    for (const line of text.split('\n')) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (match && !env[match[1]]) env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
    }
  }
  return env;
}

function sha256(file) {
  const hash = createHash('sha256');
  hash.update(readFileSync(file));
  return hash.digest('hex');
}

function filesIn(dir) {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.gpx'))
    .map((name) => join(dir, name))
    .sort();
}

function collect() {
  return TARGETS.flatMap(({ localDir, prefix }) =>
    filesIn(localDir).map((file) => ({
      file,
      key: `${prefix}${basename(file)}`,
      size: statSync(file).size,
      sha256: sha256(file),
    })),
  );
}

function wrangler(args, env) {
  const result = spawnSync('npx', ['wrangler', ...args], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 20,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`wrangler ${args.join(' ')} failed:\n${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function upload(item, env) {
  const args = [
    'r2', 'object', 'put', `${BUCKET}/${item.key}`,
    '--file', item.file,
    '--content-type', 'application/gpx+xml',
    '--remote',
  ];
  wrangler(args, env);
  process.stdout.write(`uploaded ${item.key}\n`);
}

async function verifyItem(item, env, index) {
  const temp = join('/private/tmp', `myworld-r2-verify-${index}.gpx`);
  const args = [
    'wrangler', 'r2', 'object', 'get', `${BUCKET}/${item.key}`,
    '--file', temp, '--remote',
  ];
  await execFile('npx', args, { cwd: ROOT, env, maxBuffer: 1024 * 1024 * 20 });
  const remoteHash = sha256(temp);
  unlinkSync(temp);
  if (remoteHash !== item.sha256) {
    throw new Error(`hash mismatch for ${item.key}: local ${item.sha256}, remote ${remoteHash}`);
  }
  process.stdout.write(`verified ${item.key}\n`);
}

async function verifyAll(items, env) {
  const batchSize = 8;
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    await Promise.all(batch.map((item, offset) => verifyItem(item, env, i + offset)));
  }
  process.stdout.write(`R2 GPX verify complete: ${items.length} objects.\n`);
}

function buildManifest(items) {
  return {
    bucket: BUCKET,
    generatedAt: new Date().toISOString(),
    objects: items.map(({ key, size, sha256 }) => ({ key, size, sha256 })),
  };
}

function uploadManifest(manifest, env) {
  const file = join(ROOT, '.r2-gpx-manifest.json');
  writeFileSync(file, JSON.stringify(manifest, null, 2));
  wrangler([
    'r2', 'object', 'put', `${BUCKET}/manifest.json`,
    '--file', file,
    '--content-type', 'application/json',
    '--remote',
  ], env);
  unlinkSync(file);
  process.stdout.write('uploaded manifest.json\n');
}

const mode = process.argv[2] || 'upload';
const env = loadEnv();
const items = collect();

if (mode === 'upload') {
  if (!items.length) throw new Error('No GPX files found.');
  for (const item of items) upload(item, env);
  uploadManifest(buildManifest(items), env);
  process.stdout.write(`R2 GPX sync complete: ${items.length} objects.\n`);
} else if (mode === 'manifest') {
  uploadManifest(buildManifest(items), env);
} else if (mode === 'verify') {
  if (!items.length) throw new Error('No GPX files found.');
  await verifyAll(items, env);
} else if (mode === 'list') {
  for (const item of items) process.stdout.write(`${item.key}\t${item.size}\t${item.sha256}\n`);
} else {
  throw new Error(`Unknown mode: ${mode}. Use upload, manifest, or list.`);
}
