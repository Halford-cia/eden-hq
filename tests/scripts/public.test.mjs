// check:public reviews every outgoing commit. Each case builds a throwaway
// git repository with synthetic content and runs the real script against it.
// Secret-shaped values are assembled at run time so this file holds none.

import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { repoRoot } from '../db/harness.mjs';

const script = join(repoRoot, 'scripts', 'check-public.mjs');

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'eden-public-'));
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'synthetic@example.test');
  g('config', 'user.name', 'Synthetic');
  writeFileSync(join(dir, 'README.md'), '# SYNTHETIC\n');
  g('add', '.');
  g('commit', '-q', '-m', 'base');
  g('branch', 'base');
  const commit = (files, message = 'change') => {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    g('add', '-A');
    g('commit', '-q', '-m', message);
  };
  const remove = (path) => {
    g('rm', '-q', path);
    g('commit', '-q', '-m', 'remove');
  };
  return { dir, commit, remove };
}

function run(dir, { deny, ci = false } = {}) {
  const env = { ...process.env };
  delete env.EDEN_DENYLIST_FILE;
  delete env.EDEN_PUBLIC_CI;
  const args = [script, '--repo', dir, '--base', 'base'];
  if (ci) args.push('--ci');
  if (deny !== undefined) {
    const d = mkdtempSync(join(tmpdir(), 'eden-deny-'));
    writeFileSync(join(d, 'deny.txt'), `# private\n${deny}\n`);
    env.EDEN_DENYLIST_FILE = join(d, 'deny.txt');
  }
  const r = spawnSync(process.execPath, args, { env, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const supabaseSecret = () => ['sb', 'secret', 'Q'.repeat(30)].join('_');
const serviceRoleJwt = () => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ role: 'service_role', iss: 'synthetic' })}.${'s'.repeat(43)}`;
};

describe('check:public', () => {
  it('passes clean synthetic code and fixtures', () => {
    const r = makeRepo();
    r.commit({
      'src/a.js': 'export const x = 1;\n',
      'fixtures/tasks.csv': 'title\nSYNTHETIC Frame walls\n',
      '.env.example': 'VITE_SUPABASE_URL=https://<project-ref>.supabase.co\n',
      'supabase/migrations/20990101000000_example.sql': 'select 1;\n',
    });
    const res = run(r.dir, { deny: 'nothing-matches-this' });
    expect(res.out).toContain('passed');
    expect(res.code).toBe(0);
    rmSync(r.dir, { recursive: true, force: true });
  });

  it('refuses a deny-listed value, naming file, commit and rule but never the text', () => {
    const r = makeRepo();
    r.commit({ 'docs/notes.md': 'Meet at 12 Synthetic-Private Lane.\n' });
    const res = run(r.dir, { deny: 'synthetic-private lane' });
    expect(res.code).toBe(1);
    expect(res.out).toMatch(/docs\/notes\.md · deny-listed term/);
    expect(res.out).not.toMatch(/Synthetic-Private/i);
  });

  it('reviews every outgoing commit, not only the final tree', () => {
    const r = makeRepo();
    r.commit({ 'notes.txt': `key ${supabaseSecret()}\n` });
    r.remove('notes.txt');
    const res = run(r.dir, { ci: true });
    expect(res.code).toBe(1);
    expect(res.out).toMatch(/notes\.txt · key-shaped value: Supabase secret key/);
    expect(res.out).not.toContain(supabaseSecret());
  });

  it('refuses a roster-shaped file, an env file, data outside fixtures and an unmarked fixture', () => {
    const r = makeRepo();
    r.commit({
      'private/roster.csv': 'workspace_kind,user_id\n',
      '.env.local': 'X=1\n',
      'data/tasks.json': '[]\n',
      'fixtures/plain.csv': 'title\nno marker\n',
      'photo.jpg': 'not really an image',
      'backup.tar.gz': 'x',
    });
    const res = run(r.dir, { ci: true });
    expect(res.code).toBe(1);
    for (const rule of [
      'private/roster.csv · roster, backup, dump or export file',
      '.env.local · environment file',
      'data/tasks.json · data file outside fixtures/',
      'fixtures/plain.csv · fixture without a SYNTHETIC marker',
      'photo.jpg · image outside fixtures/images/',
      'backup.tar.gz · archive or backup file',
    ]) expect(res.out).toContain(rule);
  });

  it('refuses service_role JWTs and secrets in commit messages', () => {
    const r = makeRepo();
    r.commit({ 'src/b.js': `const t = '${serviceRoleJwt()}';\n` }, 'add b');
    r.commit({ 'src/c.js': 'export {};\n' }, `oops ${supabaseSecret()}`);
    const res = run(r.dir, { ci: true });
    expect(res.code).toBe(1);
    expect(res.out).toContain('src/b.js · key-shaped value: JWT with a service_role claim');
    expect(res.out).toContain('commit message · key-shaped value: Supabase secret key');
  });

  it('locally, refuses to run without the private deny-list', () => {
    const r = makeRepo();
    const res = run(r.dir);
    expect(res.code).toBe(2);
    expect(res.out).toMatch(/EDEN_DENYLIST_FILE/);
  });

  it('passes on this repository in CI mode', () => {
    const res = spawnSync(process.execPath, [script, '--repo', repoRoot, '--ci'], { encoding: 'utf8' });
    expect(`${res.stdout}${res.stderr}`).toContain('passed');
    expect(res.status).toBe(0);
  });
});
