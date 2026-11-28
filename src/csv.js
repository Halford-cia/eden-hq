// Operational CSV export (docs/SPEC.md, "CSV per project"): stable column
// order, UTF-8, ISO dates, RFC 4180 escaping, spreadsheet formulas
// neutralized in user-entered text. No money columns exist in Stage 1.

export const TASK_COLUMNS = [
  'task_id', 'project', 'kind', 'title', 'description', 'assigned_name', 'assignee_kind',
  'start_on', 'due_on', 'follow_up_on', 'status', 'predecessor_ids', 'archived',
];
export const UPDATE_COLUMNS = ['update_id', 'task_id', 'author', 'created_at', 'body'];

const FORMULA_START = /^[=+\-@\t\r]/;

export function neutralize(text) {
  if (text == null) return '';
  const s = String(text);
  return FORMULA_START.test(s) ? `'${s}` : s;
}

export function escapeCell(value) {
  const s = value == null ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(columns, rows) {
  const lines = [columns.map(escapeCell).join(',')];
  for (const r of rows) lines.push(columns.map((c) => escapeCell(r[c])).join(','));
  return `﻿${lines.join('\r\n')}\r\n`;
}

function isoTimestamp(v) {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

/** Build the two operational CSV files from export_project's snapshot. */
export function operationalExport(snapshot) {
  const projectName = snapshot.project?.name || '';
  const tasks = (snapshot.tasks || []).map((t) => ({
    task_id: t.id,
    project: neutralize(projectName),
    kind: t.kind,
    title: neutralize(t.title),
    description: neutralize(t.description),
    assigned_name: neutralize(t.assignee_name),
    assignee_kind: t.assignee_kind || '',
    start_on: t.start_on || '',
    due_on: t.due_on || '',
    follow_up_on: t.follow_up_on || '',
    status: t.status,
    predecessor_ids: (t.predecessor_ids || []).join(' '),
    archived: t.archived ? 'yes' : 'no',
  }));
  const updates = (snapshot.updates || []).map((u) => ({
    update_id: u.id,
    task_id: u.task_id,
    author: neutralize(u.author_name),
    created_at: isoTimestamp(u.created_at),
    body: neutralize(u.body),
  }));
  const slug = projectName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project';
  return [
    { filename: `${slug}-tasks.csv`, text: toCsv(TASK_COLUMNS, tasks) },
    { filename: `${slug}-updates.csv`, text: toCsv(UPDATE_COLUMNS, updates) },
  ];
}
