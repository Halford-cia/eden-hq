#!/usr/bin/env node
// npm run restore:apply -- <decrypted-set-directory> [--show-errors]
//
// Restores a decrypted Stage 1 set into a NEW, empty Supabase project (never
// in place). Before touching any database it checks the set folder against
// its manifest and the PostgreSQL client tools (psql and pg_restore 17 or
// later). It prompts for the copy's connection string at a hidden prompt,
// refuses a database that already holds Eden, then runs the restore steps in
// order, each stopping on its first error, and stops at the first failed
// step. Prints step names and pass/fail only; tool messages (which can name
// rows) appear only with --show-errors.
//
// Next: sign out every restored session, then `npm run restore:verify`.

import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { connect, promptHidden, checkConnectionString } from './lib/connect.mjs';
import { verifySetFiles } from '../backup/lib.mjs';
import {
  restoreSteps, runSteps, libpqEnv, toolMajor, MIN_TOOL_MAJOR,
} from './lib/restore-plan.mjs';

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--'));
const showErrors = args.includes('--show-errors');

if (!dir || !existsSync(join(dir, 'manifest.json'))) {
  console.error('Usage: npm run restore:apply -- <decrypted-set-directory containing manifest.json> [--show-errors]');
  process.exit(2);
}
const repoRoot = realpathSync(resolve(fileURLToPath(import.meta.url), '..', '..'));
const real = realpathSync(dir);
if (real === repoRoot || real.startsWith(repoRoot + sep)) {
  console.error('Refusing: decrypted backups must stay outside this repository.');
  process.exit(2);
}

function run(cmd, cmdArgs, env = {}) {
  return new Promise((done) => {
    let stderr = '';
    let stdout = '';
    const child = spawn(cmd, cmdArgs, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => done({ code: 127, stdout, stderr: String(e.message) }));
    child.on('close', (code) => done({ code: code ?? 1, stdout, stderr }));
  });
}

// 1. The set folder: every required file present and intact.
let manifest;
try {
  manifest = JSON.parse(readFileSync(join(real, 'manifest.json'), 'utf8'));
} catch {
  console.error('Refused: manifest.json cannot be read.');
  process.exit(1);
}
const fileChecks = verifySetFiles(real, manifest);
if (!fileChecks.every((c) => c.ok)) {
  for (const c of fileChecks) console.error(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}`);
  console.error('Refused: the set folder is incomplete or altered. Nothing was restored.');
  process.exit(1);
}

// 2. The client tools.
for (const tool of ['psql', 'pg_restore']) {
  const { code, stdout } = await run(tool, ['--version']);
  const major = toolMajor(stdout);
  if (code !== 0 || major < MIN_TOOL_MAJOR) {
    console.error(`Refused: ${tool} ${MIN_TOOL_MAJOR} or later is required (${code !== 0 ? 'not found' : `found ${major}`}). See docs/SETUP.md, "What you need".`);
    process.exit(2);
  }
}

// 3. The target: a new project, never the serving one with data in it.
const conn = await promptHidden('Connection string of the NEW, empty project to restore into (hidden): ');
const problem = checkConnectionString(conn);
if (problem) {
  console.error(`Refused: ${problem}`);
  process.exit(2);
}
const db = await connect(conn);
try {
  const { rows } = await db.query(`select count(*)::int as n from pg_namespace where nspname in ('eden', 'eden_private', 'eden_api')`);
  if (rows[0].n > 0) {
    console.error('Refused: that database already holds Eden schemas. Never restore in place; create a new project.');
    process.exit(1);
  }
} finally {
  await db.end();
}

// 4. The steps, stopping at the first error.
const env = libpqEnv(conn);
const result = await runSteps(restoreSteps(real, env.PGDATABASE), (step) => run(step.cmd, step.args, env),
  ({ step, ok, code, stderr }) => {
    if (ok) {
      console.log(`OK      ${step.name}`);
    } else {
      console.log(`FAILED  ${step.name} (exit ${code})`);
      if (showErrors && stderr) console.error(stderr.trim());
    }
  });
if (!result.ok) {
  console.error('Stopped at the first error; later steps were not run. The copy is incomplete: delete the project and start again'
    + (showErrors ? '.' : ' (rerun with --show-errors to see the tool\'s message).'));
  process.exit(1);
}
console.log('restore:apply finished. The access gate is closed (its data is never in a set).');
console.log('Next: sign out every restored session (Authentication → Users), then npm run restore:verify -- <the same folder>.');
