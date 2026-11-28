// Task detail: edit and save, conflicts, updates thread, archive (owners),
// and the new-task form. Failed saves keep what the person typed.

import { h, field } from '../dom.js';
import { projectUrl } from '../router.js';
import {
  STATUS_LABELS, STATUSES, OPS_KINDS, assigneeValue, assigneeFromValue, fmtDate,
} from '../format.js';

const FIELDS = ['title', 'description', 'assignee', 'status', 'start_on', 'due_on', 'follow_up_on'];

function valuesOf(task) {
  return {
    title: task.title || '',
    description: task.description || '',
    assignee: assigneeValue(task.assignee_kind, task.assignee_id),
    status: task.status || 'ready',
    start_on: task.start_on || '',
    due_on: task.due_on || '',
    follow_up_on: task.follow_up_on || '',
  };
}

/** Changes from `base` to `draft`, in the shape update_task expects. */
export function diffChanges(base, draft, { ops }) {
  const changes = {};
  for (const k of FIELDS) {
    if (k === 'follow_up_on' && !ops) continue;
    if ((draft[k] || '') === (base[k] || '')) continue;
    if (k === 'assignee') changes.assignee = assigneeFromValue(draft.assignee);
    else if (['start_on', 'due_on', 'follow_up_on'].includes(k)) changes[k] = draft[k] || null;
    else changes[k] = draft[k];
  }
  return changes;
}

export async function taskPanel(ctx, { route, project, ws, assignees, backUrl }) {
  const ops = ws.kind === 'stay_eden_ops';
  const isOwner = ws.role === 'owner';
  const isNew = route.task === 'new';
  let task = isNew ? null : await ctx.api.getTask(route.task);
  if (task && task.project_id !== project.id) {
    // A task from another project: show it under its own project.
    await ctx.navigate(projectUrl(task.project_id, { task: task.id }), { replace: true });
    return h('div');
  }
  let base = task ? valuesOf(task) : valuesOf({ status: 'ready' });

  const back = h('a', {
    class: 'back', href: backUrl,
    onClick: (e) => { e.preventDefault(); ctx.navigate(backUrl); },
  }, `‹ ${project.name}`);

  // Controls
  const title = h('input', { type: 'text', required: true, maxlength: 200, value: base.title, autocomplete: 'off' });
  const kind = ops && isNew
    ? h('select', null, Object.entries(OPS_KINDS).map(([k, label]) => h('option', { value: k }, label)))
    : null;
  const assignee = assigneeSelect(assignees, task, base.assignee, isOwner);
  const status = h('select', null, STATUSES.map((s) => h('option', { value: s, selected: base.status === s }, STATUS_LABELS[s])));
  const start = h('input', { type: 'date', value: base.start_on });
  const due = h('input', { type: 'date', value: base.due_on });
  const followUp = ops ? h('input', { type: 'date', value: base.follow_up_on }) : null;
  const description = h('textarea', { rows: 4, maxlength: 8000, value: base.description });
  const msg = h('div', { class: 'message', role: 'alert' });
  const readOnly = Boolean(task?.archived) || Boolean(project.archived);
  for (const c of [title, assignee, status, start, due, followUp, description]) {
    if (c && readOnly) c.disabled = true;
  }

  // Inline "add a recorded name" for owners.
  const newContact = isOwner ? contactAdder(ctx, ws, assignee) : null;
  assignee.addEventListener('change', () => {
    if (newContact) newContact.hidden = assignee.value !== '__new';
  });

  const draft = () => ({
    title: title.value.trim(),
    description: description.value.trim(),
    assignee: assignee.value === '__new' ? base.assignee : assignee.value,
    status: status.value,
    start_on: start.value,
    due_on: due.value,
    follow_up_on: followUp ? followUp.value : '',
  });

  async function save(e) {
    e?.preventDefault();
    msg.replaceChildren();
    const d = draft();
    if (!d.title) {
      msg.append(h('p', { class: 'error' }, 'Give it a title.'));
      title.focus();
      return;
    }
    if (d.start_on && d.due_on && d.start_on > d.due_on) {
      msg.append(h('p', { class: 'error' }, 'Start must be on or before the due date.'));
      return;
    }
    try {
      if (isNew) {
        const created = await ctx.api.createTask(project.id, {
          kind: ops ? kind.value : 'task',
          title: d.title,
          description: d.description,
          assignee: assigneeFromValue(d.assignee),
          status: d.status,
          start_on: d.start_on,
          due_on: d.due_on,
          follow_up_on: d.follow_up_on,
        });
        ctx.invalidate();
        await ctx.navigate(projectUrl(project.id, { ...route, task: created.id }), { replace: true });
        return;
      }
      const changes = diffChanges(base, d, { ops });
      if (!Object.keys(changes).length) {
        msg.append(h('p', { class: 'ok' }, 'No changes to save.'));
        return;
      }
      await ctx.api.updateTask(task.id, task.version, changes);
      ctx.invalidate();
      await ctx.render();
    } catch (err) {
      if (err.kind === 'conflict') {
        showConflict(d);
      } else {
        // Keep the person's input; say what went wrong.
        msg.append(h('p', { class: 'error' }, err.message));
      }
    }
  }

  function showConflict(mine) {
    const mineChanges = diffChanges(base, mine, { ops });
    msg.replaceChildren(h('div', { class: 'conflict' },
      h('p', null, 'Someone else saved this task while you were editing. Your changes are not saved yet.'),
      h('button', {
        type: 'button',
        onClick: async () => { ctx.invalidate(); await ctx.render(); },
      }, 'Reload (discard mine)'),
      h('button', {
        type: 'button',
        class: 'primary',
        onClick: async () => {
          try {
            const fresh = await ctx.api.getTask(task.id);
            await ctx.api.updateTask(fresh.id, fresh.version, mineChanges);
            ctx.invalidate();
            await ctx.render();
          } catch (err) {
            if (err.kind === 'conflict') {
              msg.replaceChildren(h('p', { class: 'error' }, 'It changed again. Reload and try once more.'));
            } else {
              msg.replaceChildren(h('p', { class: 'error' }, err.message));
            }
          }
        },
      }, 'Reapply my changes')));
  }

  const form = h('form', { class: 'task-form', onSubmit: save },
    field(ops ? 'Item' : 'Task', title),
    kind ? field('Type', kind) : null,
    field('Assignee', assignee),
    newContact,
    field('Status', status),
    h('div', { class: 'two' }, field('Start', start), field('Due', due)),
    followUp ? field('Follow up', followUp) : null,
    field('Description', description),
    msg,
    readOnly ? null : h('button', { class: 'primary', type: 'submit' }, isNew ? (ops ? 'Add item' : 'Add task') : 'Save'));

  const parts = [back, h('h2', null, isNew ? (ops ? 'New item' : 'New task') : task.title)];
  if (task) {
    parts.push(h('p', { class: 'muted' },
      [ops ? OPS_KINDS[task.kind] : null, task.created_by_name ? `Added by ${task.created_by_name}` : null,
        task.archived ? 'Archived' : null].filter(Boolean).join(' · ')));
  }
  parts.push(form);
  if (task && isOwner && !project.archived) {
    parts.push(h('button', {
      type: 'button',
      onClick: async () => {
        try {
          await ctx.api.setTaskArchived(task.id, task.version, !task.archived);
          ctx.invalidate();
          await ctx.render();
        } catch (err) {
          msg.replaceChildren(h('p', { class: 'error' }, err.kind === 'conflict'
            ? 'Someone else changed this task. Reload and try again.' : err.message));
        }
      },
    }, task.archived ? 'Restore' : 'Archive'));
  }
  if (task) parts.push(updatesThread(ctx, task, readOnly));
  return h('div', { class: 'task-panel' }, parts);
}

function assigneeSelect(assignees, task, current, isOwner) {
  const options = [h('option', { value: '' }, 'Unassigned')];
  const values = new Set();
  const members = assignees.filter((a) => a.assignee_kind === 'member');
  const contacts = assignees.filter((a) => a.assignee_kind === 'contact');
  if (members.length) {
    options.push(h('optgroup', { label: 'Members' }, members.map((a) => {
      values.add(`member:${a.id}`);
      return h('option', { value: `member:${a.id}`, selected: current === `member:${a.id}` }, a.display_name);
    })));
  }
  if (contacts.length) {
    options.push(h('optgroup', { label: 'People and companies' }, contacts.map((a) => {
      values.add(`contact:${a.id}`);
      return h('option', { value: `contact:${a.id}`, selected: current === `contact:${a.id}` },
        `${a.display_name}${a.contact_kind === 'vendor' ? ' (company)' : ''}`);
    })));
  }
  if (current && !values.has(current) && task) {
    options.push(h('option', { value: current, selected: true }, task.assignee_name || 'Former assignee'));
  }
  if (isOwner) options.push(h('option', { value: '__new' }, '+ Add a person or company…'));
  return h('select', null, options);
}

function contactAdder(ctx, ws, select) {
  const name = h('input', { type: 'text', maxlength: 120, autocomplete: 'off' });
  const kind = h('select', null, h('option', { value: 'vendor' }, 'Company'), h('option', { value: 'person' }, 'Person'));
  const msg = h('p', { class: 'error', role: 'alert' });
  const box = h('div', { class: 'panel inline' },
    field('Name', name),
    field('Kind', kind),
    msg,
    h('button', {
      type: 'button',
      onClick: async () => {
        msg.textContent = '';
        if (!name.value.trim()) {
          msg.textContent = 'Type a name.';
          return;
        }
        try {
          const c = await ctx.api.createContact(ws.workspace_id, name.value.trim(), kind.value);
          const opt = h('option', { value: `contact:${c.id}`, selected: true }, name.value.trim());
          select.insertBefore(opt, select.lastChild);
          select.value = `contact:${c.id}`;
          box.hidden = true;
        } catch (err) {
          msg.textContent = err.message;
        }
      },
    }, 'Add name'));
  box.hidden = true;
  return box;
}

function updatesThread(ctx, task, readOnly) {
  const list = h('ol', { class: 'updates', 'aria-label': 'Updates' });
  let next = task.updates_next;
  const more = h('div');
  const paint = (items) => {
    for (const u of items) {
      list.append(h('li', null,
        h('p', { class: 'muted' }, `${u.author_name || 'Former member'} · ${fmtDate(String(u.created_at).slice(0, 10))}`),
        h('p', { class: 'body' }, u.body)));
    }
    more.replaceChildren(next ? h('button', {
      type: 'button',
      onClick: async () => {
        const page = await ctx.api.listUpdates(task.id, next);
        next = page.at(-1)?.next_cursor || null;
        paint(page);
      },
    }, 'Show more updates') : '');
  };
  if (!task.updates.length) list.append(h('li', { class: 'empty' }, 'No updates yet.'));
  paint(task.updates);

  const body = h('textarea', { rows: 2, maxlength: 4000 });
  const msg = h('p', { class: 'error', role: 'alert' });
  const form = readOnly ? null : h('form', {
    onSubmit: async (e) => {
      e.preventDefault();
      msg.textContent = '';
      if (!body.value.trim()) return;
      try {
        await ctx.api.addUpdate(task.id, body.value.trim());
        ctx.invalidate();
        await ctx.render();
      } catch (err) {
        msg.textContent = err.message;
      }
    },
  }, field('Add update', body), msg, h('button', { type: 'submit' }, 'Post update'));
  return h('section', { class: 'thread' }, h('h3', null, 'Updates'), list, more, form);
}
