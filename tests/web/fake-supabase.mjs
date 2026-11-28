// A stand-in for the supabase-js client that sends each .rpc() to the local
// PGlite database as the signed-in user, exactly as the Data API would
// (role authenticated + JWT claims). The app's real api.js runs on top of it,
// so front-end tests exercise the same operations, policies and errors.

import { asUser } from '../db/harness.mjs';

export function fakeSupabase(db, getUser) {
  const calls = [];
  const client = {
    calls,
    schema(name) {
      if (name !== 'eden_api') throw new Error('the app must only use the eden_api schema');
      return {
        async rpc(fn, args) {
          calls.push(fn);
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
            // PostgREST serializes timestamps and dates as strings.
            return { data: JSON.parse(JSON.stringify(rows)), error: null };
          } catch (e) {
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
    async signOut() {
      user = null;
      for (const l of listeners) l('SIGNED_OUT', null);
    },
    onChange(fn) { listeners.push(fn); return () => {}; },
    setUser(u) { user = u; },
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
