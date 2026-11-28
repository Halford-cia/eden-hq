// add_update returns the saved entry (review round 3, P1-4), so the browser
// shows a post without reading the thread back. Proven as each role: an
// owner and a same-workspace member get their own entry in list_updates'
// shape; the manager (other workspace), an account with no membership and a
// signed-out caller are refused and nothing is written. SYNTHETIC data.

import { describe, it, expect, beforeAll } from 'vitest';
import {
  freshDb, seedCast, asUser, asAnon, asAdmin, rpc, rejects,
} from './harness.mjs';

let db;
let cast;
let homeTask;

beforeAll(async () => {
  db = await freshDb();
  cast = await seedCast(db);
  const [p] = await asUser(db, cast.owner.id, (tx) =>
    rpc(tx, 'create_project', { p_workspace_id: cast.ws.home_building, p_name: 'SYNTHETIC Result build' }));
  [homeTask] = await asUser(db, cast.owner.id, (tx) =>
    rpc(tx, 'create_task', { p_project_id: p.id, p_kind: 'task', p_title: 'SYNTHETIC Result task' }));
});

const count = async () => (await asAdmin(db, (tx) =>
  tx.query('select count(*)::int as n from eden.task_updates where task_id = $1', [homeTask.id]))).rows[0].n;

describe('add_update returns the saved entry (review round 3, P1-4)', () => {
  it('as owner and as a same-workspace member: the row list_updates shows, with the caller as author', async () => {
    for (const [who, name] of [[cast.owner, 'SYNTHETIC owner-a'], [cast.homeMember, 'SYNTHETIC Home helper']]) {
      const rows = await asUser(db, who.id, (tx) =>
        rpc(tx, 'add_update', { p_task_id: homeTask.id, p_body: `  SYNTHETIC result by ${who.label}  ` }));
      expect(rows).toHaveLength(1);
      const [posted] = rows;
      expect(Object.keys(posted).sort()).toEqual(['author_name', 'body', 'created_at', 'id']);
      expect(posted.author_name).toBe(name);
      expect(posted.body).toBe(`SYNTHETIC result by ${who.label}`);
      const listed = await asUser(db, who.id, (tx) => rpc(tx, 'list_updates', { p_task_id: homeTask.id }));
      const same = listed.find((u) => u.id === posted.id);
      expect(same).toBeTruthy();
      expect({ ...same, next_cursor: undefined }).toEqual({ ...posted, next_cursor: undefined });
    }
  });

  it('the manager, an account with no membership and a signed-out caller are refused and nothing is written', async () => {
    const before = await count();
    for (const who of [cast.manager, cast.stranger]) {
      const err = await rejects(asUser(db, who.id, (tx) =>
        rpc(tx, 'add_update', { p_task_id: homeTask.id, p_body: 'SYNTHETIC denied' })));
      expect(err.code).toBe('P0002');
    }
    await rejects(asAnon(db, (tx) => rpc(tx, 'add_update', { p_task_id: homeTask.id, p_body: 'SYNTHETIC anon' })));
    expect(await count()).toBe(before);
  });
});
