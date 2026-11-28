// Pure parts of the hosted backup (docs/SPEC.md, "Backup and restore"),
// shared by the Cloud Run worker, the watch job and restore:verify.
// Stage 1 sets hold the operational tables; Stage 2 adds receipts and money.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { collectInventory } from './inventory.mjs';

// 2: sets record the access inventory (review P1-2).
export const MANIFEST_FORMAT = 2;

/** Files every set of a stage must hold (decrypted names). */
export const REQUIRED_FILES = {
  1: ['roles.sql', 'eden.dump', 'auth.dump', 'migrations.dump'],
};

const EDEN_SCHEMA = (r) => typeof r.schema === 'string' && r.schema.startsWith('eden');

/**
 * Who can reach what in the Eden schemas: RLS state, policies, grants to the
 * API roles, the definer function and its owner role, and the published
 * operations' results. A restored copy must match the set it came from.
 */
export async function collectEdenAccess(db) {
  const inv = await collectInventory(db);
  return {
    schemaUsage: inv.schemaUsage.filter(EDEN_SCHEMA),
    relations: inv.relations.filter(EDEN_SCHEMA),
    columns: inv.columns.filter(EDEN_SCHEMA),
    functions: inv.functions.filter(EDEN_SCHEMA),
    rls: inv.rls,
    policies: inv.policies,
    definers: inv.definers,
    definerRoleGrants: inv.definerRoleGrants,
    definerRolePolicies: inv.definerRolePolicies,
    definerRoleAttributes: inv.definerRoleAttributes,
    apiResults: inv.apiResults,
  };
}

/** Object-name timestamp: 2031-06-08T090000Z (sortable, no colons). */
export function setTimestamp(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '');
}

export function setObjectNames(ts) {
  const prefix = `sets/${ts}`;
  return {
    prefix,
    file: (name) => `${prefix}/${name}.age`,
    manifest: `${prefix}/manifest.json.age`,
    complete: `${prefix}/COMPLETE`,
    status: `status/${ts}.json`,
    latest: 'status/latest.json',
  };
}

/**
 * Row counts, applied migrations and the recovery point, read inside the
 * snapshot transaction the dump uses. The access gate's data is left out.
 */
export async function snapshotFacts(db) {
  const { rows: tables } = await db.query(
    `select n.nspname || '.' || c.relname as name
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname in ('eden', 'eden_private') and c.relkind in ('r', 'p')
       and not (n.nspname = 'eden_private' and c.relname = 'access_gate')
     order by 1`,
  );
  const counts = {};
  for (const t of tables) {
    const [schema, table] = t.name.split('.');
    const { rows } = await db.query(`select count(*)::bigint as n from "${schema}"."${table}"`);
    counts[t.name] = Number(rows[0].n);
  }
  let migrations = [];
  try {
    const { rows } = await db.query('select version from supabase_migrations.schema_migrations order by version');
    migrations = rows.map((r) => r.version);
  } catch {
    migrations = [];
  }
  const { rows: [{ now }] } = await db.query('select now() as now');
  const auth = await db.query(
    `select (select count(*) from auth.users)::bigint as users,
            (select count(*) from auth.identities)::bigint as identities`,
  );
  return {
    recoveryPoint: new Date(now).toISOString(),
    migrations,
    tables: counts,
    auth: { users: Number(auth.rows[0].users), identities: Number(auth.rows[0].identities) },
    access: await collectEdenAccess(db),
  };
}

/**
 * The Stage 1 dump commands, in set order. The worker runs them inside its
 * exported snapshot; the local clean-restore test runs the same list
 * without one (review P1-1).
 *   eden.dump        schemas eden, eden_private, eden_api; no gate data
 *   auth.dump        auth.users and auth.identities rows
 *   migrations.dump  the migration ledger WITH its table definition: a new
 *                    project has no supabase_migrations table to load into
 *   roles.sql        filtered to Eden's own roles by edenRolesOnly
 */
export function dumpCommands({ dbUrl, snapshot = null }) {
  // Rows as INSERTs naming their columns: robust to a different column order
  // between Supabase versions, small at Eden's size, and restorable by every
  // client the local test drives (its database cannot take COPY FROM STDIN).
  const base = ['--dbname', dbUrl, ...(snapshot ? ['--snapshot', snapshot] : []), '--format', 'custom', '--column-inserts'];
  return [
    { name: 'roles.sql', cmd: 'pg_dumpall', args: ['--dbname', dbUrl, '--roles-only', '--no-role-passwords'] },
    {
      name: 'eden.dump',
      cmd: 'pg_dump',
      args: [...base, '--schema', 'eden', '--schema', 'eden_private', '--schema', 'eden_api',
        '--exclude-table-data', 'eden_private.access_gate'],
    },
    { name: 'auth.dump', cmd: 'pg_dump', args: [...base, '--data-only', '--table', 'auth.users', '--table', 'auth.identities'] },
    { name: 'migrations.dump', cmd: 'pg_dump', args: [...base, '--table', 'supabase_migrations.schema_migrations'] },
  ];
}

export function buildManifest({ stage, facts, files }) {
  return {
    format: MANIFEST_FORMAT,
    stage,
    recovery_point: facts.recoveryPoint,
    migrations: facts.migrations,
    tables: facts.tables,
    auth: facts.auth,
    access: facts.access,
    files: files.map((f) => ({ name: f.name, bytes: f.bytes, sha256: f.sha256 })),
  };
}

/**
 * From `pg_dumpall --roles-only` output, keep Eden's own roles as plain
 * `CREATE ROLE <name> NOLOGIN NOINHERIT;` statements. Attribute lines and
 * memberships are dropped: Supabase's non-superuser postgres cannot replay
 * them, and the restore procedure grants what it needs explicitly.
 */
export function edenRolesOnly(sql) {
  const names = new Set();
  for (const line of sql.split('\n')) {
    const m = line.match(/^(?:CREATE|ALTER) ROLE "?(eden_[a-z_]+)"?[\s;]/);
    if (m) names.add(m[1]);
  }
  return [...names].sort().map((n) => `CREATE ROLE ${n} NOLOGIN NOINHERIT;`).join('\n') + '\n';
}

/** The status record: no rows, totals, names, object keys or project refs. */
export function statusRecord({ startedAt, finishedAt, state, lastComplete, fileCount, encryptedBytes }) {
  return {
    started_at: startedAt,
    finished_at: finishedAt,
    state, // complete | failed
    last_complete_recovery_point: lastComplete || null,
    file_count: fileCount,
    encrypted_bytes: encryptedBytes,
  };
}

/** Watch decision for status/latest.json. */
export function watchVerdict(statusText, now, staleAfterHours = 26) {
  let status;
  try {
    status = JSON.parse(statusText);
  } catch {
    return { message: 'eden_backup_stale', age_hours: null };
  }
  const last = status && status.last_complete_recovery_point ? Date.parse(status.last_complete_recovery_point) : NaN;
  if (Number.isNaN(last)) return { message: 'eden_backup_stale', age_hours: null };
  const age = Math.round(((now.getTime() - last) / 36e5) * 10) / 10;
  return { message: age > staleAfterHours ? 'eden_backup_stale' : 'eden_backup_watch_ok', age_hours: age };
}

/**
 * Close a superseded project's gate if it answers. Returns the log message
 * (never the project's name). Throws if an open gate will not close.
 */
export async function closeSuperseded(connectFn) {
  let db;
  try {
    db = await connectFn();
  } catch {
    return 'eden_superseded_unreachable';
  }
  try {
    const read = async () => {
      const { rows } = await db.query('select is_open from eden_private.access_gate where id = 1');
      return rows.length ? rows[0].is_open === true : false;
    };
    if (!(await read())) return 'eden_superseded_closed';
    await db.query(
      `update eden_private.access_gate set is_open = false, changed_by = 'eden-backup', changed_at = now() where id = 1`,
    );
    if (await read()) throw new Error('a superseded gate would not close');
    return 'eden_superseded_was_open';
  } finally {
    await db.end?.();
  }
}

/**
 * The decrypted set folder against its manifest (review P1-2): the stage's
 * required files are listed, and every listed file is present with its
 * recorded size and SHA-256. Returns checks; names only, never values.
 */
export function verifySetFiles(dir, manifest) {
  const checks = [];
  const add = (name, ok) => checks.push({ name, ok: Boolean(ok) });
  if (!dir) {
    add('set folder checked', false);
    return checks;
  }
  const listed = Array.isArray(manifest.files) ? manifest.files : [];
  const required = REQUIRED_FILES[manifest.stage];
  if (!required) add(`known stage (${Number(manifest.stage) || '?'})`, false);
  for (const name of required || []) {
    if (!listed.some((f) => f.name === name)) add(`the set lists required file ${name}`, false);
  }
  for (const f of [...listed].sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
    const safe = typeof f.name === 'string' && /^[a-z0-9._-]+$/i.test(f.name);
    if (!safe) {
      add('set file names are plain file names', false);
      continue;
    }
    const path = join(dir, f.name);
    if (!existsSync(path)) {
      add(`set file ${f.name} is present`, false);
      continue;
    }
    const buf = readFileSync(path);
    const sha = createHash('sha256').update(buf).digest('hex');
    add(`set file ${f.name} matches its recorded size and hash`, buf.length === f.bytes && sha === f.sha256);
  }
  return checks;
}

/**
 * restore:verify core: compare a restored database, and the set folder it
 * was restored from, with the set's manifest.
 * Returns { ok, checks: [{ name, ok }] }; never values.
 */
export async function verifyRestore(db, manifest, { dir } = {}) {
  const checks = [];
  const add = (name, ok) => checks.push({ name, ok: Boolean(ok) });
  add('manifest format', manifest.format === MANIFEST_FORMAT);
  checks.push(...verifySetFiles(dir, manifest));
  const facts = await snapshotFacts(db);
  add('applied migrations match the set', JSON.stringify(facts.migrations) === JSON.stringify(manifest.migrations));
  const restoredTables = Object.keys(facts.tables).sort();
  const setTables = Object.keys(manifest.tables).sort();
  add('table list matches the set', JSON.stringify(restoredTables) === JSON.stringify(setTables));
  for (const t of setTables) {
    add(`row count ${t}`, facts.tables[t] === manifest.tables[t]);
  }
  add('auth users count', facts.auth.users === manifest.auth?.users);
  add('auth identities count', facts.auth.identities === manifest.auth?.identities);
  const { rows } = await db.query('select is_open from eden_private.access_gate where id = 1');
  add('access gate closed', !rows.length || rows[0].is_open === false);

  // Who can reach what, as restored.
  const access = facts.access;
  add('row-level security on every Eden table', access.rls.length > 0 && access.rls.every((r) => r.rls === true));
  add('membership helper owned by eden_membership_reader, the only definer function',
    JSON.stringify(access.definers) === JSON.stringify([
      { schema: 'eden_private', name: 'is_member', owner: 'eden_membership_reader', config: 'search_path=""' },
    ]));
  add('restored ownership, grants and policies match the set',
    Boolean(manifest.access) && JSON.stringify(access) === JSON.stringify(manifest.access));
  return { ok: checks.every((c) => c.ok), checks };
}
