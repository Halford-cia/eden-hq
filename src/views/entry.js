// Entry screens: sign-in, no access, workspace picker, unavailable, errors,
// and the shared top bar with the workspace switcher.

import { h } from '../dom.js';

export function loadingView() {
  return h('main', { class: 'screen', 'aria-busy': 'true' }, h('p', { class: 'muted' }, 'Loading…'));
}

export function signInView(ctx) {
  const btn = h('button', { class: 'primary', type: 'button', onClick: () => ctx.auth.signIn() }, 'Sign in with Google');
  return h('main', { class: 'screen center' },
    h('h1', null, 'Eden HQ'),
    h('p', null, 'Projects and tasks for the family and the Stay Eden team.'),
    btn);
}

export function noAccessView(ctx) {
  return h('main', { class: 'screen center' },
    h('h1', null, 'Eden HQ'),
    h('p', { role: 'status' }, 'Ask Hank for workspace access.'),
    h('button', { type: 'button', onClick: () => ctx.signOut() }, 'Sign out'));
}

export function pickerView(ctx) {
  return h('main', { class: 'screen' },
    topBar(ctx, null),
    h('h1', null, 'Choose a workspace'),
    h('ul', { class: 'cards' },
      ctx.state.workspaces.map((w) => h('li', null,
        h('a', {
          class: 'card-link',
          href: `/w/${w.workspace_id}`,
          onClick: (e) => { e.preventDefault(); ctx.navigate(`/w/${w.workspace_id}`); },
        }, h('span', { class: 'card-title' }, w.name), h('span', { class: 'badge' }, w.role === 'owner' ? 'Owner' : 'Member'))))));
}

export function unavailableView(ctx) {
  return h('main', { class: 'screen center' },
    ctx.state.workspaces ? topBar(ctx, null) : null,
    h('h1', null, 'Not available'),
    h('p', null, 'This page does not exist, or you do not have access to it.'),
    h('a', { href: '/', onClick: (e) => { e.preventDefault(); ctx.navigate('/'); } }, 'Go to your workspaces'));
}

export function errorView(ctx, err) {
  return h('main', { class: 'screen center' },
    h('h1', null, 'Something went wrong'),
    h('p', { role: 'alert' }, err?.message || 'Please try again.'),
    h('button', { type: 'button', onClick: () => ctx.render() }, 'Try again'));
}

/** Top bar: app name, workspace switcher, sign out. */
export function topBar(ctx, workspaceId) {
  const ws = ctx.state.workspaces || [];
  let switcher = null;
  if (workspaceId) {
    const current = ws.find((w) => w.workspace_id === workspaceId);
    if (ws.length > 1) {
      const sel = h('select', {
        'aria-label': 'Workspace',
        class: 'workspace-switcher',
        onChange: (e) => ctx.switchWorkspace(e.target.value),
      }, ws.map((w) => h('option', { value: w.workspace_id, selected: w.workspace_id === workspaceId }, w.name)));
      switcher = sel;
    } else if (current) {
      switcher = h('span', { class: 'workspace-name' }, current.name);
    }
  }
  return h('header', { class: 'topbar' },
    h('a', { class: 'brand', href: '/', onClick: (e) => { e.preventDefault(); ctx.navigate('/'); } }, 'Eden HQ'),
    switcher,
    h('button', { type: 'button', class: 'link', onClick: () => ctx.signOut() }, 'Sign out'));
}
