// Eden HQ app shell: routing, session, workspace context and data clearing.

import { parseRoute } from './router.js';
import { signInView, noAccessView, pickerView, unavailableView, errorView, loadingView } from './views/entry.js';
import { workspaceView } from './views/workspace.js';
import { projectView } from './views/project.js';

export function createApp({ root, api, auth, win = window, download }) {
  const state = {
    workspaces: null, // my_workspaces() result for the signed-in account
    userKey: null,
    listCache: new Map(), // project list/board pages, reused when returning from a task
    scroll: new Map(),
  };
  let seq = 0;

  function clearData() {
    state.workspaces = null;
    state.listCache.clear();
    state.scroll.clear();
  }

  function currentUrl() {
    return `${win.location.pathname}${win.location.search}`;
  }

  function navigate(url, { replace = false, keepScroll = false } = {}) {
    if (!keepScroll) state.scroll.set(currentUrl(), win.scrollY || 0);
    if (replace) win.history.replaceState({}, '', url);
    else win.history.pushState({}, '', url);
    return render();
  }

  function invalidate() {
    state.listCache.clear();
  }

  const ctx = {
    api, auth, state, navigate, invalidate, win,
    download: download || defaultDownload(win),
    render: () => render(),
    workspace(id) {
      return (state.workspaces || []).find((w) => w.workspace_id === id) || null;
    },
    async signOut() {
      clearData();
      await auth.signOut();
      win.history.replaceState({}, '', '/');
      return render();
    },
    switchWorkspace(id) {
      // Workspace change clears loaded project data.
      state.listCache.clear();
      state.scroll.clear();
      return navigate(`/w/${id}`);
    },
  };

  function show(token, node) {
    if (token !== seq) return false;
    root.replaceChildren(node);
    return true;
  }

  async function render() {
    seq += 1;
    const token = seq;
    const route = parseRoute(win.location.pathname, win.location.search);
    show(token, loadingView());

    const session = await auth.getSession();
    if (route.name === 'callback') {
      win.history.replaceState({}, '', '/');
      return render();
    }
    if (!session) {
      clearData();
      return show(token, signInView(ctx));
    }
    const userKey = session.user?.id || 'signed-in';
    if (state.userKey !== userKey) {
      clearData();
      state.userKey = userKey;
    }
    if (!state.workspaces) {
      try {
        state.workspaces = await api.myWorkspaces();
      } catch (e) {
        if (e.kind === 'signed_out') return show(token, signInView(ctx));
        return show(token, errorView(ctx, e));
      }
    }
    if (!state.workspaces.length) return show(token, noAccessView(ctx));

    let node;
    try {
      if (route.name === 'home') {
        if (state.workspaces.length === 1) {
          win.history.replaceState({}, '', `/w/${state.workspaces[0].workspace_id}`);
          return render();
        }
        node = pickerView(ctx);
      } else if (route.name === 'workspace') {
        if (!ctx.workspace(route.workspaceId)) node = unavailableView(ctx);
        else node = await workspaceView(ctx, route);
      } else if (route.name === 'project') {
        node = await projectView(ctx, route);
      } else if (route.name === 'task') {
        const t = await api.getTask(route.taskId);
        win.history.replaceState({}, '', `/p/${t.project_id}?task=${t.id}`);
        return render();
      } else {
        node = unavailableView(ctx);
      }
    } catch (e) {
      if (e.kind === 'unavailable') node = unavailableView(ctx);
      else if (e.kind === 'signed_out') node = signInView(ctx);
      else node = errorView(ctx, e);
    }
    if (show(token, node)) {
      const y = state.scroll.get(currentUrl());
      if (y != null) win.scrollTo?.(0, y);
    }
    return node;
  }

  win.addEventListener('popstate', () => render());
  auth.onChange?.((event) => {
    if (event === 'SIGNED_OUT' || event === 'USER_UPDATED') {
      clearData();
      render();
    } else if (event === 'SIGNED_IN' && !state.workspaces) {
      render();
    }
  });

  return { render, ctx, state };
}

function defaultDownload(win) {
  return (filename, text) => {
    const blob = new win.Blob([text], { type: 'text/csv;charset=utf-8' });
    const url = win.URL.createObjectURL(blob);
    const a = win.document.createElement('a');
    a.href = url;
    a.download = filename;
    win.document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => win.URL.revokeObjectURL(url), 0);
  };
}
