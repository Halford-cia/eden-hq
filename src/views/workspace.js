// Workspace home: the project (or property) list, and New project for owners.

import { h, field } from '../dom.js';
import { topBar } from './entry.js';

export async function workspaceView(ctx, route) {
  const ws = ctx.workspace(route.workspaceId);
  const isOwner = ws.role === 'owner';
  const ops = ws.kind === 'stay_eden_ops';
  const noun = ops ? 'property' : 'project';
  const Noun = ops ? 'Property' : 'Project';

  let rows = await ctx.api.listProjects(ws.workspace_id, { includeArchived: route.archived });
  const list = h('ul', { class: 'cards', 'aria-label': ops ? 'Properties' : 'Projects' });
  const more = h('div');

  function renderRows(append) {
    if (!append) list.replaceChildren();
    if (!rows.length && !append) {
      list.append(h('li', { class: 'empty' }, isOwner ? `No ${noun} yet. Add the first one below.` : `No ${noun} yet.`));
    }
    for (const p of append || rows) {
      list.append(h('li', null, h('a', {
        class: 'card-link',
        href: `/p/${p.id}`,
        onClick: (e) => { e.preventDefault(); ctx.navigate(`/p/${p.id}`); },
      },
      h('span', { class: 'card-title' }, p.name),
      h('span', { class: 'muted' }, `${p.open_count} open`),
      p.archived ? h('span', { class: 'badge' }, 'Archived') : null)));
    }
    const next = (append || rows).at(-1)?.next_cursor;
    more.replaceChildren(next ? h('button', {
      type: 'button',
      onClick: async () => {
        const page = await ctx.api.listProjects(ws.workspace_id, { includeArchived: route.archived, after: next });
        rows = rows.concat(page);
        renderRows(page);
      },
    }, 'Show more') : '');
  }
  renderRows();

  let form = null;
  if (isOwner) {
    const name = h('input', { type: 'text', required: true, maxlength: 120, autocomplete: 'off' });
    const desc = h('textarea', { rows: 2, maxlength: 4000 });
    const msg = h('p', { class: 'error', role: 'alert' });
    form = h('form', {
      class: 'panel',
      onSubmit: async (e) => {
        e.preventDefault();
        msg.textContent = '';
        if (!name.value.trim()) {
          msg.textContent = `Give the ${noun} a name.`;
          return;
        }
        try {
          const p = await ctx.api.createProject(ws.workspace_id, name.value.trim(), desc.value.trim());
          ctx.invalidate();
          await ctx.navigate(`/p/${p.id}`);
        } catch (err) {
          msg.textContent = err.message;
        }
      },
    },
    h('h2', null, `New ${noun}`),
    field(`${Noun} name`, name),
    field('Description (optional)', desc),
    msg,
    h('button', { class: 'primary', type: 'submit' }, `Create ${noun}`));
  }

  const archivedToggle = h('a', {
    href: `/w/${ws.workspace_id}${route.archived ? '' : '?archived=1'}`,
    onClick: (e) => { e.preventDefault(); ctx.navigate(`/w/${ws.workspace_id}${route.archived ? '' : '?archived=1'}`); },
  }, route.archived ? 'Hide archived' : 'Show archived');

  return h('main', { class: 'screen' },
    topBar(ctx, ws.workspace_id),
    h('div', { class: 'title-row' }, h('h1', null, ops ? 'Properties' : 'Projects'), archivedToggle),
    list, more, form);
}
