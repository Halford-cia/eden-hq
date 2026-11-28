// Projects, tasks, assignment, board moves, conflicts, paging and the
// operational export snapshot. All data is SYNTHETIC.

import { describe, it, expect, beforeAll } from 'vitest';
import { freshDb, seedCast, asUser, asAdmin, rpc, rejects } from './harness.mjs';

let db;
let cast;
let project;
let vendor;
let opsVendor;

beforeAll(async () => {
  db = await freshDb();
  cast = await seedCast(db);
  [project] = await asUser(db, cast.owner.id, (tx) =>
    rpc(tx, 'create_project', { p_workspace_id: cast.ws.home_building, p_name: 'SYNTHETIC First build' }));
  [vendor] = await asUser(db, cast.owner.id, (tx) =>
    rpc(tx, 'create_contact', { p_workspace_id: cast.ws.home_building, p_display_name: 'SYNTHETIC Framing crew', p_kind: 'vendor' }));
  [opsVendor] = await asUser(db, cast.owner.id, (tx) =>
    rpc(tx, 'create_contact', { p_workspace_id: cast.ws.stay_eden_ops, p_display_name: 'SYNTHETIC Ops plumber', p_kind: 'vendor' }));
});

const owner = () => cast.owner.id;

describe('creating projects and tasks', () => {
  it('owner adds tasks assigned to a member, an outside vendor and nobody', async () => {
    const make = (args) => asUser(db, owner(), (tx) =>
      rpc(tx, 'create_task', { p_project_id: project.id, p_kind: 'task', ...args }));
    await make({ p_title: 'SYNTHETIC Frame walls', p_assignee_contact_id: vendor.id, p_start_on: '2031-06-08', p_due_on: '2031-06-12' });
    await make({ p_title: 'SYNTHETIC Rough plumbing', p_assignee_user_id: cast.owners[1].id, p_start_on: '2031-06-15', p_due_on: '2031-06-17' });
    await make({ p_title: 'SYNTHETIC Order windows' });
    const rows = await asUser(db, owner(), (tx) => rpc(tx, 'list_tasks', { p_project_id: project.id }));
    expect(rows.map((r) => [r.title, r.assignee_kind, r.assignee_name])).toEqual([
      ['SYNTHETIC Frame walls', 'contact', 'SYNTHETIC Framing crew'],
      ['SYNTHETIC Rough plumbing', 'member', 'SYNTHETIC owner-b'],
      ['SYNTHETIC Order windows', null, null],
    ]);
  });

  it('rejects a cross-workspace member assignee', async () => {
    const err = await rejects(asUser(db, owner(), (tx) => rpc(tx, 'create_task', {
      p_project_id: project.id, p_kind: 'task', p_title: 'x', p_assignee_user_id: cast.manager.id,
    })));
    expect(err.code).toBe('22023');
    expect(err.message).toMatch(/not an active member/);
  });

  it('rejects a cross-workspace outside contact', async () => {
    const err = await rejects(asUser(db, owner(), (tx) => rpc(tx, 'create_task', {
      p_project_id: project.id, p_kind: 'task', p_title: 'x', p_assignee_contact_id: opsVendor.id,
    })));
    expect(err.code).toBe('22023');
  });

  it('rejects both assignee kinds at once', async () => {
    const err = await rejects(asUser(db, owner(), (tx) => rpc(tx, 'create_task', {
      p_project_id: project.id, p_kind: 'task', p_title: 'x',
      p_assignee_contact_id: vendor.id, p_assignee_user_id: cast.owner.id,
    })));
    expect(err.code).toBe('23514');
  });

  it('rejects an end date before the start date, and allows unknown dates', async () => {
    const err = await rejects(asUser(db, owner(), (tx) => rpc(tx, 'create_task', {
      p_project_id: project.id, p_kind: 'task', p_title: 'x', p_start_on: '2031-06-10', p_due_on: '2031-06-09',
    })));
    expect(err.code).toBe('23514');
    const [ok] = await asUser(db, owner(), (tx) => rpc(tx, 'create_task', {
      p_project_id: project.id, p_kind: 'task', p_title: 'SYNTHETIC Only a due date', p_due_on: '2031-07-01',
    }));
    expect(ok.version).toBe(1);
  });

  it('rejects a revoked member as a new assignee', async () => {
    await asAdmin(db, (tx) => tx.query(
      `update eden.workspace_members set revoked_at = now() where workspace_id = $1 and user_id = $2`,
      [cast.ws.home_building, cast.homeMember.id]));
    try {
      const err = await rejects(asUser(db, owner(), (tx) => rpc(tx, 'create_task', {
        p_project_id: project.id, p_kind: 'task', p_title: 'x', p_assignee_user_id: cast.homeMember.id,
      })));
      expect(err.code).toBe('22023');
    } finally {
      await asAdmin(db, (tx) => tx.query(
        `update eden.workspace_members set revoked_at = null where workspace_id = $1 and user_id = $2`,
        [cast.ws.home_building, cast.homeMember.id]));
    }
  });

  it('rejects an archived contact as a new assignee', async () => {
    const [c] = await asUser(db, owner(), (tx) =>
      rpc(tx, 'create_contact', { p_workspace_id: cast.ws.home_building, p_display_name: 'SYNTHETIC Old vendor', p_kind: 'vendor' }));
    await asUser(db, owner(), (tx) => rpc(tx, 'set_contact_archived', { p_contact_id: c.id, p_archived: true }));
    const err = await rejects(asUser(db, owner(), (tx) => rpc(tx, 'create_task', {
      p_project_id: project.id, p_kind: 'task', p_title: 'x', p_assignee_contact_id: c.id,
    })));
    expect(err.code).toBe('22023');
  });

  it('keeps kinds to their workspace', async () => {
    const e1 = await rejects(asUser(db, owner(), (tx) => rpc(tx, 'create_task', {
      p_project_id: project.id, p_kind: 'maintenance', p_title: 'x',
    })));
    expect(e1.code).toBe('22023');
    const [ops] = await asUser(db, owner(), (tx) =>
      rpc(tx, 'create_project', { p_workspace_id: cast.ws.stay_eden_ops, p_name: 'SYNTHETIC Example Cottage' }));
    const e2 = await rejects(asUser(db, owner(), (tx) => rpc(tx, 'create_task', {
      p_project_id: ops.id, p_kind: 'task', p_title: 'x',
    })));
    expect(e2.code).toBe('22023');
    for (const kind of ['request', 'maintenance', 'note', 'follow_up']) {
      await asUser(db, owner(), (tx) => rpc(tx, 'create_task', {
        p_project_id: ops.id, p_kind: kind, p_title: `SYNTHETIC ${kind}`,
      }));
    }
  });

  it('server derives creator and timestamps', async () => {
    const [t] = await asUser(db, cast.owners[2].id, (tx) => rpc(tx, 'create_task', {
      p_project_id: project.id, p_kind: 'task', p_title: 'SYNTHETIC Derived',
    }));
    const [detail] = await asUser(db, owner(), (tx) => rpc(tx, 'get_task', { p_task_id: t.id }));
    expect(detail.created_by_name).toBe('SYNTHETIC owner-c');
  });

  it('parent IDs cannot change after insert', async () => {
    const [other] = await asUser(db, owner(), (tx) =>
      rpc(tx, 'create_project', { p_workspace_id: cast.ws.home_building, p_name: 'SYNTHETIC Other build' }));
    const [t] = await asUser(db, owner(), (tx) => rpc(tx, 'create_task', {
      p_project_id: project.id, p_kind: 'task', p_title: 'SYNTHETIC Frozen parent',
    }));
    const err = await rejects(asUser(db, owner(), (tx) => tx.query(
      'update eden.tasks set project_id = $1 where id = $2', [other.id, t.id])));
    expect(err.code).toBe('42501');
  });
});

describe('board moves and concurrent edits', () => {
  it('a status move shows in the list on the next read', async () => {
    const [t] = await asUser(db, owner(), (tx) => rpc(tx, 'create_task', {
      p_project_id: project.id, p_kind: 'task', p_title: 'SYNTHETIC Move me',
    }));
    await asUser(db, owner(), (tx) =>
      rpc(tx, 'set_task_status', { p_task_id: t.id, p_expected_version: 1, p_status: 'in_progress' }));
    const inProgress = await asUser(db, owner(), (tx) =>
      rpc(tx, 'list_tasks', { p_project_id: project.id, p_filters: { status: 'in_progress' } }));
    expect(inProgress.map((r) => r.title)).toContain('SYNTHETIC Move me');
    const ready = await asUser(db, owner(), (tx) =>
      rpc(tx, 'list_tasks', { p_project_id: project.id, p_filters: { status: 'ready' } }));
    expect(ready.map((r) => r.title)).not.toContain('SYNTHETIC Move me');
  });

  it('two edits from the same version: the first wins, the second gets a conflict', async () => {
    const [t] = await asUser(db, owner(), (tx) => rpc(tx, 'create_task', {
      p_project_id: project.id, p_kind: 'task', p_title: 'SYNTHETIC Contested',
    }));
    const [first] = await asUser(db, cast.owners[1].id, (tx) => rpc(tx, 'update_task', {
      p_task_id: t.id, p_expected_version: 1, p_changes: { title: 'SYNTHETIC Winner' },
    }));
    expect(first.version).toBe(2);
    const err = await rejects(asUser(db, cast.owners[2].id, (tx) => rpc(tx, 'update_task', {
      p_task_id: t.id, p_expected_version: 1, p_changes: { title: 'SYNTHETIC Loser' },
    })));
    expect(err.code).toBe('PT409');
    expect(err.message).toBe('stale');
    const [detail] = await asUser(db, owner(), (tx) => rpc(tx, 'get_task', { p_task_id: t.id }));
    expect(detail.title).toBe('SYNTHETIC Winner');
    expect(detail.version).toBe(2);
  });

  it('rejects unknown change fields and bad statuses', async () => {
    const [t] = await asUser(db, owner(), (tx) => rpc(tx, 'create_task', {
      p_project_id: project.id, p_kind: 'task', p_title: 'SYNTHETIC Strict',
    }));
    const e1 = await rejects(asUser(db, owner(), (tx) => rpc(tx, 'update_task', {
      p_task_id: t.id, p_expected_version: 1, p_changes: { estimated_cents: 100 },
    })));
    expect(e1.code).toBe('22023');
    const e2 = await rejects(asUser(db, owner(), (tx) => rpc(tx, 'update_task', {
      p_task_id: t.id, p_expected_version: 1, p_changes: { status: 'waiting' },
    })));
    expect(e2.code).toBe('22023');
    const e3 = await rejects(asUser(db, owner(), (tx) => rpc(tx, 'update_task', {
      p_task_id: t.id, p_expected_version: 1, p_changes: { workspace_id: cast.ws.stay_eden_ops },
    })));
    expect(e3.code).toBe('22023');
  });

  it('reassigns and clears an assignee', async () => {
    const [t] = await asUser(db, owner(), (tx) => rpc(tx, 'create_task', {
      p_project_id: project.id, p_kind: 'task', p_title: 'SYNTHETIC Reassign',
    }));
    const [v2] = await asUser(db, owner(), (tx) => rpc(tx, 'update_task', {
      p_task_id: t.id, p_expected_version: 1, p_changes: { assignee: { contact_id: vendor.id } },
    }));
    const [v3] = await asUser(db, owner(), (tx) => rpc(tx, 'update_task', {
      p_task_id: t.id, p_expected_version: v2.version, p_changes: { assignee: null },
    }));
    const [detail] = await asUser(db, owner(), (tx) => rpc(tx, 'get_task', { p_task_id: t.id }));
    expect(v3.version).toBe(3);
    expect(detail.assignee_kind).toBeNull();
  });

  it('archived tasks and projects are read-only until restored', async () => {
    const [p] = await asUser(db, owner(), (tx) =>
      rpc(tx, 'create_project', { p_workspace_id: cast.ws.home_building, p_name: 'SYNTHETIC Archive me' }));
    const [t] = await asUser(db, owner(), (tx) => rpc(tx, 'create_task', {
      p_project_id: p.id, p_kind: 'task', p_title: 'SYNTHETIC In archive',
    }));
    const [ta] = await asUser(db, owner(), (tx) =>
      rpc(tx, 'set_task_archived', { p_task_id: t.id, p_expected_version: 1, p_archived: true }));
    const e1 = await rejects(asUser(db, owner(), (tx) => rpc(tx, 'update_task', {
      p_task_id: t.id, p_expected_version: ta.version, p_changes: { title: 'x' },
    })));
    expect(e1.code).toBe('22023');
    const [tr] = await asUser(db, owner(), (tx) =>
      rpc(tx, 'set_task_archived', { p_task_id: t.id, p_expected_version: ta.version, p_archived: false }));
    await asUser(db, owner(), (tx) =>
      rpc(tx, 'set_project_archived', { p_project_id: p.id, p_expected_version: 1, p_archived: true }));
    const e2 = await rejects(asUser(db, owner(), (tx) => rpc(tx, 'create_task', {
      p_project_id: p.id, p_kind: 'task', p_title: 'x',
    })));
    expect(e2.code).toBe('22023');
    const e3 = await rejects(asUser(db, owner(), (tx) => rpc(tx, 'update_task', {
      p_task_id: t.id, p_expected_version: tr.version, p_changes: { title: 'x' },
    })));
    expect(e3.code).toBe('22023');
    const visible = await asUser(db, owner(), (tx) =>
      rpc(tx, 'list_projects', { p_workspace_id: cast.ws.home_building }));
    expect(visible.map((r) => r.id)).not.toContain(p.id);
    const all = await asUser(db, owner(), (tx) =>
      rpc(tx, 'list_projects', { p_workspace_id: cast.ws.home_building, p_include_archived: true }));
    expect(all.find((r) => r.id === p.id).archived).toBe(true);
  });
});

describe('paged reads', () => {
  async function seedProject(n) {
    const [p] = await asUser(db, owner(), (tx) =>
      rpc(tx, 'create_project', { p_workspace_id: cast.ws.home_building, p_name: `SYNTHETIC ${n}-task build` }));
    const assignees = [
      { col: 'assignee_user_id', id: cast.owners[0].id },
      { col: 'assignee_user_id', id: cast.owners[1].id },
      { col: 'assignee_user_id', id: cast.homeMember.id },
      { col: 'assignee_contact_id', id: vendor.id },
      null,
    ];
    await asAdmin(db, async (tx) => {
      for (let i = 0; i < n; i++) {
        const a = assignees[i % assignees.length];
        const status = ['ready', 'in_progress', 'done'][i % 3];
        await tx.query(
          `insert into eden.tasks (workspace_id, project_id, kind, title, status, created_by
             ${a ? `, ${a.col}` : ''})
           values ($1, $2, 'task', $3, $4, $5 ${a ? ', $6' : ''})`,
          [cast.ws.home_building, p.id, `SYNTHETIC task ${i}`, status, cast.owner.id, ...(a ? [a.id] : [])],
        );
      }
    });
    return p;
  }

  async function readAll(projectId, filters, pageSize) {
    let after = null;
    let requests = 0;
    const rows = [];
    do {
      const page = await asUser(db, owner(), (tx) => rpc(tx, 'list_tasks', {
        p_project_id: projectId, p_filters: filters, p_after: after, p_page_size: pageSize,
      }));
      requests += 1;
      rows.push(...page);
      expect(page.length).toBeLessThanOrEqual(pageSize);
      // Every row is ready to display: no follow-up request for names.
      for (const r of page) {
        if (r.assignee_id) expect(r.assignee_name).toBeTruthy();
      }
      after = page.length ? page[page.length - 1].next_cursor : null;
    } while (after);
    return { rows, requests };
  }

  it('50 and 300 tasks: one request per page, assignees included, nothing skipped or repeated', async () => {
    const small = await seedProject(50);
    const big = await seedProject(300);
    const s = await readAll(small.id, {}, 50);
    const b = await readAll(big.id, {}, 50);
    expect(s.rows.length).toBe(50);
    expect(s.requests).toBe(1);
    expect(b.rows.length).toBe(300);
    expect(b.requests).toBe(6);
    expect(new Set(b.rows.map((r) => r.id)).size).toBe(300);
    // Per page, the request count is the same (one) for both projects.
    expect(s.requests / Math.ceil(50 / 50)).toBe(b.requests / Math.ceil(300 / 50));
  });

  it('each board column pages the same way', async () => {
    const big = await seedProject(300);
    for (const status of ['ready', 'in_progress', 'done']) {
      const col = await readAll(big.id, { status }, 40);
      expect(col.rows.length).toBe(100);
      expect(col.requests).toBe(3);
      expect(col.rows.every((r) => r.status === status)).toBe(true);
    }
  });

  it('caps a page at 100 rows and refuses a forged cursor', async () => {
    const big = await seedProject(150);
    const page = await asUser(db, owner(), (tx) =>
      rpc(tx, 'list_tasks', { p_project_id: big.id, p_page_size: 1000 }));
    expect(page.length).toBe(100);
    const err = await rejects(asUser(db, owner(), (tx) =>
      rpc(tx, 'list_tasks', { p_project_id: big.id, p_after: "x'; drop table eden.tasks; --" })));
    expect(err.code).toBe('22023');
  });
});

describe('operational export', () => {
  it('returns one snapshot of the project with tricky text intact and no money fields', async () => {
    const [p] = await asUser(db, owner(), (tx) =>
      rpc(tx, 'create_project', { p_workspace_id: cast.ws.home_building, p_name: 'SYNTHETIC Export build' }));
    const tricky = 'Line one, "quoted"\nline two =SUM(A1:A2)';
    const [t] = await asUser(db, owner(), (tx) => rpc(tx, 'create_task', {
      p_project_id: p.id, p_kind: 'task', p_title: '=HYPERLINK("http://example.test")', p_description: tricky,
    }));
    await asUser(db, owner(), (tx) => rpc(tx, 'add_update', { p_task_id: t.id, p_body: '@cmd, "x"\n+1' }));
    const [snap] = await asUser(db, cast.homeMember.id, (tx) => rpc(tx, 'export_project', { p_project_id: p.id }));
    expect(snap.project.name).toBe('SYNTHETIC Export build');
    expect(snap.tasks).toHaveLength(1);
    expect(snap.tasks[0].description).toBe(tricky);
    expect(snap.updates).toHaveLength(1);
    expect(snap.updates[0].task_id).toBe(t.id);
    const keys = new Set([...Object.keys(snap.tasks[0]), ...Object.keys(snap.updates[0]), ...Object.keys(snap.project)]);
    for (const k of keys) expect(k).not.toMatch(/cents|cost|vendor_name|payment|category|receipt|budget/);
  });

  it('an empty project exports with empty task and update lists', async () => {
    const [p] = await asUser(db, owner(), (tx) =>
      rpc(tx, 'create_project', { p_workspace_id: cast.ws.home_building, p_name: 'SYNTHETIC Empty' }));
    const [snap] = await asUser(db, owner(), (tx) => rpc(tx, 'export_project', { p_project_id: p.id }));
    expect(snap.tasks).toEqual([]);
    expect(snap.updates).toEqual([]);
  });

  it('includes archived work, scoped to the one project', async () => {
    const [p] = await asUser(db, owner(), (tx) =>
      rpc(tx, 'create_project', { p_workspace_id: cast.ws.home_building, p_name: 'SYNTHETIC Scoped' }));
    const [t] = await asUser(db, owner(), (tx) => rpc(tx, 'create_task', {
      p_project_id: p.id, p_kind: 'task', p_title: 'SYNTHETIC Archived one',
    }));
    await asUser(db, owner(), (tx) =>
      rpc(tx, 'set_task_archived', { p_task_id: t.id, p_expected_version: 1, p_archived: true }));
    const [snap] = await asUser(db, owner(), (tx) => rpc(tx, 'export_project', { p_project_id: p.id }));
    expect(snap.tasks.map((x) => [x.title, x.archived])).toEqual([['SYNTHETIC Archived one', true]]);
  });
});
