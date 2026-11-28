#!/usr/bin/env node
// Runs before `vite build`. The browser build may read exactly two variables:
//   VITE_SUPABASE_URL              an https://<ref>.supabase.co project URL
//   VITE_SUPABASE_PUBLISHABLE_KEY  sb_publishable_… or a legacy JWT whose role is anon
// Anything else exits non-zero and leaves no dist/. Values are never printed.

import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadEnv } from 'vite';
import { jwtRole, keyShapedFindings } from './lib/secrets.mjs';

const ALLOWED = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_PUBLISHABLE_KEY'];

export function checkBuildEnv(env) {
  const problems = [];
  const viteKeys = Object.keys(env).filter((k) => k.startsWith('VITE_'));
  for (const k of viteKeys) {
    if (!ALLOWED.includes(k)) problems.push(`${k} is not allowed in the browser build`);
  }
  const url = (env.VITE_SUPABASE_URL || '').replace(/\/+$/, '');
  if (!url) problems.push('VITE_SUPABASE_URL is missing');
  else if (!/^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(url)) {
    problems.push('VITE_SUPABASE_URL must be an https://<project-ref>.supabase.co URL');
  }
  const key = env.VITE_SUPABASE_PUBLISHABLE_KEY || '';
  if (!key) problems.push('VITE_SUPABASE_PUBLISHABLE_KEY is missing');
  else {
    const publishable = /^sb_publishable_[A-Za-z0-9_-]{10,}$/.test(key);
    const legacyAnon = /^eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(key) && jwtRole(key) === 'anon';
    if (!publishable && !legacyAnon) {
      problems.push('VITE_SUPABASE_PUBLISHABLE_KEY must be a publishable key (sb_publishable_…) or a legacy anon JWT');
    }
    if (keyShapedFindings(key).length) problems.push('VITE_SUPABASE_PUBLISHABLE_KEY holds a secret-shaped value');
  }
  return problems;
}

function main() {
  const root = resolve(process.cwd());
  const mode = process.env.EDEN_BUILD_MODE || 'production';
  // Every VITE_ value Vite would embed: .env files plus the process environment.
  const fileEnv = loadEnv(mode, root, 'VITE_');
  const env = { ...fileEnv };
  for (const [k, v] of Object.entries(process.env)) if (k.startsWith('VITE_')) env[k] = v;
  const problems = checkBuildEnv(env);
  if (problems.length) {
    rmSync(join(root, 'dist'), { recursive: true, force: true });
    console.error('Build refused (no dist/ written):');
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log('Build environment OK: only the Supabase URL and publishable key reach the browser.');
}

if (process.argv[1]?.endsWith('build-guard.mjs')) main();
