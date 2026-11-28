#!/usr/bin/env node
// npm run restore:verify -- <decrypted-set-directory>
// Checks the set folder (every required file present, with its recorded size
// and SHA-256), then compares a restored copy, over a direct database
// connection with the gate closed, against the set's manifest.json: applied
// migrations, the complete table list, every table's row count, Auth row
// counts, the closed gate, row-level security, the membership helper's owner,
// and the restored grants and policies. Prints check names and pass/fail
// only, never values. Any failed check fails the restore.

import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, promptHidden } from './lib/connect.mjs';
import { verifyRestore, verifySetFiles, MANIFEST_FORMAT } from '../backup/lib.mjs';

const dir = process.argv[2];
if (!dir || !existsSync(join(dir, 'manifest.json'))) {
  console.error('Usage: npm run restore:verify -- <decrypted-set-directory containing manifest.json>');
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

const conn = await promptHidden('Restored database connection string (hidden): ');
const db = await connect(conn);
try {
  const { ok, checks } = await verifyRestore(db, manifest, { dir: real });
  print(checks, ok);
  process.exitCode = ok ? 0 : 1;
} finally {
  await db.end();
}
