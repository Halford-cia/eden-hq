#!/usr/bin/env node
// npm run check:public [-- --ci] [--base <ref> --head <ref>] [--repo <dir>]
// node scripts/check-public.mjs --pre-push <remote>   (the pre-push hook; refs on stdin)
//
// This repository is public. Reviews every outgoing commit (not only the
// final tree): in the hook, the commits the push sends; in CI, the event's
// base..head; otherwise the merge base with origin/main up to HEAD. Every
// changed file is inspected, or the scan fails. It fails on: environment files
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

const ZERO = /^0+$/;
const revList = (...a) => gitText('rev-list', '--reverse', ...a).split('\n').filter(Boolean);

function objectExists(sha) {
  try {
    git('cat-file', '-e', `${sha}^{commit}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * The commits leaving this machine (review P1-10).
 *   --pre-push <remote>: Git's list of outgoing refs on stdin
 *     (`<local ref> <local sha> <remote ref> <remote sha>` per line); every
 *     commit reachable from a pushed sha that the remote does not have.
 *   --base <sha> --head <sha> (CI: the event's SHAs): base..head; an all-zero
 *     base (a first push) means the whole history of head.
 *   Otherwise: the merge base with origin/main up to HEAD.
 */
function outgoingCommits() {
  const prePush = args.indexOf('--pre-push');
  if (prePush >= 0) {
    const remote = args[prePush + 1];
    if (!remote || remote.startsWith('--')) {
      console.error('check:public: --pre-push needs the remote name (the hook passes "$1").');
      process.exit(2);
    }
    const input = readFileSync(0, 'utf8');
    const seen = new Set();
    const commits = [];
    for (const line of input.split('\n').map((l) => l.trim()).filter(Boolean)) {
      const [, localSha, , remoteSha] = line.split(/\s+/);
      if (!localSha || ZERO.test(localSha)) continue; // a deletion sends no commits
      const not = ['--not', `--remotes=${remote}`];
      if (remoteSha && !ZERO.test(remoteSha) && objectExists(remoteSha)) not.push(remoteSha);
      for (const c of revList(localSha, ...not)) {
        if (!seen.has(c)) {
          seen.add(c);
          commits.push(c);
        }
      }
    }
    return commits;
  }
  const head = opt('--head') || process.env.EDEN_PUBLIC_HEAD || 'HEAD';
  const explicit = opt('--base') || process.env.EDEN_PUBLIC_BASE;
  if (explicit && ZERO.test(explicit)) return revList(head);
  if (explicit) return revList(`${gitText('merge-base', explicit, head)}..${head}`);
  for (const ref of ['origin/main', 'origin/HEAD']) {
    try {
      return revList(`${gitText('merge-base', ref, head)}..${head}`);
    } catch { /* try next */ }
  }
  return revList(head); // no remote base: review every commit
}

/**
 * The files a commit adds or changes, read NUL-delimited so no name is
 * quoted or split (review P1-11). Merges are compared with each parent.
 */
function changedEntries(commit) {
  const out = git('diff-tree', '-z', '-r', '-m', '--no-commit-id', '--root', '-M', '--raw', commit)
    .toString('utf8').split('\0');
  const entries = [];
  for (let i = 0; i < out.length; i++) {
    const meta = out[i];
    if (!meta.startsWith(':')) continue;
    const [, newMode, , newSha, status] = meta.slice(1).split(' ');
    const kind = status[0];
    const paths = kind === 'R' || kind === 'C' ? [out[i + 1], out[i + 2]] : [out[i + 1]];
    i += paths.length;
    if (kind === 'D') continue;
    entries.push({ path: paths[paths.length - 1], allPaths: paths, mode: newMode, sha: newSha });
  }
  return entries;
}

const WITHHELD = '<file name withheld: deny-listed term>';

/** A path as it may appear in a report: withheld if any name holds a private term. */
function displayPath(paths, denyList) {
  if (paths.some((p) => denyList.some((d) => p.toLowerCase().includes(d)))) return WITHHELD;
  // Control characters are shown escaped so a name cannot forge report lines.
  return paths[paths.length - 1].replace(/[\u0000-\u001f\u007f]/g, (ch) => `\\x${ch.charCodeAt(0).toString(16).padStart(2, '0')}`);
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
  const commits = outgoingCommits();
  const problems = [];
  if (ci && !commits.length) {
    console.error('check:public FAILED: no commits in the range, so nothing was reviewed. Pass the event\'s base and head SHAs (--base, --head).');
    process.exit(1);
  }

  for (const c of commits) {
    const short = c.slice(0, 10);
    const message = gitText('log', '-1', '--format=%B', c);
    for (const f of keyShapedFindings(message)) problems.push(`${short} · commit message · key-shaped value: ${f}`);
    if (denyList.some((d) => message.toLowerCase().includes(d))) problems.push(`${short} · commit message · deny-listed term`);

    for (const entry of changedEntries(c)) {
      // Formatting a finding never uses a name that holds a private term (review P0-4).
      const shown = displayPath(entry.allPaths, denyList);
      const rules = [];
      if (entry.allPaths.some((p) => denyList.some((d) => p.toLowerCase().includes(d)))) {
        rules.push('deny-listed term in the file name');
      }
      rules.push(...pathFindings(entry.path));
      if (entry.mode === '160000') {
        rules.push('entry could not be inspected (a submodule link); the scan cannot pass');
      } else {
        let buf = null;
        try {
          buf = git('cat-file', 'blob', entry.sha);
        } catch {
          rules.push('entry could not be inspected (its contents could not be read); the scan cannot pass');
        }
        if (buf) {
          rules.push(...contentFindings(entry.path, buf, denyList)
            .filter((r) => r !== 'deny-listed term in the file name'));
        }
      }
      for (const r of rules) problems.push(`${short} · ${shown} · ${r}`);
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
