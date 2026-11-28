// Display helpers. Dates are calendar dates (YYYY-MM-DD) shown without
// shifting them through the viewer's time zone.

export const STATUS_LABELS = { ready: 'Ready', in_progress: 'In progress', done: 'Done' };
export const STATUSES = ['ready', 'in_progress', 'done'];
export const OPS_KINDS = { request: 'Request', maintenance: 'Maintenance', note: 'Note', follow_up: 'Follow-up' };

const monthDay = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

export function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return '';
  return monthDay.format(new Date(Date.UTC(y, m - 1, d)));
}

export function fmtRange(start, due) {
  if (start && due) return start === due ? fmtDate(start) : `${fmtDate(start)} – ${fmtDate(due)}`;
  if (due) return `Due ${fmtDate(due)}`;
  if (start) return `Starts ${fmtDate(start)}`;
  return '';
}

export function assigneeValue(kind, id) {
  if (!kind || !id) return '';
  return `${kind}:${id}`;
}

export function assigneeFromValue(value) {
  if (!value) return null;
  if (value.startsWith('member:')) return { user_id: value.slice(7) };
  if (value.startsWith('contact:')) return { contact_id: value.slice(8) };
  return null;
}
