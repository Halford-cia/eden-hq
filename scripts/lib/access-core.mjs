// The access gate and the one-serving-project rule (docs/SPEC.md,
// "One serving project" and "Restore and cutover").
//
// Stricter than the spec text, by the open spec review item P0-2 (round 3):
// before a gate opens, every other project in the register that is not
// deleted must be READ BACK with a closed gate. An unreachable project, or one
// whose keys were deleted but whose gate cannot be read, blocks the opening:
// deleting a publishable key does not revoke user sessions on that project.

import { parseCsvRecords } from './csv.mjs';
import { checkAccounts } from './accounts-core.mjs';

export const PURPOSES = ['production', 'replacement', 'drill', 'rehearsal'];
export const STATES = ['serving', 'closed', 'keys removed', 'deleted'];
const REF_RE = /^[a-z0-9]{20}$/;

export function parseRegister(text) {
  const recs = parseCsvRecords(text, ['ref', 'publishable_key', 'purpose', 'state']);
  const errors = [];
  const entries = recs.map((r) => {
    const e = { lineNumber: r.lineNumber, ref: r.ref.toLowerCase(), publishableKey: r.publishable_key, purpose: r.purpose.toLowerCase(), state: r.state.toLowerCase() };
    if (!REF_RE.test(e.ref)) errors.push(`line ${e.lineNumber}: ref is not a Supabase project ref`);
    if (!PURPOSES.includes(e.purpose)) errors.push(`line ${e.lineNumber}: purpose must be one of ${PURPOSES.join(', ')}`);
    if (!STATES.includes(e.state)) errors.push(`line ${e.lineNumber}: state must be one of ${STATES.join(', ')}`);
    return e;
  });
  const refs = entries.map((e) => e.ref);
  const dup = refs.find((r, i) => refs.indexOf(r) !== i);
  if (dup) errors.push(`project ${dup} appears twice in the register`);
  return { entries, errors };
}

/**
 * The project ref a Supabase connection string names: the direct host
 * db.<ref>.supabase.co, or the pooler user postgres.<ref>.
 */
export function refFromConnectionString(conn) {
  let url;
  try {
    url = new URL(conn);
  } catch {
    return null;
  }
  const host = url.hostname.match(/^db\.([a-z0-9]{20})\.supabase\.co$/);
  if (host) return host[1];
  const user = decodeURIComponent(url.username).match(/^[a-z_]+\.([a-z0-9]{20})$/);
  if (user) return user[1];
  return null;
}

export async function readGate(db) {
  const { rows } = await db.query('select is_open from eden_private.access_gate where id = 1');
  return rows.length ? rows[0].is_open === true : false;
}

export async function closeGate(db, by) {
  await db.query(
    `insert into eden_private.access_gate (id, is_open, changed_by, changed_at)
     values (1, false, $1, now())
     on conflict (id) do update set is_open = false, changed_by = excluded.changed_by, changed_at = now()`,
    [by],
  );
  if (await readGate(db)) throw new Error('the gate did not read back closed');
  return { closed: true };
}

/**
 * Decide whether the target may open, then open it.
 *   connect(ref) -> db handle for that project, or throws when unreachable.
 * Returns { opened, refusals }.
 */
export async function openGate({ register, targetRef, connect, by, synthetic = false, expectedAccounts = null }) {
  const refusals = [];
  const target = register.find((e) => e.ref === targetRef);
  if (!target) {
    return { opened: false, refusals: [`${targetRef}: not in the project register`] };
  }
  if (target.state === 'deleted') refusals.push(`${targetRef}: the register marks it deleted`);
  const copy = target.purpose === 'drill' || target.purpose === 'rehearsal';
  if (copy && !synthetic) {
    refusals.push(`${targetRef}: a ${target.purpose} copy opens only when it holds synthetic data (pass --synthetic-data to confirm)`);
  }
  // The confirmation is checked, not taken on trust (review round 2, P1-2):
  // the copy's Auth rows must be exactly the expected test accounts.
  if (synthetic && !(expectedAccounts && expectedAccounts.length)) {
    refusals.push(`${targetRef}: --synthetic-data needs --expected-accounts <file>, the test accounts the copy may hold`);
  }

  for (const other of register) {
    if (other.ref === targetRef || other.state === 'deleted') continue;
    if (other.state === 'serving') {
      refusals.push(`${other.ref}: the register still marks it serving; close it and mark it closed first`);
      continue;
    }
    let db;
    try {
      db = await connect(other.ref);
    } catch {
      refusals.push(`${other.ref}: unreachable, so its gate cannot be read back closed (deleted keys alone are not proof; spec review P0-2)`);
      continue;
    }
    try {
      if (await readGate(db)) refusals.push(`${other.ref}: its gate is OPEN; run access:close against it first`);
    } catch {
      refusals.push(`${other.ref}: its gate could not be read`);
    } finally {
      await db.end?.();
    }
  }
  if (refusals.length) return { opened: false, refusals };

  const db = await connect(targetRef);
  try {
    if (synthetic) {
      const { ok, problems } = await checkAccounts(db, expectedAccounts);
      if (!ok) {
        return {
          opened: false,
          refusals: problems.map((p) => `${targetRef}: ${p}; it may hold a real person, so it stays closed`),
        };
      }
    }
    await db.query(
      `insert into eden_private.access_gate (id, is_open, changed_by, changed_at)
       values (1, true, $1, now())
       on conflict (id) do update set is_open = true, changed_by = excluded.changed_by, changed_at = now()`,
      [by],
    );
    if (!(await readGate(db))) throw new Error('the gate did not read back open');
  } finally {
    await db.end?.();
  }
  return { opened: true, refusals: [] };
}
