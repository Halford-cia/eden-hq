// Stage 1 backup logic: snapshot facts, manifest, restore verification,
// superseded-gate closing, status and watch verdicts. The hosted parts
// (Cloud Run, Cloud Storage, age, pg_dump) are exercised in Hank's
// scheduled-backup and restore-drill acceptance runs (docs/SETUP.md).

import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  freshDb, seedCast, asUser, rpc, MIGRATOR, setGate, repoRoot, migrationFiles,
} from '../db/harness.mjs';
import {
  setTimestamp, setObjectNames, snapshotFacts, buildManifest, verifyRestore, closeSuperseded,
  watchVerdict, statusRecord, edenRolesOnly, completeMarker,
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
    expect(facts.migrations).toEqual(migrationFiles().map((f) => f.split('_')[0]));
    expect(facts.migrations).toContain('20261128000100');
    expect(facts.auth.users).toBe(7);
  });

  it('a matching restored copy with a closed gate passes; any drift fails by name', async () => {
    await db.query(`set role ${MIGRATOR}`);
    const facts = await snapshotFacts(db);
    await db.query('reset role');
    const { dir, files } = setFolder();
    const manifest = JSON.parse(JSON.stringify(buildManifest({ stage: 1, facts, files })));
    seal(dir, manifest);

    // A restored copy: same data, gate closed (the dump leaves its data out).
    await setGate(db, false);
    await db.query(`set role ${MIGRATOR}`);
    const pass = await verifyRestore(db, manifest, { dir });
    expect(pass.checks.filter((c) => !c.ok)).toEqual([]);
    expect(pass.ok).toBe(true);

    const fewer = { ...manifest, tables: { ...manifest.tables, 'eden.tasks': 2 } };
    const r1 = await verifyRestore(db, fewer, { dir });
    expect(r1.ok).toBe(false);
    expect(r1.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(['row count eden.tasks']);

    const stage2 = { ...manifest, migrations: [...manifest.migrations, '20990101000000'], tables: { ...manifest.tables, 'eden.receipts': 0 } };
    const r2 = await verifyRestore(db, stage2, { dir });
    expect(r2.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual([
      'applied migrations match the set', 'table list matches the set', 'row count eden.receipts',
    ]);
    await db.query('reset role');

    await setGate(db, true);
    await db.query(`set role ${MIGRATOR}`);
    const open = await verifyRestore(db, manifest, { dir });
    expect(open.checks.find((c) => c.name === 'access gate closed').ok).toBe(false);
    await db.query('reset role');
    await setGate(db, false);
  });

  // Review P1-2: matching counts are not a recovery.
  it('counts match but a required file is absent, truncated or altered: FAIL by name', async () => {
    await db.query(`set role ${MIGRATOR}`);
    const facts = await snapshotFacts(db);
    await db.query('reset role');
    const { dir, files } = setFolder();
    const manifest = JSON.parse(JSON.stringify(buildManifest({ stage: 1, facts, files })));
    seal(dir, manifest);
    await db.query(`set role ${MIGRATOR}`);
    try {
      expect((await verifyRestore(db, manifest, { dir })).ok).toBe(true);

      rmSync(join(dir, 'eden.dump'));
      writeFileSync(join(dir, 'auth.dump'), 'SYNTHETIC altered');
      const r = await verifyRestore(db, manifest, { dir });
      expect(r.ok).toBe(false);
      expect(r.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual([
        'set file auth.dump matches its recorded size and hash',
        'set file eden.dump is present',
      ]);

      // A manifest that leaves a required file out fails too.
      const short = { ...manifest, files: manifest.files.filter((f) => f.name !== 'roles.sql') };
      const r2 = await verifyRestore(db, short, { dir });
      expect(r2.checks.filter((c) => !c.ok).map((c) => c.name)).toContain('the set lists required file roles.sql');

      // And no folder at all is not a pass.
      const r3 = await verifyRestore(db, manifest);
      expect(r3.ok).toBe(false);
    } finally {
      await db.query('reset role');
    }
  });

  // Review round 3, P1-2: the worker uploads the manifest before COMPLETE. A
  // set whose last upload failed has every file and a manifest, and no marker.
  it('every file intact but no COMPLETE marker, or a marker for another manifest: FAIL by name', async () => {
    await db.query(`set role ${MIGRATOR}`);
    const facts = await snapshotFacts(db);
    await db.query('reset role');
    const { dir, files } = setFolder();
    const manifest = JSON.parse(JSON.stringify(buildManifest({ stage: 1, facts, files })));
    seal(dir, manifest);
    await setGate(db, false);
    await db.query(`set role ${MIGRATOR}`);
    try {
      const pass = await verifyRestore(db, manifest, { dir });
      expect(pass.checks.filter((c) => !c.ok)).toEqual([]);
      expect(pass.checks.map((c) => c.name)).toContain('the COMPLETE marker certifies this manifest');

      rmSync(join(dir, 'COMPLETE'));
      const missing = await verifyRestore(db, manifest, { dir });
      expect(missing.ok).toBe(false);
      expect(missing.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual([
        'the set ends in its COMPLETE marker (the backup finished)',
      ]);

      // The old constant marker, and a marker for a different manifest.
      for (const marker of [Buffer.from('complete\n'), completeMarker(Buffer.from('{"SYNTHETIC":"other manifest"}'))]) {
        writeFileSync(join(dir, 'COMPLETE'), marker);
        const wrong = await verifyRestore(db, manifest, { dir });
        expect(wrong.ok).toBe(false);
        expect(wrong.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual([
          'the COMPLETE marker certifies this manifest',
        ]);
      }

      // A manifest edited after the marker was written fails the same way.
      writeFileSync(join(dir, 'COMPLETE'), completeMarker(Buffer.from(JSON.stringify(manifest, null, 2))));
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ ...manifest, note: 'SYNTHETIC edit' }, null, 2));
      const edited = await verifyRestore(db, manifest, { dir });
      expect(edited.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual([
        'the COMPLETE marker certifies this manifest',
      ]);
    } finally {
      await db.query('reset role');
    }
  });

  it('the worker writes the marker for the manifest it uploaded, as its last object', () => {
    const src = readFileSync(join(repoRoot, 'backup', 'worker.mjs'), 'utf8');
    const manifestUpload = src.indexOf('uploadObject(backupBucket, names.manifest');
    const markerUpload = src.indexOf('uploadObject(backupBucket, names.complete, completeMarker(manifest))');
    expect(manifestUpload).toBeGreaterThan(0);
    expect(markerUpload).toBeGreaterThan(manifestUpload);
    expect(src.indexOf('uploadObject(backupBucket', markerUpload + 1)).toBe(-1);
  });

  it('restored RLS, helper ownership and grants are compared with the set', async () => {
    await db.query(`set role ${MIGRATOR}`);
    const facts = await snapshotFacts(db);
    await db.query('reset role');
    expect(facts.access.definers).toEqual([
      { schema: 'eden_private', name: 'is_member', owner: 'eden_membership_reader', config: 'search_path=""' },
    ]);
    const { dir, files } = setFolder();
    const manifest = JSON.parse(JSON.stringify(buildManifest({ stage: 1, facts, files })));
    seal(dir, manifest);

    const copy = await freshDb();
    await seedLike(copy);
    await setGate(copy, false);
    // The helper left owned by the operator, as the reviewed restore did.
    await copy.exec('alter function eden_private.is_member(uuid, boolean) owner to postgres');
    await copy.exec('alter table eden.tasks disable row level security');
    await copy.query(`set role ${MIGRATOR}`);
    const r = await verifyRestore(copy, { ...manifest, tables: (await snapshotFacts(copy)).tables, auth: (await snapshotFacts(copy)).auth }, { dir });
    await copy.query('reset role');
    const failed = r.checks.filter((c) => !c.ok).map((c) => c.name);
    expect(failed).toContain('row-level security on every Eden table');
    expect(failed).toContain('membership helper owned by eden_membership_reader, the only definer function');
    expect(failed).toContain('restored ownership, grants and policies match the set');
  });

  it('restore:verify (the real script) refuses a folder holding only a manifest, before asking for a connection', async () => {
    await db.query(`set role ${MIGRATOR}`);
    const facts = await snapshotFacts(db);
    await db.query('reset role');
    const d = mkdtempSync(join(tmpdir(), 'eden-set-'));
    const manifest = buildManifest({
      stage: 1,
      facts,
      files: [
        { name: 'eden.dump', bytes: 10, sha256: 'a'.repeat(64) },
        { name: 'auth.dump', bytes: 10, sha256: 'b'.repeat(64) },
      ],
    });
    writeFileSync(join(d, 'manifest.json'), JSON.stringify(manifest));
    const res = spawnSync(process.execPath, [join(repoRoot, 'scripts', 'restore-verify.mjs'), d],
      { input: 'postgresql://unused@127.0.0.1:1/none\n', encoding: 'utf8' });
    const out = `${res.stdout}${res.stderr}`;
    expect(out).toContain('FAIL  set file eden.dump is present');
    expect(out).toContain('restore:verify FAILED');
    expect(out).not.toContain('PASSED');
    expect(res.status).toBe(1);
  });
});

// A decrypted set folder holding the four Stage 1 files (SYNTHETIC bytes).
/** manifest.json and the COMPLETE marker the worker writes last, as decrypted. */
function seal(dir, manifest) {
  const buf = Buffer.from(JSON.stringify(manifest, null, 2));
  writeFileSync(join(dir, 'manifest.json'), buf);
  writeFileSync(join(dir, 'COMPLETE'), completeMarker(buf));
}

function setFolder() {
  const dir = mkdtempSync(join(tmpdir(), 'eden-set-'));
  const files = [];
  for (const name of ['roles.sql', 'eden.dump', 'auth.dump', 'migrations.dump']) {
    const buf = Buffer.from(`SYNTHETIC ${name}\n`);
    writeFileSync(join(dir, name), buf);
    files.push({ name, bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') });
  }
  return { dir, files };
}

async function seedLike(copy) {
  const c = await seedCast(copy);
  const [p] = await asUser(copy, c.owner.id, (tx) =>
    rpc(tx, 'create_project', { p_workspace_id: c.ws.home_building, p_name: 'SYNTHETIC Backup build' }));
  await asUser(copy, c.owner.id, (tx) =>
    rpc(tx, 'create_task', { p_project_id: p.id, p_kind: 'task', p_title: 'SYNTHETIC One' }));
}

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
