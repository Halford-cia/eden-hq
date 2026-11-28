// @vitest-environment happy-dom
//
// Front-end tests for the Stage 1 screens, driving the real UI and the real
// api.js against the migrations in local Postgres (PGlite). SYNTHETIC data.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { freshDb, seedCast, asUser, asAdmin, rpc } from '../db/harness.mjs';
import { createApi, createAuth } from '../../src/api.js';
import { createApp } from '../../src/app.js';
import { parseCsv } from '../../scripts/lib/csv.mjs';
import { fakeSupabase, fakeAuth, fakeAuthClient, settle, byText } from './fake-supabase.mjs';

let db;
let cast;

beforeAll(async () => {
  db = await freshDb();
  cast = await seedCast(db);
});

function mount(user, { path = '/' } = {}) {
  document.body.replaceChildren();
  const root = document.createElement('div');
  document.body.append(root);
  window.history.replaceState({}, '', path);
  const auth = fakeAuth(user);
  const client = fakeSupabase(db, () => auth.user);
  const downloads = [];
  const app = createApp({
    root, api: createApi(client), auth, win: window,
    download: (filename, text) => downloads.push({ filename, text }),
  });
  return { root, app, auth, client, downloads };
}

async function go(m, path) {
  await m.app.ctx.navigate(path);
  await settle();
}

function setValue(el, value) {
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function fieldByLabel(root, label) {
  const l = [...root.querySelectorAll('label')].find((x) => x.textContent.trim() === label);
  if (!l) throw new Error(`no field labelled ${label}`);
  return root.querySelector(`#${CSS.escape(l.getAttribute('for'))}`);
}

async function submit(form) {
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await settle();
}

beforeEach(() => {
  window.scrollTo = () => {};
});

describe('entry', () => {
  it('signed out: shows Google sign-in only', async () => {
    const m = mount(null);
    await m.app.render();
    const btn = byText(m.root, 'button', 'Sign in with Google');
    expect(btn).toBeTruthy();
    btn.click();
    expect(m.auth.signInCalls).toBe(1);
    expect(m.client.calls).toEqual([]);
  });

  it('a signed-in account with no membership sees the ask-Hank screen and sign out', async () => {
    const m = mount(cast.stranger);
    await m.app.render();
    expect(m.root.textContent).toContain('Ask Hank for workspace access');
    expect(byText(m.root, 'button', 'Sign out')).toBeTruthy();
  });

  it('one membership opens that workspace directly (the manager → Stay Eden)', async () => {
    const m = mount(cast.manager);
    await m.app.render();
    await settle();
    expect(window.location.pathname).toBe(`/w/${cast.ws.stay_eden_ops}`);
    expect(m.root.querySelector('h1').textContent).toBe('Properties');
  });

  it('several memberships open the picker (owners see both)', async () => {
    const m = mount(cast.owner);
    await m.app.render();
    expect(m.root.textContent).toContain('Choose a workspace');
    expect(m.root.textContent).toContain('Home building');
    expect(m.root.textContent).toContain('Stay Eden operations');
  });

  it('deep links: a known Home project and a missing one show the same unavailable screen to the manager', async () => {
    const [p] = await asUser(db, cast.owner.id, (tx) =>
      rpc(tx, 'create_project', { p_workspace_id: cast.ws.home_building, p_name: 'SYNTHETIC Hidden build' }));
    const m = mount(cast.manager, { path: `/p/${p.id}` });
    await m.app.render();
    await settle();
    const known = m.root.querySelector('main').textContent;
    await go(m, '/p/00000000-0000-4000-8000-000000000000');
    const missing = m.root.querySelector('main').textContent;
    expect(known).toContain('Not available');
    expect(known).toBe(missing);
    expect(known).not.toContain('SYNTHETIC Hidden build');
    await go(m, `/w/${cast.ws.home_building}`);
    expect(m.root.textContent).toContain('Not available');
  });

  it('sign out clears loaded data', async () => {
    const m = mount(cast.owner, { path: `/w/${cast.ws.home_building}` });
    await m.app.render();
    await settle();
    expect(m.app.state.workspaces.length).toBe(2);
    byText(m.root, 'button', 'Sign out').click();
    await settle();
    expect(m.app.state.workspaces).toBeNull();
    expect(m.app.state.listCache.size).toBe(0);
    expect(m.root.textContent).toContain('Sign in with Google');
  });
});

// Review P0-1: an account change on an already-open tab.
describe('account change on an open tab', () => {
  async function homeTask(title) {
    const [p] = await asUser(db, cast.owner.id, (tx) =>
      rpc(tx, 'create_project', { p_workspace_id: cast.ws.home_building, p_name: `SYNTHETIC ${title} build` }));
    const [t] = await asUser(db, cast.owner.id, (tx) =>
      rpc(tx, 'create_task', { p_project_id: p.id, p_kind: 'task', p_title: `SYNTHETIC ${title}`, p_description: 'SYNTHETIC private detail' }));
    return { p, t };
  }

  it('the previous account\'s Home task leaves the screen the moment another account signs in', async () => {
    const { p, t } = await homeTask('Switch task');
    const m = mount(cast.owner, { path: `/p/${p.id}?task=${t.id}` });
    await m.app.render();
    await settle();
    expect(m.root.textContent).toContain('SYNTHETIC Switch task');

    m.auth.switchUser(cast.manager);
    // Synchronously: nothing of the owner's screen is left.
    expect(m.root.textContent).not.toContain('SYNTHETIC Switch task');
    expect(m.root.textContent).not.toContain('SYNTHETIC private detail');
    expect(m.app.state.workspaces).toBeNull();
    expect(m.app.state.listCache.size).toBe(0);

    await settle();
    // The manager gets the same answer as a fresh request: not available.
    expect(m.root.textContent).toContain('Not available');
    expect(m.root.textContent).not.toContain('SYNTHETIC Switch task');
    // The refusal dropped every cached membership (review round 2, P0-1);
    // the next screen reads the manager's afresh.
    expect(m.app.state.workspaces).toBeNull();
    await m.app.ctx.navigate('/');
    await settle();
    expect(m.app.state.workspaces.map((w) => w.kind)).toEqual(['stay_eden_ops']);
  });

  it('a response still in flight for the previous account is discarded', async () => {
    const { p } = await homeTask('Inflight task');
    const m = mount(cast.owner, { path: `/p/${p.id}` });
    m.client.delayMs = 40;
    const pending = m.app.render();
    // Wait until the owner's task page is in flight, then switch accounts.
    for (let i = 0; i < 200 && !m.client.calls.includes('list_tasks'); i++) {
      await new Promise((r) => setTimeout(r, 2));
    }
    expect(m.client.calls).toContain('list_tasks');
    m.auth.switchUser(cast.manager);
    m.client.delayMs = 0;
    await pending;
    await settle(60);
    await new Promise((r) => setTimeout(r, 200));
    await settle(60);
    expect(m.root.textContent).not.toContain('SYNTHETIC Inflight task');
    // The manager's refusal dropped the cached memberships (review round 2, P0-1).
    expect(m.app.state.workspaces).toBeNull();
    for (const entry of m.app.state.listCache.values()) {
      expect(JSON.stringify(entry)).not.toContain('SYNTHETIC Inflight task');
    }
  });

  it('the same account refreshing its token keeps the screen as it is', async () => {
    const { p } = await homeTask('Refresh task');
    const m = mount(cast.owner, { path: `/p/${p.id}` });
    await m.app.render();
    await settle();
    m.client.calls.length = 0;
    m.auth.emit('TOKEN_REFRESHED', { user: { id: cast.owner.id } });
    m.auth.emit('SIGNED_IN', { user: { id: cast.owner.id } });
    await settle();
    expect(m.root.textContent).toContain('SYNTHETIC Refresh task');
    expect(m.client.calls).toEqual([]);
  });
});

// Review P1-12: sign-out that cannot reach the Auth server.
describe('sign-out when the server cannot be reached', () => {
  it('the adapter ends the session on this device when global sign-out fails', async () => {
    const client = fakeAuthClient({ failGlobalSignOut: true });
    const auth = createAuth(client, { origin: 'https://example.test' });
    expect(await auth.getSession()).not.toBeNull();
    const result = await auth.signOut();
    expect(result).toEqual({ ok: false, local: true });
    expect(client.calls).toEqual(['global', 'local']);
    expect(await auth.getSession()).toBeNull();
  });

  it('the adapter reports success when global sign-out works', async () => {
    const client = fakeAuthClient();
    const auth = createAuth(client, { origin: 'https://example.test' });
    expect(await auth.signOut()).toEqual({ ok: true });
    expect(await auth.getSession()).toBeNull();
  });

  it('the app clears the screen at once and says the other sessions may still be open', async () => {
    const m = mount(cast.owner, { path: `/w/${cast.ws.home_building}` });
    await m.app.render();
    await settle();
    m.auth.signOutResult = { ok: false, local: true };
    byText(m.root, 'button', 'Sign out').click();
    expect(m.root.textContent).not.toContain('Projects');
    await settle();
    expect(m.app.state.workspaces).toBeNull();
    expect(m.root.textContent).toContain('Sign in with Google');
    expect(m.root.textContent).toMatch(/signed out on this device/i);
  });

  it('if even this device keeps the session, no data comes back and the person is told', async () => {
    const m = mount(cast.owner, { path: `/w/${cast.ws.home_building}` });
    await m.app.render();
    await settle();
    m.auth.signOutResult = { ok: false, local: false };
    m.client.calls.length = 0;
    byText(m.root, 'button', 'Sign out').click();
    await settle();
    expect(m.client.calls).toEqual([]);
    expect(m.root.textContent).not.toContain('Projects');
    expect(m.root.textContent).toMatch(/sign-out did not finish/i);
    expect(byText(m.root, 'button', 'Try signing out again')).toBeTruthy();
  });
});

describe('Home project: create, assign, list, board', () => {
  let projectId;

  it('an owner creates a project from the workspace screen', async () => {
    const m = mount(cast.owner, { path: `/w/${cast.ws.home_building}` });
    await m.app.render();
    await settle();
    const form = m.root.querySelector('form');
    setValue(fieldByLabel(form, 'Project name'), 'SYNTHETIC First build');
    await submit(form);
    expect(window.location.pathname).toMatch(/^\/p\//);
    projectId = window.location.pathname.slice(3);
    expect(m.root.textContent).toContain('No tasks yet. Add first task.');
  });

  it('a member sees no New project form', async () => {
    const m = mount(cast.homeMember, { path: `/w/${cast.ws.home_building}` });
    await m.app.render();
    await settle();
    expect(m.root.textContent).not.toContain('New project');
  });

  async function addTask(m, { title, assignee, start, due }) {
    await go(m, `/p/${projectId}?task=new`);
    const form = m.root.querySelector('form.task-form');
    setValue(fieldByLabel(form, 'Task'), title);
    if (assignee) {
      const sel = fieldByLabel(form, 'Assignee');
      const opt = [...sel.options].find((o) => o.textContent.startsWith(assignee));
      setValue(sel, opt.value);
    }
    if (start) setValue(fieldByLabel(form, 'Start'), start);
    if (due) setValue(fieldByLabel(form, 'Due'), due);
    await submit(form);
    return form;
  }

  it('adds tasks for a member, an outside vendor (created in the picker) and nobody', async () => {
    const m = mount(cast.owner);
    await go(m, `/p/${projectId}?task=new`);
    // Create an outside name from the picker.
    let form = m.root.querySelector('form.task-form');
    const sel = fieldByLabel(form, 'Assignee');
    setValue(sel, '__new');
    const adder = m.root.querySelector('.panel.inline');
    expect(adder.hidden).toBe(false);
    setValue(fieldByLabel(adder, 'Name'), 'SYNTHETIC Framing crew');
    byText(adder, 'button', 'Add name').click();
    await settle();
    expect(sel.selectedOptions[0].textContent).toBe('SYNTHETIC Framing crew');
    setValue(fieldByLabel(form, 'Task'), 'SYNTHETIC Frame walls');
    setValue(fieldByLabel(form, 'Start'), '2031-06-08');
    setValue(fieldByLabel(form, 'Due'), '2031-06-12');
    await submit(form);

    await addTask(m, { title: 'SYNTHETIC Rough plumbing', assignee: 'SYNTHETIC owner-b' });
    await addTask(m, { title: 'SYNTHETIC Order windows' });

    await go(m, `/p/${projectId}`);
    const rows = [...m.root.querySelectorAll('.task-row')].map((r) => r.textContent);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain('SYNTHETIC Frame walls');
    expect(rows[0]).toContain('SYNTHETIC Framing crew');
    expect(rows[0]).toContain('Jun 8 – Jun 12');
    expect(rows[1]).toContain('SYNTHETIC owner-b');
    expect(rows[2]).toContain('SYNTHETIC Order windows');
    form = null;
  });

  it('refuses an end date before the start, keeping what was typed', async () => {
    const m = mount(cast.owner);
    const form = await addTask(m, { title: 'SYNTHETIC Backwards', start: '2031-06-10', due: '2031-06-09' });
    expect(form.textContent).toContain('Start must be on or before the due date.');
    expect(fieldByLabel(form, 'Task').value).toBe('SYNTHETIC Backwards');
    expect(window.location.search).toContain('task=new');
  });

  it('a failed save keeps input and shows the server reason (archived task, archived contact)', async () => {
    const m = mount(cast.owner);
    await go(m, `/p/${projectId}`);
    const [first] = m.app.state.listCache.values().next().value.rows;
    await go(m, `/p/${projectId}?task=${first.id}`);
    const form = m.root.querySelector('form.task-form');
    // Server-side rejection: assign to a member of another workspace by forging the option.
    const sel = fieldByLabel(form, 'Assignee');
    const forged = document.createElement('option');
    forged.value = `member:${cast.manager.id}`;
    forged.textContent = 'forged';
    sel.append(forged);
    setValue(sel, forged.value);
    setValue(fieldByLabel(form, 'Description'), 'SYNTHETIC keep me');
    await submit(form);
    expect(form.querySelector('.message').textContent).toMatch(/not an active member/i);
    expect(fieldByLabel(form, 'Description').value).toBe('SYNTHETIC keep me');
  });

  it('a board move updates the list after refresh, with no dragging', async () => {
    const m = mount(cast.owner);
    await go(m, `/p/${projectId}?view=board`);
    const readyCol = m.root.querySelector('.col[data-status="ready"]');
    const card = [...readyCol.querySelectorAll('.card')].find((c) => c.textContent.includes('SYNTHETIC Order windows'));
    const move = card.querySelector('select');
    expect(move.getAttribute('aria-label')).toBe('Move SYNTHETIC Order windows');
    setValue(move, 'in_progress');
    await settle();
    // Refresh: a fresh app instance on the list view filtered to In progress.
    const fresh = mount(cast.owner, { path: `/p/${projectId}?status=in_progress` });
    await fresh.app.render();
    await settle();
    const rows = [...fresh.root.querySelectorAll('.task-row')].map((r) => r.textContent);
    expect(rows.some((r) => r.includes('SYNTHETIC Order windows') && r.includes('In progress'))).toBe(true);
  });

  it('phone layout: the board shows one column with a column picker and Next column', async () => {
    const m = mount(cast.owner);
    await go(m, `/p/${projectId}?view=board`);
    const board = m.root.querySelector('.board');
    expect(board.dataset.col).toBe('ready');
    byText(m.root, 'button', 'Next column').click();
    await settle();
    expect(m.root.querySelector('.board').dataset.col).toBe('in_progress');
    expect(window.location.search).toContain('col=in_progress');
  });

  it('task detail opens beside the list (desktop) or full screen (phone), and back keeps filters', async () => {
    const m = mount(cast.owner);
    await go(m, `/p/${projectId}?assignee=none`);
    const link = m.root.querySelector('.task-row a');
    link.click();
    await settle();
    expect(m.root.querySelector('main').classList.contains('has-detail')).toBe(true);
    expect(m.root.querySelector('aside.detail')).toBeTruthy();
    expect(window.location.search).toContain('assignee=none');
    byText(m.root.querySelector('aside'), 'a', '‹ SYNTHETIC First build').click();
    await settle();
    expect(window.location.search).toBe('?assignee=none');
    expect(m.root.querySelector('aside.detail')).toBeNull();
  });

  it('two concurrent edits: the second editor gets an explanation and can reapply', async () => {
    const a = mount(cast.owners[0]);
    await go(a, `/p/${projectId}`);
    const target = [...a.app.state.listCache.values()][0].rows.find((r) => r.title === 'SYNTHETIC Rough plumbing');
    await go(a, `/p/${projectId}?task=${target.id}`);
    const formA = a.root.querySelector('form.task-form');

    // Someone else saves first.
    await asUser(db, cast.owners[1].id, (tx) => rpc(tx, 'update_task', {
      p_task_id: target.id, p_expected_version: target.version, p_changes: { title: 'SYNTHETIC Rough plumbing (winner)' },
    }));

    setValue(fieldByLabel(formA, 'Description'), 'SYNTHETIC my note');
    await submit(formA);
    expect(formA.textContent).toContain('Someone else saved this task while you were editing');
    expect(fieldByLabel(formA, 'Description').value).toBe('SYNTHETIC my note');
    byText(formA, 'button', 'Reapply my changes').click();
    await settle();
    const [t] = await asUser(db, cast.owner.id, (tx) => rpc(tx, 'get_task', { p_task_id: target.id }));
    expect(t.title).toBe('SYNTHETIC Rough plumbing (winner)');
    expect(t.description).toBe('SYNTHETIC my note');
  });

  it('a member can post an update; it shows with the author', async () => {
    const m = mount(cast.homeMember);
    await go(m, `/p/${projectId}`);
    const first = [...m.app.state.listCache.values()][0].rows[0];
    await go(m, `/p/${projectId}?task=${first.id}`);
    const thread = m.root.querySelector('.thread');
    setValue(fieldByLabel(thread, 'Add update'), 'SYNTHETIC Crew confirmed.');
    await submit(thread.querySelector('form'));
    expect(m.root.querySelector('.thread').textContent).toContain('SYNTHETIC Crew confirmed.');
    expect(m.root.querySelector('.thread').textContent).toContain('SYNTHETIC Home helper');
  });

  it('members cannot archive; owners can', async () => {
    const mm = mount(cast.homeMember);
    await go(mm, `/p/${projectId}`);
    const first = [...mm.app.state.listCache.values()][0].rows[0];
    await go(mm, `/p/${projectId}?task=${first.id}`);
    expect(byText(mm.root, 'button', 'Archive')).toBeFalsy();
    const mo = mount(cast.owner);
    await go(mo, `/p/${projectId}?task=${first.id}`);
    expect(byText(mo.root, 'button', 'Archive')).toBeTruthy();
  });
});

describe('paged reads from the screen', () => {
  async function seed(n) {
    const [p] = await asUser(db, cast.owner.id, (tx) =>
      rpc(tx, 'create_project', { p_workspace_id: cast.ws.home_building, p_name: `SYNTHETIC ${n} tasks` }));
    const people = [cast.owners[0], cast.owners[1], cast.owners[2], cast.homeMember];
    await asAdmin(db, async (tx) => {
      for (let i = 0; i < n; i++) {
        await tx.query(
          `insert into eden.tasks (workspace_id, project_id, kind, title, created_by, assignee_user_id, status)
           values ($1, $2, 'task', $3, $4, $5, $6)`,
          [cast.ws.home_building, p.id, `SYNTHETIC task ${i}`, cast.owner.id, people[i % people.length].id,
            ['ready', 'in_progress', 'done'][i % 3]],
        );
      }
    });
    return p.id;
  }

  it('List and each Board column load one request per page at 50 and 300 tasks, assignees included', async () => {
    const counts = {};
    for (const n of [50, 300]) {
      const pid = await seed(n);
      const m = mount(cast.owner);
      await go(m, `/p/${pid}`);
      const listCalls = m.client.calls.filter((c) => c === 'list_tasks').length;
      const rows = m.root.querySelectorAll('.task-row');
      expect(rows.length).toBe(50);
      expect([...rows].every((r) => r.textContent.includes('SYNTHETIC'))).toBe(true);
      m.client.calls.length = 0;
      await go(m, `/p/${pid}?view=board`);
      const boardCalls = m.client.calls.filter((c) => c === 'list_tasks').length;
      counts[n] = { listCalls, boardCalls, other: m.client.calls.filter((c) => !['list_tasks', 'get_project', 'list_assignees'].includes(c)) };
    }
    expect(counts[50].listCalls).toBe(1);
    expect(counts[300].listCalls).toBe(1);
    expect(counts[50].boardCalls).toBe(3);
    expect(counts[300].boardCalls).toBe(3);
    expect(counts[300].other).toEqual([]);
  });

  it('Show more fetches exactly one more page', async () => {
    const pid = await seed(120);
    const m = mount(cast.owner);
    await go(m, `/p/${pid}`);
    m.client.calls.length = 0;
    byText(m.root, 'button', 'Show more').click();
    await settle();
    expect(m.client.calls).toEqual(['list_tasks']);
    expect(m.root.querySelectorAll('.task-row').length).toBe(100);
  });
});

describe('operational CSV export', () => {
  it('exports tricky text intact, formulas neutralized, scoped to the project', async () => {
    const [p] = await asUser(db, cast.owner.id, (tx) =>
      rpc(tx, 'create_project', { p_workspace_id: cast.ws.home_building, p_name: 'SYNTHETIC Export, "quoted"' }));
    await asUser(db, cast.owner.id, (tx) => rpc(tx, 'create_task', {
      p_project_id: p.id, p_kind: 'task', p_title: '=SUM(A1:A9)',
      p_description: 'Line one, with "quotes"\nLine two', p_due_on: '2031-07-01',
    }));
    const m = mount(cast.homeMember);
    await go(m, `/p/${p.id}`);
    byText(m.root, 'button', 'Export').click();
    await settle();
    expect(m.downloads.map((d) => d.filename)).toEqual(['synthetic-export-quoted-tasks.csv', 'synthetic-export-quoted-updates.csv']);
    const rows = parseCsv(m.downloads[0].text);
    expect(rows).toHaveLength(2);
    const [header, row] = rows;
    const rec = Object.fromEntries(header.map((h, i) => [h.replace(/^﻿/, ''), row[i]]));
    expect(rec.title).toBe("'=SUM(A1:A9)");
    expect(rec.description).toBe('Line one, with "quotes"\nLine two');
    expect(rec.project).toBe('SYNTHETIC Export, "quoted"');
    expect(rec.due_on).toBe('2031-07-01');
    expect(header.join(',')).not.toMatch(/cents|cost|vendor|payment|category|receipt|budget/);
  });

  it('an empty project yields header-only files', async () => {
    const [p] = await asUser(db, cast.owner.id, (tx) =>
      rpc(tx, 'create_project', { p_workspace_id: cast.ws.home_building, p_name: 'SYNTHETIC Empty export' }));
    const m = mount(cast.owner);
    await go(m, `/p/${p.id}`);
    byText(m.root, 'button', 'Export').click();
    await settle();
    expect(parseCsv(m.downloads[0].text)).toHaveLength(1);
    expect(parseCsv(m.downloads[1].text)).toHaveLength(1);
  });
});

describe('Stay Eden for the manager', () => {
  it('the manager adds a maintenance item to a property and moves it', async () => {
    const [p] = await asUser(db, cast.owner.id, (tx) =>
      rpc(tx, 'create_project', { p_workspace_id: cast.ws.stay_eden_ops, p_name: 'SYNTHETIC Example Cottage' }));
    const m = mount(cast.manager);
    await go(m, `/p/${p.id}?task=new`);
    const form = m.root.querySelector('form.task-form');
    setValue(fieldByLabel(form, 'Item'), 'SYNTHETIC Leaking tap');
    setValue(fieldByLabel(form, 'Type'), 'maintenance');
    setValue(fieldByLabel(form, 'Follow up'), '2031-06-20');
    await submit(form);
    expect(m.root.querySelector('aside').textContent).toContain('Maintenance');
    // The manager is not an owner: no project form, no archive, no new-name option.
    expect([...fieldByLabel(m.root.querySelector('form.task-form'), 'Assignee').options].map((o) => o.value)).not.toContain('__new');
  });
});

describe('accessibility basics', () => {
  it('every form control on the project screens has a label or an accessible name', async () => {
    const [p] = await asUser(db, cast.owner.id, (tx) =>
      rpc(tx, 'create_project', { p_workspace_id: cast.ws.home_building, p_name: 'SYNTHETIC A11y' }));
    const [t] = await asUser(db, cast.owner.id, (tx) =>
      rpc(tx, 'create_task', { p_project_id: p.id, p_kind: 'task', p_title: 'SYNTHETIC One' }));
    const m = mount(cast.owner);
    for (const path of [`/p/${p.id}`, `/p/${p.id}?view=board`, `/p/${p.id}?task=${t.id}`, `/p/${p.id}?task=new`]) {
      await go(m, path);
      for (const el of m.root.querySelectorAll('input, select, textarea')) {
        const labelled = el.getAttribute('aria-label')
          || (el.id && m.root.querySelector(`label[for="${el.id}"]`))
          || el.closest('label');
        expect(labelled, `${path}: ${el.outerHTML.slice(0, 80)}`).toBeTruthy();
      }
      for (const b of m.root.querySelectorAll('button, a')) {
        expect(b.textContent.trim().length, `${path}: empty control`).toBeGreaterThan(0);
      }
    }
  });
});
