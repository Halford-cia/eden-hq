// docs/SETUP.md is the procedure Hank follows. These checks hold its order
// to the review (P1-3, P1-4): nothing is used before it exists, the drill
// runs on synthetic data before any real person is enrolled, and the one-
// serving-project rule is kept through the drill.

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
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

// Shell code blocks of the document: [{ text, lines }].
const codeBlocks = [...doc.matchAll(/^[ \t]*```(\w*)\n([\s\S]*?)^[ \t]*```/gm)]
  .filter((m) => ['sh', 'bash', 'zsh', ''].includes(m[1]))
  .map((m) => m[2].replace(/^ {3,4}/gm, ''));
// Commands as typed: continuation lines joined.
const commands = codeBlocks.flatMap((b) => b.replace(/\\\n\s*/g, ' ').split('\n'));

describe('docs/SETUP.md keeps database passwords out of shell history (review round 2, P0-4)', () => {
  it('no typed command carries a connection string or a password', () => {
    for (const c of commands) {
      expect(c, c).not.toMatch(/postgres(ql)?:\/\//);
      expect(c, c).not.toMatch(/<[^>]*(string|password)[^>]*>/i);
      expect(c, c).not.toMatch(/PGPASSWORD=|password=/i);
    }
  });

  it('psql runs from connection options without a password and prompts for it with -W', () => {
    const psql = commands.filter((c) => /^\s*psql\b/.test(c) && !/--version/.test(c));
    expect(psql.length).toBeGreaterThan(0);
    for (const c of psql) {
      expect(c, c).toMatch(/\s-W\b/);
      expect(c, c).toMatch(/sslmode=verify-full/);
      expect(c, c).toMatch(/sslrootcert=/);
    }
  });

  it('the documented psql command leaves no password in zsh history', () => {
    const zsh = '/bin/zsh';
    let has = true;
    try {
      execFileSync(zsh, ['-f', '-c', 'true']);
    } catch {
      has = false;
    }
    if (!has) return; // CI (Linux) has no zsh; the two checks above still hold.
    const psql = commands.find((c) => /^\s*psql\b/.test(c) && !/--version/.test(c));
    // An interactive zsh with history on, psql replaced by a no-op, the
    // placeholders filled with SYNTHETIC values.
    const home = mkdtempSync(join(tmpdir(), 'eden-hist-'));
    const hist = join(home, '.zsh_history');
    // A connection-string placeholder is filled the way step 8 builds the
    // string, with a SYNTHETIC password; every other placeholder plainly.
    // Built through URL so no connection-string-with-password literal sits
    // in this public file (check:public).
    const filled = new URL('postgresql://pooler.example.test:5432/postgres');
    filled.username = 'postgres.synthetic';
    filled.password = 'SYNTHETICPW';
    const typed = psql
      .replace(/<[^>]*string[^>]*>/gi, filled.toString())
      .replace(/<[^>]+>/g, 'SYNTHETIC')
      .replace(/\s#.*$/, '');
    execFileSync(zsh, ['-f', '-i', '-c', [
      `HISTFILE=${hist}; SAVEHIST=100; HISTSIZE=100; setopt INC_APPEND_HISTORY`,
      'psql() { :; }',
      `print -s -- ${JSON.stringify(typed)}`,
      'fc -W',
    ].join('\n')], { env: { HOME: home, PATH: process.env.PATH }, stdio: 'ignore' });
    const saved = readFileSync(hist, 'utf8');
    expect(saved).toContain('psql');
    expect(saved).not.toContain('SYNTHETICPW');
    expect(saved).not.toMatch(/password=|:\/\/[^@\s]*:[^@\s]*@/i);
  });
});

describe('docs/SETUP.md drill proves who is in the copy (review round 2, P1-2)', () => {
  const drill = section(/Restore drill/).body;

  it('step 9 records the six test accounts in a private expected-accounts file', () => {
    const s9 = section(/Synthetic test accounts/).body;
    expect(s9).toMatch(/expected-accounts file/);
    expect(s9).toContain('user_id,google_subject');
  });

  it('restore:verify and every --synthetic-data opening check the copy against that file', () => {
    expect(drill).toMatch(/npm run restore:verify -- <decrypted set folder> --expected-accounts <expected-accounts file>/);
    const opens = doc.split('\n').filter((l) => l.includes('--synthetic-data') && l.includes('npm run access:open'));
    expect(opens.length).toBeGreaterThan(0);
    for (const l of opens) expect(l, l).toContain('--expected-accounts');
  });

  it('roster:show is not offered as the proof that the set is synthetic', () => {
    const s1 = drill.split(/\n2\. /)[0];
    expect(s1).not.toMatch(/roster:show[^.]*confirm only the six test accounts/);
    expect(s1).toMatch(/Authentication → Users/);
  });
});

describe('docs/SETUP.md Scheduler targets (review round 2, P1-3)', () => {
  const block = codeBlocks.find((b) => b.includes('gcloud scheduler jobs create http'));

  it('names each target outright: no shell variable before :run, which zsh reads as a :r modifier', () => {
    expect(block).toContain('/jobs/eden-backup:run"');
    expect(block).toContain('/jobs/eden-backup-watch:run"');
    expect(block).not.toMatch(/\$\{?\w+\}?:run/);
  });

  for (const shell of ['/bin/zsh', '/bin/bash']) {
    it(`expands to the two Cloud Run job targets in ${shell}`, () => {
      try {
        execFileSync(shell, ['-c', 'true']);
      } catch {
        return; // not installed here (CI has no zsh)
      }
      // gcloud replaced by printing its --uri value; placeholders SYNTHETIC.
      const script = 'gcloud() { while [ $# -gt 0 ]; do [ "$1" = --uri ] && printf "%s\\n" "$2"; shift; done; }\n'
        + block.replace(/<p>/g, 'p-synthetic').replace(/<r>/g, 'us-central1');
      const out = execFileSync(shell, ['-c', script], { encoding: 'utf8' }).trim().split('\n');
      expect(out).toEqual([
        'https://run.googleapis.com/v2/projects/p-synthetic/locations/us-central1/jobs/eden-backup:run',
        'https://run.googleapis.com/v2/projects/p-synthetic/locations/us-central1/jobs/eden-backup-watch:run',
      ]);
    });
  }
});
