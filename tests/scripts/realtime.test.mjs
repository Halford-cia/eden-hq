// The hosted Realtime acceptance check (review round 3, P1-5): its logic,
// with Owner A's synthetic changes made through the real operations on the
// local migrations, and stand-in Realtime subscribers. Hosted Realtime
// delivery itself is Hank's run (docs/SETUP.md step 9.8). SYNTHETIC data.

import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import {
  freshDb, seedCast, asUser, asAdmin, rpc, setGate, repoRoot,
} from '../db/harness.mjs';
import { fakeSupabase } from '../web/fake-supabase.mjs';
import { runRealtimeCheck, subscriptionsFor, EDEN_TABLES } from '../../scripts/lib/realtime-core.mjs';

let db;
let cast;

beforeAll(async () => {
  db = await freshDb();
  cast = await seedCast(db);
  for (const [ws, name] of [[cast.ws.home_building, 'SYNTHETIC Test build'], [cast.ws.stay_eden_ops, 'SYNTHETIC Test cottage']]) {
    await asUser(db, cast.owner.id, (tx) => rpc(tx, 'create_project', { p_workspace_id: ws, p_name: name }));
  }
});

/**
 * A stand-in subscriber: every channel joins with `status`; when `leak` is
 * set, each change Owner A makes is delivered to every binding it holds.
 */
function subscriber({ status = 'SUBSCRIBED', leak = false } = {}) {
  const bindings = [];
  const channels = [];
  return {
    bindings,
    channels,
    leak,
    channel(name) {
      const ch = {
        name,
        on(type, filter, cb) { bindings.push({ type, filter, cb }); return ch; },
        subscribe(cb) { channels.push(name); setTimeout(() => cb(status), 0); return ch; },
      };
      return ch;
    },
    async removeAllChannels() { channels.length = 0; },
  };
}

/** Owner A through the real operations; each write is offered to leaking subscribers. */
function ownerClient(user, subs) {
  const base = fakeSupabase(db, () => user);
  return {
    schema(name) {
      const s = base.schema(name);
      return {
        async rpc(fn, args) {
          const r = await s.rpc(fn, args);
          if (!r.error && !['my_workspaces', 'list_projects'].includes(fn)) {
            for (const sub of subs) if (sub.leak) for (const b of sub.bindings) b.cb({ SYNTHETIC: true });
          }
          return r;
        },
      };
    },
  };
}

const fast = { listenMs: 5, joinMs: 50, wait: (ms) => new Promise((r) => setTimeout(r, ms)) };

function run(subs, { owner = cast.owner } = {}) {
  const names = ['signed-out client', 'Manager', 'Helper'];
  return runRealtimeCheck({
    ...fast,
    stamp: 'SYNTHETIC-stamp',
    clients: { owner: ownerClient(owner, subs), subscribers: subs.map((client, i) => ({ name: names[i], client })) },
  });
}

describe('realtime:check (review round 3, P1-5)', () => {
  it('subscribes to every Eden table and every Eden schema', async () => {
    const { rows } = await asAdmin(db, (tx) => tx.query(
      `select schemaname, tablename from pg_tables where schemaname like 'eden%' order by 1, 2`));
    expect(EDEN_TABLES.map(([s, t]) => `${s}.${t}`).sort()).toEqual(rows.map((r) => `${r.schemaname}.${r.tablename}`).sort());
    const labels = subscriptionsFor().map((s) => s.label);
    for (const r of rows) expect(labels).toContain(`${r.schemaname}.${r.tablename}`);
    expect(labels).toEqual(expect.arrayContaining(['eden.*', 'eden_private.*', 'eden_api.*']));
  });

  it('zero deliveries to all three subscribers after changes in both workspaces: PASS', async () => {
    const subs = [subscriber(), subscriber(), subscriber()];
    const r = await run(subs);
    expect(r.lines.at(-1)).toBe('realtime:check PASSED');
    expect(r.ok).toBe(true);
    expect(r.changes).toEqual(['home_building', 'stay_eden_ops']);
    for (const s of subs) {
      // Every subscription bound, on its own channel; cleaned up afterwards.
      expect(s.bindings.map((b) => b.type)).toEqual(subscriptionsFor().map(() => 'postgres_changes'));
      expect(s.bindings.map((b) => b.filter)).toEqual(subscriptionsFor().map((x) => x.filter));
      expect(s.channels).toEqual([]);
    }
    expect(r.lines).toContain(`PASS  Helper: 0 changes delivered (${subscriptionsFor().length} channels: ${subscriptionsFor().length} subscribed)`);
    // The changes were real and were cleaned up: one archived Done item per workspace.
    const { rows } = await asAdmin(db, (tx) => tx.query(
      `select workspace_id, status, archived_at is not null as archived from eden.tasks where title = 'SYNTHETIC realtime check SYNTHETIC-stamp'`));
    expect(rows.map((x) => x.workspace_id).sort()).toEqual([cast.ws.home_building, cast.ws.stay_eden_ops].sort());
    expect(rows.every((x) => x.status === 'done' && x.archived)).toBe(true);
  });

  it('channels the server refuses still pass when nothing is delivered, and say so', async () => {
    const subs = [subscriber({ status: 'CHANNEL_ERROR' }), subscriber({ status: 'CHANNEL_ERROR' }), subscriber()];
    const r = await run(subs);
    expect(r.ok).toBe(true);
    expect(r.lines).toContain(`PASS  Manager: 0 changes delivered (${subscriptionsFor().length} channels: ${subscriptionsFor().length} refused)`);
  });

  it('one delivery to the Helper fails the check, naming the subscriber and the count only', async () => {
    const subs = [subscriber(), subscriber(), subscriber({ leak: true })];
    const r = await run(subs);
    expect(r.ok).toBe(false);
    expect(r.lines.at(-1)).toBe('realtime:check FAILED');
    expect(r.lines.find((l) => l.includes('Helper'))).toMatch(/^FAIL {2}Helper: \d+ changes delivered/);
    expect(r.lines.find((l) => l.includes('Manager'))).toMatch(/^PASS/);
    const out = r.lines.join('\n');
    for (const secret of [cast.owner.id, cast.homeMember.id, cast.ws.home_building, 'SYNTHETIC Test build', 'realtime check']) {
      expect(out).not.toContain(secret);
    }
  });

  it('a changes token that is not an owner of both workspaces is refused before anything is subscribed', async () => {
    const subs = [subscriber(), subscriber(), subscriber()];
    const r = await run(subs, { owner: cast.manager });
    expect(r.ok).toBe(false);
    expect(r.lines[0]).toBe('FAIL  the changes token is not an owner of home_building');
    expect(subs.every((s) => s.bindings.length === 0)).toBe(true);
  });

  it('changes that cannot be made (gate closed) fail the check: zero deliveries proves nothing then', async () => {
    const subs = [subscriber(), subscriber(), subscriber()];
    await setGate(db, false);
    try {
      const r = await run(subs);
      expect(r.ok).toBe(false);
      expect(r.lines.at(-1)).toBe('realtime:check FAILED');
    } finally {
      await setGate(db, true);
    }
  });

  it('the script refuses a secret key before connecting to anything', () => {
    const res = spawnSync(process.execPath, [join(repoRoot, 'scripts', 'realtime-check.mjs')], {
      input: 'https://aaaaaaaaaaaaaaaaaaaa.supabase.co\nsb_secret_SYNTHETIC\n', encoding: 'utf8',
    });
    expect(`${res.stdout}${res.stderr}`).toContain('Refused: use the publishable key, never the secret key.');
    expect(`${res.stdout}${res.stderr}`).not.toContain('sb_secret_SYNTHETIC');
    expect(res.status).toBe(2);
  });
});
