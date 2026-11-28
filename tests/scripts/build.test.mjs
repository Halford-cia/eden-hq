// Browser build guard and dist scan (docs/SPEC.md, "Browser build").
// Builds run in a throwaway copy of the project so planted values never
// touch the working tree.

import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, cpSync, symlinkSync, writeFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { repoRoot } from '../db/harness.mjs';
import { checkBuildEnv } from '../../scripts/build-guard.mjs';

const URL_OK = `https://${'a'.repeat(20)}.supabase.co`;
const KEY_OK = 'sb_publishable_SYNTHETICabcdef123456';
const secretKey = () => ['sb', 'secret', 'Z'.repeat(30)].join('_');
const jwt = (role) => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256' })}.${b64({ role })}.${'s'.repeat(43)}`;
};

function copyProject() {
  const dir = mkdtempSync(join(tmpdir(), 'eden-build-'));
  for (const p of ['index.html', 'vite.config.mjs', 'package.json', 'src', 'scripts']) {
    cpSync(join(repoRoot, p), join(dir, p), { recursive: true });
  }
  symlinkSync(join(repoRoot, 'node_modules'), join(dir, 'node_modules'), 'dir');
  return dir;
}

function build(dir, env) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('VITE_')));
  const guard = spawnSync(process.execPath, ['scripts/build-guard.mjs'], { cwd: dir, env: { ...clean, ...env }, encoding: 'utf8' });
  if (guard.status !== 0) return { code: guard.status, out: guard.stdout + guard.stderr };
  const vite = spawnSync(process.execPath, [join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--logLevel', 'error'],
    { cwd: dir, env: { ...clean, ...env }, encoding: 'utf8' });
  return { code: vite.status, out: vite.stdout + vite.stderr };
}

function allFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p); else out.push(p);
    }
  };
  walk(dir);
  return out;
}

describe('build guard rules', () => {
  it('accepts exactly the two variables with valid shapes', () => {
    expect(checkBuildEnv({ VITE_SUPABASE_URL: URL_OK, VITE_SUPABASE_PUBLISHABLE_KEY: KEY_OK })).toEqual([]);
    expect(checkBuildEnv({ VITE_SUPABASE_URL: URL_OK, VITE_SUPABASE_PUBLISHABLE_KEY: jwt('anon') })).toEqual([]);
  });
  it('refuses secret keys, service_role JWTs, extra VITE_ variables and non-Supabase URLs', () => {
    expect(checkBuildEnv({ VITE_SUPABASE_URL: URL_OK, VITE_SUPABASE_PUBLISHABLE_KEY: secretKey() })).not.toEqual([]);
    expect(checkBuildEnv({ VITE_SUPABASE_URL: URL_OK, VITE_SUPABASE_PUBLISHABLE_KEY: jwt('service_role') })).not.toEqual([]);
    expect(checkBuildEnv({ VITE_SUPABASE_URL: URL_OK, VITE_SUPABASE_PUBLISHABLE_KEY: KEY_OK, VITE_EXTRA: 'x' }))
      .toEqual(['VITE_EXTRA is not allowed in the browser build']);
    expect(checkBuildEnv({ VITE_SUPABASE_URL: 'http://example.test', VITE_SUPABASE_PUBLISHABLE_KEY: KEY_OK })).not.toEqual([]);
    expect(checkBuildEnv({})).toHaveLength(2);
  });
  it('never prints the offending value', () => {
    const msgs = checkBuildEnv({ VITE_SUPABASE_URL: URL_OK, VITE_SUPABASE_PUBLISHABLE_KEY: secretKey() }).join(' ');
    expect(msgs).not.toContain(secretKey());
  });
});

describe('npm run build in a throwaway copy', () => {
  let dir;
  beforeAll(() => {
    dir = copyProject();
  });

  it('a secret-key-shaped value in the publishable-key slot fails and leaves no dist/', () => {
    mkdirSync(join(dir, 'dist'), { recursive: true });
    writeFileSync(join(dir, 'dist', 'stale.txt'), 'old build');
    const r = build(dir, { VITE_SUPABASE_URL: URL_OK, VITE_SUPABASE_PUBLISHABLE_KEY: secretKey() });
    expect(r.code).toBe(1);
    expect(r.out).not.toContain(secretKey());
    expect(existsSync(join(dir, 'dist'))).toBe(false);
  });

  it('planted markers in a non-VITE_ variable and an ignored .env.local reach no built file; no source maps', () => {
    const envMarker = 'SYNTHETIC_ENV_MARKER_7f3a91';
    const fileMarker = 'SYNTHETIC_FILE_MARKER_c02d55';
    writeFileSync(join(dir, '.env.local'), `PRIVATE_THING=${fileMarker}\nSUPABASE_SECRET=${fileMarker}\n`);
    const r = build(dir, {
      VITE_SUPABASE_URL: URL_OK, VITE_SUPABASE_PUBLISHABLE_KEY: KEY_OK, SECRET_MARKER: envMarker,
    });
    expect(r.code, r.out).toBe(0);
    const files = allFiles(join(dir, 'dist'));
    expect(files.length).toBeGreaterThan(1);
    expect(files.some((f) => f.endsWith('.map'))).toBe(false);
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      expect(text.includes(envMarker)).toBe(false);
      expect(text.includes(fileMarker)).toBe(false);
    }
    // The publishable values are the only configuration embedded.
    expect(files.some((f) => readFileSync(f, 'utf8').includes(KEY_OK))).toBe(true);
    const scan = spawnSync(process.execPath, ['scripts/check-dist.mjs'], {
      cwd: dir, env: { ...process.env, EDEN_DIST_MARKERS: `${envMarker},${fileMarker}` }, encoding: 'utf8',
    });
    expect(scan.status, scan.stdout + scan.stderr).toBe(0);
  });

  it('check:dist catches a planted marker and a source map, naming the file only', () => {
    writeFileSync(join(dir, 'dist', 'planted.js'), 'const x = "SYNTHETIC_PLANTED_42";\n');
    writeFileSync(join(dir, 'dist', 'planted.js.map'), '{}');
    const scan = spawnSync(process.execPath, ['scripts/check-dist.mjs'], {
      cwd: dir, env: { ...process.env, EDEN_DIST_MARKERS: 'SYNTHETIC_PLANTED_42' }, encoding: 'utf8',
    });
    expect(scan.status).toBe(1);
    expect(scan.stderr).toContain('planted.js · planted test marker');
    expect(scan.stderr).toContain('planted.js.map · source map in a production build');
    expect(scan.stderr).not.toContain('SYNTHETIC_PLANTED_42');
  });
});
