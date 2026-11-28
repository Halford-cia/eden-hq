// Stage 1 backup logic: snapshot facts, manifest, restore verification,
// superseded-gate closing, status and watch verdicts. The hosted parts
// (Cloud Run, Cloud Storage, age, pg_dump) are exercised in Hank's
// scheduled-backup and restore-drill acceptance runs (docs/SETUP.md).

import { describe, it, expect, beforeAll } from 'vitest';
import { freshDb, seedCast, asUser, rpc, MIGRATOR, setGate } from '../db/harness.mjs';
import {
  setTimestamp, setObjectNames, snapshotFacts, buildManifest, verifyRestore, closeSuperseded,
  watchVerdict, statusRecord, edenRolesOnly,
} from '../../backup/lib.mjs';

let db;
let cast;

beforeAll(async () => {
  db = await freshDb();
  cast = await seedCast(db);
  const [p] = await asUser(db, cast.owner.id, (tx) =>
    rpc(tx, 'create_project', { p_workspace_id: cast.ws.home_building, p_name: 'SYNTHETIC Backup build' }));
  await asUser(db, cast.owner.id, (tx) =>
    rpc(tx, 'create_task', { p_project_id: p.id, p_kind: 'task', p_title: 'SYNTHETIC One' }));
});

describe('set naming and status', () => {
  it('names objects by a sortable UTC timestamp with no colons', () => {
    const ts = setTimestamp(new Date('2031-06-08T09:00:05.123Z'));
    expect(ts).toBe('2031-06-08T090005Z');
    const n = setObjectNames(ts);
    expect(n.complete).toBe('sets/2031-06-08T090005Z/COMPLETE');
    expect(n.file('eden.dump')).toBe('sets/2031-06-08T090005Z/eden.dump.age');
    expect(n.latest).toBe('status/latest.json');
  });

  it('the status record holds no rows, names or keys', () => {
    const s = statusRecord({
      startedAt: 'a', finishedAt: 'b', state: 'complete', lastComplete: 'c', fileCount: 5, encryptedBytes: 10,
    });
    expect(Object.keys(s).sort()).toEqual([
      'encrypted_bytes', 'file_count', 'finished_at', 'last_complete_recovery_point', 'started_at', 'state',
    ]);
  });

  it('watch: ok within the window, stale past it or when missing/unreadable', () => {
    const now = new Date('2031-06-09T10:00:00Z');
    const ok = JSON.stringify({ last_complete_recovery_point: '2031-06-08T09:00:00Z' });
    expect(watchVerdict(ok, now, 26)).toEqual({ message: 'eden_backup_watch_ok', age_hours: 25 });
    expect(watchVerdict(ok, now, 1).message).toBe('eden_backup_stale');
    expect(watchVerdict('', now).message).toBe('eden_backup_stale');
    expect(watchVerdict('{"last_complete_recovery_point":null}', now).message).toBe('eden_backup_stale');
  });

  it('keeps only Eden roles from a roles dump', () => {
    const sql = [
      'CREATE ROLE eden_membership_reader;',
      'ALTER ROLE eden_membership_reader WITH NOSUPERUSER NOLOGIN;',
      'CREATE ROLE authenticator;',
      'ALTER ROLE postgres WITH LOGIN;',
      'GRANT eden_membership_reader TO postgres;',
      'GRANT anon TO authenticator;',
    ].join('\n');
    expect(edenRolesOnly(sql)).toBe('CREATE ROLE eden_membership_reader NOLOGIN NOINHERIT;\n');
  });
});

describe('snapshot facts, manifest and restore:verify', () => {
  it('records Stage 1 tables, migrations and counts, without the gate', async () => {
    await db.query(`set role ${MIGRATOR}`);
    const facts = await snapshotFacts(db);
    await db.query('reset role');
    expect(Object.keys(facts.tables)).toEqual([
      'eden.outside_contacts', 'eden.projects', 'eden.task_budgets', 'eden.task_updates', 'eden.tasks',
      'eden.workspace_members', 'eden.workspaces',
    ]);
    expect(facts.tables['eden.workspaces']).toBe(2);
    expect(facts.tables['eden.tasks']).toBe(1);
    expect(facts.migrations).toEqual(['20261127000100', '20261127000200']);
    expect(facts.auth.users).toBe(7);
  });

  it('a matching restored copy with a closed gate passes; any drift fails by name', async () => {
    await db.query(`set role ${MIGRATOR}`);
    const facts = await snapshotFacts(db);
    const manifest = JSON.parse(JSON.stringify(buildManifest({ stage: 1, facts, files: [] })));
    await db.query('reset role');

    // A restored copy: same data, gate closed (the dump leaves its data out).
    await setGate(db, false);
    await db.query(`set role ${MIGRATOR}`);
    const pass = await verifyRestore(db, manifest);
    expect(pass.ok).toBe(true);

    const fewer = { ...manifest, tables: { ...manifest.tables, 'eden.tasks': 2 } };
    const r1 = await verifyRestore(db, fewer);
    expect(r1.ok).toBe(false);
    expect(r1.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(['row count eden.tasks']);

    const stage2 = { ...manifest, migrations: [...manifest.migrations, '20990101000000'], tables: { ...manifest.tables, 'eden.receipts': 0 } };
    const r2 = await verifyRestore(db, stage2);
    expect(r2.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual([
      'applied migrations match the set', 'table list matches the set', 'row count eden.receipts',
    ]);
    await db.query('reset role');

    await setGate(db, true);
    await db.query(`set role ${MIGRATOR}`);
    const open = await verifyRestore(db, manifest);
    expect(open.checks.find((c) => c.name === 'access gate closed').ok).toBe(false);
    await db.query('reset role');
  });
});

describe('superseded projects', () => {
  it('closes an open former gate, reports a closed one, and survives an unreachable one', async () => {
    const old = await freshDb();
    await old.query(`set role ${MIGRATOR}`);
    await old.query('update eden_private.access_gate set is_open = true');
    expect(await closeSuperseded(async () => old)).toBe('eden_superseded_was_open');
    expect((await old.query('select is_open from eden_private.access_gate')).rows[0].is_open).toBe(false);
    expect(await closeSuperseded(async () => old)).toBe('eden_superseded_closed');
    expect(await closeSuperseded(async () => { throw new Error('down'); })).toBe('eden_superseded_unreachable');
  });
});
