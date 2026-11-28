// A stand-in for the supabase-js client that sends each .rpc() to the local
// PGlite database as the signed-in user, exactly as the Data API would
// (role authenticated + JWT claims). The app's real api.js runs on top of it,
// so front-end tests exercise the same operations, policies and errors.

import { asUser } from '../db/harness.mjs';

export function fakeSupabase(db, getUser, opts = {}) {
  const calls = [];
  const client = {
    calls,
    // Milliseconds each response takes to arrive after the database answered
    // (a slow network), settable per test.
    delayMs: opts.delayMs || 0,
    // While true, every request fails as if the service were down.
    offline: false,
    schema(name) {
      if (name !== 'eden_api') throw new Error('the app must only use the eden_api schema');
      return {
        async rpc(fn, args) {
          calls.push(fn);
          // A service outage: the request never reaches the database
          // (supabase-js rejects with a fetch error).
          if (client.offline) throw new TypeError('SYNTHETIC fetch failed');
          const user = getUser();
          const keys = Object.keys(args || {});
          const params = keys.map((k) => {
            const v = args[k];
            return v !== null && typeof v === 'object' ? JSON.stringify(v) : v;
          });
          const sql = `select * from eden_api.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')})`;
          try {
            const rows = await asUser(db, user ? user.id : null, (tx) => tx.query(sql, params).then((r) => r.rows),
              { role: user ? 'authenticated' : 'anon' });
            if (client.delayMs) await new Promise((r) => setTimeout(r, client.delayMs));
            // PostgREST serializes timestamps and dates as strings.
            return { data: JSON.parse(JSON.stringify(rows)), error: null };
          } catch (e) {
            if (client.delayMs) await new Promise((r) => setTimeout(r, client.delayMs));
            return { data: null, error: { code: e.code, message: e.message } };
          }
        },
      };
    },
  };
  return client;
}

export function fakeAuth(initialUser) {
  let user = initialUser;
  const listeners = [];
  return {
    get user() { return user; },
    signInCalls: 0,
    async getSession() { return user ? { user: { id: user.id } } : null; },
    async signIn() { this.signInCalls += 1; },
    // When set, signOut returns this result instead of signing out.
    signOutResult: null,
    async signOut() {
      if (this.signOutResult) {
        const r = this.signOutResult;
        if (r.local) {
          user = null;
          for (const l of listeners) l('SIGNED_OUT', null);
        }
        return r;
      }
      user = null;
      for (const l of listeners) l('SIGNED_OUT', null);
      return { ok: true };
    },
    onChange(fn) { listeners.push(fn); return () => {}; },
    setUser(u) { user = u; },
    /** Another tab (or the account chooser) signs a different person in on this browser. */
    switchUser(u) {
      user = u;
      for (const l of listeners) l('SIGNED_IN', u ? { user: { id: u.id } } : null);
    },
    emit(event, session) {
      for (const l of listeners) l(event, session);
    },
  };
}

/**
 * The parts of a supabase-js client that createAuth uses, with a global
 * sign-out that can fail while the session survives, as the pinned Auth
 * client does when its sign-out request does not reach the server.
 */
export function fakeAuthClient({ failGlobalSignOut = false, failLocalSignOut = false } = {}) {
  let session = { user: { id: '00000000-0000-4000-8000-00000000c0de' }, access_token: 'SYNTHETIC' };
  const calls = [];
  return {
    calls,
    auth: {
      async getSession() { return { data: { session }, error: null }; },
      async signOut(opts = {}) {
        const scope = opts.scope || 'global';
        calls.push(scope);
        if (scope === 'global' && failGlobalSignOut) {
          return { error: { name: 'AuthRetryableFetchError', message: 'SYNTHETIC network failure', status: 0 } };
        }
        if (scope === 'local' && failLocalSignOut) return { error: { message: 'SYNTHETIC storage failure' } };
        session = null;
        return { error: null };
      },
      onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
      async signInWithOAuth() { return { error: null }; },
    },
  };
}

/**
 * happy-dom updates `matches` on a viewport change but never fires the
 * MediaQueryList `change` event a phone rotation fires in a browser. This
 * stands in for window.matchMedia, so a test can cross the breakpoint the
 * way Chromium does: `bp.set(false)` = narrower than 900 px.
 */
export function fakeBreakpoint(win, { wide = true } = {}) {
  const listeners = new Set();
  const mql = {
    media: '(min-width: 900px)',
    get matches() { return wide; },
    addEventListener(type, fn) { if (type === 'change') listeners.add(fn); },
    removeEventListener(type, fn) { listeners.delete(fn); },
  };
  const original = win.matchMedia;
  win.matchMedia = () => mql;
  return {
    set(next) {
      if (next === wide) return;
      wide = next;
      for (const fn of listeners) fn({ matches: wide, media: mql.media });
    },
    restore() { win.matchMedia = original; },
  };
}

/** Wait for pending promises and DOM updates. */
export async function settle(times = 30) {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

export function byText(root, selector, text) {
  return [...root.querySelectorAll(selector)].find((el) => el.textContent.trim() === text
    || el.textContent.includes(text));
}
