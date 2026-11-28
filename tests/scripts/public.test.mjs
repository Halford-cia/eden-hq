// check:public reviews every outgoing commit. Each case builds a throwaway
// git repository with synthetic content and runs the real script against it.
// Secret-shaped values are assembled at run time so this file holds none.

import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, symlinkSync, existsSync } from 'node:fs';
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
    const root = execFileSync('git', ['-C', repoRoot, 'rev-list', '--max-parents=0', 'HEAD'], { encoding: 'utf8' })
      .trim().split('\n')[0];
    const res = spawnSync(process.execPath, [script, '--repo', repoRoot, '--ci', '--base', root, '--head', 'HEAD'],
      { encoding: 'utf8' });
    expect(`${res.stdout}${res.stderr}`).toContain('passed');
    expect(res.status).toBe(0);
  });
});

// Review P0-4: a private term in a path must not reach the report.
describe('check:public never prints a matched term, even in a path', () => {
  it('redacts a file name holding a deny-listed term in every finding for that file', () => {
    const r = makeRepo();
    r.commit({
      'docs/12-synthetic-private-lane-notes.md': 'Meet at 12 Synthetic-Private Lane.\n',
      'fixtures/synthetic-private-lane.csv': 'no marker\n',
    });
    const res = run(r.dir, { deny: 'synthetic-private-lane\nsynthetic-private lane' });
    expect(res.code).toBe(1);
    expect(res.out.toLowerCase()).not.toContain('synthetic-private');
    expect(res.out).toContain('deny-listed term in the file name');
    expect(res.out).toContain('fixture without a SYNTHETIC marker');
    expect(res.out).toMatch(/<file name withheld: deny-listed term>/);
  });

  it('redacts a renamed file whose old name held the term', () => {
    const r = makeRepo();
    r.commit({ 'docs/synthetic-private-lane.md': '# SYNTHETIC\n' });
    execFileSync('git', ['-C', r.dir, 'mv', 'docs/synthetic-private-lane.md', 'docs/renamed.md']);
    execFileSync('git', ['-C', r.dir, 'commit', '-q', '-m', 'rename']);
    const res = run(r.dir, { deny: 'synthetic-private-lane' });
    expect(res.code).toBe(1);
    expect(res.out.toLowerCase()).not.toContain('synthetic-private');
  });
});

// Review P1-11: every expected file is inspected, or the scan fails.
describe('check:public inspects every file or fails', () => {
  it('reads a file whose name Git would quote (accented characters)', () => {
    const r = makeRepo();
    r.commit({ 'docs/café-notes.md': 'Meet at 12 Synthetic-Private Lane.\n' });
    const res = run(r.dir, { deny: 'synthetic-private lane' });
    expect(res.code).toBe(1);
    expect(res.out).toContain('docs/café-notes.md · deny-listed term');
  });

  it('reads names with tabs, quotes and newlines', () => {
    const r = makeRepo();
    r.commit({ 'docs/odd\t"name"\nhere.md': `key ${supabaseSecret()}\n` });
    const res = run(r.dir, { ci: true });
    expect(res.code).toBe(1);
    expect(res.out).toContain('key-shaped value: Supabase secret key');
  });

  it('fails, without the name, when an entry cannot be inspected (a submodule link)', () => {
    const r = makeRepo();
    const sha = execFileSync('git', ['-C', r.dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    execFileSync('git', ['-C', r.dir, 'update-index', '--add', '--cacheinfo', `160000,${sha},synthetic-private-lane-sub`]);
    execFileSync('git', ['-C', r.dir, 'commit', '-q', '-m', 'gitlink']);
    const res = run(r.dir, { deny: 'synthetic-private-lane' });
    expect(res.code).toBe(1);
    expect(res.out).toContain('could not be inspected');
    expect(res.out.toLowerCase()).not.toContain('synthetic-private');
  });
});

// Review P1-10: CI and the pre-push hook review the commits actually leaving.
describe('check:public reviews the outgoing revision range', () => {
  const g = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: 'pipe' }).trim();

  it('CI: reviews --base..--head from the event, even when HEAD equals the remote main', () => {
    const r = makeRepo();
    const before = g(r.dir, 'rev-parse', 'HEAD');
    r.commit({ 'notes.txt': `key ${supabaseSecret()}\n` });
    const after = g(r.dir, 'rev-parse', 'HEAD');
    // A push to main: the checkout's origin/main already equals the new head.
    g(r.dir, 'update-ref', 'refs/remotes/origin/main', after);
    const env = { ...process.env };
    delete env.EDEN_PUBLIC_BASE;
    const res = spawnSync(process.execPath, [script, '--repo', r.dir, '--ci', '--base', before, '--head', after],
      { env, encoding: 'utf8' });
    expect(res.status).toBe(1);
    expect(`${res.stdout}${res.stderr}`).toContain('notes.txt · key-shaped value');
  });

  it('CI: an empty range fails instead of passing with nothing reviewed', () => {
    const r = makeRepo();
    const head = g(r.dir, 'rev-parse', 'HEAD');
    const res = spawnSync(process.execPath, [script, '--repo', r.dir, '--ci', '--base', head, '--head', head],
      { encoding: 'utf8' });
    expect(res.status).toBe(1);
    expect(`${res.stdout}${res.stderr}`).toMatch(/no commits/i);
  });

  it('CI: a first push (all-zero base) reviews the whole history of the head', () => {
    const r = makeRepo();
    r.commit({ 'notes.txt': `key ${supabaseSecret()}\n` });
    const res = spawnSync(process.execPath, [script, '--repo', r.dir, '--ci', '--base', '0'.repeat(40), '--head', 'HEAD'],
      { encoding: 'utf8' });
    expect(res.status).toBe(1);
    expect(`${res.stdout}${res.stderr}`).toContain('notes.txt · key-shaped value');
  });

  function withRemote() {
    const r = makeRepo();
    const bare = mkdtempSync(join(tmpdir(), 'eden-remote-'));
    execFileSync('git', ['init', '-q', '--bare', bare]);
    g(r.dir, 'remote', 'add', 'fork', bare);
    g(r.dir, 'push', '-q', 'fork', 'main');
    // The real hook, running the real script (linked, untracked) from this clone.
    mkdirSync(join(r.dir, 'scripts'), { recursive: true });
    symlinkSync(script, join(r.dir, 'scripts', 'check-public.mjs'));
    writeFileSync(join(r.dir, '.git', 'info', 'exclude'), 'scripts/\n');
    g(r.dir, 'config', 'core.hooksPath', join(repoRoot, '.githooks'));
    return r;
  }

  function push(r, deny, ...refs) {
    const d = mkdtempSync(join(tmpdir(), 'eden-deny-'));
    writeFileSync(join(d, 'deny.txt'), `${deny}\n`);
    const env = { ...process.env, EDEN_DENYLIST_FILE: join(d, 'deny.txt') };
    delete env.EDEN_PUBLIC_CI;
    delete env.EDEN_PUBLIC_BASE;
    const res = spawnSync('git', ['-C', r.dir, 'push', 'fork', ...refs], { env, encoding: 'utf8' });
    return { code: res.status, out: `${res.stdout}${res.stderr}` };
  }

  it('pre-push: an ordinary push inspects its own commits and passes when clean', () => {
    const r = withRemote();
    r.commit({ 'src/a.js': 'export const a = 1;\n' });
    const res = push(r, 'nothing-matches-this', 'main');
    expect(res.out).toMatch(/check:public passed: 1 outgoing commit/);
    expect(res.code).toBe(0);
  });

  it('pre-push: pushing another branch inspects that branch, not the checked-out HEAD', () => {
    const r = withRemote();
    g(r.dir, 'switch', '-q', '-c', 'leak');
    r.commit({ 'docs/notes.md': 'Meet at 12 Synthetic-Private Lane.\n' });
    g(r.dir, 'switch', '-q', 'main');
    const res = push(r, 'synthetic-private lane', 'leak');
    expect(res.code).not.toBe(0);
    expect(res.out).toContain('docs/notes.md · deny-listed term');
    expect(res.out.toLowerCase()).not.toContain('synthetic-private lane');
    // Nothing reached the remote.
    const remote = spawnSync('git', ['-C', r.dir, 'ls-remote', 'fork', 'refs/heads/leak'], { encoding: 'utf8' });
    expect(remote.stdout.trim()).toBe('');
  });

  // Review round 2, P1-1: the agent's token cannot push a workflow file, so
  // Hank moves the template into .github/workflows/ (SETUP.md, "Before setup").
  // Before and after the move there is exactly one CI definition.
  const activeCi = join(repoRoot, '.github', 'workflows', 'ci.yml');
  const templateCi = join(repoRoot, 'docs', 'ci', 'github-actions-ci.yml');

  it('there is exactly one CI definition: the template, or the active workflow after Hank moves it', () => {
    expect(existsSync(activeCi) !== existsSync(templateCi)).toBe(true);
  });

  it('the CI definition takes the range from the event, not from origin/main', () => {
    const yml = readFileSync(existsSync(activeCi) ? activeCi : templateCi, 'utf8');
    expect(yml).toContain('github.event.pull_request.base.sha');
    expect(yml).toContain('github.event.pull_request.head.sha');
    expect(yml).toContain('github.event.before');
    expect(yml).not.toMatch(/--base\s+"?origin\//);
  });
});
