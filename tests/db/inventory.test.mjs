// The reviewed schema and grant inventory, on a database built only from
// supabase/migrations/. Any difference fails.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  freshDb, emptyProject, migrationFiles, migrationsDir, stripSqlComments, repoRoot,
} from './harness.mjs';
import { collectInventory } from '../../backup/inventory.mjs';
import expected from './inventory.expected.mjs';

let inv;
let graphqlDb;

beforeAll(async () => {
  const db = await freshDb();
  graphqlDb = db;
  inv = await collectInventory(db);
});

describe('schema and grant inventory', () => {
  for (const key of Object.keys(expected)) {
    it(`matches the reviewed inventory: ${key}`, () => {
      expect(inv[key]).toEqual(expected[key]);
    });
  }

  it('has no unreviewed inventory sections', () => {
    expect(Object.keys(inv).sort()).toEqual(Object.keys(expected).sort());
  });

  it('enables RLS on every Eden table', () => {
    expect(inv.rls.length).toBeGreaterThan(0);
    expect(inv.rls.every((r) => r.rls === true)).toBe(true);
  });

  it('gives anon and PUBLIC nothing in the Eden schemas', () => {
    const eden = (r) => r.schema.startsWith('eden');
    for (const key of ['schemaUsage', 'relations', 'columns', 'functions']) {
      const leaked = inv[key].filter((r) => eden(r) && r.grantee !== 'authenticated');
      expect(leaked).toEqual([]);
    }
  });

  it('exposes no base table or view to the app role, only column grants', () => {
    expect(inv.relations).toEqual([]);
  });

  it('has exactly one SECURITY DEFINER function in Stage 1, owned by its own role, empty search_path', () => {
    expect(inv.definers).toEqual([
      { schema: 'eden_private', name: 'is_member', owner: 'eden_membership_reader', config: 'search_path=""' },
    ]);
  });

  it('keeps money out of every operational API name, argument and result field', () => {
    const money = /cents|cost|vendor_name|payment|category|receipt|budget|amount|total|variance/;
    const fns = inv.functions.filter((f) => f.schema === 'eden_api').map((f) => f.name);
    for (const f of fns) expect(f).not.toMatch(money);
    // Every published operation has a pinned result, and no result field is money.
    const pinned = inv.apiResults.map((r) => r.name).sort();
    expect(pinned).toEqual([...new Set(fns)].sort());
    for (const r of inv.apiResults) expect(r.returns, r.name).not.toMatch(money);
  });

  it('puts no Eden table in the Realtime publication and adds no storage policy', () => {
    expect(inv.realtime).toEqual([]);
    expect(inv.storagePolicies).toEqual([]);
  });

  it('removes the GraphQL extension', () => {
    expect(inv.extensions).toEqual([]);
  });

  // Review P0-3: the fixture must start the way a hosted project does, with
  // pg_graphql installed, or the assertion above proves nothing.
  it('starts from a project that has pg_graphql installed, so the removal is real', async () => {
    const empty = await emptyProject();
    const { rows } = await empty.query(`select extname from pg_extension where extname = 'pg_graphql'`);
    expect(rows).toEqual([{ extname: 'pg_graphql' }]);
    const graphqlSchema = await empty.query(`select 1 from pg_namespace where nspname = 'graphql'`);
    expect(graphqlSchema.rows).toHaveLength(1);
  });

  it('leaves no GraphQL resolver for anon or authenticated to call', async () => {
    for (const role of ['anon', 'authenticated']) {
      const err = await graphqlDb.transaction(async (tx) => {
        await tx.query(`set local role ${role}`);
        try {
          await tx.query(`select graphql.resolve('{__schema{types{name}}}')`);
          return null;
        } catch (e) {
          return e;
        }
      });
      expect(err, role).toBeTruthy();
      expect(['3F000', '42883', '42501'], role).toContain(err.code);
    }
  });

  it('no migration re-creates the GraphQL extension', () => {
    for (const file of migrationFiles()) {
      const sql = stripSqlComments(readFileSync(join(migrationsDir, file), 'utf8'));
      expect(sql, file).not.toMatch(/create\s+extension[^;]*pg_graphql/i);
    }
  });
});

// Review round 2, P0-3: the inventory must see what the app roles can reach
// in EVERY schema, not a hard-coded list. Each case below adds one harmless
// SYNTHETIC object reachable by an app role on a fresh database and expects
// the collected inventory to differ from the reviewed one.
describe('access in a schema the inventory was not told about', () => {
  const MIGRATOR_SQL = (sql) => `set role supabase_postgres;\n${sql}\nreset role;`;

  async function withExtra(sql) {
    const db = await freshDb();
    await db.exec(MIGRATOR_SQL(sql));
    return collectInventory(db);
  }

  function differs(extra) {
    return Object.keys(expected).some((k) => JSON.stringify(extra[k]) !== JSON.stringify(expected[k]));
  }

  it('the reviewer\'s case: a constant view in a new schema, usage and select granted to authenticated', async () => {
    const extra = await withExtra(`
      create schema synthetic_side;
      create view synthetic_side.one as select 1 as x;
      grant usage on schema synthetic_side to authenticated;
      grant select on synthetic_side.one to authenticated;`);
    expect(differs(extra)).toBe(true);
    expect(extra.schemaUsage).toContainEqual({ schema: 'synthetic_side', grantee: 'authenticated', privilege: 'USAGE' });
    expect(extra.relations).toContainEqual(
      { schema: 'synthetic_side', name: 'one', kind: 'v', grantee: 'authenticated', privilege: 'SELECT' });
  });

  it('a grant to PUBLIC reaches both app roles and is listed for each', async () => {
    const extra = await withExtra(`
      create schema synthetic_public;
      create table synthetic_public.t (x int);
      grant usage on schema synthetic_public to public;
      grant select on synthetic_public.t to public;`);
    expect(differs(extra)).toBe(true);
    for (const grantee of ['anon', 'authenticated']) {
      expect(extra.relations).toContainEqual(
        { schema: 'synthetic_public', name: 't', kind: 'r', grantee, privilege: 'SELECT' });
    }
  });

  it('access inherited through a role the app role belongs to', async () => {
    const extra = await withExtra(`
      create schema synthetic_inherit;
      create view synthetic_inherit.v as select 1 as x;
      create role synthetic_reader nologin;
      grant usage on schema synthetic_inherit to synthetic_reader;
      grant select on synthetic_inherit.v to synthetic_reader;
      grant synthetic_reader to authenticated with inherit true;`);
    expect(differs(extra)).toBe(true);
    expect(extra.relations).toContainEqual(
      { schema: 'synthetic_inherit', name: 'v', kind: 'v', grantee: 'authenticated', privilege: 'SELECT' });
    expect(extra.apiRoleMemberships.map((r) => r.role)).toContain('synthetic_reader');
  });

  it('a role the app role can only SET ROLE to (no inherit) is still listed', async () => {
    const extra = await withExtra(`
      create role synthetic_settable nologin;
      grant synthetic_settable to anon with inherit false, set true;`);
    expect(differs(extra)).toBe(true);
    expect(extra.apiRoleMemberships).toContainEqual(
      { member: 'anon', role: 'synthetic_settable', inherit: false, set: true });
  });

  it('a function in a new schema, a column grant and a sequence', async () => {
    const extra = await withExtra(`
      create schema synthetic_more;
      grant usage on schema synthetic_more to anon;
      create function synthetic_more.f() returns int language sql as $$ select 1 $$;
      grant execute on function synthetic_more.f() to anon;
      create table synthetic_more.t (a int, b int);
      grant select (a) on synthetic_more.t to anon;
      create sequence synthetic_more.s;
      grant usage on sequence synthetic_more.s to anon;`);
    expect(differs(extra)).toBe(true);
    expect(extra.functions).toContainEqual({ schema: 'synthetic_more', name: 'f()', grantee: 'anon', privilege: 'EXECUTE' });
    expect(extra.columns).toContainEqual(
      { schema: 'synthetic_more', name: 't', column: 'a', grantee: 'anon', privilege: 'SELECT' });
    expect(extra.relations).toContainEqual(
      { schema: 'synthetic_more', name: 's', kind: 'S', grantee: 'anon', privilege: 'USAGE' });
  });

  it('outside the Eden schemas, only the reviewed platform baseline is reachable', () => {
    // The fixture models a new hosted project; these are its built-in
    // objects the app roles can reach. Anything else is a finding.
    const PLATFORM = new Set(['auth', 'graphql', 'public', 'storage']);
    for (const key of ['schemaUsage', 'relations', 'columns', 'functions']) {
      const outside = inv[key].filter((r) => !r.schema.startsWith('eden'));
      for (const r of outside) expect(PLATFORM.has(r.schema), `${key}: ${JSON.stringify(r)}`).toBe(true);
    }
    // No platform table or view is reachable at all, and the only platform
    // function is auth.uid().
    expect(inv.relations.filter((r) => !r.schema.startsWith('eden'))).toEqual([]);
    expect(inv.columns.filter((r) => !r.schema.startsWith('eden'))).toEqual([]);
    expect([...new Set(inv.functions.filter((r) => !r.schema.startsWith('eden')).map((r) => `${r.schema}.${r.name}`))])
      .toEqual(['auth.uid()']);
    expect(inv.apiRoleMemberships).toEqual([]);
  });

  // Dropping pg_graphql leaves its empty schema behind, still carrying the
  // extension's USAGE grants (the widened inventory found it). It must stay
  // empty: nothing in it is reachable by an app role.
  it('the schema pg_graphql leaves behind holds nothing an app role can reach', async () => {
    for (const key of ['relations', 'columns', 'functions']) {
      expect(inv[key].filter((r) => r.schema === 'graphql'), key).toEqual([]);
    }
    const { rows } = await graphqlDb.query(
      `select count(*)::int as n from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'graphql'`);
    expect(rows[0].n).toBe(0);
  });
});

describe('Data API settings in supabase/config.toml', () => {
  const toml = readFileSync(join(repoRoot, 'supabase', 'config.toml'), 'utf8');
  it('exposes exactly eden_api', () => {
    const api = toml.split(/^\[/m).find((s) => s.startsWith('api]'));
    const schemas = api.match(/^schemas\s*=\s*\[(.*)\]/m)[1];
    expect(schemas.split(',').map((s) => s.trim().replace(/"/g, ''))).toEqual(['eden_api']);
    expect(api).toMatch(/^extra_search_path\s*=\s*\[\]/m);
  });
  it('disables Realtime, anonymous, email and phone sign-in', () => {
    expect(toml).toMatch(/\[realtime\]\n(#.*\n)*enabled = false/);
    expect(toml).toMatch(/enable_anonymous_sign_ins = false/);
    expect(toml).toMatch(/\[auth\.email\]\nenable_signup = false/);
    expect(toml).toMatch(/\[auth\.sms\]\nenable_signup = false/);
  });
});
