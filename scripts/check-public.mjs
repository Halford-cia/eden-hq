#!/usr/bin/env node
// npm run check:public [-- --ci] [--base <ref>] [--repo <dir>]
//
// This repository is public. Reviews every outgoing commit between the remote
// base and HEAD (not only the final tree) and fails on: environment files
// other than .env.example; roster, backup, dump, export or archive files;
// CSV/JSON/SQL data outside fixtures/ and images outside fixtures/images/;
// fixture files without a SYNTHETIC marker; key-shaped values; and any entry
// in Hank's private deny-list (local runs only: EDEN_DENYLIST_FILE names a
// file outside the repository). Reports name the file, commit and rule, never
// the matched text.

import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, existsSync } from 'node:fs';
import { resolve, sep, basename, extname } from 'node:path';
import { keyShapedFindings } from './lib/secrets.mjs';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const ci = args.includes('--ci') || process.env.EDEN_PUBLIC_CI === '1';
const repo = resolve(opt('--repo') || process.cwd());

const git = (...a) => execFileSync('git', ['-C', repo, ...a], { maxBuffer: 64 * 1024 * 1024 });
const gitText = (...a) => git(...a).toString('utf8').trim();

const DATA_EXT = new Set(['.csv', '.tsv', '.json', '.jsonl', '.ndjson', '.sql', '.xlsx', '.xls', '.ods', '.db', '.sqlite', '.sqlite3']);
const ARCHIVE_EXT = new Set(['.zip', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar', '.age', '.dump', '.bak', '.backup', '.pgdump', '.gpg']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic', '.heif', '.bmp', '.tif', '.tiff', '.svg', '.ico', '.avif']);
const DATA_NAME = /(roster|register|backup|dump|export|archive|members|guests?)/i;
// Code and config that carry these extensions but are not data.
const ALLOWED_DATA_PATHS = [
  /^package\.json$/,
  /^package-lock\.json$/,
  /^supabase\/migrations\/\d{14}_[a-z0-9_]+\.sql$/,
];

function loadDenyList() {
  if (ci) return [];
  const file = process.env.EDEN_DENYLIST_FILE;
  if (!file) {
    console.error('check:public: set EDEN_DENYLIST_FILE to Hank\'s private deny-list (a file outside this repository), or pass --ci in CI.');
    process.exit(2);
  }
  if (!existsSync(file)) {
    console.error('check:public: the file named by EDEN_DENYLIST_FILE does not exist.');
    process.exit(2);
  }
  const real = realpathSync(file);
  const root = realpathSync(repo);
  if (real === root || real.startsWith(root + sep)) {
    console.error('check:public: the deny-list must live outside this repository.');
    process.exit(2);
  }
  return readFileSync(real, 'utf8').split(/\r?\n/).map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#')).map((l) => l.toLowerCase());
}

function baseRef() {
  const explicit = opt('--base') || process.env.EDEN_PUBLIC_BASE;
  if (explicit) return gitText('merge-base', explicit, 'HEAD');
  for (const ref of ['origin/main', 'origin/HEAD']) {
    try {
      return gitText('merge-base', ref, 'HEAD');
    } catch { /* try next */ }
  }
  return null; // no remote base: review every commit
}

function isBinary(buf) {
  return buf.subarray(0, 8000).includes(0);
}

export function pathFindings(path) {
  const found = [];
  const name = basename(path);
  const ext = extname(name).toLowerCase();
  const inFixtures = path.startsWith('fixtures/');
  if (/^\.env($|\.)/.test(name) && name !== '.env.example') found.push('environment file');
  if (ARCHIVE_EXT.has(ext)) found.push('archive or backup file');
  if (!inFixtures && DATA_NAME.test(name) && (DATA_EXT.has(ext) || ext === '.txt')) {
    found.push('roster, backup, dump or export file');
  }
  if (DATA_EXT.has(ext) && !inFixtures && !ALLOWED_DATA_PATHS.some((re) => re.test(path))) {
    found.push('data file outside fixtures/');
  }
  if (IMAGE_EXT.has(ext) && !path.startsWith('fixtures/images/')) found.push('image outside fixtures/images/');
  return found;
}

export function contentFindings(path, buf, denyList) {
  const found = [];
  const binary = isBinary(buf);
  if (path.startsWith('fixtures/')) {
    const marked = binary ? /synthetic/i.test(basename(path)) : buf.toString('utf8').includes('SYNTHETIC');
    if (!marked) found.push('fixture without a SYNTHETIC marker');
  }
  if (!binary) {
    const text = buf.toString('utf8');
    for (const f of keyShapedFindings(text)) found.push(`key-shaped value: ${f}`);
    const lower = text.toLowerCase();
    if (denyList.some((d) => lower.includes(d))) found.push('deny-listed term');
  }
  if (denyList.some((d) => path.toLowerCase().includes(d))) found.push('deny-listed term in the file name');
  return found;
}

function main() {
  const denyList = loadDenyList();
  const base = baseRef();
  const range = base ? [`${base}..HEAD`] : ['HEAD'];
  const commits = gitText('rev-list', '--reverse', ...range).split('\n').filter(Boolean);
  const problems = [];

  for (const c of commits) {
    const short = c.slice(0, 10);
    const message = gitText('log', '-1', '--format=%B', c);
    for (const f of keyShapedFindings(message)) problems.push(`${short} · commit message · key-shaped value: ${f}`);
    if (denyList.some((d) => message.toLowerCase().includes(d))) problems.push(`${short} · commit message · deny-listed term`);

    const entries = gitText('diff-tree', '--no-commit-id', '--root', '-r', '-M', '--name-status', c)
      .split('\n').filter(Boolean);
    for (const line of entries) {
      const parts = line.split('\t');
      const status = parts[0][0];
      if (status === 'D') continue;
      const path = parts[parts.length - 1];
      const rules = [...pathFindings(path)];
      let buf;
      try {
        buf = git('show', `${c}:${path}`);
      } catch {
        continue; // submodule or unreadable entry
      }
      rules.push(...contentFindings(path, buf, denyList));
      for (const r of rules) problems.push(`${short} · ${path} · ${r}`);
    }
  }

  if (problems.length) {
    console.error(`check:public FAILED (${problems.length}). Nothing here is safe to push:`);
    for (const p of [...new Set(problems)]) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log(`check:public passed: ${commits.length} outgoing commit(s) reviewed${ci ? ' (CI: deny-list not applied)' : ', deny-list applied'}.`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('check-public.mjs')) {
  main();
}
