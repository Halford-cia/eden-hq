#!/usr/bin/env node
// npm run restore:verify -- <decrypted-set-directory>
// Checks the set folder (the worker's COMPLETE marker certifying its
// manifest, review round 3 P1-2; every required file present, with its
// recorded size and SHA-256), then compares a restored copy, over a direct database
// connection with the gate closed, against the set's manifest.json: applied
// migrations, the complete table list, every table's row count, Auth row
// counts, the closed gate, row-level security, the membership helper's owner,
// and the restored grants and policies. With --expected-accounts it also
// checks that the restored Auth rows are exactly those test accounts. Prints
// check names, pass/fail and counts only, never values. Any failed check
// fails the restore.

import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, promptHidden } from './lib/connect.mjs';
import { verifyRestore, verifySetFiles, MANIFEST_FORMAT } from '../backup/lib.mjs';
import { parseExpectedAccounts, checkAccounts } from './lib/accounts-core.mjs';

const dir = process.argv[2];
if (!dir || !existsSync(join(dir, 'manifest.json'))) {
  console.error('Usage: npm run restore:verify -- <decrypted-set-directory containing manifest.json> [--expected-accounts <file>]');
  process.exit(2);
}
const repoRoot = realpathSync(resolve(fileURLToPath(import.meta.url), '..', '..'));
const real = realpathSync(dir);
if (real === repoRoot || real.startsWith(repoRoot + sep)) {
  console.error('Refusing: decrypted backups must stay outside this repository.');
  process.exit(2);
}

const print = (checks, ok) => {
  for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}`);
  console.log(ok ? 'restore:verify PASSED' : 'restore:verify FAILED');
};

let manifest;
try {
  manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
} catch {
  print([{ name: 'manifest.json is readable', ok: false }], false);
  process.exit(1);
}

// The folder first: a set with a missing or altered file is not a recovery,
// whatever the database says.
const fileChecks = [{ name: 'manifest format', ok: manifest.format === MANIFEST_FORMAT }, ...verifySetFiles(real, manifest)];
if (!fileChecks.every((c) => c.ok)) {
  print(fileChecks, false);
  process.exit(1);
}

// --expected-accounts <file> (review round 2, P1-2): for a synthetic drill,
// also prove the restored Auth users and identities are exactly the test
// accounts (header user_id,google_subject; outside this repository).
let expectedAccounts = null;
const ai = process.argv.indexOf('--expected-accounts');
if (ai >= 0) {
  const file = process.argv[ai + 1];
  if (!file || !existsSync(file)) {
    console.error('Usage: --expected-accounts <file> (header user_id,google_subject)');
    process.exit(2);
  }
  const realFile = realpathSync(file);
  if (realFile === repoRoot || realFile.startsWith(repoRoot + sep)) {
    console.error('Refusing: the expected-accounts file must live outside this repository.');
    process.exit(2);
  }
  const parsed = parseExpectedAccounts(readFileSync(file, 'utf8'));
  if (parsed.errors.length) {
    console.error('Refused: the expected-accounts file has problems:');
    for (const e of parsed.errors) console.error(`  ${e}`);
    process.exit(2);
  }
  expectedAccounts = parsed.accounts;
}

const conn = await promptHidden('Restored database connection string (hidden): ');
const db = await connect(conn);
try {
  const result = await verifyRestore(db, manifest, { dir: real });
  const checks = [...result.checks];
  if (expectedAccounts) {
    const acc = await checkAccounts(db, expectedAccounts);
    checks.push({ name: 'Auth users and identities are exactly the expected test accounts', ok: acc.ok });
    for (const p of acc.problems) console.log(`      ${p}`);
  }
  const ok = checks.every((c) => c.ok);
  print(checks, ok);
  if (!expectedAccounts) {
    console.log('NOTE  who is in the copy was not checked (no --expected-accounts): never open it as synthetic.');
  }
  process.exitCode = ok ? 0 : 1;
} finally {
  await db.end();
}
