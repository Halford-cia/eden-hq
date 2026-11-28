// The drill's synthetic-only proof (review round 2, P1-2): a set holds every
// Auth user and identity, not only those with a membership, so the restored
// copy's Auth rows are checked against the six expected test accounts
// before it may open. SYNTHETIC identities only.

import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { freshDb, seedCast, createAuthUser, MIGRATOR, repoRoot } from '../db/harness.mjs';
import { parseExpectedAccounts, checkAccounts } from '../../scripts/lib/accounts-core.mjs';
import { parseRegister, openGate, closeGate } from '../../scripts/lib/access-core.mjs';

const DRILL = 'cccccccccccccccccccc';

let db;
let cast;
let six;

const fileOf = (accounts) => ['user_id,google_subject', ...accounts.map((a) => `${a.id},${a.subject}`)].join('\n');

beforeAll(async () => {
  db = await freshDb();
  // The repository's own cast: four owners, the manager and the helper hold
  // memberships; the stranger signed in once and is pending (no membership).
  cast = await seedCast(db);
  six = [...cast.owners, cast.manager, cast.homeMember];
  await db.query(`set role ${MIGRATOR}`);
  // A restored copy arrives with its gate closed.
  await closeGate(db, 'test');
});

describe('parseExpectedAccounts', () => {
  it('reads user_id,google_subject lines', () => {
    const { accounts, errors } = parseExpectedAccounts(fileOf(six));
    expect(errors).toEqual([]);
    expect(accounts).toHaveLength(6);
  });

  it('refuses malformed, duplicate or empty files without echoing values', () => {
    const bad = 'user_id,google_subject\nnot-a-uuid,s1\n'
      + `${six[0].id},${six[0].subject}\n${six[0].id},${six[0].subject}\n${six[1].id},\n`;
    const { errors } = parseExpectedAccounts(bad);
    expect(errors.length).toBeGreaterThanOrEqual(3);
    for (const e of errors) {
      expect(e).not.toContain(six[0].id);
      expect(e).not.toContain(six[0].subject);
    }
    expect(parseExpectedAccounts('user_id,google_subject\n').errors.join()).toMatch(/no accounts/);
  });
});

describe('checkAccounts against the restored Auth rows', () => {
  it('the reviewer\'s fixture: the roster shows six, but a seventh pending account fails the check', async () => {
    const { accounts } = parseExpectedAccounts(fileOf(six));
    const r = await checkAccounts(db, accounts);
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toMatch(/1 Auth user is not an expected test account/);
    expect(r.problems.join('\n')).toMatch(/1 identity is not an expected test account/);
    // Names only: no identifier, subject or address from the database.
    const text = r.problems.join('\n');
    for (const u of [...six, cast.stranger]) {
      expect(text).not.toContain(u.id);
      expect(text).not.toContain(u.subject);
      expect(text).not.toContain(u.email);
    }
  });

  it('passes when the Auth rows are exactly the expected accounts', async () => {
    const all = [...six, cast.stranger];
    const r = await checkAccounts(db, parseExpectedAccounts(fileOf(all)).accounts);
    expect(r).toEqual({ ok: true, problems: [] });
  });

  it('fails on a missing expected account, a wrong subject or a second identity', async () => {
    const all = [...six, cast.stranger];
    const missing = await checkAccounts(db, parseExpectedAccounts(fileOf([...all,
      { id: '00000000-0000-4000-8000-0000000000aa', subject: 'synthetic-google-absent' }])).accounts);
    expect(missing.ok).toBe(false);
    expect(missing.problems.join()).toMatch(/1 expected test account is not in Auth/);

    const wrongSubject = await checkAccounts(db, parseExpectedAccounts(fileOf(all.map((u, i) =>
      (i === 0 ? { ...u, subject: 'synthetic-google-other' } : u)))).accounts);
    expect(wrongSubject.ok).toBe(false);

    const extra = await freshDb();
    const u = await createAuthUser(extra, 'second-identity');
    await extra.query(`insert into auth.identities (provider_id, user_id, identity_data, provider)
                       values ('synthetic-other', $1, '{}', 'email')`, [u.id]);
    const second = await checkAccounts(extra, parseExpectedAccounts(fileOf([u])).accounts);
    expect(second.ok).toBe(false);
    expect(second.problems.join()).toMatch(/identit/);
  });
});

describe('access:open --synthetic-data needs the expected accounts to match', () => {
  const reg = () => parseRegister(`ref,publishable_key,purpose,state\n${DRILL},k,drill,closed\n`).entries;
  const connect = async () => db;

  it('refuses without an expected-accounts list', async () => {
    const r = await openGate({ register: reg(), targetRef: DRILL, connect, by: 'test', synthetic: true });
    expect(r.opened).toBe(false);
    expect(r.refusals.join()).toMatch(/expected-accounts/);
  });

  it('refuses when the copy holds an account that is not an expected test account; the gate stays closed', async () => {
    const r = await openGate({
      register: reg(), targetRef: DRILL, connect, by: 'test', synthetic: true,
      expectedAccounts: parseExpectedAccounts(fileOf(six)).accounts,
    });
    expect(r.opened).toBe(false);
    expect(r.refusals.join()).toMatch(/not an expected test account/);
    const { rows } = await db.query('select is_open from eden_private.access_gate where id = 1');
    expect(rows[0].is_open).toBe(false);
  });

  it('opens when they match exactly', async () => {
    await closeGate(db, 'test');
    const r = await openGate({
      register: reg(), targetRef: DRILL, connect, by: 'test', synthetic: true,
      expectedAccounts: parseExpectedAccounts(fileOf([...six, cast.stranger])).accounts,
    });
    expect(r.opened).toBe(true);
    await closeGate(db, 'test');
  });
});

describe('the scripts', () => {
  it('access:open refuses an expected-accounts file inside the repository', () => {
    const dir = mkdtempSync(join(tmpdir(), 'eden-accounts-'));
    const register = join(dir, 'register.csv');
    writeFileSync(register, `ref,publishable_key,purpose,state\n${DRILL},k,drill,closed\n`);
    const r = spawnSync(process.execPath, [join(repoRoot, 'scripts', 'access.mjs'), 'open', register,
      '--synthetic-data', '--expected-accounts', join(repoRoot, 'package.json')], { input: '\n', encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/outside this repository/);
  });

  it('access:open --synthetic-data without --expected-accounts refuses before asking for anything', () => {
    const dir = mkdtempSync(join(tmpdir(), 'eden-accounts-'));
    const register = join(dir, 'register.csv');
    writeFileSync(register, `ref,publishable_key,purpose,state\n${DRILL},k,drill,closed\n`);
    const r = spawnSync(process.execPath, [join(repoRoot, 'scripts', 'access.mjs'), 'open', register,
      '--synthetic-data'], { input: '\n', encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--expected-accounts/);
  });
});
