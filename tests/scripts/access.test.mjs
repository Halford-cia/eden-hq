// access:open / access:close and the one-serving-project rule, including the
// open spec review item P0-2 (round 3): a former project must read back
// closed before another opens; unreachable or keys-removed is not enough.

import { describe, it, expect, beforeAll } from 'vitest';
import { freshDb, MIGRATOR, createAuthUser } from '../db/harness.mjs';
import {
  parseRegister, refFromConnectionString, openGate, closeGate, readGate,
} from '../../scripts/lib/access-core.mjs';
import { checkConnectionString } from '../../scripts/lib/connect.mjs';

const PROD = 'aaaaaaaaaaaaaaaaaaaa';
const OLD = 'bbbbbbbbbbbbbbbbbbbb';
const DRILL = 'cccccccccccccccccccc';

let dbs;

async function project() {
  const db = await freshDb();
  await db.query(`set role ${MIGRATOR}`);
  return db;
}

beforeAll(async () => {
  dbs = { [PROD]: await project(), [OLD]: await project(), [DRILL]: await project() };
});

function register(rows) {
  const text = ['ref,publishable_key,purpose,state', ...rows.map((r) => r.join(','))].join('\n');
  const { entries, errors } = parseRegister(text);
  expect(errors).toEqual([]);
  return entries;
}

const reachable = (refs) => async (ref) => {
  if (!refs.includes(ref)) throw new Error('unreachable');
  return dbs[ref];
};

describe('connection strings', () => {
  it('reads the project ref from direct and pooler strings', () => {
    expect(refFromConnectionString(`postgresql://postgres:pw@db.${PROD}.supabase.co:5432/postgres`)).toBe(PROD);
    expect(refFromConnectionString(`postgresql://postgres.${OLD}:pw@aws-0-x.pooler.supabase.com:5432/postgres`)).toBe(OLD);
    expect(refFromConnectionString('postgresql://postgres@127.0.0.1:54322/postgres')).toBeNull();
  });
  it('refuses a remote string that does not verify the server certificate', () => {
    expect(checkConnectionString(`postgresql://postgres:pw@db.${PROD}.supabase.co:5432/postgres`)).toMatch(/verify-full/);
    expect(checkConnectionString(`postgresql://postgres:pw@db.${PROD}.supabase.co:5432/postgres?sslmode=require`)).toMatch(/verify-full/);
    expect(checkConnectionString(`postgresql://postgres:pw@db.${PROD}.supabase.co:5432/postgres?sslmode=verify-full&sslrootcert=/x/ca.crt`)).toBeNull();
    expect(checkConnectionString('postgresql://postgres:pw@127.0.0.1:54322/postgres')).toBeNull();
  });
});

describe('access:close', () => {
  it('closes and reads back closed; recreates a missing row closed', async () => {
    const db = dbs[DRILL];
    await closeGate(db, 'test');
    expect(await readGate(db)).toBe(false);
    await db.query('delete from eden_private.access_gate');
    expect(await readGate(db)).toBe(false);
    await closeGate(db, 'test');
    expect((await db.query('select count(*)::int as n from eden_private.access_gate')).rows[0].n).toBe(1);
  });
});

describe('access:open', () => {
  it('opens the only project in the register', async () => {
    const reg = register([[PROD, 'sb_publishable_SYNTHETIC', 'production', 'closed']]);
    const r = await openGate({ register: reg, targetRef: PROD, connect: reachable([PROD]), by: 'test' });
    expect(r).toEqual({ opened: true, refusals: [] });
    expect(await readGate(dbs[PROD])).toBe(true);
    await closeGate(dbs[PROD], 'test');
  });

  it('refuses while another entry is still marked serving', async () => {
    const reg = register([
      [PROD, 'k', 'replacement', 'closed'],
      [OLD, 'k', 'production', 'serving'],
    ]);
    const r = await openGate({ register: reg, targetRef: PROD, connect: reachable([PROD, OLD]), by: 'test' });
    expect(r.opened).toBe(false);
    expect(r.refusals.join()).toMatch(/still marks it serving/);
    expect(await readGate(dbs[PROD])).toBe(false);
  });

  it('refuses while another project reads back with an OPEN gate', async () => {
    const db = dbs[OLD];
    await db.query(`update eden_private.access_gate set is_open = true`);
    const reg = register([[PROD, 'k', 'replacement', 'closed'], [OLD, 'k', 'production', 'closed']]);
    const r = await openGate({ register: reg, targetRef: PROD, connect: reachable([PROD, OLD]), by: 'test' });
    expect(r.opened).toBe(false);
    expect(r.refusals.join()).toMatch(/gate is OPEN/);
    await closeGate(db, 'test');
  });

  it('P0-2: refuses when a former project is unreachable, even if its keys were removed', async () => {
    for (const state of ['closed', 'keys removed']) {
      const reg = register([[PROD, 'k', 'replacement', 'closed'], [OLD, 'k', 'production', state]]);
      const r = await openGate({ register: reg, targetRef: PROD, connect: reachable([PROD]), by: 'test' });
      expect(r.opened).toBe(false);
      expect(r.refusals.join()).toMatch(/unreachable/);
      expect(await readGate(dbs[PROD])).toBe(false);
    }
  });

  it('opens once every other non-deleted entry reads back closed; deleted entries are skipped', async () => {
    const reg = register([
      [PROD, 'k', 'replacement', 'closed'],
      [OLD, 'k', 'production', 'keys removed'],
      [DRILL, 'k', 'drill', 'deleted'],
    ]);
    const r = await openGate({ register: reg, targetRef: PROD, connect: reachable([PROD, OLD]), by: 'test' });
    expect(r.opened).toBe(true);
    await closeGate(dbs[PROD], 'test');
  });

  it('a drill or rehearsal copy opens only with the synthetic-data confirmation', async () => {
    const reg = register([[DRILL, 'k', 'drill', 'closed']]);
    const r1 = await openGate({ register: reg, targetRef: DRILL, connect: reachable([DRILL]), by: 'test' });
    expect(r1.opened).toBe(false);
    expect(r1.refusals.join()).toMatch(/synthetic/);
    // The confirmation alone is not enough any more (review round 2, P1-2):
    // the copy's Auth rows must be the expected test accounts.
    const bare = await openGate({ register: reg, targetRef: DRILL, connect: reachable([DRILL]), by: 'test', synthetic: true });
    expect(bare.opened).toBe(false);
    expect(bare.refusals.join()).toMatch(/expected-accounts/);
    // Auth rows are written by the platform, not the migration role.
    await dbs[DRILL].query('reset role');
    const tester = await createAuthUser(dbs[DRILL], 'drill-tester');
    await dbs[DRILL].query(`set role ${MIGRATOR}`);
    const r2 = await openGate({
      register: reg, targetRef: DRILL, connect: reachable([DRILL]), by: 'test', synthetic: true,
      expectedAccounts: [{ id: tester.id, subject: tester.subject }],
    });
    expect(r2.opened).toBe(true);
    await closeGate(dbs[DRILL], 'test');
  });

  it('refuses a target missing from the register or marked deleted', async () => {
    const reg = register([[OLD, 'k', 'production', 'deleted']]);
    expect((await openGate({ register: reg, targetRef: PROD, connect: reachable([PROD]), by: 't' })).opened).toBe(false);
    expect((await openGate({ register: reg, targetRef: OLD, connect: reachable([OLD]), by: 't' })).opened).toBe(false);
  });

  it('validates register lines', () => {
    const { errors } = parseRegister('ref,publishable_key,purpose,state\nnot-a-ref,k,prod,live\n');
    expect(errors).toHaveLength(3);
  });
});
