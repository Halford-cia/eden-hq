// Workspace home: the project (or property) list, and New project for owners.

import { h, field, inFlight, moreControl, lostAccess } from '../dom.js';
import { topBar } from './entry.js';

export async function workspaceView(ctx, route) {
  const ws = ctx.workspace(route.workspaceId);
  const isOwner = ws.role === 'owner';
  const ops = ws.kind === 'stay_eden_ops';
  const noun = ops ? 'property' : 'project';
  const Noun = ops ? 'Property' : 'Project';

  let rows = await ctx.api.listProjects(ws.workspace_id, { includeArchived: route.archived });
  const list = h('ul', { class: 'cards', 'aria-label': ops ? 'Properties' : 'Projects' });
  const more = h('div', { class: 'more' });

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
    more.replaceChildren(...(next ? moreControl(ctx, 'Show more', async () => {
      const stillCurrent = ctx.current();
      const page = await ctx.api.listProjects(ws.workspace_id, { includeArchived: route.archived, after: next });
      if (!stillCurrent()) return;
      rows = rows.concat(page);
      renderRows(page);
    }) : []));
  }
  renderRows();

  let form = null;
  if (isOwner) {
    const name = h('input', { type: 'text', required: true, maxlength: 120, autocomplete: 'off' });
    const desc = h('textarea', { rows: 2, maxlength: 4000 });
    const msg = h('p', { class: 'error', role: 'alert' });
    const submitBtn = h('button', { class: 'primary', type: 'submit' }, `Create ${noun}`);
    // One create per tap, however slow the answer (review P1-7).
    const create = inFlight(async () => {
      msg.textContent = '';
      if (!name.value.trim()) {
        msg.textContent = `Give the ${noun} a name.`;
        return;
      }
      let p;
      try {
        p = await ctx.api.createProject(ws.workspace_id, name.value.trim(), desc.value.trim());
      } catch (err) {
        if (await lostAccess(ctx, err)) return; // review round 3, P0
        msg.textContent = err.message;
        return;
      }
      ctx.invalidate();
      await ctx.navigate(`/p/${p.id}`);
    }, () => [submitBtn]);
    form = h('form', {
      class: 'panel',
      onSubmit: (e) => {
        e.preventDefault();
        create();
      },
    },
    h('h2', null, `New ${noun}`),
    field(`${Noun} name`, name),
    field('Description (optional)', desc),
    msg,
    submitBtn);
  }

  const archivedToggle = h('a', {
    href: `/w/${ws.workspace_id}${route.archived ? '' : '?archived=1'}`,
    onClick: (e) => { e.preventDefault(); ctx.navigate(`/w/${ws.workspace_id}${route.archived ? '' : '?archived=1'}`); },
  }, route.archived ? 'Hide archived' : 'Show archived');

  return h('main', { class: 'screen' },
    topBar(ctx, ws.workspace_id),
    h('div', { class: 'title-row' }, h('h1', null, ops ? 'Properties' : 'Projects'), archivedToggle),
    list, more, form,
    isOwner ? contactsSection(ctx, ws) : null);
}

/**
 * Owners correct or retire the recorded people and companies tasks are
 * assigned to (review round 2, P1-5). Renaming changes the name on every
 * task already assigned to it; archiving takes it out of the assignee
 * picker and keeps it on past tasks; Restore brings it back. Loaded only
 * when opened. The database refuses members whatever the screen shows.
 */
function contactsSection(ctx, ws) {
  const box = h('section', { class: 'panel contacts', 'aria-label': 'People and companies' });
  const toggle = h('button', { type: 'button', 'aria-expanded': 'false' }, 'People and companies');
  const body = h('div');
  body.hidden = true;
  let showArchived = false;

  const changed = async () => {
    // Every cached picker for this account is out of date now.
    ctx.invalidate();
    await load();
  };

  async function load() {
    const stillCurrent = ctx.current();
    const status = h('p', { class: 'muted', role: 'status' }, 'Loading…');
    body.replaceChildren(status);
    let active;
    let archived = [];
    try {
      active = await ctx.api.listContacts(ws.workspace_id, { archived: false });
      if (showArchived) archived = await ctx.api.listContacts(ws.workspace_id, { archived: true });
    } catch (e) {
      if (!stillCurrent()) return;
      if (e.kind === 'unavailable') {
        await ctx.accessLost();
        return;
      }
      body.replaceChildren(h('p', { class: 'error', role: 'alert' }, e.message),
        h('button', { type: 'button', onClick: () => load() }, 'Try again'));
      return;
    }
    if (!stillCurrent()) return;
    const activeList = pagedNames(ctx, ws, active, { archived: false, changed, className: 'active-names' });
    const parts = [
      h('p', { class: 'muted' }, 'Renaming changes the name on tasks already assigned to it. Archived names leave the assignee list and stay on past tasks.'),
      active.length ? activeList : h('p', { class: 'empty' }, 'No names recorded yet.'),
      h('button', {
        type: 'button',
        onClick: () => { showArchived = !showArchived; load(); },
      }, showArchived ? 'Hide archived names' : 'Show archived names'),
    ];
    if (showArchived) {
      const archivedList = pagedNames(ctx, ws, archived, { archived: true, changed, className: 'archived-names' });
      parts.push(h('h3', null, 'Archived'), archived.length ? archivedList : h('p', { class: 'empty' }, 'None.'));
    }
    body.replaceChildren(...parts);
  }

  toggle.addEventListener('click', () => {
    body.hidden = !body.hidden;
    toggle.setAttribute('aria-expanded', String(!body.hidden));
    if (!body.hidden) load();
  });
  box.append(toggle, body);
  return box;
}

function pagedNames(ctx, ws, first, { archived, changed, className }) {
  const list = h('ul', { class: `names ${className}` });
  const more = h('div', { class: 'more' });
  const add = (rows) => {
    for (const c of rows) list.append(nameRow(ctx, c, changed));
    const next = rows.at(-1)?.next_cursor;
    more.replaceChildren(...(next ? moreControl(ctx, 'Show more names', async () => {
      const stillCurrent = ctx.current();
      const page = await ctx.api.listContacts(ws.workspace_id, { archived, after: next });
      if (!stillCurrent()) return;
      add(page);
    }) : []));
  };
  add(first);
  return h('div', null, list, more);
}

function nameRow(ctx, c, changed) {
  const label = `${c.display_name}${c.kind === 'vendor' ? ' (company)' : ' (person)'}`;
  const msg = h('p', { class: 'error', role: 'alert' });
  const name = h('input', { type: 'text', required: true, maxlength: 120, autocomplete: 'off', value: c.display_name });
  const kind = h('select', null,
    h('option', { value: 'vendor', selected: c.kind === 'vendor' }, 'Company'),
    h('option', { value: 'person', selected: c.kind === 'person' }, 'Person'));
  const saveBtn = h('button', { class: 'primary', type: 'submit' }, 'Save name');
  const save = inFlight(async () => {
    msg.textContent = '';
    if (!name.value.trim()) {
      msg.textContent = 'Type a name.';
      return;
    }
    try {
      await ctx.api.updateContact(c.id, name.value.trim(), kind.value);
    } catch (e) {
      if (e.kind === 'unavailable') {
        await ctx.accessLost();
        return;
      }
      msg.textContent = e.message; // what was typed stays in the form
      return;
    }
    await changed();
  }, () => [saveBtn]);
  const form = h('form', {
    class: 'inline',
    onSubmit: (e) => { e.preventDefault(); save(); },
  }, field('Name', name), field('Kind', kind), msg, saveBtn,
  h('button', { type: 'button', onClick: () => { form.hidden = true; } }, 'Cancel'));
  form.hidden = true;

  const rowMsg = h('p', { class: 'error', role: 'alert' });
  const archiveBtn = h('button', { type: 'button' }, c.archived ? 'Restore' : 'Archive');
  const archive = inFlight(async () => {
    rowMsg.textContent = '';
    try {
      await ctx.api.setContactArchived(c.id, !c.archived);
    } catch (e) {
      if (e.kind === 'unavailable') {
        await ctx.accessLost();
        return;
      }
      rowMsg.textContent = e.message;
      return;
    }
    await changed();
  }, () => [archiveBtn]);
  archiveBtn.addEventListener('click', () => archive());

  const renameBtn = c.archived ? null : h('button', {
    type: 'button',
    onClick: () => { form.hidden = false; name.focus?.(); },
  }, 'Rename');
  return h('li', { class: 'name-row' },
    h('span', { class: 'card-title' }, label),
    h('div', { class: 'toolbar' }, renameBtn, archiveBtn),
    rowMsg,
    c.archived ? null : form);
}
