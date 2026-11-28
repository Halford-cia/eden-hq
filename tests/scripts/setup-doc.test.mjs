// docs/SETUP.md is the procedure Hank follows. These checks hold its order
// to the review (P1-3, P1-4): nothing is used before it exists, the drill
// runs on synthetic data before any real person is enrolled, and the one-
// serving-project rule is kept through the drill.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from '../db/harness.mjs';

const doc = readFileSync(join(repoRoot, 'docs', 'SETUP.md'), 'utf8');
const sections = doc.split(/^## /m).slice(1).map((s) => ({ title: s.split('\n')[0], body: s }));
const section = (re) => {
  const s = sections.find((x) => re.test(x.title));
  if (!s) throw new Error(`SETUP.md has no section matching ${re}`);
  return s;
};
const at = (needle, from = 0) => {
  const i = doc.indexOf(needle, from);
  if (i < 0) throw new Error(`SETUP.md does not contain ${needle}`);
  return i;
};

describe('docs/SETUP.md order', () => {
  it('exposes eden_api only after the migrations create it (P1-4)', () => {
    expect(at('Exposed schemas')).toBeGreaterThan(at('db push'));
  });

  it('lists the PostgreSQL client tools with a version check before anything uses them (P1-4)', () => {
    const need = section(/What you need/).body;
    expect(need).toMatch(/libpq/);
    expect(need).toMatch(/psql --version/);
    expect(need).toMatch(/pg_restore --version/);
    expect(need).toMatch(/17 or later/);
  });

  it('restores with restore:apply, which stops on the first error, not hand-typed commands (P1-1)', () => {
    const drill = section(/Restore drill/).body;
    expect(drill).toContain('npm run restore:apply --');
    expect(drill).not.toMatch(/^\s*pg_restore /m);
    expect(drill).toContain('npm run restore:verify --');
  });

  it('runs the drill on synthetic identities before any real person is enrolled (P1-3)', () => {
    const synthetic = sections.findIndex((s) => /Synthetic test accounts/.test(s.title));
    const drill = sections.findIndex((s) => /Restore drill/.test(s.title));
    const real = sections.findIndex((s) => /Real users/.test(s.title));
    expect(synthetic).toBeGreaterThanOrEqual(0);
    expect(synthetic).toBeLessThan(drill);
    expect(drill).toBeLessThan(real);
    const body = sections[synthetic].body;
    expect(body).toMatch(/six/i);
    expect(body).not.toMatch(/family|cleaning manager's own/i);
  });

  it('changes the synthetic roster after the snapshot, closes production before opening the drill, and reopens it after (P1-3)', () => {
    const drill = section(/Restore drill/).body;
    const i = (s) => {
      const k = drill.indexOf(s);
      if (k < 0) throw new Error(`the drill does not contain ${s}`);
      return k;
    };
    expect(i('COMPLETE')).toBeLessThan(i('downgrade'));
    expect(i('npm run access:close')).toBeLessThan(i('--synthetic-data'));
    expect(drill).toMatch(/mark production `closed`/);
    expect(i('--synthetic-data')).toBeLessThan(i('`deleted`'));
    expect(drill).toMatch(/Reopen production/);
    expect(i('`deleted`')).toBeLessThan(i('Reopen production'));
    // The positive closed-gate check stays, before roster:apply.
    expect(i('gate holds')).toBeLessThan(i('npm run roster:apply'));
    // How the drill is reached: a local app pointed at the drill only.
    expect(drill).toContain('npm run dev');
    expect(drill).toContain('/auth/v1/callback');
  });
});
