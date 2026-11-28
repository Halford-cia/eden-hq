// Roster of record: memberships come only from Hank's private roster
// (docs/SPEC.md, "Roster of record"). Pure logic over a database handle with
// `query(text, params) -> { rows }`, so tests run it against local Postgres.
//
// Output is for the terminal only. Apply and show print display names, never
// UUIDs or Google subjects; pending prints what Hank needs to copy.

import { parseCsvRecords } from './csv.mjs';

export const WORKSPACE_KINDS = ['home_building', 'stay_eden_ops'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseRoster(text) {
  const records = parseCsvRecords(text, ['workspace_kind', 'user_id', 'google_subject', 'role', 'display_name']);
  return records.map((r) => ({
    lineNumber: r.lineNumber,
    kind: r.workspace_kind,
    userId: r.user_id.toLowerCase(),
    subject: r.google_subject,
    role: r.role.toLowerCase(),
    displayName: r.display_name,
  }));
}

function label(line) {
  return line.displayName ? `"${line.displayName}" (line ${line.lineNumber})` : `line ${line.lineNumber}`;
}

async function workspaces(db) {
  const { rows } = await db.query('select id, kind, name from eden.workspaces order by kind');
  return rows;
}

/** Validate the roster against Auth and compute the change set. */
export async function planRoster(db, lines) {
  const errors = [];
  const ws = await workspaces(db);
  const wsByKind = new Map(ws.map((w) => [w.kind, w]));
  const seen = new Set();

  for (const line of lines) {
    if (!WORKSPACE_KINDS.includes(line.kind) || !wsByKind.has(line.kind)) {
      errors.push(`${label(line)}: unknown workspace kind`);
    }
    if (!UUID_RE.test(line.userId)) errors.push(`${label(line)}: user_id is not a UUID`);
    if (!line.subject) errors.push(`${label(line)}: google_subject is empty`);
    if (!['owner', 'member'].includes(line.role)) errors.push(`${label(line)}: role must be owner or member`);
    if (!line.displayName) errors.push(`${label(line)}: display_name is empty`);
    if (line.displayName.length > 80) errors.push(`${label(line)}: display_name is longer than 80 characters`);
    const key = `${line.kind}|${line.userId}`;
    if (seen.has(key)) errors.push(`${label(line)}: the same person appears twice in this workspace`);
    seen.add(key);
  }

  const ids = [...new Set(lines.map((l) => l.userId).filter((id) => UUID_RE.test(id)))];
  const auth = new Map();
  if (ids.length) {
    const { rows } = await db.query(
      `select u.id::text as id,
              coalesce(array_agg(i.provider_id) filter (where i.provider = 'google'), '{}') as subjects
       from auth.users u
       left join auth.identities i on i.user_id = u.id
       where u.id = any($1::uuid[])
       group by u.id`,
      [ids],
    );
    for (const r of rows) auth.set(r.id, r.subjects);
  }
  for (const line of lines) {
    if (!UUID_RE.test(line.userId)) continue;
    const subjects = auth.get(line.userId);
    if (!subjects) {
      errors.push(`${label(line)}: no Auth account has this UUID in this project`);
    } else if (!subjects.includes(line.subject)) {
      errors.push(`${label(line)}: the Google subject does not match this account`);
    }
  }

  for (const kind of WORKSPACE_KINDS) {
    if (!wsByKind.has(kind)) continue;
    if (!lines.some((l) => l.kind === kind && l.role === 'owner')) {
      errors.push(`${wsByKind.get(kind).name}: the roster leaves this workspace without an owner`);
    }
  }

  const changes = [];
  if (errors.length) return { errors, changes };

  const { rows: current } = await db.query(
    `select workspace_id, user_id::text as user_id, display_name, role, revoked_at
     from eden.workspace_members`,
  );
  const cur = new Map(current.map((r) => [`${r.workspace_id}|${r.user_id}`, r]));
  const listed = new Set();
  for (const line of lines) {
    const w = wsByKind.get(line.kind);
    const key = `${w.id}|${line.userId}`;
    listed.add(key);
    const row = cur.get(key);
    const base = { workspaceId: w.id, workspaceName: w.name, userId: line.userId, displayName: line.displayName, role: line.role };
    if (!row) {
      changes.push({ ...base, action: 'add' });
    } else if (row.revoked_at) {
      changes.push({ ...base, action: 'reinstate' });
    } else if (row.role !== line.role || row.display_name !== line.displayName) {
      changes.push({ ...base, action: row.role !== line.role ? `role ${row.role} -> ${line.role}` : 'rename', previousName: row.display_name });
    }
  }
  for (const row of current) {
    const key = `${row.workspace_id}|${row.user_id}`;
    if (!row.revoked_at && !listed.has(key)) {
      const w = ws.find((x) => x.id === row.workspace_id);
      changes.push({
        workspaceId: row.workspace_id, workspaceName: w ? w.name : 'workspace', userId: row.user_id,
        displayName: row.display_name, role: row.role, action: 'revoke',
      });
    }
  }
  return { errors, changes };
}

export function describeChange(c) {
  switch (c.action) {
    case 'add': return `${c.workspaceName}: add ${c.displayName} as ${c.role}`;
    case 'reinstate': return `${c.workspaceName}: reinstate ${c.displayName} as ${c.role}`;
    case 'revoke': return `${c.workspaceName}: revoke ${c.displayName}`;
    case 'rename': return `${c.workspaceName}: rename ${c.previousName} to ${c.displayName}`;
    default: return `${c.workspaceName}: ${c.displayName}: ${c.action}`;
  }
}

/**
 * Apply the whole roster in one transaction, or refuse it and change nothing.
 * Returns { applied, errors, changes }.
 */
export async function applyRoster(db, lines, { dryRun = false } = {}) {
  if (dryRun) {
    const plan = await planRoster(db, lines);
    return { applied: false, ...plan };
  }
  await db.query('begin');
  try {
    await db.query('lock table eden.workspace_members in share row exclusive mode');
    const plan = await planRoster(db, lines);
    if (plan.errors.length) {
      await db.query('rollback');
      return { applied: false, ...plan };
    }
    for (const c of plan.changes) {
      if (c.action === 'revoke') {
        await db.query(
          `update eden.workspace_members set revoked_at = now()
           where workspace_id = $1 and user_id = $2 and revoked_at is null`,
          [c.workspaceId, c.userId],
        );
      } else {
        await db.query(
          `insert into eden.workspace_members (workspace_id, user_id, display_name, role)
           values ($1, $2, $3, $4)
           on conflict (workspace_id, user_id) do update
             set display_name = excluded.display_name,
                 role = excluded.role,
                 granted_at = case when eden.workspace_members.revoked_at is not null
                                   then now() else eden.workspace_members.granted_at end,
                 revoked_at = null`,
          [c.workspaceId, c.userId, c.displayName, c.role],
        );
      }
    }
    await db.query('commit');
    return { applied: plan.changes.length > 0, ...plan };
  } catch (e) {
    await db.query('rollback').catch(() => {});
    throw e;
  }
}

/** Auth accounts without an active membership (for Hank to copy into the roster). */
export async function pendingAccounts(db) {
  const { rows } = await db.query(
    `select u.id::text as user_id,
            i.provider_id as google_subject,
            coalesce(i.identity_data ->> 'email', u.email) as email,
            coalesce((i.identity_data ->> 'email_verified')::boolean, u.email_confirmed_at is not null) as verified
     from auth.users u
     left join auth.identities i on i.user_id = u.id and i.provider = 'google'
     where not exists (
       select 1 from eden.workspace_members m where m.user_id = u.id and m.revoked_at is null
     )
     order by u.created_at, u.id`,
  );
  return rows;
}

/** Read-back: active members by workspace, and how many rows are revoked. */
export async function showRoster(db) {
  const ws = await workspaces(db);
  const { rows } = await db.query(
    `select workspace_id, display_name, role, revoked_at is not null as revoked
     from eden.workspace_members
     order by role desc, display_name`,
  );
  return ws.map((w) => ({
    kind: w.kind,
    name: w.name,
    active: rows.filter((r) => r.workspace_id === w.id && !r.revoked)
      .map((r) => ({ displayName: r.display_name, role: r.role })),
    revokedCount: rows.filter((r) => r.workspace_id === w.id && r.revoked).length,
  }));
}

export function formatShow(result) {
  const out = [];
  for (const w of result) {
    out.push(`${w.name} (${w.kind})`);
    for (const m of w.active) out.push(`  ${m.role.padEnd(6)}  ${m.displayName}`);
    if (!w.active.length) out.push('  (no active members)');
    out.push(`  revoked rows: ${w.revokedCount}`);
  }
  return out.join('\n');
}
