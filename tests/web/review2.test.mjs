// @vitest-environment happy-dom
//
// Screen behaviour from the Stage 1 review, round 2 (457r2c): revoked access
// between visits (P0-1), a pending export after the account leaves (P0-2),
// crossing the phone/desktop breakpoint with an unsaved edit (P1-4), owners
// correcting recorded names (P1-5) and Show more failing on a phone (P1-6).
// Real UI and api.js against the migrations in local Postgres. SYNTHETIC data.

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import {
  freshDb, seedCast, asUser, asAdmin, rpc, revokeMember, addMember, setGate,
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

const submitEvent = () => new Event('submit', { bubbles: true, cancelable: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function project(name, ws = cast.ws.home_building) {
  const [p] = await asUser(db, cast.owner.id, (tx) => rpc(tx, 'create_project', { p_workspace_id: ws, p_name: name }));
  return p;
}

async function task(projectId, title, extra = {}) {
  const [t] = await asUser(db, cast.owner.id, (tx) =>
    rpc(tx, 'create_task', { p_project_id: projectId, p_kind: 'task', p_title: title, ...extra }));
  return t;
}

async function contact(name, ws = cast.ws.home_building) {
  const [c] = await asUser(db, cast.owner.id, (tx) =>
    rpc(tx, 'create_contact', { p_workspace_id: ws, p_display_name: name, p_kind: 'vendor' }));
  return c;
}

async function bulkTasks(projectId, n, { ws = cast.ws.home_building, status = 'ready', prefix = 'SYNTHETIC bulk' } = {}) {
  await asAdmin(db, async (tx) => {
    for (let i = 0; i < n; i++) {
      await tx.query(
        `insert into eden.tasks (workspace_id, project_id, kind, title, created_by, status)
         values ($1, $2, 'task', $3, $4, $5)`,
        [ws, projectId, `${prefix} ${String(i).padStart(3, '0')}`, cast.owner.id, status],
      );
    }
  });
}

// ---------------------------------------------------------------------------
// P0-1: a revoked member returning to a cached project
// ---------------------------------------------------------------------------

describe('access revoked between visits (review round 2, P0-1)', () => {
  async function visitAndCache(m) {
    const p = await project('SYNTHETIC Revoke build');
    const roofer = await contact('SYNTHETIC Revoke Roofing');
    const t = await task(p.id, 'SYNTHETIC Revoke secret task', { p_assignee_contact_id: roofer.id });
    await task(p.id, 'SYNTHETIC Revoke second task');
    await go(m, `/p/${p.id}`);
    expect(m.root.textContent).toContain('SYNTHETIC Revoke secret task');
    expect(m.root.textContent).toContain('SYNTHETIC Revoke Roofing');
    await go(m, `/p/${p.id}?task=${t.id}`);
    expect(m.root.querySelector('aside.detail').textContent).toContain('SYNTHETIC Revoke secret task');
    return { p, t };
  }

  function expectNothingFrom(m) {
    const text = m.root.textContent;
    // The refusal itself, or (once memberships are read again) the
    // no-access screen.
    expect(text).toMatch(/Not available|Ask Hank for workspace access/);
    expect(text).not.toContain('SYNTHETIC Revoke secret task');
    expect(text).not.toContain('SYNTHETIC Revoke second task');
    expect(text).not.toContain('SYNTHETIC Revoke Roofing');
    expect(text).not.toContain('SYNTHETIC Revoke build');
  }

  function expectCachesEmpty(m) {
    for (const cache of [m.app.state.listCache, m.app.state.metaCache]) {
      for (const v of cache.values()) expect(JSON.stringify(v)).not.toContain('SYNTHETIC Revoke');
    }
  }

  it('after a roster revocation, Back to the cached project shows nothing from it', async () => {
    const m = mount(cast.homeMember);
    const { p } = await visitAndCache(m);
    await revokeMember(db, cast.ws.home_building, cast.homeMember);
    try {
      m.client.calls.length = 0;
      byText(m.root.querySelector('aside'), 'a', '‹ SYNTHETIC Revoke build').click();
      await settle();
      // A current access decision was asked for before anything was painted.
      expect(m.client.calls).toContain('get_project');
      expect(m.root.textContent).toContain('Not available');
      expectNothingFrom(m);
      expectCachesEmpty(m);
      // Going to the same project again still paints nothing from memory.
      await go(m, `/p/${p.id}`);
      expectNothingFrom(m);
    } finally {
      await addMember(db, cast.ws.home_building, cast.homeMember, 'member', 'SYNTHETIC Home helper');
    }
  });

  it('a denied task request drops the cached project, assignees and pages', async () => {
    const m = mount(cast.homeMember);
    const { p, t } = await visitAndCache(m);
    await revokeMember(db, cast.ws.home_building, cast.homeMember);
    try {
      // A fresh task request is denied...
      await go(m, `/p/${p.id}?task=${t.id}`);
      expectNothingFrom(m);
      expectCachesEmpty(m);
      expect(m.app.state.listCache.size).toBe(0);
      expect(m.app.state.metaCache.size).toBe(0);
      // ...and Back to the project does not repaint it from memory.
      await go(m, `/p/${p.id}`);
      expectNothingFrom(m);
    } finally {
      await addMember(db, cast.ws.home_building, cast.homeMember, 'member', 'SYNTHETIC Home helper');
    }
  });

  it('after the access gate closes, Back to the cached project shows nothing from it', async () => {
    const m = mount(cast.owner);
    const { p } = await visitAndCache(m);
    await setGate(db, false);
    try {
      byText(m.root.querySelector('aside'), 'a', '‹ SYNTHETIC Revoke build').click();
      await settle();
      expectNothingFrom(m);
      expectCachesEmpty(m);
      await go(m, `/p/${p.id}?view=board`);
      expectNothingFrom(m);
    } finally {
      await setGate(db, true);
    }
  });

  it('a revoked member is shown the current memberships, not the old ones', async () => {
    const m = mount(cast.homeMember);
    const { p } = await visitAndCache(m);
    await revokeMember(db, cast.ws.home_building, cast.homeMember);
    try {
      await go(m, `/p/${p.id}`);
      expectNothingFrom(m);
      await go(m, '/');
      expect(m.root.textContent).toContain('Ask Hank for workspace access');
    } finally {
      await addMember(db, cast.ws.home_building, cast.homeMember, 'member', 'SYNTHETIC Home helper');
    }
  });

  it('with access unchanged, Back repaints the cached pages after one access check', async () => {
    const m = mount(cast.homeMember);
    await visitAndCache(m);
    m.client.calls.length = 0;
    byText(m.root.querySelector('aside'), 'a', '‹ SYNTHETIC Revoke build').click();
    await settle();
    expect(m.client.calls).toEqual(['get_project']);
    expect(m.root.textContent).toContain('SYNTHETIC Revoke secret task');
  });
});

// ---------------------------------------------------------------------------
// P0-2: a pending export after the account leaves
// ---------------------------------------------------------------------------

describe('a pending export after the account leaves (review round 2, P0-2)', () => {
  async function pendingExport(user) {
    const p = await project('SYNTHETIC Late export build');
    await task(p.id, 'SYNTHETIC Late export task');
    const m = mount(user);
    await go(m, `/p/${p.id}`);
    m.client.delayMs = 60;
    byText(m.root, 'button', 'Export').click();
    // The export request is in flight.
    for (let i = 0; i < 200 && !m.client.calls.includes('export_project'); i++) await wait(2);
    expect(m.client.calls).toContain('export_project');
    return m;
  }

  async function drain(m) {
    m.client.delayMs = 0;
    await wait(150);
    await settle(60);
  }

  it('another account signing in: zero downloads, nothing shown', async () => {
    const m = await pendingExport(cast.owner);
    m.auth.switchUser(cast.manager);
    await drain(m);
    expect(m.downloads).toEqual([]);
    expect(m.root.textContent).not.toContain('Exported');
  });

  it('sign-out on this tab: zero downloads', async () => {
    const m = await pendingExport(cast.owner);
    await m.app.ctx.signOut();
    await drain(m);
    expect(m.downloads).toEqual([]);
    expect(m.root.textContent).toContain('Sign in with Google');
  });

  it('signed out from another tab: zero downloads', async () => {
    const m = await pendingExport(cast.homeMember);
    m.auth.setUser(null);
    m.auth.emit('SIGNED_OUT', null);
    await drain(m);
    expect(m.downloads).toEqual([]);
  });

  it('signing out and back in as the same person before it lands: still zero downloads', async () => {
    const m = await pendingExport(cast.owner);
    m.auth.setUser(null);
    m.auth.emit('SIGNED_OUT', null);
    m.auth.switchUser(cast.owner);
    await drain(m);
    expect(m.downloads).toEqual([]);
  });

  it('an unchanged account still gets both files', async () => {
    const m = await pendingExport(cast.owner);
    await drain(m);
    expect(m.downloads.map((d) => d.filename)).toEqual([
      'synthetic-late-export-build-tasks.csv', 'synthetic-late-export-build-updates.csv',
    ]);
  });
});

// ---------------------------------------------------------------------------
// P1-4: crossing the breakpoint keeps an unsaved edit
// ---------------------------------------------------------------------------

describe('rotating across the breakpoint keeps an unsaved edit (review round 2, P1-4)', () => {
  it('phone to desktop on the board: the draft stays and the other columns load', async () => {
    const p = await project('SYNTHETIC Rotate build');
    const t = await task(p.id, 'SYNTHETIC Rotate task', { p_description: 'SYNTHETIC saved text' });
    await task(p.id, 'SYNTHETIC Rotate doing', { p_status: 'in_progress' });
    bp.set(false);
    const m = mount(cast.owner);
    await go(m, `/p/${p.id}?view=board&task=${t.id}`);
    expect(m.root.querySelector('.col[data-status="in_progress"]').textContent).not.toContain('SYNTHETIC Rotate doing');
    setValue(fieldByLabel(m.root.querySelector('form.task-form'), 'Description'), 'SYNTHETIC unsaved draft');

    m.client.calls.length = 0;
    bp.set(true);
    await settle();
    expect(fieldByLabel(m.root.querySelector('form.task-form'), 'Description').value).toBe('SYNTHETIC unsaved draft');
    expect(m.client.calls).not.toContain('get_task');
    expect(m.root.querySelector('.col[data-status="in_progress"]').textContent).toContain('SYNTHETIC Rotate doing');

    // And back to a phone: still the draft, no task refetch.
    bp.set(false);
    await settle();
    expect(fieldByLabel(m.root.querySelector('form.task-form'), 'Description').value).toBe('SYNTHETIC unsaved draft');
    expect(m.client.calls).not.toContain('get_task');
  });

  it('on the list view and the new-task form, rotation rebuilds nothing', async () => {
    const p = await project('SYNTHETIC Rotate list build');
    const m = mount(cast.owner);
    await go(m, `/p/${p.id}?task=new`);
    setValue(fieldByLabel(m.root.querySelector('form.task-form'), 'Task'), 'SYNTHETIC typed title');
    m.client.calls.length = 0;
    bp.set(false);
    await settle();
    bp.set(true);
    await settle();
    expect(fieldByLabel(m.root.querySelector('form.task-form'), 'Task').value).toBe('SYNTHETIC typed title');
    expect(m.client.calls).toEqual([]);
  });

  it('an owner\'s project edit form survives rotation', async () => {
    const p = await project('SYNTHETIC Rotate edit build');
    const m = mount(cast.owner);
    await go(m, `/p/${p.id}?view=board`);
    byText(m.root, 'button', 'Edit project').click();
    setValue(fieldByLabel(m.root.querySelector('form.project-edit'), 'Project name'), 'SYNTHETIC half typed');
    bp.set(false);
    await settle();
    const form = m.root.querySelector('form.project-edit');
    expect(form.hidden).toBe(false);
    expect(fieldByLabel(form, 'Project name').value).toBe('SYNTHETIC half typed');
  });
});

// ---------------------------------------------------------------------------
// P1-5: owners correct or retire a recorded name
// ---------------------------------------------------------------------------

describe('owners correct and retire recorded names (review round 2, P1-5)', () => {
  async function openNames(m, ws = cast.ws.home_building) {
    await go(m, `/w/${ws}`);
    byText(m.root, 'button', 'People and companies').click();
    await settle();
    return m.root.querySelector('.contacts');
  }

  function rowFor(panel, name) {
    const row = [...panel.querySelectorAll('li')].find((li) => li.textContent.includes(name));
    if (!row) throw new Error(`no row for ${name}`);
    return row;
  }

  it('an owner renames a typo; past tasks show the corrected name', async () => {
    const c = await contact('SYNTHETIC Plumbnig Co');
    const p = await project('SYNTHETIC Names build');
    const t = await task(p.id, 'SYNTHETIC Pipe task', { p_assignee_contact_id: c.id });
    const m = mount(cast.owner);
    const panel = await openNames(m);
    const row = rowFor(panel, 'SYNTHETIC Plumbnig Co');
    byText(row, 'button', 'Rename').click();
    const form = row.querySelector('form');
    setValue(fieldByLabel(form, 'Name'), 'SYNTHETIC Plumbing Co');
    form.dispatchEvent(submitEvent());
    await settle();
    expect(m.root.querySelector('.contacts').textContent).toContain('SYNTHETIC Plumbing Co');
    const [got] = await asUser(db, cast.owner.id, (tx) => rpc(tx, 'get_task', { p_task_id: t.id }));
    expect(got.assignee_id).toBe(c.id);
    expect(got.assignee_name).toBe('SYNTHETIC Plumbing Co');
    // The picker offers the corrected name.
    await go(m, `/p/${p.id}?task=new`);
    expect(m.root.querySelector('form.task-form').textContent).toContain('SYNTHETIC Plumbing Co');
    expect(m.root.querySelector('form.task-form').textContent).not.toContain('SYNTHETIC Plumbnig Co');
  });

  it('an owner archives a name: gone from the picker, kept on past tasks, restorable', async () => {
    const c = await contact('SYNTHETIC Retired Roofer');
    const p = await project('SYNTHETIC Archive name build');
    const t = await task(p.id, 'SYNTHETIC Old roof task', { p_assignee_contact_id: c.id });
    const m = mount(cast.owner);
    let panel = await openNames(m);
    byText(rowFor(panel, 'SYNTHETIC Retired Roofer'), 'button', 'Archive').click();
    await settle();
    panel = m.root.querySelector('.contacts');
    expect(panel.querySelector('ul.active-names').textContent).not.toContain('SYNTHETIC Retired Roofer');

    await go(m, `/p/${p.id}?task=new`);
    expect(m.root.querySelector('form.task-form').textContent).not.toContain('SYNTHETIC Retired Roofer');
    await go(m, `/p/${p.id}?task=${t.id}`);
    expect(m.root.querySelector('aside.detail').textContent).toContain('SYNTHETIC Retired Roofer');
    const [got] = await asUser(db, cast.owner.id, (tx) => rpc(tx, 'get_task', { p_task_id: t.id }));
    expect(got.assignee_id).toBe(c.id);

    panel = await openNames(m);
    byText(panel, 'button', 'Show archived names').click();
    await settle();
    panel = m.root.querySelector('.contacts');
    byText(rowFor(panel.querySelector('ul.archived-names'), 'SYNTHETIC Retired Roofer'), 'button', 'Restore').click();
    await settle();
    await go(m, `/p/${p.id}?task=new`);
    expect(m.root.querySelector('form.task-form').textContent).toContain('SYNTHETIC Retired Roofer');
  });

  it('a rename that fails keeps what was typed and says why', async () => {
    await contact('SYNTHETIC Keep typed Co');
    const m = mount(cast.owner);
    const panel = await openNames(m);
    const row = rowFor(panel, 'SYNTHETIC Keep typed Co');
    byText(row, 'button', 'Rename').click();
    const form = row.querySelector('form');
    setValue(fieldByLabel(form, 'Name'), 'SYNTHETIC Keep typed Company');
    m.client.offline = true;
    form.dispatchEvent(submitEvent());
    await settle();
    m.client.offline = false;
    expect(form.querySelector('[role="alert"]').textContent).toMatch(/could not reach/i);
    expect(fieldByLabel(form, 'Name').value).toBe('SYNTHETIC Keep typed Company');
  });

  it('members and the manager get no name controls', async () => {
    const mm = mount(cast.homeMember);
    await go(mm, `/w/${cast.ws.home_building}`);
    expect(byText(mm.root, 'button', 'People and companies')).toBeFalsy();
    const mg = mount(cast.manager);
    await go(mg, `/w/${cast.ws.stay_eden_ops}`);
    expect(byText(mg.root, 'button', 'People and companies')).toBeFalsy();
  });

  it('the workspace screen makes no extra request until the owner opens the names', async () => {
    const m = mount(cast.owner);
    await go(m, `/w/${cast.ws.home_building}`);
    m.client.calls.length = 0;
    await go(m, `/w/${cast.ws.home_building}`);
    expect(m.client.calls).toEqual(['list_projects']);
  });
});

// ---------------------------------------------------------------------------
// P2: posting to a long, expanded thread
// ---------------------------------------------------------------------------

describe('posting to a long thread keeps it expanded and shows the new entry (review round 2, P2)', () => {
  it('51 entries expanded, post the 52nd: all 52 on screen, newest last', async () => {
    const p = await project('SYNTHETIC Long thread build');
    const t = await task(p.id, 'SYNTHETIC Long thread task');
    await asUser(db, cast.owner.id, async (tx) => {
      for (let i = 0; i < 51; i++) {
        await rpc(tx, 'add_update', { p_task_id: t.id, p_body: `SYNTHETIC entry ${String(i + 1).padStart(2, '0')}` });
      }
    });
    const m = mount(cast.owner);
    await go(m, `/p/${p.id}?task=${t.id}`);
    byText(m.root.querySelector('.thread'), 'button', 'Show more updates').click();
    await settle();
    expect(m.root.querySelectorAll('ol.updates > li').length).toBe(51);
    const thread = m.root.querySelector('.thread');
    setValue(fieldByLabel(thread, 'Add update'), 'SYNTHETIC entry 52');
    thread.querySelector('form').dispatchEvent(submitEvent());
    await settle();
    const items = [...m.root.querySelectorAll('ol.updates > li')];
    expect(items.length).toBe(52);
    expect(items.at(-1).textContent).toContain('SYNTHETIC entry 52');
  });
});

// ---------------------------------------------------------------------------
// P1-6: Show more during an outage
// ---------------------------------------------------------------------------

describe('Show more during an outage keeps the page and says so (review round 2, P1-6)', () => {
  async function failThenRecover(m, scope, rowSelector, before, after, label = 'Show more') {
    expect(scope().querySelectorAll(rowSelector).length).toBe(before);
    m.client.offline = true;
    byText(scope(), 'button', label).click();
    await settle();
    m.client.offline = false;
    expect(scope().querySelectorAll(rowSelector).length).toBe(before);
    const alert = scope().querySelector('.more [role="alert"]');
    expect(alert, 'a visible message beside the control').toBeTruthy();
    expect(alert.textContent).toMatch(/could not load more/i);
    expect(alert.textContent).toMatch(/try again/i);
    // Retry after recovery loads the next page and clears the message.
    byText(scope(), 'button', label).click();
    await settle();
    expect(scope().querySelectorAll(rowSelector).length).toBe(after);
    expect(scope().querySelector('.more [role="alert"]')?.textContent || '').toBe('');
  }

  it('task list', async () => {
    const p = await project('SYNTHETIC Outage list build');
    await bulkTasks(p.id, 51);
    const m = mount(cast.owner);
    await go(m, `/p/${p.id}`);
    await failThenRecover(m, () => m.root.querySelector('section.work'), '.task-row', 50, 51);
  });

  it('board column on a phone', async () => {
    const p = await project('SYNTHETIC Outage board build');
    await bulkTasks(p.id, 51);
    bp.set(false);
    const m = mount(cast.owner);
    await go(m, `/p/${p.id}?view=board`);
    await failThenRecover(m, () => m.root.querySelector('.col[data-status="ready"]'), '.card', 50, 51);
  });

  it('workspace project list', async () => {
    await asAdmin(db, async (tx) => {
      for (let i = 0; i < 51; i++) {
        await tx.query(
          `insert into eden.projects (workspace_id, name, created_by) values ($1, $2, $3)`,
          [cast.ws.stay_eden_ops, `SYNTHETIC Outage cottage ${String(i).padStart(3, '0')}`, cast.owner.id],
        );
      }
    });
    const m = mount(cast.manager);
    await go(m, `/w/${cast.ws.stay_eden_ops}`);
    await failThenRecover(m, () => m.root.querySelector('main'), 'ul.cards > li', 50, 51);
  });

  it('updates thread', async () => {
    const p = await project('SYNTHETIC Outage thread build');
    const t = await task(p.id, 'SYNTHETIC Outage thread task');
    await asUser(db, cast.owner.id, async (tx) => {
      for (let i = 0; i < 21; i++) {
        await rpc(tx, 'add_update', { p_task_id: t.id, p_body: `SYNTHETIC note ${i}` });
      }
    });
    const m = mount(cast.owner);
    await go(m, `/p/${p.id}?task=${t.id}`);
    await failThenRecover(m, () => m.root.querySelector('.thread'), 'ol.updates > li', 20, 21, 'Show more updates');
  });
});
