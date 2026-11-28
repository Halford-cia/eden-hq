// Empty-project rehearsal of the roster procedure (docs/SPEC.md Stage 1
// acceptance), on a database built only from supabase/migrations/.
// Six SYNTHETIC Google identities; the roster text lives only in memory.

import { describe, it, expect, beforeAll } from 'vitest';
import { freshDb, createAuthUser, MIGRATOR, asUser, rpc, setGate, rejects } from '../db/harness.mjs';
import {
  parseRoster, applyRoster, showRoster, pendingAccounts, planRoster,
} from '../../scripts/lib/roster-core.mjs';

let db;
let people;

const header = 'workspace_kind,user_id,google_subject,role,display_name';
const line = (kind, p, role, name) => `${kind},${p.id},${p.subject},${role},"${name}"`;

function baseRoster({ dadRole = 'owner', dropSister = false, extra = [] } = {}) {
  const { a, b, c, d, m } = people;
  const owners = [[a, 'SYNTHETIC Owner A'], [b, 'SYNTHETIC Owner B'], [c, 'SYNTHETIC Owner C'], [d, 'SYNTHETIC Owner D']];
  const rows = [header];
  for (const [p, n] of owners) {
    if (dropSister && p === d) continue;
    rows.push(line('home_building', p, p === b ? dadRole : 'owner', n));
  }
  for (const [p, n] of owners) rows.push(line('stay_eden_ops', p, 'owner', n));
  rows.push(line('stay_eden_ops', m, 'member', 'SYNTHETIC Cleaning manager'));
  rows.push(...extra);
  return rows.join('\n') + '\n';
}

beforeAll(async () => {
  db = await freshDb();
  people = {
    a: await createAuthUser(db, 'owner-a'),
    b: await createAuthUser(db, 'owner-b'),
    c: await createAuthUser(db, 'owner-c'),
    d: await createAuthUser(db, 'owner-d'),
    m: await createAuthUser(db, 'manager'),
    n: await createAuthUser(db, 'newcomer'),
  };
  await db.query(`set role ${MIGRATOR}`);
});

async function show() {
  const r = await showRoster(db);
  return Object.fromEntries(r.map((w) => [w.kind, {
    active: w.active.map((m) => `${m.role}:${m.displayName}`).sort(),
    revoked: w.revokedCount,
  }]));
}

describe('roster:pending', () => {
  it('lists every account without an active membership, with its Google subject', async () => {
    const rows = await pendingAccounts(db);
    expect(rows).toHaveLength(6);
    expect(rows.find((r) => r.user_id === people.n.id).google_subject).toBe(people.n.subject);
  });
});

describe('roster:apply', () => {
  it('dry run reports the changes and makes none', async () => {
    const result = await applyRoster(db, parseRoster(baseRoster()), { dryRun: true });
    expect(result.errors).toEqual([]);
    expect(result.changes).toHaveLength(9);
    expect((await show()).home_building.active).toEqual([]);
  });

  it('applies: four owners in both workspaces, the manager only in Stay Eden', async () => {
    const result = await applyRoster(db, parseRoster(baseRoster()));
    expect(result.applied).toBe(true);
    const s = await show();
    expect(s.home_building.active).toEqual([
      'owner:SYNTHETIC Owner A', 'owner:SYNTHETIC Owner B', 'owner:SYNTHETIC Owner C', 'owner:SYNTHETIC Owner D',
    ]);
    expect(s.stay_eden_ops.active).toEqual([
      'member:SYNTHETIC Cleaning manager',
      'owner:SYNTHETIC Owner A', 'owner:SYNTHETIC Owner B', 'owner:SYNTHETIC Owner C', 'owner:SYNTHETIC Owner D',
    ]);
    const pending = await pendingAccounts(db);
    expect(pending.map((r) => r.user_id)).toEqual([people.n.id]);
  });

  it('a rerun with the same file changes nothing', async () => {
    const result = await applyRoster(db, parseRoster(baseRoster()));
    expect(result.applied).toBe(false);
    expect(result.changes).toEqual([]);
  });

  it('changing a role to member downgrades it, and the next request loses owner rights', async () => {
    await db.query('reset role');
    await setGate(db, true);
    const ws = (await db.query(`select id from eden.workspaces where kind = 'home_building'`)).rows[0].id;
    await db.query(`set role ${MIGRATOR}`);
    const result = await applyRoster(db, parseRoster(baseRoster({ dadRole: 'member' })));
    expect(result.changes.map((c) => c.action)).toEqual(['role owner -> member']);
    await db.query('reset role');
    const err = await rejects(asUser(db, people.b.id, (tx) =>
      rpc(tx, 'create_project', { p_workspace_id: ws, p_name: 'SYNTHETIC x' })));
    expect(err.code).toBe('42501');
    await db.query(`set role ${MIGRATOR}`);
    expect((await show()).home_building.active).toContain('member:SYNTHETIC Owner B');
  });

  it('removing a line revokes that membership, keeping the row', async () => {
    const drop = await applyRoster(db, parseRoster(baseRoster({ dropSister: true })));
    // The same file also restores Owner B's role from the previous test.
    expect(drop.changes.map((c) => c.action).sort()).toEqual(['revoke', 'role member -> owner']);
    const s = await show();
    expect(s.home_building.active).not.toContain('owner:SYNTHETIC Owner D');
    expect(s.home_building.revoked).toBe(1);
    // Putting the line back reinstates it.
    const back = await applyRoster(db, parseRoster(baseRoster()));
    expect(back.changes.map((c) => c.action)).toEqual(['reinstate']);
  });

  it('refuses a roster that leaves Home building without an owner, changing nothing', async () => {
    const { a, b, c, d, m } = people;
    const text = [header,
      line('home_building', a, 'member', 'SYNTHETIC Owner A'),
      ...[a, b, c, d].map((p) => line('stay_eden_ops', p, 'owner', 'SYNTHETIC x')),
      line('stay_eden_ops', m, 'member', 'SYNTHETIC Cleaning manager'),
    ].join('\n');
    const before = await show();
    const result = await applyRoster(db, parseRoster(text));
    expect(result.applied).toBe(false);
    expect(result.errors.join('\n')).toMatch(/Home building: the roster leaves this workspace without an owner/);
    expect(await show()).toEqual(before);
  });

  it('refuses a missing UUID, a mismatched subject and an unknown kind, naming each line by display name', async () => {
    const extra = [
      `home_building,00000000-0000-4000-8000-000000000000,synthetic-nobody,member,"SYNTHETIC Ghost"`,
      `home_building,${people.n.id},synthetic-wrong-subject,member,"SYNTHETIC Wrong subject"`,
      `garden_shed,${people.n.id},${people.n.subject},member,"SYNTHETIC Unknown kind"`,
    ];
    const before = await show();
    const result = await applyRoster(db, parseRoster(baseRoster({ extra })));
    expect(result.applied).toBe(false);
    const text = result.errors.join('\n');
    expect(text).toMatch(/"SYNTHETIC Ghost".*no Auth account/);
    expect(text).toMatch(/"SYNTHETIC Wrong subject".*Google subject does not match/);
    expect(text).toMatch(/"SYNTHETIC Unknown kind".*unknown workspace kind/);
    // Errors never carry UUIDs or subjects.
    expect(text).not.toContain(people.n.id);
    expect(text).not.toContain(people.n.subject);
    expect(await show()).toEqual(before);
  });

  it('refuses the same person twice in one workspace', async () => {
    const extra = [line('home_building', people.a, 'member', 'SYNTHETIC Owner A again')];
    const { errors } = await planRoster(db, parseRoster(baseRoster({ extra })));
    expect(errors.join('\n')).toMatch(/appears twice/);
  });

  it('adds a newcomer after their first sign-in, in one transaction with the rest', async () => {
    const extra = [line('home_building', people.n, 'member', 'SYNTHETIC Newcomer')];
    const result = await applyRoster(db, parseRoster(baseRoster({ extra })));
    expect(result.changes.map((c) => c.action)).toEqual(['add']);
    expect(await pendingAccounts(db)).toEqual([]);
  });
});
