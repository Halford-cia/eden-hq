// Pure parts of the hosted backup (docs/SPEC.md, "Backup and restore"),
// shared by the Cloud Run worker, the watch job and restore:verify.
// Stage 1 sets hold the operational tables; Stage 2 adds receipts and money.

export const MANIFEST_FORMAT = 1;

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
  };
}

export function buildManifest({ stage, facts, files }) {
  return {
    format: MANIFEST_FORMAT,
    stage,
    recovery_point: facts.recoveryPoint,
    migrations: facts.migrations,
    tables: facts.tables,
    auth: facts.auth,
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
 * restore:verify core: compare a restored database with a set's manifest.
 * Returns { ok, checks: [{ name, ok }] }; never values.
 */
export async function verifyRestore(db, manifest) {
  const checks = [];
  const add = (name, ok) => checks.push({ name, ok: Boolean(ok) });
  add('manifest format', manifest.format === MANIFEST_FORMAT);
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
  return { ok: checks.every((c) => c.ok), checks };
}
