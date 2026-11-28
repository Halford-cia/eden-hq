// Who can read and write what, proven by real queries as each role:
// owner, same-workspace member, the operations-only manager, a signed-in
// account with no membership, and a signed-out (anon) caller.

import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  freshDb, seedCast, asUser, asAnon, asAdmin, rpc, rejects, setGate, revokeMember, addMember,
} from './harness.mjs';

let db;
let cast;
let homeProject;
let homeTask;
let opsProject;
let opsItem;

beforeAll(async () => {
  db = await freshDb();
  cast = await seedCast(db);
  [homeProject] = await asUser(db, cast.owner.id, (tx) =>
    rpc(tx, 'create_project', { p_workspace_id: cast.ws.home_building, p_name: 'SYNTHETIC First build' }));
  [homeTask] = await asUser(db, cast.owner.id, (tx) =>
    rpc(tx, 'create_task', { p_project_id: homeProject.id, p_kind: 'task', p_title: 'SYNTHETIC Frame walls' }));
  [opsProject] = await asUser(db, cast.owner.id, (tx) =>
    rpc(tx, 'create_project', { p_workspace_id: cast.ws.stay_eden_ops, p_name: 'SYNTHETIC Example Cottage' }));
  [opsItem] = await asUser(db, cast.owner.id, (tx) =>
    rpc(tx, 'create_task', {
      p_project_id: opsProject.id, p_kind: 'maintenance', p_title: 'SYNTHETIC Leaking tap',
      p_assignee_user_id: cast.manager.id,
    }));
});

function expectUnavailable(err) {
  expect(err.code).toBe('P0002');
  expect(err.message).toBe('unavailable');
}

describe('entry: which workspaces each account sees', () => {
  it('owners see both workspaces as owner', async () => {
    for (const o of cast.owners) {
      const rows = await asUser(db, o.id, (tx) => rpc(tx, 'my_workspaces'));
      expect(rows.map((r) => [r.kind, r.role])).toEqual([
        ['home_building', 'owner'], ['stay_eden_ops', 'owner'],
      ]);
    }
  });

  it('the manager sees only Stay Eden operations, as member', async () => {
    const rows = await asUser(db, cast.manager.id, (tx) => rpc(tx, 'my_workspaces'));
    expect(rows.map((r) => [r.kind, r.role])).toEqual([['stay_eden_ops', 'member']]);
  });

  it('a new Google identity with no membership sees nothing', async () => {
    const rows = await asUser(db, cast.stranger.id, (tx) => rpc(tx, 'my_workspaces'));
    expect(rows).toEqual([]);
    const direct = await asUser(db, cast.stranger.id, (tx) =>
      tx.query('select count(*)::int as n from eden.tasks'));
    expect(direct.rows[0].n).toBe(0);
  });

  it('a signed-out caller cannot reach the API or the tables at all', async () => {
    const e1 = await rejects(asAnon(db, (tx) => rpc(tx, 'my_workspaces')));
    expect(e1.code).toBe('42501');
    const e2 = await rejects(asAnon(db, (tx) => tx.query('select * from eden.tasks')));
    expect(e2.code).toBe('42501');
    const e3 = await rejects(asAnon(db, (tx) => tx.query('select * from eden.workspaces')));
    expect(e3.code).toBe('42501');
  });
});

describe('manager against Home building', () => {
  it('a known Home project and a missing one look the same', async () => {
    const known = await rejects(asUser(db, cast.manager.id, (tx) =>
      rpc(tx, 'get_project', { p_project_id: homeProject.id })));
    const missing = await rejects(asUser(db, cast.manager.id, (tx) =>
      rpc(tx, 'get_project', { p_project_id: randomUUID() })));
    expectUnavailable(known);
    expectUnavailable(missing);
    expect(known.message).toBe(missing.message);
  });

  it('cannot list, read, export or add to Home work', async () => {
    for (const [name, args] of [
      ['list_tasks', { p_project_id: homeProject.id }],
      ['get_task', { p_task_id: homeTask.id }],
      ['export_project', { p_project_id: homeProject.id }],
      ['list_updates', { p_task_id: homeTask.id }],
      ['list_projects', { p_workspace_id: cast.ws.home_building }],
      ['list_assignees', { p_workspace_id: cast.ws.home_building }],
      ['create_task', { p_project_id: homeProject.id, p_kind: 'task', p_title: 'x' }],
      ['add_update', { p_task_id: homeTask.id, p_body: 'x' }],
      ['update_task', { p_task_id: homeTask.id, p_expected_version: 1, p_changes: { title: 'x' } }],
      ['create_project', { p_workspace_id: cast.ws.home_building, p_name: 'x' }],
    ]) {
      const err = await rejects(asUser(db, cast.manager.id, (tx) => rpc(tx, name, args)));
      expectUnavailable(err);
    }
  });

  it('direct table reads return no Home rows', async () => {
    const r = await asUser(db, cast.manager.id, async (tx) => ({
      projects: (await tx.query('select workspace_id from eden.projects')).rows,
      tasks: (await tx.query('select workspace_id from eden.tasks')).rows,
      members: (await tx.query('select workspace_id from eden.workspace_members')).rows,
      workspaces: (await tx.query('select kind from eden.workspaces')).rows,
    }));
    expect(r.projects.every((p) => p.workspace_id === cast.ws.stay_eden_ops)).toBe(true);
    expect(r.tasks.every((t) => t.workspace_id === cast.ws.stay_eden_ops)).toBe(true);
    expect(r.members.every((m) => m.workspace_id === cast.ws.stay_eden_ops)).toBe(true);
    expect(r.workspaces).toEqual([{ kind: 'stay_eden_ops' }]);
  });

  it('a direct insert into Home naming a supplied workspace is refused', async () => {
    const err = await rejects(asUser(db, cast.manager.id, (tx) => tx.query(
      `insert into eden.tasks (workspace_id, project_id, kind, title) values ($1, $2, 'task', 'x')`,
      [cast.ws.home_building, homeProject.id])));
    expect(['P0002', '42501']).toContain(err.code);
  });

  it('planted role claims grant nothing', async () => {
    const extraClaims = {
      app_metadata: { role: 'owner', workspaces: [cast.ws.home_building] },
      user_metadata: { role: 'owner' },
      user_role: 'owner',
    };
    const rows = await asUser(db, cast.manager.id, (tx) => rpc(tx, 'my_workspaces'), { extraClaims });
    expect(rows.map((r) => r.kind)).toEqual(['stay_eden_ops']);
    const err = await rejects(asUser(db, cast.manager.id, (tx) =>
      rpc(tx, 'get_project', { p_project_id: homeProject.id }), { extraClaims }));
    expectUnavailable(err);
  });

  it('cannot change membership rows or the access gate', async () => {
    const e1 = await rejects(asUser(db, cast.manager.id, (tx) => tx.query(
      `update eden.workspace_members set role = 'owner' where user_id = $1`, [cast.manager.id])));
    expect(e1.code).toBe('42501');
    const e2 = await rejects(asUser(db, cast.manager.id, (tx) => tx.query(
      `insert into eden.workspace_members (workspace_id, user_id, display_name, role)
       values ($1, $2, 'x', 'owner')`, [cast.ws.home_building, cast.manager.id])));
    expect(e2.code).toBe('42501');
    const e3 = await rejects(asUser(db, cast.owner.id, (tx) => tx.query(
      `update eden_private.access_gate set is_open = false`)));
    expect(e3.code).toBe('42501');
    const e4 = await rejects(asUser(db, cast.owner.id, (tx) => tx.query(
      `select is_open from eden_private.access_gate`)));
    expect(e4.code).toBe('42501');
  });
});

describe('the manager in Stay Eden operations', () => {
  it('sees and works the assigned item', async () => {
    const rows = await asUser(db, cast.manager.id, (tx) =>
      rpc(tx, 'list_tasks', { p_project_id: opsProject.id }));
    expect(rows.map((r) => r.title)).toEqual(['SYNTHETIC Leaking tap']);
    expect(rows[0].assignee_name).toBe('SYNTHETIC Cleaning manager');
    await asUser(db, cast.manager.id, (tx) =>
      rpc(tx, 'add_update', { p_task_id: opsItem.id, p_body: 'SYNTHETIC Plumber booked.' }));
    const [moved] = await asUser(db, cast.manager.id, (tx) =>
      rpc(tx, 'set_task_status', { p_task_id: opsItem.id, p_expected_version: 1, p_status: 'in_progress' }));
    expect(moved.version).toBe(2);
  });

  it('cannot create projects, contacts or archive work (owner operations)', async () => {
    for (const [name, args] of [
      ['create_project', { p_workspace_id: cast.ws.stay_eden_ops, p_name: 'x' }],
      ['create_contact', { p_workspace_id: cast.ws.stay_eden_ops, p_display_name: 'x', p_kind: 'vendor' }],
      ['set_task_archived', { p_task_id: opsItem.id, p_expected_version: 2, p_archived: true }],
      ['set_project_archived', { p_project_id: opsProject.id, p_expected_version: 1, p_archived: true }],
      ['update_project', { p_project_id: opsProject.id, p_expected_version: 1, p_name: 'SYNTHETIC renamed' }],
    ]) {
      const err = await rejects(asUser(db, cast.manager.id, (tx) => rpc(tx, name, args)));
      expect(err.code).toBe('42501');
    }
  });

  it('an update records the server-side author, not a supplied one', async () => {
    const err = await rejects(asUser(db, cast.manager.id, (tx) => tx.query(
      `insert into eden.task_updates (workspace_id, project_id, task_id, author_user_id, body)
       values ($1, $2, $3, $4, 'x')`,
      [cast.ws.stay_eden_ops, opsProject.id, opsItem.id, cast.owner.id])));
    expect(err.code).toBe('42501');
    const [u] = await asUser(db, cast.manager.id, (tx) =>
      rpc(tx, 'list_updates', { p_task_id: opsItem.id }));
    expect(u.author_name).toBe('SYNTHETIC Cleaning manager');
  });
});

describe('same-workspace member (non-owner) in Home building', () => {
  it('works tasks but cannot do owner operations', async () => {
    const rows = await asUser(db, cast.homeMember.id, (tx) =>
      rpc(tx, 'list_tasks', { p_project_id: homeProject.id }));
    expect(rows.length).toBe(1);
    const [t] = await asUser(db, cast.homeMember.id, (tx) =>
      rpc(tx, 'create_task', { p_project_id: homeProject.id, p_kind: 'task', p_title: 'SYNTHETIC Member task' }));
    expect(t.version).toBe(1);
    const err = await rejects(asUser(db, cast.homeMember.id, (tx) =>
      rpc(tx, 'create_project', { p_workspace_id: cast.ws.home_building, p_name: 'x' })));
    expect(err.code).toBe('42501');
    const err2 = await rejects(asUser(db, cast.homeMember.id, (tx) => tx.query(
      `update eden.tasks set archived_at = now() where id = $1`, [t.id])));
    expect(err2.code).toBe('42501');
  });
});

describe('revocation and downgrade take effect on the next request', () => {
  it('a revoked member is denied on the next list and write with the same token', async () => {
    const temp = cast.homeMember;
    const before = await asUser(db, temp.id, (tx) => rpc(tx, 'list_tasks', { p_project_id: homeProject.id }));
    expect(before.length).toBeGreaterThan(0);
    await revokeMember(db, cast.ws.home_building, temp);
    expectUnavailable(await rejects(asUser(db, temp.id, (tx) =>
      rpc(tx, 'list_tasks', { p_project_id: homeProject.id }))));
    expectUnavailable(await rejects(asUser(db, temp.id, (tx) =>
      rpc(tx, 'create_task', { p_project_id: homeProject.id, p_kind: 'task', p_title: 'x' }))));
    await addMember(db, cast.ws.home_building, temp, 'member', 'SYNTHETIC Home helper');
  });

  it('an owner downgraded to member loses owner operations at once', async () => {
    const o = cast.owners[3];
    await asUser(db, o.id, (tx) =>
      rpc(tx, 'create_contact', { p_workspace_id: cast.ws.home_building, p_display_name: 'SYNTHETIC Crew', p_kind: 'vendor' }));
    await addMember(db, cast.ws.home_building, o, 'member');
    const err = await rejects(asUser(db, o.id, (tx) =>
      rpc(tx, 'create_contact', { p_workspace_id: cast.ws.home_building, p_display_name: 'x', p_kind: 'vendor' })));
    expect(err.code).toBe('42501');
    const ok = await asUser(db, o.id, (tx) => rpc(tx, 'list_tasks', { p_project_id: homeProject.id }));
    expect(ok.length).toBeGreaterThan(0);
    await addMember(db, cast.ws.home_building, o, 'owner');
  });
});

describe('the access gate', () => {
  it('while closed, everyone is denied, owners included', async () => {
    await setGate(db, false);
    try {
      expect(await asUser(db, cast.owner.id, (tx) => rpc(tx, 'my_workspaces'))).toEqual([]);
      expectUnavailable(await rejects(asUser(db, cast.owner.id, (tx) =>
        rpc(tx, 'list_tasks', { p_project_id: homeProject.id }))));
      expectUnavailable(await rejects(asUser(db, cast.owner.id, (tx) =>
        rpc(tx, 'create_project', { p_workspace_id: cast.ws.home_building, p_name: 'x' }))));
    } finally {
      await setGate(db, true);
    }
  });

  it('a missing gate row counts as closed', async () => {
    await asAdmin(db, (tx) => tx.query('delete from eden_private.access_gate'));
    try {
      expect(await asUser(db, cast.owner.id, (tx) => rpc(tx, 'my_workspaces'))).toEqual([]);
    } finally {
      await asAdmin(db, (tx) => tx.query(
        `insert into eden_private.access_gate (id, is_open, changed_by) values (1, true, 'test')`));
    }
  });

  it('a fresh migration creates the gate closed', async () => {
    const fresh = await freshDb();
    const { rows } = await fresh.query('select is_open, changed_by from eden_private.access_gate');
    expect(rows).toEqual([{ is_open: false, changed_by: 'migration' }]);
  });
});
