// Eden HQ app shell: routing, session, workspace context and data clearing.

import { parseRoute } from './router.js';
import {
  signInView, noAccessView, pickerView, unavailableView, errorView, loadingView, signOutFailedView,
} from './views/entry.js';
import { workspaceView } from './views/workspace.js';
import { projectView } from './views/project.js';

export function createApp({ root, api, auth, win = window, download }) {
  const state = {
    workspaces: null, // my_workspaces() result for the signed-in account
    userKey: null,
    // Bumped on every account change and sign-out. A result that arrives for
    // an earlier generation is dropped, never shown or cached (review P0-1).
    generation: 0,
    listCache: new Map(), // project list/board pages, reused when returning from a task
    visitingProject: null, // the project the last render showed; see render()
    metaCache: new Map(), // project metadata and assignees, same lifetime
    scroll: new Map(),
    notice: null, // shown on the sign-in screen
    signOutFailed: false, // the session survived a sign-out on this device
    flash: null, // a message that must survive the next render (board moves)
    // The screen's own answer to a phone/desktop breakpoint change, or null
    // (review round 2, P1-4): { node, fn }, used only while node is on screen.
    onBreakpoint: null,
  };
  let seq = 0;

  function clearData() {
    state.workspaces = null;
    // New maps, so a request still in flight cannot write into the new ones.
    state.listCache = new Map();
    state.metaCache = new Map();
    state.scroll.clear();
    state.flash = null;
  }

  /**
   * The signed-in account changed (or signed out): take the previous
   * account's screen down now, drop its data and anything still in flight.
   */
  function resetIdentity(userKey) {
    seq += 1;
    state.generation += 1;
    clearData();
    state.userKey = userKey;
    root.replaceChildren(loadingView());
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
    state.listCache = new Map();
    state.metaCache = new Map();
  }

  /**
   * The database refused this account something it could read before: a
   * roster change or a closed gate (review round 2, P0-1). Everything loaded
   * under the old access is dropped, memberships included, so nothing of it
   * can be painted again from memory; the next screen asks afresh.
   */
  function accessLost() {
    clearData();
  }

  // Matches the desktop breakpoint in styles.css; below it the board shows
  // (and fetches) one column at a time.
  const wide = win.matchMedia ? win.matchMedia('(min-width: 900px)') : null;

  const ctx = {
    api, auth, state, navigate, invalidate, win,
    download: download || defaultDownload(win),
    render: () => render(),
    isPhone: () => (wide ? !wide.matches : false),
    workspace(id) {
      return (state.workspaces || []).find((w) => w.workspace_id === id) || null;
    },
    /** A function that runs `fn` only while the account that asked is still signed in. */
    current() {
      const gen = state.generation;
      return () => gen === state.generation;
    },
    /**
     * For a result that leaves the page (a download): true only if the same
     * account that asked is still the one on screen AND the one the Auth
     * client holds now (review round 2, P0-2). Capture before the request.
     */
    deliveryGuard() {
      const gen = state.generation;
      const userKey = state.userKey;
      return async () => {
        if (gen !== state.generation || userKey === null || userKey !== state.userKey) return false;
        let session;
        try {
          session = await auth.getSession();
        } catch {
          return false;
        }
        return gen === state.generation && (session?.user?.id || null) === userKey;
      };
    },
    /** Call after the database answered `unavailable` for something on screen. */
    accessLost() {
      accessLost();
      return render();
    },
    /**
     * Register the screen's answer to crossing the breakpoint. It runs only
     * while `node` is on screen; nothing else is rebuilt, so forms keep what
     * was typed (review round 2, P1-4).
     */
    onBreakpoint(node, fn) {
      state.onBreakpoint = { node, fn };
    },
    async signOut() {
      // The screen and data go first, before the network is involved.
      resetIdentity(null);
      state.signOutFailed = true;
      let result;
      try {
        result = await auth.signOut();
      } catch {
        result = { ok: false, local: false };
      }
      win.history.replaceState({}, '', '/');
      if (result && result.ok === false && !result.local) {
        // The session is still on this device: show no data from it.
        seq += 1;
        root.replaceChildren(signOutFailedView(ctx));
        return null;
      }
      state.signOutFailed = false;
      state.notice = result && result.ok === false
        ? 'You are signed out on this device. Eden HQ could not reach the server to end your other sessions; sign out on your other devices too, or sign in and out again later.'
        : null;
      return render();
    },
    switchWorkspace(id) {
      // Workspace change clears loaded project data.
      invalidate();
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
    state.onBreakpoint = null;
    const route = parseRoute(win.location.pathname, win.location.search);
    // Cached task rows serve one visit to a project only: a task and Back, a
    // filter, a board column. Entering the project from anywhere else (the
    // Projects screen, a link, the browser's history) reads them again, so a
    // task finished elsewhere never shows as Ready (review round 3, P1-3).
    const visiting = route.name === 'project' ? route.projectId : null;
    if (visiting && visiting !== state.visitingProject) state.listCache = new Map();
    state.visitingProject = visiting;
    if (state.signOutFailed) return show(token, signOutFailedView(ctx));
    show(token, loadingView());

    const session = await auth.getSession();
    if (token !== seq) return null;
    if (route.name === 'callback') {
      win.history.replaceState({}, '', '/');
      return render();
    }
    if (!session) {
      if (state.userKey !== null || state.workspaces) {
        resetIdentity(null);
        return render();
      }
      return show(token, signInView(ctx));
    }
    const userKey = session.user?.id || 'signed-in';
    if (state.userKey !== userKey) {
      resetIdentity(userKey);
      state.notice = null;
      return render();
    }
    if (!state.workspaces) {
      const stillCurrent = ctx.current();
      let workspaces;
      try {
        workspaces = await api.myWorkspaces();
      } catch (e) {
        if (!stillCurrent() || token !== seq) return null;
        if (e.kind === 'signed_out') return show(token, signInView(ctx));
        return show(token, errorView(ctx, e));
      }
      if (!stillCurrent() || token !== seq) return null;
      state.workspaces = workspaces;
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
      if (token !== seq) return null;
      if (e.kind === 'unavailable') {
        // Whatever was loaded under earlier access goes now (review round 2, P0-1).
        accessLost();
        node = unavailableView(ctx);
      } else if (e.kind === 'signed_out') node = signInView(ctx);
      else node = errorView(ctx, e);
    }
    if (show(token, node)) {
      const y = state.scroll.get(currentUrl());
      if (y != null) win.scrollTo?.(0, y);
    }
    return node;
  }

  win.addEventListener('popstate', () => render());
  // Crossing the breakpoint (a phone rotating) changes only which board
  // columns are on screen: the screen updates those itself, and nothing is
  // re-rendered, so an unsaved form survives (review round 2, P1-4).
  wide?.addEventListener?.('change', () => {
    const hook = state.onBreakpoint;
    if (hook && hook.node.isConnected) hook.fn();
  });
  // Every Auth event names the session it is about. Another tab or the
  // account chooser can sign someone else in on this browser while a screen
  // is open, so the incoming account is compared with the rendered one.
  auth.onChange?.((event, session) => {
    const id = session?.user?.id || null;
    if (event === 'SIGNED_OUT' || !id) {
      state.signOutFailed = false;
      if (state.userKey !== null || state.workspaces) resetIdentity(null);
      render();
      return;
    }
    if (state.signOutFailed) return; // a sign-out is being retried: show nothing
    if (state.userKey === null) {
      // Nothing is rendered for any account yet (first load, sign-in return).
      if (event !== 'INITIAL_SESSION') render();
      return;
    }
    if (id !== state.userKey) {
      resetIdentity(id);
      state.notice = null;
      render();
      return;
    }
    if (event === 'USER_UPDATED') {
      invalidate();
      state.workspaces = null;
      render();
    }
    // The same account signing in again or refreshing its token: no change.
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
