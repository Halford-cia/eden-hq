// URL <-> screen. Every screen re-checks access on the server when it loads,
// so a deep link or refresh never trusts what the browser remembers.

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

export function parseRoute(pathname, search = '') {
  const q = new URLSearchParams(search);
  const path = pathname.replace(/\/+$/, '') || '/';
  if (path === '/') return { name: 'home' };
  if (path === '/auth/callback') return { name: 'callback' };
  let m = path.match(new RegExp(`^/w/(${UUID})$`, 'i'));
  if (m) return { name: 'workspace', workspaceId: m[1].toLowerCase(), archived: q.get('archived') === '1' };
  m = path.match(new RegExp(`^/p/(${UUID})$`, 'i'));
  if (m) {
    const view = q.get('view') === 'board' ? 'board' : 'list';
    const task = q.get('task');
    return {
      name: 'project',
      projectId: m[1].toLowerCase(),
      view,
      status: ['ready', 'in_progress', 'done'].includes(q.get('status')) ? q.get('status') : '',
      assignee: q.get('assignee') || '',
      column: ['ready', 'in_progress', 'done'].includes(q.get('col')) ? q.get('col') : 'ready',
      archived: q.get('archived') === '1',
      task: task && new RegExp(`^${UUID}$`, 'i').test(task) ? task.toLowerCase() : (task === 'new' ? 'new' : null),
    };
  }
  m = path.match(new RegExp(`^/t/(${UUID})$`, 'i'));
  if (m) return { name: 'task', taskId: m[1].toLowerCase() };
  return { name: 'unavailable' };
}

export function projectUrl(projectId, opts = {}) {
  const q = new URLSearchParams();
  if (opts.view === 'board') q.set('view', 'board');
  if (opts.status) q.set('status', opts.status);
  if (opts.assignee) q.set('assignee', opts.assignee);
  if (opts.view === 'board' && opts.column && opts.column !== 'ready') q.set('col', opts.column);
  if (opts.archived) q.set('archived', '1');
  if (opts.task) q.set('task', opts.task);
  const s = q.toString();
  return `/p/${projectId}${s ? `?${s}` : ''}`;
}

/** Filters for list_tasks from the route's assignee/status parameters. */
export function filtersFromRoute(route) {
  const f = {};
  if (route.status) f.status = route.status;
  if (route.archived) f.include_archived = true;
  if (route.assignee === 'none') f.unassigned = true;
  else if (route.assignee.startsWith('member:')) f.assignee_user_id = route.assignee.slice(7);
  else if (route.assignee.startsWith('contact:')) f.assignee_contact_id = route.assignee.slice(8);
  return f;
}
