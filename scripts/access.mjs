#!/usr/bin/env node
// npm run access:close [-- --by <name>]
// npm run access:open -- <private-project-register> [--by <name>] [--target <ref>]
//                        [--synthetic-data --expected-accounts <file>]
//
// The project register lives outside this repository (Hank's password
// manager). Header: ref,publishable_key,purpose,state
// access:open asks for the connection string of the project to open, then
// for the connection string of every other register entry not marked
// deleted, and opens the gate only if each of those reads back closed.
// A drill or rehearsal copy opens only with --synthetic-data, and only if its
// Auth users and identities are exactly the accounts in the expected-accounts
// file (header user_id,google_subject; outside this repository).

import { readFileSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { userInfo } from 'node:os';
import { connect, promptHidden } from './lib/connect.mjs';
import { parseRegister, refFromConnectionString, openGate, closeGate } from './lib/access-core.mjs';
import { parseExpectedAccounts } from './lib/accounts-core.mjs';

const repoRoot = realpathSync(resolve(fileURLToPath(import.meta.url), '..', '..'));
const [cmd, ...rest] = process.argv.slice(2);

function flag(name) {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
}
const by = flag('--by') || `operator:${userInfo().username}`;

try {
  if (cmd === 'close') {
    const conn = await promptHidden('Connection string of the project to CLOSE (hidden): ');
    const db = await connect(conn);
    try {
      await closeGate(db, by);
      console.log(`Gate closed and read back closed${refFromConnectionString(conn) ? ` for ${refFromConnectionString(conn)}` : ''}.`);
    } finally {
      await db.end();
    }
  } else if (cmd === 'open') {
    const file = rest.find((a, i) => !a.startsWith('--') && !['--by', '--target', '--expected-accounts'].includes(rest[i - 1]));
    if (!file) {
      console.error('Usage: npm run access:open -- <private-project-register> [--target <ref>] [--synthetic-data --expected-accounts <file>]');
      process.exit(2);
    }
    const outsideRepo = (path, what) => {
      const real = realpathSync(resolve(path));
      if (real === repoRoot || real.startsWith(repoRoot + sep)) {
        console.error(`Refusing: ${what} must live outside this repository.`);
        process.exit(2);
      }
    };
    outsideRepo(file, 'the project register');
    const synthetic = rest.includes('--synthetic-data');
    // Review round 2, P1-2: a copy opens as synthetic only when its Auth rows
    // are exactly these test accounts; checked before anything is asked for.
    let expectedAccounts = null;
    if (synthetic) {
      const accountsFile = flag('--expected-accounts');
      if (!accountsFile) {
        console.error('Refused: --synthetic-data needs --expected-accounts <file> (docs/SETUP.md step 9.2). The gate stays closed.');
        process.exit(2);
      }
      outsideRepo(accountsFile, 'the expected-accounts file');
      const parsed = parseExpectedAccounts(readFileSync(accountsFile, 'utf8'));
      if (parsed.errors.length) {
        console.error('Refused: the expected-accounts file has problems:');
        for (const e of parsed.errors) console.error(`  ${e}`);
        process.exit(1);
      }
      expectedAccounts = parsed.accounts;
    }
    const { entries, errors } = parseRegister(readFileSync(file, 'utf8'));
    if (errors.length) {
      console.error('Refused: the register has problems:');
      for (const e of errors) console.error(`  ${e}`);
      process.exit(1);
    }
    const targetConn = await promptHidden('Connection string of the project to OPEN (hidden): ');
    const targetRef = flag('--target') || refFromConnectionString(targetConn);
    if (!targetRef) {
      console.error('Refused: cannot tell which project that is; pass --target <ref>.');
      process.exit(2);
    }
    const parsedRef = refFromConnectionString(targetConn);
    if (parsedRef && parsedRef !== targetRef) {
      console.error('Refused: --target does not match the connection string.');
      process.exit(2);
    }
    const connectTo = async (ref) => {
      if (ref === targetRef) return connect(targetConn);
      const conn = await promptHidden(`Connection string for register entry ${ref}, to read its gate (hidden; empty = unreachable): `);
      if (!conn) throw new Error('unreachable');
      if (refFromConnectionString(conn) !== ref) throw new Error('that connection string is for a different project');
      return connect(conn);
    };
    const result = await openGate({
      register: entries, targetRef, connect: connectTo, by, synthetic, expectedAccounts,
    });
    if (!result.opened) {
      console.error('Refused. The gate stays closed:');
      for (const r of result.refusals) console.error(`  ${r}`);
      process.exitCode = 1;
    } else {
      console.log(`Gate open for ${targetRef}. Mark it "serving" in the project register now.`);
    }
  } else {
    console.error('Usage: access.mjs open <register> | close');
    process.exit(2);
  }
} catch (e) {
  console.error(`Failed: ${e.code ? `${e.code} ` : ''}${String(e.message).split('\n')[0]}`);
  process.exit(1);
}
