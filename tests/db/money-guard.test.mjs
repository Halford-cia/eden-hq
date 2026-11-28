// Owner-only money, enforced in the database before budgets ship.
//
// Stage 1 creates eden.task_budgets with an owner-only SELECT policy and no
// write privilege for any app role. Stage 2 adds the audited write path. These
// tests prove that a non-owner can never receive a money row, even by
// querying the table directly with the app role, and that nobody can write
// one through the app role yet.

import { describe, it, expect, beforeAll } from 'vitest';
import {
  freshDb, seedCast, asUser, asAdmin, rpc, rejects, addMember, setGate,
} from './harness.mjs';

let db;
let cast;
let project;
let task;

const SELECT_BUDGETS = 'select task_id, estimated_cents, actual_cents, vendor_name, category, payment_state from eden.task_budgets';

beforeAll(async () => {
  db = await freshDb();
  cast = await seedCast(db);
  [project] = await asUser(db, cast.owner.id, (tx) =>
    rpc(tx, 'create_project', { p_workspace_id: cast.ws.home_building, p_name: 'SYNTHETIC Budget build' }));
  [task] = await asUser(db, cast.owner.id, (tx) =>
    rpc(tx, 'create_task', { p_project_id: project.id, p_kind: 'task', p_title: 'SYNTHETIC Framing' }));
  // Seeded by the operator role: Stage 1 has no app write path for money.
  await asAdmin(db, (tx) => tx.query(
    `insert into eden.task_budgets (task_id, workspace_id, project_id, estimated_cents, actual_cents, vendor_name, category)
     values ($1, $2, $3, 10000, 12500, 'SYNTHETIC Example Co.', 'SYNTHETIC Framing')`,
    [task.id, cast.ws.home_building, project.id]));
});

describe('reading money rows', () => {
  it('an active owner of the workspace can read the budget row', async () => {
    const { rows } = await asUser(db, cast.owner.id, (tx) => tx.query(SELECT_BUDGETS));
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].estimated_cents)).toBe(10000);
  });

  it('a same-workspace member, the manager and a stranger receive no money rows', async () => {
    for (const who of [cast.homeMember, cast.manager, cast.stranger]) {
      const { rows } = await asUser(db, who.id, (tx) => tx.query(SELECT_BUDGETS));
      expect(rows).toEqual([]);
      const agg = await asUser(db, who.id, (tx) =>
        tx.query('select count(*)::int as n, sum(estimated_cents) as s from eden.task_budgets'));
      expect(agg.rows[0]).toEqual({ n: 0, s: null });
    }
  });

  it('a signed-out caller cannot touch the table', async () => {
    const err = await rejects(asUser(db, null, (tx) => tx.query(SELECT_BUDGETS), { role: 'anon' }));
    expect(err.code).toBe('42501');
  });

  it('an owner of a different workspace only (Stay Eden) receives nothing', async () => {
    // The manager is promoted to owner of Stay Eden for this check only.
    await addMember(db, cast.ws.stay_eden_ops, cast.manager, 'owner', 'SYNTHETIC Cleaning manager');
    try {
      const { rows } = await asUser(db, cast.manager.id, (tx) => tx.query(SELECT_BUDGETS));
      expect(rows).toEqual([]);
    } finally {
      await addMember(db, cast.ws.stay_eden_ops, cast.manager, 'member', 'SYNTHETIC Cleaning manager');
    }
  });

  it('a downgrade from owner to member hides money on the next request', async () => {
    const o = cast.owners[2];
    expect((await asUser(db, o.id, (tx) => tx.query(SELECT_BUDGETS))).rows).toHaveLength(1);
    await addMember(db, cast.ws.home_building, o, 'member');
    try {
      expect((await asUser(db, o.id, (tx) => tx.query(SELECT_BUDGETS))).rows).toEqual([]);
      // Operational reads still work for the downgraded member.
      const tasks = await asUser(db, o.id, (tx) => rpc(tx, 'list_tasks', { p_project_id: project.id }));
      expect(tasks).toHaveLength(1);
    } finally {
      await addMember(db, cast.ws.home_building, o, 'owner');
    }
  });

  it('a closed gate hides money from owners too', async () => {
    await setGate(db, false);
    try {
      expect((await asUser(db, cast.owner.id, (tx) => tx.query(SELECT_BUDGETS))).rows).toEqual([]);
    } finally {
      await setGate(db, true);
    }
  });

  it('planted claims do not reveal money to a member', async () => {
    const { rows } = await asUser(db, cast.homeMember.id, (tx) => tx.query(SELECT_BUDGETS), {
      extraClaims: { app_metadata: { role: 'owner' }, user_role: 'owner' },
    });
    expect(rows).toEqual([]);
  });
});

describe('writing money rows (Stage 2 adds the audited path)', () => {
  it('no app role can insert, update or delete a budget, owners included', async () => {
    for (const who of [cast.owner, cast.homeMember]) {
      const ins = await rejects(asUser(db, who.id, (tx) => tx.query(
        `insert into eden.task_budgets (task_id, workspace_id, project_id, estimated_cents)
         values ($1, $2, $3, 1)`, [task.id, cast.ws.home_building, project.id])));
      expect(ins.code).toBe('42501');
      const upd = await rejects(asUser(db, who.id, (tx) => tx.query(
        'update eden.task_budgets set actual_cents = 1')));
      expect(upd.code).toBe('42501');
      const del = await rejects(asUser(db, who.id, (tx) => tx.query('delete from eden.task_budgets')));
      expect(del.code).toBe('42501');
    }
  });
});

describe('operational results never carry money', () => {
  const money = /cents|cost|vendor_name|payment|category|receipt|budget/;

  it('list, detail and export return operational fields only, to an owner too', async () => {
    const results = await asUser(db, cast.owner.id, async (tx) => ({
      list: await rpc(tx, 'list_tasks', { p_project_id: project.id }),
      detail: await rpc(tx, 'get_task', { p_task_id: task.id }),
      exp: await rpc(tx, 'export_project', { p_project_id: project.id }),
    }));
    const keys = [
      ...Object.keys(results.list[0]),
      ...Object.keys(results.detail[0]),
      ...Object.keys(results.exp[0].tasks[0]),
    ];
    for (const k of keys) expect(k).not.toMatch(money);
    const text = JSON.stringify(results);
    expect(text).not.toContain('12500');
    expect(text).not.toContain('Example Co.');
  });
});

// Open review items (spec review round 3), carried as stage tests.
describe('pending: Stage 2 receipts (spec review round 3, P0-1)', () => {
  it.todo('an owner downgraded to member with roster:apply cannot fetch a receipt they downloaded before, on the same session, through the hosted delivery path after the cache is warmed');
  it.todo('removing a receipt cuts off a warmed cached download on the same session');
  it.todo('full-export images go through the same ownership-checked, non-cacheable download path');
});
