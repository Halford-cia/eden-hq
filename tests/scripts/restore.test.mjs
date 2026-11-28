// Clean-restore acceptance (review P1-1, P1-2): the worker's own dump
// commands against a local copy of a seeded project, then the real
// `restore:apply` and `restore:verify` scripts into a NEW, empty project,
// with native psql / pg_dump / pg_restore 17+ talking to local PGlite over
// 127.0.0.1. Both databases run as the non-superuser migration role, as
// hosted Supabase's postgres does. SYNTHETIC data only.
//
// Needs the PostgreSQL client tools on PATH (docs/SETUP.md, "What you need";
// CI installs postgresql-client-17).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import {
  freshDb, emptyProject, seedCast, asUser, asAdmin, rpc, MIGRATOR, reopenAs, repoRoot, migrationFiles,
} from '../db/harness.mjs';
import {
  dumpCommands, edenRolesOnly, snapshotFacts, buildManifest,
} from '../../backup/lib.mjs';

const HOST = '127.0.0.1';

function run(cmd, args, { input, env } = {}) {
  return new Promise((done) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    let err = '';
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => done({ code: 127, stdout: Buffer.alloc(0), stderr: String(e.message) }));
    child.on('close', (code) => done({ code, stdout: Buffer.concat(out), stderr: err }));
    child.stdin.end(input || '');
  });
}

// A local connection string. PGlite accepts any password; it is set through
// URL so no connection-string-with-password literal sits in this public file.
function localUrl(port) {
  const u = new URL(`postgresql://${HOST}:${port}/template1?sslmode=disable`);
  u.username = MIGRATOR;
  u.password = 'local-only';
  return u.toString();
}

async function serve(db) {
  const server = new PGLiteSocketServer({ db, port: 0, host: HOST });
  await server.start();
  const { port } = server.server.address();
  return { server, url: localUrl(port) };
}

/** A new hosted project: Supabase's schemas and pg_graphql, nothing of Eden. */
async function newProject() {
  const db = await emptyProject();
  // Hosted postgres may write Auth rows; the local model grants the same.
  await db.exec(`grant insert, update, delete on auth.users, auth.identities to ${MIGRATOR}`);
  return reopenAs(db, MIGRATOR);
}

const restoreApply = (dir, url, extra = []) => run(process.execPath,
  [join(repoRoot, 'scripts', 'restore-apply.mjs'), dir, ...extra], { input: `${url}\n` });
const restoreVerify = (dir, url, extra = []) => run(process.execPath,
  [join(repoRoot, 'scripts', 'restore-verify.mjs'), dir, ...extra], { input: `${url}\n` });

let tools = true;
let source;
let sourceServer;
let setDir;
let manifest;
let cast;

beforeAll(async () => {
  for (const t of ['psql', 'pg_dump', 'pg_restore', 'pg_dumpall']) {
    const r = await run(t, ['--version']);
    if (r.code !== 0 || Number((String(r.stdout).match(/\(PostgreSQL\)\s+(\d+)/) || [])[1]) < 17) tools = false;
  }
  if (!tools) return;

  // The serving project: seeded, then reopened as the migration role.
  let db = await freshDb();
  cast = await seedCast(db);
  const [p] = await asUser(db, cast.owner.id, (tx) =>
    rpc(tx, 'create_project', { p_workspace_id: cast.ws.home_building, p_name: 'SYNTHETIC Restore build' }));
  const [t] = await asUser(db, cast.owner.id, (tx) =>
    rpc(tx, 'create_task', { p_project_id: p.id, p_kind: 'task', p_title: 'SYNTHETIC Restore task' }));
  await asUser(db, cast.owner.id, (tx) => rpc(tx, 'add_update', { p_task_id: t.id, p_body: 'SYNTHETIC note' }));
  await asUser(db, cast.owner.id, (tx) => rpc(tx, 'create_contact', {
    p_workspace_id: cast.ws.home_building, p_display_name: 'SYNTHETIC Framing crew', p_kind: 'vendor',
  }));
  await asAdmin(db, (tx) => tx.query(
    `insert into eden.task_budgets (task_id, workspace_id, project_id, estimated_cents) values ($1, $2, $3, 4200)`,
    [t.id, cast.ws.home_building, p.id]));
  source = await reopenAs(db, MIGRATOR);
  db = null;
  ({ server: sourceServer } = await serve(source));
  const url = localUrl(sourceServer.server.address().port);

  // The worker's dump commands, without its exported snapshot.
  setDir = mkdtempSync(join(tmpdir(), 'eden-set-'));
  const files = [];
  for (const step of dumpCommands({ dbUrl: url })) {
    const r = await run(step.cmd, step.args);
    if (r.code !== 0) throw new Error(`${step.cmd} for ${step.name} exited ${r.code}: ${r.stderr.split('\n')[0]}`);
    const buf = step.name === 'roles.sql' ? Buffer.from(edenRolesOnly(r.stdout.toString('utf8'))) : r.stdout;
    writeFileSync(join(setDir, step.name), buf);
    files.push({ name: step.name, bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') });
  }
  const facts = await snapshotFacts(source);
  manifest = buildManifest({ stage: 1, facts, files });
  writeFileSync(join(setDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
}, 240_000);

afterAll(async () => {
  await sourceServer?.stop();
});

describe('clean restore with the native tools, as a non-superuser', () => {
  it('the client tools are installed (17 or later)', () => {
    expect(tools, 'install the PostgreSQL 17+ client tools: docs/SETUP.md, "What you need"').toBe(true);
  });

  it('the set holds the four Stage 1 files and the roles file names only Eden roles', () => {
    if (!tools) return;
    expect(manifest.files.map((f) => f.name).sort()).toEqual(['auth.dump', 'eden.dump', 'migrations.dump', 'roles.sql']);
    expect(readFileSync(join(setDir, 'roles.sql'), 'utf8')).toBe('CREATE ROLE eden_membership_reader NOLOGIN NOINHERIT;\n');
  });

  it('restore:apply into a new project succeeds; restore:verify passes; owners, ledger and gate are right', async () => {
    if (!tools) return;
    const target = await newProject();
    const { server, url } = await serve(target);
    try {
      const applied = await restoreApply(setDir, url, ['--show-errors']);
      const out = `${applied.stdout}${applied.stderr}`;
      expect(out, out).toContain('restore:apply finished');
      expect(applied.code).toBe(0);

      const verified = await restoreVerify(setDir, url);
      const vout = `${verified.stdout}${verified.stderr}`;
      expect(vout, vout).toContain('restore:verify PASSED');
      expect(vout).not.toContain('FAIL ');
      expect(verified.code).toBe(0);

      // Review round 2, P1-2: the set holds every Auth account. The cast's
      // roster shows six people; the seventh signed in and is pending. Checked
      // against the six, the copy fails; against all seven, it passes.
      const accDir = mkdtempSync(join(tmpdir(), 'eden-accounts-'));
      const accountsFile = (people) => {
        const f = join(accDir, `accounts-${people.length}.csv`);
        writeFileSync(f, ['user_id,google_subject', ...people.map((u) => `${u.id},${u.subject}`)].join('\n'));
        return f;
      };
      const six = [...cast.owners, cast.manager, cast.homeMember];
      const short = await restoreVerify(setDir, url, ['--expected-accounts', accountsFile(six)]);
      const sout = `${short.stdout}${short.stderr}`;
      expect(sout).toContain('FAIL  Auth users and identities are exactly the expected test accounts');
      expect(sout).toContain('1 Auth user is not an expected test account');
      expect(sout).toContain('restore:verify FAILED');
      expect(short.code).toBe(1);
      for (const u of [...six, cast.stranger]) {
        expect(sout).not.toContain(u.id);
        expect(sout).not.toContain(u.subject);
      }
      const exact = await restoreVerify(setDir, url, ['--expected-accounts', accountsFile([...six, cast.stranger])]);
      const eout = `${exact.stdout}${exact.stderr}`;
      expect(eout, eout).toContain('PASS  Auth users and identities are exactly the expected test accounts');
      expect(exact.code).toBe(0);
    } finally {
      await server.stop();
    }
    // Read back directly. PGlite is one shared backend: the tools' session
    // settings (row_security = off) outlive their connections there, unlike
    // on a real server, so they are reset first.
    await target.exec('reset all');
    const owner = await target.query(
      `select pg_get_userbyid(proowner) as owner from pg_proc where proname = 'is_member'`);
    expect(owner.rows).toEqual([{ owner: 'eden_membership_reader' }]);
    const create = await target.query(
      `select has_schema_privilege('eden_membership_reader', 'eden_private', 'CREATE') as c`);
    expect(create.rows[0].c).toBe(false);
    const ledger = await target.query('select version from supabase_migrations.schema_migrations order by 1');
    expect(ledger.rows.map((r) => r.version)).toEqual(migrationFiles().map((f) => f.split('_')[0]));
    expect((await target.query(`select count(*)::int as n from pg_extension where extname = 'pg_graphql'`)).rows[0].n).toBe(0);

    // Closed gate: an owner gets nothing. Opened (after roster:apply in the
    // drill): the owner reads the task and the money row, a member no money.
    expect(await asUser(target, cast.owner.id, (tx) => rpc(tx, 'my_workspaces'))).toEqual([]);
    // The gate row is absent (never in a set); open it the way access:open does.
    await asAdmin(target, (tx) => tx.query(
      `insert into eden_private.access_gate (id, is_open, changed_by) values (1, true, 'test')
       on conflict (id) do update set is_open = true`));
    const ws = await asUser(target, cast.owner.id, (tx) => rpc(tx, 'my_workspaces'));
    expect(ws.map((w) => w.kind).sort()).toEqual(['home_building', 'stay_eden_ops']);
    const money = await asUser(target, cast.owner.id, (tx) => tx.query('select estimated_cents from eden.task_budgets'));
    expect(money.rows.map((r) => Number(r.estimated_cents))).toEqual([4200]);
    const hidden = await asUser(target, cast.homeMember.id, (tx) => tx.query('select estimated_cents from eden.task_budgets'));
    expect(hidden.rows).toEqual([]);
    await target.close();
  });

  it('refuses a database that already holds Eden (never in place)', async () => {
    if (!tools) return;
    const url = localUrl(sourceServer.server.address().port);
    const r = await restoreApply(setDir, url);
    expect(`${r.stdout}${r.stderr}`).toMatch(/already holds Eden/);
    expect(r.code).toBe(1);
  });

  it('stops at the first failed step and runs none after it', async () => {
    if (!tools) return;
    const target = await newProject();
    // An Auth row that collides with the set: the Auth step must fail.
    await target.query(`insert into auth.users (id, email) values ($1, 'collide@example.test')`, [cast.owner.id]);
    const { server, url } = await serve(target);
    let r;
    try {
      r = await restoreApply(setDir, url);
    } finally {
      await server.stop();
    }
    const out = `${r.stdout}${r.stderr}`;
    expect(out).toContain('FAILED  restore Auth users and identities');
    expect(out).toContain('Stopped at the first error');
    expect(out).not.toContain('restore the Eden schemas and rows');
    expect(r.code).toBe(1);
    // Nothing of Eden arrived, and the Auth step left no partial rows.
    expect((await target.query(`select count(*)::int as n from pg_namespace where nspname = 'eden'`)).rows[0].n).toBe(0);
    expect((await target.query('select count(*)::int as n from auth.users')).rows[0].n).toBe(1);
    await target.close();
  });

  it('refuses an incomplete set folder before connecting to anything', async () => {
    if (!tools) return;
    const partial = mkdtempSync(join(tmpdir(), 'eden-set-'));
    writeFileSync(join(partial, 'manifest.json'), JSON.stringify(manifest));
    const r = await restoreApply(partial, 'postgresql://unused@127.0.0.1:1/none');
    expect(`${r.stdout}${r.stderr}`).toContain('FAIL  set file eden.dump is present');
    expect(r.code).toBe(1);
  });
});
