#!/usr/bin/env node
// npm run roster:pending
// npm run roster:apply -- <private-roster-file> [--dry-run]
// npm run roster:show
//
// The roster file lives outside this repository (Hank's password manager).
// Header: workspace_kind,user_id,google_subject,role,display_name

import { readFileSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, promptHidden } from './lib/connect.mjs';
import {
  parseRoster, applyRoster, pendingAccounts, showRoster, formatShow, describeChange,
} from './lib/roster-core.mjs';

const repoRoot = realpathSync(resolve(fileURLToPath(import.meta.url), '..', '..'));

function refuseInsideRepo(file) {
  const real = realpathSync(resolve(file));
  if (real === repoRoot || real.startsWith(repoRoot + sep)) {
    console.error('Refusing: the private roster must live outside this repository.');
    process.exit(2);
  }
}

async function withDb(fn) {
  const conn = await promptHidden('Database connection string (hidden): ');
  const db = await connect(conn);
  try {
    return await fn(db);
  } finally {
    await db.end();
  }
}

const [cmd, ...rest] = process.argv.slice(2);

try {
  if (cmd === 'pending') {
    await withDb(async (db) => {
      const rows = await pendingAccounts(db);
      if (!rows.length) {
        console.log('Every Auth account has an active membership.');
        return;
      }
      console.log('Accounts without an active membership (copy UUID and subject into the private roster):');
      for (const r of rows) {
        console.log(`  ${r.user_id}  subject ${r.google_subject ?? '(no Google identity)'}  ${r.email ?? ''}${r.verified ? '' : '  (address NOT verified)'}`);
      }
    });
  } else if (cmd === 'apply') {
    const file = rest.find((a) => !a.startsWith('--'));
    const dryRun = rest.includes('--dry-run');
    if (!file) {
      console.error('Usage: npm run roster:apply -- <private-roster-file> [--dry-run]');
      process.exit(2);
    }
    refuseInsideRepo(file);
    const lines = parseRoster(readFileSync(file, 'utf8'));
    await withDb(async (db) => {
      const result = await applyRoster(db, lines, { dryRun });
      if (result.errors.length) {
        console.error('Refused. Nothing was changed. Fix these lines:');
        for (const e of result.errors) console.error(`  ${e}`);
        process.exitCode = 1;
        return;
      }
      if (!result.changes.length) {
        console.log('No change: the database already matches the roster.');
        return;
      }
      console.log(dryRun ? 'Dry run. These changes would be made:' : 'Applied in one transaction:');
      for (const c of result.changes) console.log(`  ${describeChange(c)}`);
      if (!dryRun) console.log('Run npm run roster:show to read it back.');
    });
  } else if (cmd === 'show') {
    await withDb(async (db) => {
      console.log(formatShow(await showRoster(db)));
    });
  } else {
    console.error('Usage: roster.mjs pending | apply <file> [--dry-run] | show');
    process.exit(2);
  }
} catch (e) {
  // Never print the connection string or row values.
  console.error(`Failed: ${e.code ? `${e.code} ` : ''}${String(e.message).split('\n')[0]}`);
  process.exit(1);
}
