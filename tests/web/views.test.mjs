// @vitest-environment happy-dom
//
// Screen behaviour from the Stage 1 review (P1-5 to P1-9), driving the real
// UI and api.js against the migrations in local Postgres. SYNTHETIC data.

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { freshDb, seedCast, asUser, asAdmin, rpc } from '../db/harness.mjs';
import { createApi } from '../../src/api.js';
import { createApp } from '../../src/app.js';
import { fakeSupabase, fakeAuth, settle, byText } from './fake-supabase.mjs';

let db;
let cast;

beforeAll(async () => {
  db = await freshDb();
  cast = await seedCast(db);
});

beforeEach(() => {
  window.scrollTo = () => {};
  window.happyDOM.setViewport({ width: 1280, height: 900 });
});
afterEach(() => {
  window.happyDOM.setViewport({ width: 1280, height: 900 });
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

// P1-5
describe('posting an update keeps an unsaved task edit', () => {
  it('the typed description survives Post update and can still be saved', async () => {
    const p = await project('SYNTHETIC Draft build');
    const t = await task(p.id, 'SYNTHETIC Draft task', { p_description: 'SYNTHETIC saved text' });
    const m = mount(cast.owner);
    await go(m, `/p/${p.id}?task=${t.id}`);
    const form = m.root.querySelector('form.task-form');
    setValue(fieldByLabel(form, 'Description'), 'SYNTHETIC unsaved edit');
    const thread = m.root.querySelector('.thread');
    setValue(fieldByLabel(thread, 'Add update'), 'SYNTHETIC Crew booked.');
    thread.querySelector('form').dispatchEvent(submitEvent());
    await settle();

    expect(m.root.querySelector('.thread').textContent).toContain('SYNTHETIC Crew booked.');
    const formAfter = m.root.querySelector('form.task-form');
    expect(fieldByLabel(formAfter, 'Description').value).toBe('SYNTHETIC unsaved edit');
    expect(fieldByLabel(m.root.querySelector('.thread'), 'Add update').value).toBe('');

    formAfter.dispatchEvent(submitEvent());
    await settle();
    const [saved] = await asUser(db, cast.owner.id, (tx) => rpc(tx, 'get_task', { p_task_id: t.id }));
    expect(saved.description).toBe('SYNTHETIC unsaved edit');
    expect(saved.updates.map((u) => u.body)).toEqual(['SYNTHETIC Crew booked.']);
  });
});

// P1-6
describe('a failed board move keeps its explanation', () => {
  it('names the card whose move failed, after the board reloads', async () => {
    const p = await project('SYNTHETIC Stale board build');
    const t = await task(p.id, 'SYNTHETIC Stale card');
    const m = mount(cast.owner);
    await go(m, `/p/${p.id}?view=board`);
    // A separate edit wins first.
    await asUser(db, cast.owners[1].id, (tx) => rpc(tx, 'update_task', {
      p_task_id: t.id, p_expected_version: t.version, p_changes: { description: 'SYNTHETIC winner' },
    }));
    const card = [...m.root.querySelectorAll('.card')].find((c) => c.textContent.includes('SYNTHETIC Stale card'));
    setValue(card.querySelector('select'), 'done');
    await settle();

    const alert = m.root.querySelector('.board-message[role="alert"]');
    expect(alert.textContent).toMatch(/SYNTHETIC Stale card/);
    expect(alert.textContent).toMatch(/someone else changed/i);
    const marked = m.root.querySelector('.card.move-failed');
    expect(marked.textContent).toContain('SYNTHETIC Stale card');
    // The database kept the winning version; the card is still in Ready.
    const [kept] = await asUser(db, cast.owner.id, (tx) => rpc(tx, 'get_task', { p_task_id: t.id }));
    expect(kept.status).toBe('ready');
    expect(kept.description).toBe('SYNTHETIC winner');
    // The message is shown once, not on every later screen.
    await go(m, `/p/${p.id}?view=board&col=done`);
    expect(m.root.querySelector('.board-message').textContent).toBe('');
  });
});

// P1-7
describe('one tap, one record', () => {
  it('a second tap while Create project is pending creates nothing more', async () => {
    const m = mount(cast.owner);
    await go(m, `/w/${cast.ws.home_building}`);
    const form = m.root.querySelector('form.panel');
    setValue(fieldByLabel(form, 'Project name'), 'SYNTHETIC Double tap');
    m.client.delayMs = 120;
    form.dispatchEvent(submitEvent());
    await new Promise((r) => setTimeout(r, 30));
    expect(form.querySelector('button[type="submit"]').disabled).toBe(true);
    form.dispatchEvent(submitEvent());
    await new Promise((r) => setTimeout(r, 600));
    await settle();
    expect(m.client.calls.filter((c) => c === 'create_project')).toHaveLength(1);
    const { rows } = await asAdmin(db, (tx) => tx.query(`select count(*)::int as n from eden.projects where name = 'SYNTHETIC Double tap'`));
    expect(rows[0].n).toBe(1);
  });

  it('a failed create re-enables the button so it can be retried', async () => {
    const m = mount(cast.owner);
    await go(m, `/w/${cast.ws.home_building}`);
    const form = m.root.querySelector('form.panel');
    setValue(fieldByLabel(form, 'Project name'), 'x'.repeat(121)); // too long: the database refuses
    form.dispatchEvent(submitEvent());
    await settle();
    expect(form.querySelector('[role="alert"]').textContent).not.toBe('');
    expect(form.querySelector('button[type="submit"]').disabled).toBe(false);
  });

  it('a second tap while Add task is pending creates one task', async () => {
    const p = await project('SYNTHETIC Double task build');
    const m = mount(cast.owner);
    await go(m, `/p/${p.id}?task=new`);
    const form = m.root.querySelector('form.task-form');
    setValue(fieldByLabel(form, 'Task'), 'SYNTHETIC Once');
    m.client.delayMs = 120;
    form.dispatchEvent(submitEvent());
    await new Promise((r) => setTimeout(r, 30));
    form.dispatchEvent(submitEvent());
    await new Promise((r) => setTimeout(r, 800));
    await settle();
    expect(m.client.calls.filter((c) => c === 'create_task')).toHaveLength(1);
  });

  it('a second tap while Post update is pending posts once', async () => {
    const p = await project('SYNTHETIC Double update build');
    const t = await task(p.id, 'SYNTHETIC Thread task');
    const m = mount(cast.owner);
    await go(m, `/p/${p.id}?task=${t.id}`);
    const thread = m.root.querySelector('.thread');
    setValue(fieldByLabel(thread, 'Add update'), 'SYNTHETIC Once only');
    m.client.delayMs = 120;
    const f = thread.querySelector('form');
    f.dispatchEvent(submitEvent());
    await new Promise((r) => setTimeout(r, 30));
    f.dispatchEvent(submitEvent());
    await new Promise((r) => setTimeout(r, 800));
    await settle();
    expect(m.client.calls.filter((c) => c === 'add_update')).toHaveLength(1);
  });
});

// P1-8
describe('requests needed to display a phone board', () => {
  async function seed(n) {
    const p = await project(`SYNTHETIC Phone ${n}`);
    await asAdmin(db, async (tx) => {
      for (let i = 0; i < n; i++) {
        await tx.query(
          `insert into eden.tasks (workspace_id, project_id, kind, title, created_by, status)
           values ($1, $2, 'task', $3, $4, $5)`,
          [cast.ws.home_building, p.id, `SYNTHETIC phone task ${i}`, cast.owner.id, ['ready', 'in_progress', 'done'][i % 3]],
        );
      }
    });
    return p.id;
  }

  it('at 375 px the board fetches only the visible column: three requests in all', async () => {
    window.happyDOM.setViewport({ width: 375, height: 800 });
    const pid = await seed(150);
    const m = mount(cast.owner);
    await go(m, `/w/${cast.ws.home_building}`);
    m.client.calls.length = 0;
    await go(m, `/p/${pid}?view=board`);
    expect(m.client.calls.sort()).toEqual(['get_project', 'list_assignees', 'list_tasks']);
    const visible = m.root.querySelector('.col[data-status="ready"]');
    expect(visible.querySelectorAll('.card').length).toBe(50);
    // Next column: one request for that column only.
    m.client.calls.length = 0;
    byText(m.root, 'button', 'Next column').click();
    await settle();
    expect(m.client.calls).toEqual(['list_tasks']);
    expect(m.root.querySelector('.col[data-status="in_progress"]').querySelectorAll('.card').length).toBe(50);
  });

  it('at 375 px a cold task link on the board takes four requests, and Back none', async () => {
    window.happyDOM.setViewport({ width: 375, height: 800 });
    const pid = await seed(60);
    const [first] = await asUser(db, cast.owner.id, (tx) => rpc(tx, 'list_tasks', { p_project_id: pid }));
    const m = mount(cast.owner);
    await go(m, `/w/${cast.ws.home_building}`);
    m.client.calls.length = 0;
    await go(m, `/p/${pid}?view=board&task=${first.id}`);
    expect(m.client.calls.sort()).toEqual(['get_project', 'get_task', 'list_assignees', 'list_tasks']);
    expect(m.root.querySelector('aside.detail').textContent).toContain(first.title);
    m.client.calls.length = 0;
    byText(m.root.querySelector('aside'), 'a', '‹ SYNTHETIC Phone 60').click();
    await settle();
    expect(m.client.calls).toEqual([]);
  });

  it('at desktop width all three columns load, with metadata fetched once', async () => {
    const pid = await seed(30);
    const m = mount(cast.owner);
    await go(m, `/w/${cast.ws.home_building}`);
    m.client.calls.length = 0;
    await go(m, `/p/${pid}?view=board`);
    expect(m.client.calls.sort()).toEqual(['get_project', 'list_assignees', 'list_tasks', 'list_tasks', 'list_tasks']);
  });
});

// P1-9
describe('owners rename and archive a project from the app', () => {
  it('an owner corrects a name and archives, with version checks', async () => {
    const p = await project('SYNTHETIC Typo bulid');
    const m = mount(cast.owner);
    await go(m, `/p/${p.id}`);
    byText(m.root, 'button', 'Edit project').click();
    await settle();
    const form = m.root.querySelector('form.project-edit');
    setValue(fieldByLabel(form, 'Project name'), 'SYNTHETIC Typo build');
    form.dispatchEvent(submitEvent());
    await settle();
    expect(m.root.querySelector('h1').textContent).toContain('SYNTHETIC Typo build');
    let [got] = await asUser(db, cast.owner.id, (tx) => rpc(tx, 'get_project', { p_project_id: p.id }));
    expect(got.name).toBe('SYNTHETIC Typo build');

    byText(m.root, 'button', 'Archive project').click();
    await settle();
    expect(m.root.querySelector('h1').textContent).toContain('Archived');
    [got] = await asUser(db, cast.owner.id, (tx) => rpc(tx, 'get_project', { p_project_id: p.id }));
    expect(got.archived).toBe(true);
    byText(m.root, 'button', 'Restore project').click();
    await settle();
    [got] = await asUser(db, cast.owner.id, (tx) => rpc(tx, 'get_project', { p_project_id: p.id }));
    expect(got.archived).toBe(false);
  });

  it('a stale rename explains itself and keeps what was typed', async () => {
    const p = await project('SYNTHETIC Race build');
    const m = mount(cast.owner);
    await go(m, `/p/${p.id}`);
    byText(m.root, 'button', 'Edit project').click();
    await settle();
    await asUser(db, cast.owners[1].id, (tx) => rpc(tx, 'update_project', {
      p_project_id: p.id, p_expected_version: p.version, p_name: 'SYNTHETIC Race build (winner)',
    }));
    const form = m.root.querySelector('form.project-edit');
    setValue(fieldByLabel(form, 'Project name'), 'SYNTHETIC Race build (mine)');
    form.dispatchEvent(submitEvent());
    await settle();
    expect(form.textContent).toMatch(/someone else saved/i);
    expect(fieldByLabel(form, 'Project name').value).toBe('SYNTHETIC Race build (mine)');
    const [got] = await asUser(db, cast.owner.id, (tx) => rpc(tx, 'get_project', { p_project_id: p.id }));
    expect(got.name).toBe('SYNTHETIC Race build (winner)');
  });

  it('a member and the manager see no project controls', async () => {
    const home = await project('SYNTHETIC Member view build');
    const mm = mount(cast.homeMember);
    await go(mm, `/p/${home.id}`);
    expect(byText(mm.root, 'button', 'Edit project')).toBeFalsy();
    expect(byText(mm.root, 'button', 'Archive project')).toBeFalsy();
    const ops = await project('SYNTHETIC Example Cabin', cast.ws.stay_eden_ops);
    const mg = mount(cast.manager);
    await go(mg, `/p/${ops.id}`);
    expect(mg.root.textContent).toContain('SYNTHETIC Example Cabin');
    expect(byText(mg.root, 'button', 'Edit property')).toBeFalsy();
    expect(byText(mg.root, 'button', 'Archive property')).toBeFalsy();
  });
});
