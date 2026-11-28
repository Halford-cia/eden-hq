// Local Postgres 17 (PGlite) harness that models the parts of a hosted
// Supabase project Eden HQ relies on: the anon / authenticated / service_role
// API roles, a non-superuser `postgres` that applies migrations (modelled by
// `supabase_postgres`), auth.users / auth.identities, a storage.objects stub,
// and the supabase_realtime publication.
//
// Every row the tests create is SYNTHETIC: example.test addresses, generated
// UUIDs and invented names.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = join(here, '..', '..');
export const migrationsDir = join(repoRoot, 'supabase', 'migrations');

export const MIGRATOR = 'supabase_postgres';

const SUPABASE_SIM = `
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create role ${MIGRATOR} nologin createrole;
alter database template1 owner to ${MIGRATOR};
grant anon, authenticated, service_role to ${MIGRATOR};

create schema auth;
create table auth.users (
  id uuid primary key,
  email text,
  email_confirmed_at timestamptz,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create table auth.identities (
  id uuid primary key default gen_random_uuid(),
  provider_id text not null,
  user_id uuid not null references auth.users (id),
  identity_data jsonb not null default '{}'::jsonb,
  provider text not null,
  email text generated always as (lower(identity_data ->> 'email')) stored,
  created_at timestamptz not null default now(),
  unique (provider_id, provider)
);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  ), '')::uuid
$$;
grant usage on schema auth to anon, authenticated, service_role, ${MIGRATOR};
grant select, references on auth.users, auth.identities to ${MIGRATOR};

create schema storage;
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text,
  name text,
  owner_id text,
  metadata jsonb
);
alter table storage.objects enable row level security;
grant usage on schema storage to anon, authenticated, service_role;

create publication supabase_realtime;

grant usage on schema public to anon, authenticated, service_role;
`;

// What \`supabase db push\` creates on its first run and records for each
// applied migration. A new hosted project does not have it.
const MIGRATION_LEDGER = `
create schema supabase_migrations;
create table supabase_migrations.schema_migrations (version text primary key, statements text[], name text);
alter schema supabase_migrations owner to ${MIGRATOR};
alter table supabase_migrations.schema_migrations owner to ${MIGRATOR};
`;

export function migrationFiles() {
  return readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

/** SQL text without -- line comments and block comments (strings kept). */
export function stripSqlComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
}

/**
 * A new, empty hosted project before any migration: Supabase's roles and
 * schemas, with no Eden objects and no migration ledger.
 */
export async function emptyProject() {
  // Calendar dates stay 'YYYY-MM-DD' strings, as the Data API returns them.
  const db = await PGlite.create({ parsers: { 1082: (v) => v } });
  await db.exec(SUPABASE_SIM);
  await installGraphqlStandIn(db);
  return db;
}

// A hosted project starts with pg_graphql enabled (schema `graphql`), and
// Supabase lets its non-superuser postgres drop it. PGlite has no pg_graphql,
// so a SYNTHETIC stand-in with the same name, schema and a resolver function
// is installed by the migration role (review P0-3: the removal test must
// start with the extension present).
async function installGraphqlStandIn(db) {
  const share = (await db.query(`select setting from pg_config where name = 'SHAREDIR'`)).rows[0].setting;
  const FS = db.mod.FS;
  FS.writeFile(`${share}/extension/pg_graphql.control`, [
    "comment = 'SYNTHETIC stand-in for Supabase pg_graphql'",
    "default_version = '1.5.11'",
    'relocatable = false',
    'schema = graphql',
    'trusted = true',
    '',
  ].join('\n'));
  FS.writeFile(`${share}/extension/pg_graphql--1.5.11.sql`,
    "create function graphql.resolve(query text) returns jsonb language sql stable as $$ select '{}'::jsonb $$;\n"
    + 'grant usage on schema graphql to anon, authenticated, service_role;\n'
    + 'grant execute on function graphql.resolve(text) to anon, authenticated, service_role;\n');
  await db.exec(`set role ${MIGRATOR}; create extension pg_graphql; reset role;`);
}

/** Fresh database with every migration applied, as Supabase's postgres would. */
export async function freshDb({ upTo } = {}) {
  const db = await emptyProject();
  await db.exec(MIGRATION_LEDGER);
  for (const file of migrationFiles()) {
    if (upTo && file > upTo) break;
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    await db.exec(`set role ${MIGRATOR};\n${sql}\nreset role;`);
    const [version, ...rest] = file.replace(/\.sql$/, '').split('_');
    await db.query('insert into supabase_migrations.schema_migrations (version, name) values ($1, $2)',
      [version, rest.join('_')]);
  }
  return db;
}

/** Run queries as the migration/operator role (like a direct connection as postgres). */
export async function asAdmin(db, fn) {
  return db.transaction(async (tx) => {
    await tx.query(`set local role ${MIGRATOR}`);
    return fn(tx);
  });
}

function claimsFor(sub, role) {
  const claims = { role, aud: role };
  if (sub) claims.sub = sub;
  return JSON.stringify(claims);
}

/**
 * Run queries exactly as the Data API would for a request: role
 * `authenticated` (or `anon`), with the verified JWT claims in
 * request.jwt.claims. Extra claims can be planted to prove they grant nothing.
 */
export async function asUser(db, sub, fn, { role = 'authenticated', extraClaims } = {}) {
  return db.transaction(async (tx) => {
    await tx.query(`set local role ${role}`);
    const claims = { ...JSON.parse(claimsFor(sub, role)), ...(extraClaims || {}) };
    await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
    return fn(tx);
  });
}

export async function asAnon(db, fn) {
  return asUser(db, null, fn, { role: 'anon' });
}

/** Call an eden_api operation with named arguments, like supabase-js .rpc(). */
export function rpc(tx, name, args = {}) {
  const keys = Object.keys(args);
  const params = keys.map((k) => {
    const v = args[k];
    return v !== null && typeof v === 'object' ? JSON.stringify(v) : v;
  });
  const list = keys.map((k, i) => `${k} => $${i + 1}`).join(', ');
  return tx.query(`select * from eden_api.${name}(${list})`, params).then((r) => r.rows);
}

/** Expect a promise to reject; returns the error. */
export async function rejects(promise) {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  throw new Error('expected the call to be refused, but it succeeded');
}

/** Create a synthetic Auth user with a Google identity. */
export async function createAuthUser(db, label) {
  const id = randomUUID();
  const subject = `synthetic-google-${label}-${id.slice(0, 8)}`;
  const email = `${label}@example.test`;
  await db.query(
    `insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now())`,
    [id, email],
  );
  await db.query(
    `insert into auth.identities (provider_id, user_id, identity_data, provider)
     values ($1, $2, $3, 'google')`,
    [subject, id, JSON.stringify({ sub: subject, email, email_verified: true })],
  );
  return { id, subject, email, label };
}

export async function workspaceIds(db) {
  const { rows } = await db.query(`select id, kind from eden.workspaces`);
  return Object.fromEntries(rows.map((r) => [r.kind, r.id]));
}

export async function setGate(db, open) {
  await asAdmin(db, (tx) =>
    tx.query(
      `update eden_private.access_gate set is_open = $1, changed_by = 'test', changed_at = now() where id = 1`,
      [open],
    ),
  );
}

export async function addMember(db, workspaceId, user, role, displayName) {
  await asAdmin(db, (tx) =>
    tx.query(
      `insert into eden.workspace_members (workspace_id, user_id, display_name, role)
       values ($1, $2, $3, $4)
       on conflict (workspace_id, user_id)
       do update set role = excluded.role, display_name = excluded.display_name, revoked_at = null`,
      [workspaceId, user.id, displayName || `SYNTHETIC ${user.label}`, role],
    ),
  );
}

export async function revokeMember(db, workspaceId, user) {
  await asAdmin(db, (tx) =>
    tx.query(
      `update eden.workspace_members set revoked_at = now() where workspace_id = $1 and user_id = $2`,
      [workspaceId, user.id],
    ),
  );
}

/**
 * The Stage 1 cast: four owners of both workspaces, the cleaning manager as a
 * member of Stay Eden only, a same-workspace Home member, and a signed-in
 * account with no membership. Gate open.
 */
export async function seedCast(db) {
  const ws = await workspaceIds(db);
  const owners = [];
  for (const label of ['owner-a', 'owner-b', 'owner-c', 'owner-d']) {
    owners.push(await createAuthUser(db, label));
  }
  const manager = await createAuthUser(db, 'manager');
  const homeMember = await createAuthUser(db, 'home-member');
  const stranger = await createAuthUser(db, 'stranger');
  for (const o of owners) {
    await addMember(db, ws.home_building, o, 'owner');
    await addMember(db, ws.stay_eden_ops, o, 'owner');
  }
  await addMember(db, ws.stay_eden_ops, manager, 'member', 'SYNTHETIC Cleaning manager');
  await addMember(db, ws.home_building, homeMember, 'member', 'SYNTHETIC Home helper');
  await setGate(db, true);
  return { ws, owners, owner: owners[0], manager, homeMember, stranger };
}
