// @vitest-environment happy-dom
//
// Screen behaviour from the Stage 1 review, round 3 (457r3): a denied Save or
// Post takes the task down and the next screen reads current memberships
// (P0), reopening a project from Projects shows current task rows (P1-3),
// posting reads nothing back (P1-4), and a new recorded name reaches the next
// task form (P2-2). Real UI and api.js against the migrations in local
// Postgres. SYNTHETIC data only.

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import {
  freshDb, seedCast, asUser, asAdmin, rpc, revokeMember, addMember,
} from '../db/harness.mjs';
import { createApi } from '../../src/api.js';
import { createApp } from '../../src/app.js';
import { fakeSupabase, fakeAuth, fakeBreakpoint, settle, byText } from './fake-supabase.mjs';

let db;
let cast;
let bp;

beforeAll(async () => {
  db = await freshDb();
  cast = await seedCast(db);
});

beforeEach(() => {
  window.scrollTo = () => {};
  bp = fakeBreakpoint(window, { wide: true });
});
afterEach(() => {
  bp.restore();
});

function mount(user, { path = '/' } = {}) {
  document.body.replaceChildren();
  const root = document.createElement('div');
  document.body.append(root);
  window.history.replaceState({}, '', path);
  const auth = fakeAuth(user);
  const client = fakeSupabase(db, () => auth.user);
  const app = createApp({ root, api: createApi(client), auth, win: window, download: () => {} });
  return { root, app, auth, client };
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

const submitEvent = () => new Event('submit', { bubbles: true, cancelable: true });

async function project(name, ws = cast.ws.home_building) {
  const [p] = await asUser(db, cast.owner.id, (tx) => rpc(tx, 'create_project', { p_workspace_id: ws, p_name: name }));
  return p;
}

async function task(projectId, title, extra = {}) {
  const [t] = await asUser(db, cast.owner.id, (tx) =>
    rpc(tx, 'create_task', { p_project_id: projectId, p_kind: 'task', p_title: title, ...extra }));
  return t;
}

// ---------------------------------------------------------------------------
// P0: Save and Post after the workspace was revoked
// ---------------------------------------------------------------------------

describe('a denied Save or Post takes the task down (review round 3, P0)', () => {
  // Owner B holds both workspaces; Home is revoked while a Home task is open.
  const ownerB = () => cast.owners[1];

  async function openTask(m) {
    const p = await project('SYNTHETIC Denied build');
    const [c] = await asUser(db, cast.owner.id, (tx) => rpc(tx, 'create_contact', {
      p_workspace_id: cast.ws.home_building, p_display_name: 'SYNTHETIC Denied Roofing', p_kind: 'vendor',
    }));
    const t = await task(p.id, 'SYNTHETIC Denied task title', {
      p_description: 'SYNTHETIC Denied task description', p_assignee_contact_id: c.id,
    });
    await asUser(db, cast.owner.id, (tx) => rpc(tx, 'add_update', { p_task_id: t.id, p_body: 'SYNTHETIC Denied thread entry' }));
    await go(m, `/p/${p.id}?task=${t.id}`);
    const detail = m.root.querySelector('aside.detail').textContent;
    for (const s of ['SYNTHETIC Denied task title', 'SYNTHETIC Denied Roofing', 'SYNTHETIC Denied thread entry']) {
      expect(detail).toContain(s);
    }
    expect(fieldByLabel(m.root, 'Description').value).toBe('SYNTHETIC Denied task description');
    return { p, t };
  }

  function expectTaskGone(m) {
    const text = m.root.textContent;
    expect(text).toContain('Not available');
    expect(m.root.querySelector('aside.detail')).toBeNull();
    expect(m.root.querySelector('textarea')).toBeNull();
    for (const s of ['SYNTHETIC Denied task title', 'SYNTHETIC Denied Roofing', 'SYNTHETIC Denied thread entry',
      'SYNTHETIC Denied build', 'Home building']) {
      expect(text).not.toContain(s);
    }
    for (const el of m.root.querySelectorAll('input, select')) {
      expect(el.value || '').not.toContain('SYNTHETIC Denied');
    }
    for (const cache of [m.app.state.listCache, m.app.state.metaCache]) expect(cache.size).toBe(0);
  }

  async function expectNextNavigationCurrent(m) {
    // The next screen reads memberships afresh: no picker built from the
    // old list, no revoked workspace or role on screen.
    m.client.calls.length = 0;
    byText(m.root, 'a', 'Go to your workspaces').click();
    await settle();
    expect(m.client.calls[0]).toBe('my_workspaces');
    expect(m.app.state.workspaces.map((w) => w.kind)).toEqual(['stay_eden_ops']);
    expect(m.root.textContent).not.toContain('Choose a workspace');
    expect(m.root.textContent).not.toContain('Home building');
    expect(window.location.pathname).toBe(`/w/${cast.ws.stay_eden_ops}`);
  }

  it('Save: the task, its thread and the form go; the next navigation shows current access', async () => {
    const m = mount(ownerB());
    await openTask(m);
    // Picker built while both workspaces were held (the old membership list).
    expect(m.app.state.workspaces).toHaveLength(2);
    await revokeMember(db, cast.ws.home_building, ownerB());
    try {
      setValue(fieldByLabel(m.root, 'Description'), 'SYNTHETIC Denied edit');
      m.root.querySelector('form.task-form').dispatchEvent(submitEvent());
      await settle();
      expectTaskGone(m);
      await expectNextNavigationCurrent(m);
    } finally {
      await addMember(db, cast.ws.home_building, ownerB(), 'owner');
    }
  });

  it('Post: the task, its thread and the form go; the next navigation shows current access', async () => {
    const m = mount(ownerB());
    await openTask(m);
    await revokeMember(db, cast.ws.home_building, ownerB());
    try {
      const thread = m.root.querySelector('.thread');
      setValue(fieldByLabel(thread, 'Add update'), 'SYNTHETIC Denied post');
      thread.querySelector('form').dispatchEvent(submitEvent());
      await settle();
      expectTaskGone(m);
      expect(m.root.textContent).not.toContain('SYNTHETIC Denied post');
      await expectNextNavigationCurrent(m);
    } finally {
      await addMember(db, cast.ws.home_building, ownerB(), 'owner');
    }
  });

  it('the Eden HQ link after a denial reads memberships before showing the picker', async () => {
    // Owner C keeps Stay Eden but loses Home; the picker must not be built
    // from the two-workspace list loaded before.
    const ownerC = cast.owners[2];
    const m = mount(ownerC);
    const { t } = await openTask(m);
    await revokeMember(db, cast.ws.home_building, ownerC);
    try {
      setValue(fieldByLabel(m.root, 'Description'), 'SYNTHETIC Denied edit');
      m.root.querySelector('form.task-form').dispatchEvent(submitEvent());
      await settle();
      expectTaskGone(m);
      await go(m, '/');
      expect(m.root.textContent).not.toContain('Choose a workspace');
      expect(m.root.textContent).not.toContain('Home building');
      // And the task itself stays unavailable.
      await go(m, `/t/${t.id}`);
      expect(m.root.textContent).not.toContain('SYNTHETIC Denied task title');
    } finally {
      await addMember(db, cast.ws.home_building, ownerC, 'owner');
    }
  });

  it('with access unchanged, Save still saves and keeps the task on screen', async () => {
    const m = mount(ownerB());
    await openTask(m);
    setValue(fieldByLabel(m.root, 'Description'), 'SYNTHETIC Denied saved fine');
    m.root.querySelector('form.task-form').dispatchEvent(submitEvent());
    await settle();
    expect(m.root.querySelector('aside.detail').textContent).toContain('SYNTHETIC Denied task title');
    expect(fieldByLabel(m.root, 'Description').value).toBe('SYNTHETIC Denied saved fine');
  });
});

// ---------------------------------------------------------------------------
// P1-3: reopening a project from Projects
// ---------------------------------------------------------------------------

describe('reopening a project from Projects shows current rows (review round 3, P1-3)', () => {
  it('a task finished in another tab shows Done when the project is reopened', async () => {
    const p = await project('SYNTHETIC Reopen build');
    const t = await task(p.id, 'SYNTHETIC Reopen task');
    const m = mount(cast.homeMember);
    await go(m, `/p/${p.id}`);
    expect(m.root.querySelector('.task-row .status').textContent).toBe('Ready');
    byText(m.root, 'a', '‹ Projects').click();
    await settle();
    // Another tab finishes the task.
    await asUser(db, cast.owner.id, (tx) =>
      rpc(tx, 'set_task_status', { p_task_id: t.id, p_expected_version: t.version, p_status: 'done' }));
    m.client.calls.length = 0;
    byText(m.root, 'a', 'SYNTHETIC Reopen build').click();
    await settle();
    expect(m.client.calls).toContain('list_tasks');
    expect(m.root.querySelector('.task-row .status').textContent).toBe('Done');
  });

  it('the same for a board column', async () => {
    const p = await project('SYNTHETIC Reopen board build');
    const t = await task(p.id, 'SYNTHETIC Reopen board task');
    const m = mount(cast.homeMember);
    await go(m, `/p/${p.id}?view=board`);
    expect(m.root.querySelector('.col[data-status="ready"]').textContent).toContain('SYNTHETIC Reopen board task');
    await go(m, `/w/${cast.ws.home_building}`);
    await asUser(db, cast.owner.id, (tx) =>
      rpc(tx, 'set_task_status', { p_task_id: t.id, p_expected_version: t.version, p_status: 'done' }));
    await go(m, `/p/${p.id}?view=board`);
    expect(m.root.querySelector('.col[data-status="ready"]').textContent).not.toContain('SYNTHETIC Reopen board task');
    expect(m.root.querySelector('.col[data-status="done"]').textContent).toContain('SYNTHETIC Reopen board task');
  });

  it('Back from a task keeps the loaded rows, the filters and the scroll position, after one access check', async () => {
    const p = await project('SYNTHETIC Reopen filters build');
    const t = await task(p.id, 'SYNTHETIC Reopen filtered task');
    const m = mount(cast.homeMember);
    const listUrl = `/p/${p.id}?status=ready`;
    await go(m, listUrl);
    let y = 0;
    window.scrollTo = (_x, yy) => { y = yy; };
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 420 });
    try {
      byText(m.root, 'a', 'SYNTHETIC Reopen filtered task').click();
      await settle();
      m.client.calls.length = 0;
      byText(m.root.querySelector('aside'), 'a', '‹ SYNTHETIC Reopen filters build').click();
      await settle();
      expect(m.client.calls).toEqual(['get_project']);
      expect(`${window.location.pathname}${window.location.search}`).toBe(listUrl);
      expect(m.root.textContent).toContain('SYNTHETIC Reopen filtered task');
      expect(y).toBe(420);
    } finally {
      delete window.scrollY;
    }
    expect(t.id).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// P1-4: posting to a long thread on a phone
// ---------------------------------------------------------------------------

describe('posting reads nothing back (review round 3, P1-4)', () => {
  it('300 entries on a phone: one write, no reads, the new entry shown, page and cursor kept', async () => {
    bp.set(false);
    const p = await project('SYNTHETIC Long post build');
    const t = await task(p.id, 'SYNTHETIC Long post task');
    await asAdmin(db, async (tx) => {
      for (let i = 0; i < 300; i++) {
        await tx.query(
          `insert into eden.task_updates (workspace_id, project_id, task_id, author_user_id, body)
           values ($1, $2, $3, $4, $5)`,
          [cast.ws.home_building, p.id, t.id, cast.owner.id, `SYNTHETIC entry ${String(i + 1).padStart(3, '0')}`],
        );
      }
      // The insert trigger stamps the time; spread the entries out so their
      // order is their number, all before the post below.
      await tx.query(
        `update eden.task_updates
            set created_at = now() - interval '1 hour' + make_interval(secs => substring(body from '([0-9]+)$')::int)
          where task_id = $1`,
        [t.id],
      );
    });
    const m = mount(cast.homeMember);
    await go(m, `/p/${p.id}?task=${t.id}`);
    const rows = () => [...m.root.querySelectorAll('.thread ol.updates > li')];
    expect(rows()).toHaveLength(20);
    const thread = m.root.querySelector('.thread');
    m.client.calls.length = 0;
    setValue(fieldByLabel(thread, 'Add update'), 'SYNTHETIC entry newest');
    thread.querySelector('form').dispatchEvent(submitEvent());
    await settle();
    expect(m.client.calls).toEqual(['add_update']);
    expect(rows()).toHaveLength(21);
    const newest = rows().find((li) => li.textContent.includes('SYNTHETIC entry newest'));
    expect(newest, 'the posted entry is on screen').toBeTruthy();
    expect(newest.textContent).toContain('SYNTHETIC Home helper');
    // The first page and its cursor are kept: Show more continues at entry 21.
    expect(rows()[19].textContent).toContain('SYNTHETIC entry 020');
    m.client.calls.length = 0;
    byText(thread, 'button', 'Show more updates').click();
    await settle();
    expect(m.client.calls).toEqual(['list_updates']);
    expect(rows().some((li) => li.textContent.includes('SYNTHETIC entry 021'))).toBe(true);
    // Read to the end: every entry once, the newest last.
    for (let i = 0; i < 20 && byText(thread, 'button', 'Show more updates'); i++) {
      byText(thread, 'button', 'Show more updates').click();
      await settle();
    }
    const bodies = rows().map((li) => li.querySelector('.body').textContent);
    expect(bodies).toHaveLength(301);
    expect(new Set(bodies).size).toBe(301);
    expect(bodies.at(-1)).toBe('SYNTHETIC entry newest');
  });

  it('a short thread: the entry is added in place, the "No updates yet" line goes', async () => {
    const p = await project('SYNTHETIC Short post build');
    const t = await task(p.id, 'SYNTHETIC Short post task');
    const m = mount(cast.homeMember);
    await go(m, `/p/${p.id}?task=${t.id}`);
    const thread = m.root.querySelector('.thread');
    expect(thread.textContent).toContain('No updates yet.');
    m.client.calls.length = 0;
    setValue(fieldByLabel(thread, 'Add update'), 'SYNTHETIC first entry');
    thread.querySelector('form').dispatchEvent(submitEvent());
    await settle();
    expect(m.client.calls).toEqual(['add_update']);
    expect(thread.textContent).not.toContain('No updates yet.');
    expect([...thread.querySelectorAll('ol.updates > li')].map((li) => li.querySelector('.body').textContent))
      .toEqual(['SYNTHETIC first entry']);
    // A reload agrees with what was shown.
    await go(m, `/p/${p.id}?task=${t.id}`);
    expect([...m.root.querySelectorAll('.thread ol.updates > li .body')].map((x) => x.textContent))
      .toEqual(['SYNTHETIC first entry']);
  });
});

// ---------------------------------------------------------------------------
// P2-2: a recorded name reaches the next task form
// ---------------------------------------------------------------------------

describe('a name added from a task form is in the next form (review round 3, P2-2)', () => {
  it('Add name, back out without saving, open a new task: the name is offered', async () => {
    const p = await project('SYNTHETIC Name cache build');
    const m = mount(cast.owner);
    await go(m, `/p/${p.id}?task=new`);
    // The task form's Assignee, not the filter bar's.
    const assignee = fieldByLabel(m.root.querySelector('aside.detail'), 'Assignee');
    setValue(assignee, '__new');
    const adder = m.root.querySelector('.panel.inline');
    setValue(fieldByLabel(adder, 'Name'), 'SYNTHETIC Cached Supplier');
    byText(adder, 'button', 'Add name').click();
    await settle();
    expect(assignee.selectedOptions[0].textContent).toBe('SYNTHETIC Cached Supplier');
    byText(m.root.querySelector('aside'), 'a', '‹ SYNTHETIC Name cache build').click();
    await settle();
    await go(m, `/p/${p.id}?task=new`);
    const offered = [...fieldByLabel(m.root.querySelector('aside.detail'), 'Assignee').options].map((o) => o.textContent);
    expect(offered.some((x) => x.startsWith('SYNTHETIC Cached Supplier'))).toBe(true);
  });
});
