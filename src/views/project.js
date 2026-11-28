// Project (or property) screen: List and Board views of the same tasks, with
// task detail beside the view on desktop and full screen on a phone.

import { h, field } from '../dom.js';
import { ApiError } from '../api.js';
import { projectUrl, filtersFromRoute } from '../router.js';
import { STATUS_LABELS, STATUSES, fmtRange, fmtDate } from '../format.js';
import { operationalExport } from '../csv.js';
import { topBar } from './entry.js';
import { taskPanel } from './task.js';

export async function projectView(ctx, route) {
  const project = await ctx.api.getProject(route.projectId);
  const ws = ctx.workspace(project.workspace_id);
  if (!ws) throw new ApiError('unavailable', 'This is not available.');
  const ops = ws.kind === 'stay_eden_ops';
  const isOwner = ws.role === 'owner';
  const filters = filtersFromRoute(route);
  const urlFor = (extra) => projectUrl(project.id, { ...route, task: null, ...extra });

  const [assignees, work] = await Promise.all([
    ctx.api.listAssignees(ws.workspace_id),
    route.view === 'board'
      ? boardSection(ctx, route, project, filters, urlFor)
      : listSection(ctx, route, project, filters),
  ]);
  const panel = route.task
    ? await taskPanel(ctx, { route, project, ws, assignees, backUrl: urlFor({}) })
    : null;

  const tabs = h('nav', { class: 'tabs', 'aria-label': 'View' },
    tab(ctx, 'List', route.view === 'list', urlFor({ view: 'list' })),
    tab(ctx, 'Board', route.view === 'board', urlFor({ view: 'board' })));

  const exportMsg = h('span', { class: 'muted', role: 'status' });
  const exportBtn = h('button', {
    type: 'button',
    onClick: async () => {
      exportMsg.textContent = 'Preparing export…';
      try {
        const snapshot = await ctx.api.exportProject(project.id);
        const files = operationalExport(snapshot);
        for (const f of files) ctx.download(f.filename, f.text);
        exportMsg.textContent = `Exported ${files.length} files.`;
      } catch (e) {
        exportMsg.textContent = e.message;
      }
    },
  }, 'Export');

  const addBtn = project.archived ? null : h('a', {
    class: 'button primary',
    href: projectUrl(project.id, { ...route, task: 'new' }),
    onClick: (e) => { e.preventDefault(); ctx.navigate(projectUrl(project.id, { ...route, task: 'new' })); },
  }, ops ? '+ Item' : '+ Task');

  const filterBar = filterControls(ctx, route, assignees, urlFor);

  return h('main', { class: `screen project${panel ? ' has-detail' : ''}` },
    topBar(ctx, ws.workspace_id),
    h('div', { class: 'title-row' },
      h('a', {
        class: 'back', href: `/w/${ws.workspace_id}`,
        onClick: (e) => { e.preventDefault(); ctx.navigate(`/w/${ws.workspace_id}`); },
      }, ops ? '‹ Properties' : '‹ Projects'),
      h('h1', null, project.name, project.archived ? h('span', { class: 'badge' }, 'Archived') : null)),
    h('div', { class: 'layout' },
      h('section', { class: 'work', 'aria-label': `${project.name} tasks` },
        h('div', { class: 'toolbar' }, tabs, addBtn, exportBtn, exportMsg),
        filterBar,
        work),
      panel ? h('aside', { class: 'detail', 'aria-label': 'Task detail' }, panel) : null));
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

async function listSection(ctx, route, project, filters) {
  const key = `list|${project.id}|${JSON.stringify(filters)}`;
  const entry = await loadPage(ctx, key, (after) => ctx.api.listTasks(project.id, filters, { after }));
  const list = h('ul', { class: 'task-list', 'aria-label': 'Tasks' });
  const more = h('div', { class: 'more' });

  function paint() {
    list.replaceChildren();
    if (!entry.rows.length) {
      list.append(h('li', { class: 'empty' },
        Object.keys(filters).length ? 'Nothing matches these filters.' : 'No tasks yet. Add first task.'));
    }
    for (const t of entry.rows) list.append(taskRow(ctx, project, route, t));
    more.replaceChildren(entry.next ? h('button', {
      type: 'button',
      onClick: async () => {
        const page = await ctx.api.listTasks(project.id, filters, { after: entry.next });
        entry.rows = entry.rows.concat(page);
        entry.next = page.at(-1)?.next_cursor || null;
        paint();
      },
    }, 'Show more') : '');
  }
  paint();
  return h('div', null, list, more);
}

async function boardSection(ctx, route, project, filters, urlFor) {
  const columns = await Promise.all(STATUSES.map(async (status) => {
    const f = { ...filters, status };
    const key = `board|${project.id}|${JSON.stringify(f)}`;
    const entry = await loadPage(ctx, key, (after) => ctx.api.listTasks(project.id, f, { after }));
    return { status, entry, filters: f };
  }));

  const picker = h('select', {
    'aria-label': 'Board column',
    onChange: (e) => ctx.navigate(urlFor({ column: e.target.value }), { keepScroll: true }),
  }, columns.map((c) => h('option', { value: c.status, selected: route.column === c.status },
    `${STATUS_LABELS[c.status]} ${c.entry.rows.length}${c.entry.next ? '+' : ''}`)));
  const nextIdx = (STATUSES.indexOf(route.column) + 1) % STATUSES.length;
  const nextBtn = h('button', {
    type: 'button',
    onClick: () => ctx.navigate(urlFor({ column: STATUSES[nextIdx] }), { keepScroll: true }),
  }, 'Next column');

  const msg = h('p', { class: 'error', role: 'alert' });
  const board = h('div', { class: 'board', 'data-col': route.column },
    columns.map((c) => column(ctx, route, project, c, msg)));
  return h('div', null, h('div', { class: 'board-picker' }, picker, nextBtn), msg, board);
}

function column(ctx, route, project, c, msg) {
  const list = h('ul', { class: 'cards' });
  const more = h('div', { class: 'more' });
  function paint() {
    list.replaceChildren();
    if (!c.entry.rows.length) list.append(h('li', { class: 'empty' }, 'Nothing here.'));
    for (const t of c.entry.rows) list.append(card(t));
    more.replaceChildren(c.entry.next ? h('button', {
      type: 'button',
      onClick: async () => {
        const page = await ctx.api.listTasks(project.id, c.filters, { after: c.entry.next });
        c.entry.rows = c.entry.rows.concat(page);
        c.entry.next = page.at(-1)?.next_cursor || null;
        paint();
      },
    }, 'Show more') : '');
  }
  function card(t) {
    const url = projectUrl(project.id, { ...route, task: t.id });
    const move = h('select', {
      'aria-label': `Move ${t.title}`,
      disabled: t.archived,
      onChange: async (e) => {
        const to = e.target.value;
        if (!to || to === t.status) return;
        try {
          await ctx.api.setTaskStatus(t.id, t.version, to);
          msg.textContent = '';
        } catch (err) {
          msg.textContent = err.kind === 'conflict'
            ? 'Someone else changed that task. The board has been reloaded.'
            : err.message;
        }
        ctx.invalidate();
        await ctx.render();
      },
    },
    h('option', { value: '' }, 'Move to…'),
    STATUSES.filter((s) => s !== t.status).map((s) => h('option', { value: s }, STATUS_LABELS[s])));
    return h('li', { class: 'card' },
      h('span', { class: 'task-title' }, t.title),
      h('span', { class: 'task-meta' }, [t.assignee_name, fmtRange(t.start_on, t.due_on)].filter(Boolean).join(' · ')),
      h('div', { class: 'card-actions' },
        h('a', { href: url, onClick: (e) => { e.preventDefault(); ctx.navigate(url); } }, 'Open'),
        move));
  }
  paint();
  return h('section', { class: 'col', 'data-status': c.status, 'aria-label': STATUS_LABELS[c.status] },
    h('h2', null, STATUS_LABELS[c.status]), list, more);
}
