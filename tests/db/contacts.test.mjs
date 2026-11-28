// Recorded names (outside contacts): owners correct and retire them, members
// cannot (review round 2, P1-5). Real queries as an owner, a same-workspace
// member, the operations-only manager, a signed-in account with no
// membership and a signed-out caller. SYNTHETIC data.

import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { freshDb, seedCast, asUser, asAnon, rpc, rejects, setGate, addMember } from './harness.mjs';

let db;
let cast;
let project;

beforeAll(async () => {
  db = await freshDb();
  cast = await seedCast(db);
  [project] = await asUser(db, cast.owner.id, (tx) =>
    rpc(tx, 'create_project', { p_workspace_id: cast.ws.home_building, p_name: 'SYNTHETIC Names build' }));
});

async function contact(name, ws = cast.ws.home_building) {
  const [c] = await asUser(db, cast.owner.id, (tx) =>
    rpc(tx, 'create_contact', { p_workspace_id: ws, p_display_name: name, p_kind: 'vendor' }));
  return c;
}

const nameOf = async (id) => {
  const rows = await asUser(db, cast.owner.id, (tx) =>
    tx.query('select display_name, kind, archived_at from eden.outside_contacts where id = $1', [id]));
  return rows.rows[0];
};

function expectUnavailable(err) {
  expect(err.code).toBe('P0002');
}

describe('update_contact', () => {
  it('an owner renames a name and changes its kind; the task keeps the same contact', async () => {
    const c = await contact('SYNTHETIC Elecrtic Co');
    const [t] = await asUser(db, cast.owner.id, (tx) => rpc(tx, 'create_task', {
      p_project_id: project.id, p_kind: 'task', p_title: 'SYNTHETIC Wiring', p_assignee_contact_id: c.id,
    }));
    const [r] = await asUser(db, cast.owners[2].id, (tx) => rpc(tx, 'update_contact', {
      p_contact_id: c.id, p_display_name: '  SYNTHETIC Electric Co  ', p_kind: 'person',
    }));
    expect(r.id).toBe(c.id);
    expect(await nameOf(c.id)).toMatchObject({ display_name: 'SYNTHETIC Electric Co', kind: 'person', archived_at: null });
    const [got] = await asUser(db, cast.homeMember.id, (tx) => rpc(tx, 'get_task', { p_task_id: t.id }));
    expect(got.assignee_id).toBe(c.id);
    expect(got.assignee_name).toBe('SYNTHETIC Electric Co');
  });

  it('a same-workspace member is refused, through the operation and directly', async () => {
    const c = await contact('SYNTHETIC Member cannot rename');
    const err = await rejects(asUser(db, cast.homeMember.id, (tx) => rpc(tx, 'update_contact', {
      p_contact_id: c.id, p_display_name: 'SYNTHETIC changed', p_kind: 'vendor',
    })));
    expect(err.code).toBe('42501');
    const direct = await asUser(db, cast.homeMember.id, (tx) => tx.query(
      `update eden.outside_contacts set display_name = 'SYNTHETIC changed' where id = $1`, [c.id]));
    // RLS: the owner-only update policy matches no row for a member.
    expect(direct.affectedRows).toBe(0);
    expect((await nameOf(c.id)).display_name).toBe('SYNTHETIC Member cannot rename');
  });

  it('the manager, an account with no membership and a missing id all get `unavailable`', async () => {
    const c = await contact('SYNTHETIC Outsiders cannot rename');
    for (const who of [cast.manager, cast.stranger]) {
      expectUnavailable(await rejects(asUser(db, who.id, (tx) => rpc(tx, 'update_contact', {
        p_contact_id: c.id, p_display_name: 'SYNTHETIC changed', p_kind: 'vendor',
      }))));
    }
    expectUnavailable(await rejects(asUser(db, cast.owner.id, (tx) => rpc(tx, 'update_contact', {
      p_contact_id: randomUUID(), p_display_name: 'SYNTHETIC changed', p_kind: 'vendor',
    }))));
    expect((await nameOf(c.id)).display_name).toBe('SYNTHETIC Outsiders cannot rename');
  });

  it('a signed-out caller cannot call it', async () => {
    const c = await contact('SYNTHETIC Anon cannot rename');
    const err = await rejects(asAnon(db, (tx) => rpc(tx, 'update_contact', {
      p_contact_id: c.id, p_display_name: 'x', p_kind: 'vendor',
    })));
    expect(err.code).toBe('42501');
  });

  it('a downgraded owner loses it at once, and the closed gate refuses even owners', async () => {
    const c = await contact('SYNTHETIC Downgrade name');
    const o = cast.owners[3];
    await addMember(db, cast.ws.home_building, o, 'member');
    try {
      const err = await rejects(asUser(db, o.id, (tx) => rpc(tx, 'update_contact', {
        p_contact_id: c.id, p_display_name: 'SYNTHETIC changed', p_kind: 'vendor',
      })));
      expect(err.code).toBe('42501');
    } finally {
      await addMember(db, cast.ws.home_building, o, 'owner');
    }
    await setGate(db, false);
    try {
      expectUnavailable(await rejects(asUser(db, cast.owner.id, (tx) => rpc(tx, 'update_contact', {
        p_contact_id: c.id, p_display_name: 'SYNTHETIC changed', p_kind: 'vendor',
      }))));
    } finally {
      await setGate(db, true);
    }
  });

  it('refuses an empty name or an unknown kind', async () => {
    const c = await contact('SYNTHETIC Valid name');
    for (const [name, kind] of [['   ', 'vendor'], ['SYNTHETIC ok', 'robot']]) {
      const err = await rejects(asUser(db, cast.owner.id, (tx) => rpc(tx, 'update_contact', {
        p_contact_id: c.id, p_display_name: name, p_kind: kind,
      })));
      expect(err.code).toBe('23514');
    }
  });
});

describe('list_contacts and archiving', () => {
  it('archived names leave the assignee list, stay on past tasks, and come back on restore', async () => {
    const c = await contact('SYNTHETIC Archive me Co');
    const [t] = await asUser(db, cast.owner.id, (tx) => rpc(tx, 'create_task', {
      p_project_id: project.id, p_kind: 'task', p_title: 'SYNTHETIC Old job', p_assignee_contact_id: c.id,
    }));
    await asUser(db, cast.owner.id, (tx) => rpc(tx, 'set_contact_archived', { p_contact_id: c.id, p_archived: true }));
    const picker = await asUser(db, cast.homeMember.id, (tx) =>
      rpc(tx, 'list_assignees', { p_workspace_id: cast.ws.home_building }));
    expect(picker.map((a) => a.id)).not.toContain(c.id);
    const active = await asUser(db, cast.homeMember.id, (tx) =>
      rpc(tx, 'list_contacts', { p_workspace_id: cast.ws.home_building }));
    expect(active.map((a) => a.id)).not.toContain(c.id);
    const archived = await asUser(db, cast.homeMember.id, (tx) =>
      rpc(tx, 'list_contacts', { p_workspace_id: cast.ws.home_building, p_archived: true }));
    expect(archived.find((a) => a.id === c.id)).toMatchObject({ display_name: 'SYNTHETIC Archive me Co', archived: true });
    const [got] = await asUser(db, cast.homeMember.id, (tx) => rpc(tx, 'get_task', { p_task_id: t.id }));
    expect(got.assignee_id).toBe(c.id);
    expect(got.assignee_name).toBe('SYNTHETIC Archive me Co');
    // A member cannot restore it.
    const err = await rejects(asUser(db, cast.homeMember.id, (tx) =>
      rpc(tx, 'set_contact_archived', { p_contact_id: c.id, p_archived: false })));
    expect(err.code).toBe('42501');
    await asUser(db, cast.owner.id, (tx) => rpc(tx, 'set_contact_archived', { p_contact_id: c.id, p_archived: false }));
    const back = await asUser(db, cast.homeMember.id, (tx) =>
      rpc(tx, 'list_assignees', { p_workspace_id: cast.ws.home_building }));
    expect(back.map((a) => a.id)).toContain(c.id);
  });

  it('pages past 50 names with a cursor and no repeats', async () => {
    const [ops] = await asUser(db, cast.owner.id, (tx) => rpc(tx, 'my_workspaces'))
      .then((rows) => rows.filter((w) => w.kind === 'stay_eden_ops'));
    for (let i = 0; i < 53; i++) await contact(`SYNTHETIC Paged name ${String(i).padStart(2, '0')}`, ops.workspace_id);
    const first = await asUser(db, cast.manager.id, (tx) => rpc(tx, 'list_contacts', { p_workspace_id: ops.workspace_id }));
    expect(first).toHaveLength(50);
    const cursor = first.at(-1).next_cursor;
    expect(cursor).toBeTruthy();
    const second = await asUser(db, cast.manager.id, (tx) =>
      rpc(tx, 'list_contacts', { p_workspace_id: ops.workspace_id, p_after: cursor }));
    expect(second).toHaveLength(3);
    expect(second.at(-1).next_cursor).toBeNull();
    const ids = [...first, ...second].map((c) => c.id);
    expect(new Set(ids).size).toBe(53);
  });

  it('the manager cannot list Home names; an account with no membership lists nothing; signed-out is refused', async () => {
    await contact('SYNTHETIC Home only name');
    for (const who of [cast.manager, cast.stranger]) {
      expectUnavailable(await rejects(asUser(db, who.id, (tx) =>
        rpc(tx, 'list_contacts', { p_workspace_id: cast.ws.home_building }))));
    }
    const err = await rejects(asAnon(db, (tx) => rpc(tx, 'list_contacts', { p_workspace_id: cast.ws.home_building })));
    expect(err.code).toBe('42501');
  });
});
