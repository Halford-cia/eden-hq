#!/usr/bin/env node
// npm run access:close [-- --by <name>]
// npm run access:open -- <private-project-register> [--by <name>] [--target <ref>] [--synthetic-data]
//
// The project register lives outside this repository (Hank's password
// manager). Header: ref,publishable_key,purpose,state
// access:open asks for the connection string of the project to open, then
// for the connection string of every other register entry not marked
// deleted, and opens the gate only if each of those reads back closed.

import { readFileSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { userInfo } from 'node:os';
import { connect, promptHidden } from './lib/connect.mjs';
import { parseRegister, refFromConnectionString, openGate, closeGate } from './lib/access-core.mjs';

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
    const file = rest.find((a, i) => !a.startsWith('--') && !['--by', '--target'].includes(rest[i - 1]));
    if (!file) {
      console.error('Usage: npm run access:open -- <private-project-register> [--target <ref>] [--synthetic-data]');
      process.exit(2);
    }
    const real = realpathSync(resolve(file));
    if (real === repoRoot || real.startsWith(repoRoot + sep)) {
      console.error('Refusing: the project register must live outside this repository.');
      process.exit(2);
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
      register: entries, targetRef, connect: connectTo, by, synthetic: rest.includes('--synthetic-data'),
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
