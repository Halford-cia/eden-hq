#!/usr/bin/env node
// npm run restore:verify -- <decrypted-set-directory>
// Compares a restored copy, over a direct database connection with the gate
// closed, against the set's manifest.json: applied migrations, the complete
// table list, every table's row count, Auth row counts and the closed gate.
// Prints check names and pass/fail only, never values.

import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, promptHidden } from './lib/connect.mjs';
import { verifyRestore } from '../backup/lib.mjs';

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

const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
const conn = await promptHidden('Restored database connection string (hidden): ');
const db = await connect(conn);
try {
  const { ok, checks } = await verifyRestore(db, manifest);
  for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}`);
  console.log(ok ? 'restore:verify PASSED' : 'restore:verify FAILED');
  process.exitCode = ok ? 0 : 1;
} finally {
  await db.end();
}
