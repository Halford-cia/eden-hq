// The reviewed schema and grant inventory, on a database built only from
// supabase/migrations/. Any difference fails.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { freshDb, repoRoot } from './harness.mjs';
import { collectInventory } from './inventory.mjs';
import expected from './inventory.expected.mjs';

let inv;

beforeAll(async () => {
  const db = await freshDb();
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

  it('keeps money columns out of every operational API result', () => {
    const money = /cents|cost|vendor_name|payment|category|receipt|budget|amount|total|variance/;
    const fns = inv.functions.filter((f) => f.schema === 'eden_api').map((f) => f.name);
    for (const f of fns) expect(f).not.toMatch(money);
  });

  it('puts no Eden table in the Realtime publication and adds no storage policy', () => {
    expect(inv.realtime).toEqual([]);
    expect(inv.storagePolicies).toEqual([]);
  });

  it('removes the GraphQL extension', () => {
    expect(inv.extensions).toEqual([]);
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
