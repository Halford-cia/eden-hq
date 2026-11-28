// Project (or property) screen: List and Board views of the same tasks, with
// task detail beside the view on desktop and full screen on a phone.
//
// Requests (review P1-8): the project, the visible tasks and an opened task
// are fetched together; assignees follow once the workspace is known.
// Assignees and task pages are cached, which an account change, a workspace
// switch, any save or any `unavailable` answer replaces. The project itself
// is fetched on every visit: it is the access check that must pass before a
// cached page is shown again (review round 2, P0-1). On a phone the board
// fetches only the column on screen.

import { h, field, inFlight, moreControl } from '../dom.js';
import { ApiError } from '../api.js';
import { projectUrl, filtersFromRoute } from '../router.js';
import { STATUS_LABELS, STATUSES, fmtRange, fmtDate } from '../format.js';
import { operationalExport } from '../csv.js';
import { topBar } from './entry.js';
import { taskPanel } from './task.js';

/** A cached value from the current metadata cache (never written into a newer one). */
async function cached(ctx, key, fetch) {
  const cache = ctx.state.metaCache;
  if (cache.has(key)) return cache.get(key);
  const value = await fetch();
  cache.set(key, value);
  return value;
}

export async function projectView(ctx, route) {
  const filters = filtersFromRoute(route);
  const phone = ctx.isPhone ? ctx.isPhone() : false;
  const urlFor = (extra) => projectUrl(route.projectId, { ...route, task: null, ...extra });
  const wantTask = route.task && route.task !== 'new';

  // The project is always asked for afresh: it is the current access
  // decision. Cached pages are painted only once it answers, so a roster
  // change or a closed gate since the last visit shows nothing from memory
  // (review round 2, P0-1).
  const [project, work, openTask] = await Promise.all([
    ctx.api.getProject(route.projectId),
    route.view === 'board'
      ? boardColumns(ctx, route, filters, phone)
      : listEntry(ctx, route, filters),
    wantTask ? ctx.api.getTask(route.task) : null,
  ]);
  const ws = ctx.workspace(project.workspace_id);
  if (!ws) throw new ApiError('unavailable', 'This is not available.');
  const ops = ws.kind === 'stay_eden_ops';
  const isOwner = ws.role === 'owner';
  const assignees = await cached(ctx, `assignees|${ws.workspace_id}`, () => ctx.api.listAssignees(ws.workspace_id));

  const workSlot = h('div', { class: 'work-slot' },
    route.view === 'board'
      ? boardSection(ctx, route, project, work, urlFor)
      : listSection(ctx, route, project, filters, work));
  if (route.view === 'board') {
    // Rotation: fetch the columns that came on screen and replace the board
    // only; the task panel and any form keep what was typed (review round 2, P1-4).
    ctx.onBreakpoint?.(workSlot, async () => {
      const stillCurrent = ctx.current();
      let columns;
      try {
        columns = await boardColumns(ctx, route, filters, ctx.isPhone ? ctx.isPhone() : false);
      } catch (e) {
        if (!stillCurrent() || !workSlot.isConnected) return;
        if (e.kind === 'unavailable') {
          await ctx.accessLost();
          return;
        }
        workSlot.querySelector('.board-message')?.replaceChildren(`Could not load the other columns. ${e.message}`);
        return;
      }
      if (!stillCurrent() || !workSlot.isConnected) return;
      workSlot.replaceChildren(boardSection(ctx, route, project, columns, urlFor));
    });
  }
  const panel = route.task
    ? await taskPanel(ctx, { route, project, ws, assignees, backUrl: urlFor({}), task: openTask })
    : null;

  const tabs = h('nav', { class: 'tabs', 'aria-label': 'View' },
    tab(ctx, 'List', route.view === 'list', urlFor({ view: 'list' })),
    tab(ctx, 'Board', route.view === 'board', urlFor({ view: 'board' })));

  const exportMsg = h('span', { class: 'muted', role: 'status' });
  const exportBtn = h('button', { type: 'button' }, 'Export');
  const runExport = inFlight(async () => {
    // Who asked, captured before the request: the files are handed to the
    // browser only if that same account is still signed in when the answer
    // arrives (review round 2, P0-2).
    const stillSameAccount = ctx.deliveryGuard();
    exportMsg.textContent = 'Preparing export…';
    let files;
    try {
      const snapshot = await ctx.api.exportProject(project.id);
      files = operationalExport(snapshot);
    } catch (e) {
      if (!(await stillSameAccount())) return;
      if (e.kind === 'unavailable') {
        await ctx.accessLost();
        return;
      }
      exportMsg.textContent = e.message;
      return;
    }
    if (!(await stillSameAccount())) return; // discarded, never downloaded
    for (const f of files) ctx.download(f.filename, f.text);
    exportMsg.textContent = `Exported ${files.length} files.`;
  }, () => [exportBtn]);
  exportBtn.addEventListener('click', () => runExport());

  const addBtn = project.archived ? null : h('a', {
    class: 'button primary',
    href: projectUrl(project.id, { ...route, task: 'new' }),
    onClick: (e) => { e.preventDefault(); ctx.navigate(projectUrl(project.id, { ...route, task: 'new' })); },
  }, ops ? '+ Item' : '+ Task');

  const filterBar = filterControls(ctx, route, assignees, urlFor);
  const controls = isOwner ? projectControls(ctx, project, ops) : null;

  return h('main', { class: `screen project${panel ? ' has-detail' : ''}` },
    topBar(ctx, ws.workspace_id),
    h('div', { class: 'title-row' },
      h('a', {
        class: 'back', href: `/w/${ws.workspace_id}`,
        onClick: (e) => { e.preventDefault(); ctx.navigate(`/w/${ws.workspace_id}`); },
      }, ops ? '‹ Properties' : '‹ Projects'),
      h('h1', null, project.name, project.archived ? h('span', { class: 'badge' }, 'Archived') : null)),
    controls,
    h('div', { class: 'layout' },
      h('section', { class: 'work', 'aria-label': `${project.name} tasks` },
        h('div', { class: 'toolbar' }, tabs, addBtn, exportBtn, exportMsg),
        filterBar,
        workSlot),
      panel ? h('aside', { class: 'detail', 'aria-label': 'Task detail' }, panel) : null));
}

/**
 * Owners correct a project's name and description, and archive or restore
 * it, each against the version they loaded (review P1-9). The database
 * refuses members and the manager whatever the screen shows.
 */
function projectControls(ctx, project, ops) {
  const Noun = ops ? 'Property' : 'Project';
  const noun = ops ? 'property' : 'project';
  const msg = h('p', { class: 'error', role: 'alert' });

  const name = h('input', { type: 'text', required: true, maxlength: 120, autocomplete: 'off', value: project.name });
  const desc = h('textarea', { rows: 2, maxlength: 4000, value: project.description || '' });
  const saveBtn = h('button', { class: 'primary', type: 'submit' }, 'Save');
  const editMsg = h('p', { class: 'error', role: 'alert' });
  const save = inFlight(async () => {
    editMsg.textContent = '';
    if (!name.value.trim()) {
      editMsg.textContent = `Give the ${noun} a name.`;
      return;
    }
    try {
      await ctx.api.updateProject(project.id, project.version, name.value.trim(), desc.value.trim());
    } catch (err) {
      // What was typed stays in the form.
      editMsg.textContent = err.kind === 'conflict'
        ? `Someone else saved this ${noun} first. Reload to see their change; what you typed is still here.`
        : err.message;
      return;
    }
    ctx.invalidate();
    await ctx.render();
  }, () => [saveBtn]);
  const form = h('form', {
    class: 'panel project-edit',
    onSubmit: (e) => {
      e.preventDefault();
      save();
    },
  },
  field(`${Noun} name`, name),
  field('Description (optional)', desc),
  editMsg,
  saveBtn,
  h('button', { type: 'button', onClick: () => { form.hidden = true; editBtn.hidden = false; } }, 'Cancel'));
  form.hidden = true;

  const editBtn = h('button', {
    type: 'button',
    onClick: () => { form.hidden = false; editBtn.hidden = true; name.focus?.(); },
  }, `Edit ${noun}`);

  const archiveBtn = h('button', { type: 'button' }, project.archived ? `Restore ${noun}` : `Archive ${noun}`);
  const archive = inFlight(async () => {
    msg.textContent = '';
    try {
      await ctx.api.setProjectArchived(project.id, project.version, !project.archived);
    } catch (err) {
      msg.textContent = err.kind === 'conflict'
        ? `Someone else changed this ${noun}. Reload and try again.`
        : err.message;
      return;
    }
    ctx.invalidate();
    await ctx.render();
  }, () => [archiveBtn]);
  archiveBtn.addEventListener('click', () => archive());

  return h('div', { class: 'project-controls' },
    h('div', { class: 'toolbar' }, project.archived ? null : editBtn, archiveBtn),
    msg,
    project.archived ? null : form);
}

function tab(ctx, label, active, url) {
  return h('a', {
    href: url,
    class: `tab${active ? ' active' : ''}`,
    'aria-current': active ? 'page' : null,
    onClick: (e) => { e.preventDefault(); ctx.navigate(url); },
  }, label);
}

function filterControls(ctx, route, assignees, urlFor) {
  const assignee = h('select', {
    onChange: (e) => ctx.navigate(urlFor({ assignee: e.target.value })),
  },
  h('option', { value: '' }, 'Everyone'),
  h('option', { value: 'none', selected: route.assignee === 'none' }, 'Unassigned'),
  assignees.map((a) => {
    const v = `${a.assignee_kind}:${a.id}`;
    return h('option', { value: v, selected: route.assignee === v }, a.display_name);
  }));
  const parts = [field('Assignee', assignee)];
  if (route.view === 'list') {
    const status = h('select', {
      onChange: (e) => ctx.navigate(urlFor({ status: e.target.value })),
    },
    h('option', { value: '' }, 'Any status'),
    STATUSES.map((s) => h('option', { value: s, selected: route.status === s }, STATUS_LABELS[s])));
    parts.push(field('Status', status));
  }
  const archived = h('input', {
    type: 'checkbox', checked: route.archived,
    onChange: (e) => ctx.navigate(urlFor({ archived: e.target.checked })),
  });
  parts.push(h('label', { class: 'check' }, archived, ' Show archived'));
  return h('div', { class: 'filters' }, parts);
}

async function loadPage(ctx, key, fetchPage) {
  // The cache this request belongs to: a sign-in, sign-out or invalidation
  // replaces the map, so a late answer never lands in the new one.
  const cache = ctx.state.listCache;
  let entry = cache.get(key);
  if (!entry) {
    const rows = await fetchPage(null);
    entry = { rows, next: rows.at(-1)?.next_cursor || null };
    cache.set(key, entry);
  }
  return entry;
}

function taskRow(ctx, project, route, t) {
  const url = projectUrl(project.id, { ...route, task: t.id });
  return h('li', { class: `task-row${route.task === t.id ? ' selected' : ''}` },
    h('a', {
      href: url,
      onClick: (e) => { e.preventDefault(); ctx.navigate(url); },
    },
    h('span', { class: 'task-title' }, t.title),
    h('span', { class: `status status-${t.status}` }, STATUS_LABELS[t.status]),
    h('span', { class: 'task-meta' },
      [t.assignee_name, fmtRange(t.start_on, t.due_on), t.follow_up_on ? `Follow up ${fmtDate(t.follow_up_on)}` : '']
        .filter(Boolean).join(' · ')),
    t.archived ? h('span', { class: 'badge' }, 'Archived') : null));
}

function listEntry(ctx, route, filters) {
  const key = `list|${route.projectId}|${JSON.stringify(filters)}`;
  return loadPage(ctx, key, (after) => ctx.api.listTasks(route.projectId, filters, { after }));
}

function listSection(ctx, route, project, filters, entry) {
  const list = h('ul', { class: 'task-list', 'aria-label': 'Tasks' });
  const more = h('div', { class: 'more' });

  function paint() {
    list.replaceChildren();
    if (!entry.rows.length) {
      list.append(h('li', { class: 'empty' },
        Object.keys(filters).length ? 'Nothing matches these filters.' : 'No tasks yet. Add first task.'));
    }
    for (const t of entry.rows) list.append(taskRow(ctx, project, route, t));
    more.replaceChildren(...(entry.next ? moreControl(ctx, 'Show more', async () => {
      const stillCurrent = ctx.current();
      const page = await ctx.api.listTasks(project.id, filters, { after: entry.next });
      if (!stillCurrent()) return;
      entry.rows = entry.rows.concat(page);
      entry.next = page.at(-1)?.next_cursor || null;
      paint();
    }) : []));
  }
  paint();
  return h('div', null, list, more);
}

/** Board columns: all three on a wide screen, only the visible one on a phone. */
function boardColumns(ctx, route, filters, phone) {
  return Promise.all(STATUSES.map(async (status) => {
    const f = { ...filters, status };
    if (phone && status !== route.column) return { status, entry: null, filters: f };
    const key = `board|${route.projectId}|${JSON.stringify(f)}`;
    const entry = await loadPage(ctx, key, (after) => ctx.api.listTasks(route.projectId, f, { after }));
    return { status, entry, filters: f };
  }));
}

function boardSection(ctx, route, project, columns, urlFor) {
  const picker = h('select', {
    'aria-label': 'Board column',
    onChange: (e) => ctx.navigate(urlFor({ column: e.target.value }), { keepScroll: true }),
  }, columns.map((c) => h('option', { value: c.status, selected: route.column === c.status },
    c.entry ? `${STATUS_LABELS[c.status]} ${c.entry.rows.length}${c.entry.next ? '+' : ''}` : STATUS_LABELS[c.status])));
  const nextIdx = (STATUSES.indexOf(route.column) + 1) % STATUSES.length;
  const nextBtn = h('button', {
    type: 'button',
    onClick: () => ctx.navigate(urlFor({ column: STATUSES[nextIdx] }), { keepScroll: true }),
  }, 'Next column');

  // A failed move's explanation survives the reload that follows it
  // (review P1-6), and is shown once.
  const flash = ctx.state.flash && ctx.state.flash.kind === 'board-move' && ctx.state.flash.projectId === project.id
    ? ctx.state.flash : null;
  if (flash) ctx.state.flash = null;
  const msg = h('p', { class: 'error board-message', role: 'alert' }, flash ? flash.text : '');
  const board = h('div', { class: 'board', 'data-col': route.column },
    columns.map((c) => column(ctx, route, project, c, flash)));
  return h('div', null, h('div', { class: 'board-picker' }, picker, nextBtn), msg, board);
}

function column(ctx, route, project, c, flash) {
  const list = h('ul', { class: 'cards' });
  const more = h('div', { class: 'more' });
  function paint() {
    list.replaceChildren();
    if (!c.entry) return; // not on screen (phone): fetched when chosen
    if (!c.entry.rows.length) list.append(h('li', { class: 'empty' }, 'Nothing here.'));
    for (const t of c.entry.rows) list.append(card(t));
    more.replaceChildren(...(c.entry.next ? moreControl(ctx, 'Show more', async () => {
      const stillCurrent = ctx.current();
      const page = await ctx.api.listTasks(project.id, c.filters, { after: c.entry.next });
      if (!stillCurrent()) return;
      c.entry.rows = c.entry.rows.concat(page);
      c.entry.next = page.at(-1)?.next_cursor || null;
      paint();
    }) : []));
  }
  function card(t) {
    const url = projectUrl(project.id, { ...route, task: t.id });
    const failed = flash && flash.taskId === t.id;
    const move = h('select', {
      'aria-label': `Move ${t.title}`,
      disabled: t.archived,
      onChange: async (e) => {
        const to = e.target.value;
        if (!to || to === t.status) return;
        move.disabled = true;
        try {
          await ctx.api.setTaskStatus(t.id, t.version, to);
          ctx.state.flash = null;
        } catch (err) {
          ctx.state.flash = {
            kind: 'board-move',
            projectId: project.id,
            taskId: t.id,
            text: err.kind === 'conflict'
              ? `Could not move “${t.title}”: someone else changed that task first. The board has been reloaded; check the card and move it again.`
              : `Could not move “${t.title}”: ${err.message}`,
          };
        }
        ctx.invalidate();
        await ctx.render();
      },
    },
    h('option', { value: '' }, 'Move to…'),
    STATUSES.filter((s) => s !== t.status).map((s) => h('option', { value: s }, STATUS_LABELS[s])));
    return h('li', { class: `card${failed ? ' move-failed' : ''}` },
      h('span', { class: 'task-title' }, t.title),
      failed ? h('span', { class: 'badge' }, 'Move failed') : null,
      h('span', { class: 'task-meta' }, [t.assignee_name, fmtRange(t.start_on, t.due_on)].filter(Boolean).join(' · ')),
      h('div', { class: 'card-actions' },
        h('a', { href: url, onClick: (e) => { e.preventDefault(); ctx.navigate(url); } }, 'Open'),
        move));
  }
  paint();
  return h('section', { class: 'col', 'data-status': c.status, 'aria-label': STATUS_LABELS[c.status] },
    h('h2', null, STATUS_LABELS[c.status]), list, more);
}
