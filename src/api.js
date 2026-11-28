// The only path from the browser to Eden data: published eden_api
// operations through supabase-js, each authorized by the database.

export class ApiError extends Error {
  constructor(kind, message, cause) {
    super(message);
    this.kind = kind; // unavailable | conflict | forbidden | invalid | signed_out | network
    this.cause = cause;
  }
}

const FRIENDLY = {
  tasks_start_before_due: 'Start must be on or before the due date.',
  tasks_one_assignee: 'Choose one assignee.',
};

export function toApiError(error) {
  if (!error) return null;
  const code = error.code || '';
  const message = String(error.message || '');
  if (code === 'P0002') return new ApiError('unavailable', 'This is not available.', error);
  if (code === 'PT409') return new ApiError('conflict', 'Someone else saved this first.', error);
  if (code === '42501') {
    if (/schema|permission denied for/i.test(message)) {
      return new ApiError('signed_out', 'Please sign in again.', error);
    }
    return new ApiError('forbidden', 'Only workspace owners can do that.', error);
  }
  if (code === 'PGRST301' || code === 'PGRST302' || /JWT/.test(message)) {
    return new ApiError('signed_out', 'Please sign in again.', error);
  }
  if (['22023', '23514', '22007', '22008', '22P02', '23502', '23503'].includes(code)) {
    const constraint = Object.keys(FRIENDLY).find((c) => message.includes(c));
    if (constraint) return new ApiError('invalid', FRIENDLY[constraint], error);
    if (code === '23503') return new ApiError('invalid', 'That choice is not available in this workspace.', error);
    if (code === '22007' || code === '22008') return new ApiError('invalid', 'Check the dates.', error);
    if (code === '23514' || code === '23502') return new ApiError('invalid', 'Check the highlighted values.', error);
    return new ApiError('invalid', capitalize(message), error);
  }
  return new ApiError('network', 'Could not reach Eden HQ. Your changes are still here; try again.', error);
}

function capitalize(s) {
  return s ? s[0].toUpperCase() + s.slice(1) + (s.endsWith('.') ? '' : '.') : 'Something went wrong.';
}

export function createApi(client) {
  const api = client.schema('eden_api');

  async function call(name, args) {
    let res;
    try {
      res = await api.rpc(name, args);
    } catch (e) {
      throw new ApiError('network', 'Could not reach Eden HQ. Your changes are still here; try again.', e);
    }
    if (res.error) throw toApiError(res.error);
    return res.data || [];
  }
  const one = async (name, args) => {
    const rows = await call(name, args);
    if (!rows.length) throw new ApiError('unavailable', 'This is not available.');
    return rows[0];
  };

  return {
    myWorkspaces: () => call('my_workspaces', {}),
    listProjects: (workspaceId, { after = null, includeArchived = false, pageSize = 50 } = {}) =>
      call('list_projects', {
        p_workspace_id: workspaceId, p_include_archived: includeArchived, p_after: after, p_page_size: pageSize,
      }),
    getProject: (projectId) => one('get_project', { p_project_id: projectId }),
    createProject: (workspaceId, name, description) =>
      one('create_project', { p_workspace_id: workspaceId, p_name: name, p_description: description || null }),
    listAssignees: (workspaceId) => call('list_assignees', { p_workspace_id: workspaceId }),
    createContact: (workspaceId, displayName, kind) =>
      one('create_contact', { p_workspace_id: workspaceId, p_display_name: displayName, p_kind: kind }),
    listTasks: (projectId, filters = {}, { after = null, pageSize = 50 } = {}) =>
      call('list_tasks', { p_project_id: projectId, p_filters: filters, p_after: after, p_page_size: pageSize }),
    getTask: (taskId) => one('get_task', { p_task_id: taskId }),
    createTask: (projectId, f) => one('create_task', {
      p_project_id: projectId,
      p_kind: f.kind,
      p_title: f.title,
      p_description: f.description || null,
      p_assignee_user_id: f.assignee?.user_id || null,
      p_assignee_contact_id: f.assignee?.contact_id || null,
      p_start_on: f.start_on || null,
      p_due_on: f.due_on || null,
      p_follow_up_on: f.follow_up_on || null,
      p_status: f.status || 'ready',
    }),
    updateTask: (taskId, expectedVersion, changes) =>
      one('update_task', { p_task_id: taskId, p_expected_version: expectedVersion, p_changes: changes }),
    setTaskStatus: (taskId, expectedVersion, status) =>
      one('set_task_status', { p_task_id: taskId, p_expected_version: expectedVersion, p_status: status }),
    setTaskArchived: (taskId, expectedVersion, archived) =>
      one('set_task_archived', { p_task_id: taskId, p_expected_version: expectedVersion, p_archived: archived }),
    addUpdate: (taskId, body) => one('add_update', { p_task_id: taskId, p_body: body }),
    listUpdates: (taskId, after = null) => call('list_updates', { p_task_id: taskId, p_after: after }),
    exportProject: (projectId) => one('export_project', { p_project_id: projectId }),
  };
}

/** Google sign-in through Supabase Auth (PKCE). */
export function createAuth(client, { origin }) {
  return {
    async getSession() {
      const { data } = await client.auth.getSession();
      return data.session || null;
    },
    async signIn() {
      await client.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: `${origin}/auth/callback`, scopes: 'openid email profile' },
      });
    },
    /**
     * Ends the session everywhere. The Auth client keeps the session when its
     * global sign-out request fails, so on any failure the session is ended
     * on this device at least (review P1-12).
     * Returns { ok: true } or { ok: false, local: <session gone from this device> }.
     */
    async signOut() {
      let res;
      try {
        res = await client.auth.signOut();
      } catch (e) {
        res = { error: e };
      }
      if (!res?.error) return { ok: true };
      try {
        await client.auth.signOut({ scope: 'local' });
      } catch { /* reported below by the session check */ }
      let still = true;
      try {
        const { data } = await client.auth.getSession();
        still = Boolean(data?.session);
      } catch { /* assume the session survived */ }
      return { ok: false, local: !still };
    },
    onChange(fn) {
      const { data } = client.auth.onAuthStateChange((event, session) => fn(event, session));
      return () => data.subscription.unsubscribe();
    },
  };
}
