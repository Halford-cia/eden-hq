// The Stage 1 restore of a decrypted set into a NEW, empty Supabase project
// (docs/SETUP.md, restore drill; review P1-1). Every step stops on its first
// error, and the sequence stops at the first failed step.
//
// The connection reaches the tools through libpq environment variables, never
// the command line (where other local users could read it).

import { join } from 'node:path';

const PSQL = ['--no-psqlrc', '--quiet', '--set', 'ON_ERROR_STOP=1'];
const RESTORE = ['--exit-on-error', '--single-transaction'];

// The migration hands eden_private.is_member to eden_membership_reader. A
// non-superuser cannot restore that ownership directly (the new owner needs
// CREATE on the schema for the ALTER), so the dump is restored without
// owners and the transfer is repeated exactly as the migration does it.
export const HELPER_OWNERSHIP_SQL = [
  'grant eden_membership_reader to current_user;',
  'grant usage, create on schema eden_private to eden_membership_reader;',
  'alter function eden_private.is_member(uuid, boolean) owner to eden_membership_reader;',
  'revoke create on schema eden_private from eden_membership_reader;',
  'revoke eden_membership_reader from current_user;',
].join('\n');

export function restoreSteps(dir, database) {
  const d = ['--dbname', database];
  return [
    { name: 'remove the GraphQL extension', cmd: 'psql', args: [...PSQL, ...d, '--command', 'drop extension if exists pg_graphql'] },
    { name: 'create the Eden roles', cmd: 'psql', args: [...PSQL, ...d, '--single-transaction', '--file', join(dir, 'roles.sql')] },
    { name: 'restore Auth users and identities', cmd: 'pg_restore', args: [...RESTORE, '--data-only', ...d, join(dir, 'auth.dump')] },
    { name: 'restore the Eden schemas and rows', cmd: 'pg_restore', args: [...RESTORE, '--no-owner', ...d, join(dir, 'eden.dump')] },
    { name: 'give the membership helper to its own role', cmd: 'psql', args: [...PSQL, ...d, '--single-transaction', '--command', HELPER_OWNERSHIP_SQL] },
    { name: 'create the migration ledger schema', cmd: 'psql', args: [...PSQL, ...d, '--command', 'create schema if not exists supabase_migrations'] },
    { name: 'restore the migration ledger (table and rows)', cmd: 'pg_restore', args: [...RESTORE, '--no-owner', ...d, join(dir, 'migrations.dump')] },
  ];
}

/** libpq environment for a postgresql:// connection string. */
export function libpqEnv(conn) {
  const url = new URL(conn);
  const env = {
    PGHOST: url.hostname.replace(/^\[|\]$/g, ''),
    PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.replace(/^\//, '')) || 'postgres',
    PGAPPNAME: 'eden-hq-restore',
  };
  const mode = url.searchParams.get('sslmode');
  if (mode) env.PGSSLMODE = mode;
  const root = url.searchParams.get('sslrootcert');
  if (root) env.PGSSLROOTCERT = root;
  return env;
}

/** Run steps in order; stop at the first failure. */
export async function runSteps(steps, runner, report = () => {}) {
  const done = [];
  for (const step of steps) {
    const { code, stderr } = await runner(step);
    if (code !== 0) {
      report({ step, ok: false, code, stderr });
      return { ok: false, failed: step.name, done };
    }
    report({ step, ok: true });
    done.push(step.name);
  }
  return { ok: true, failed: null, done };
}

/** Major version from `psql --version` style output, or 0. */
export function toolMajor(text) {
  const m = String(text).match(/\(PostgreSQL\)\s+(\d+)/);
  return m ? Number(m[1]) : 0;
}

export const MIN_TOOL_MAJOR = 17;
