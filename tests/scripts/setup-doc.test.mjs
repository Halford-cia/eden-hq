// docs/SETUP.md is the procedure Hank follows. These checks hold its order
// to the review (P1-3, P1-4): nothing is used before it exists, the drill
// runs on synthetic data before any real person is enrolled, and the one-
// serving-project rule is kept through the drill.

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { repoRoot, migrationFiles } from '../db/harness.mjs';

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

describe('docs/SETUP.md: the guard, CI and a passing check come before setup (review round 3, P1-1)', () => {
  const titles = sections.map((s) => s.title);
  const beforeIdx = titles.findIndex((t) => /^Before setup/.test(t));
  const before = sections[beforeIdx]?.body || '';
  const b = (s) => {
    // `git push` means the typed command (a code-block line), not prose.
    const k = s === 'git push' ? before.search(/^[ \t]*git push[ \t]*$/m) : before.indexOf(s);
    if (k < 0) throw new Error(`the before-setup section does not contain ${s}`);
    return k;
  };

  it('is the first section, ahead of step 0 and its npm ci on main', () => {
    expect(beforeIdx).toBe(0);
    expect(titles.findIndex((t) => /What you need/.test(t))).toBe(1);
    expect(section(/What you need/).body).toMatch(/merged[\s\S]*npm ci/);
    // Nothing in it installs or tests: main has no package.json until the merge.
    const blocks = [...before.matchAll(/```(?:sh)?\n([\s\S]*?)```/g)].map((m) => m[1]).join('\n');
    expect(blocks).not.toMatch(/^\s*npm /m);
  });

  it('sets the deny-list and the hook before the first push, then activates CI and pushes', () => {
    expect(b('EDEN_DENYLIST_FILE')).toBeLessThan(b('git config core.hooksPath .githooks'));
    expect(b('git config core.hooksPath .githooks')).toBeLessThan(b('git mv docs/ci/github-actions-ci.yml .github/workflows/ci.yml'));
    expect(b('git mv docs/ci/github-actions-ci.yml .github/workflows/ci.yml')).toBeLessThan(b('git push'));
    // No push command of any kind before the hook is on.
    expect(before.slice(0, b('git config core.hooksPath .githooks'))).not.toMatch(/^[ \t]*git push/m);
  });

  it('requires a passing check on the pushed head, makes it required on main, and merges only then', () => {
    expect(b('git push')).toBeLessThan(b('gh pr checks 2 --watch'));
    expect(before).toContain('headRefOid');
    expect(before).toContain('git rev-parse HEAD');
    expect(b('gh pr checks 2 --watch')).toBeLessThan(b('require the status check `test`'));
    expect(b('require the status check `test`')).toBeLessThan(b('Merge #2 only'));
  });

  it('names the check the workflow actually produces', () => {
    const wf = readFileSync(join(repoRoot, 'docs', 'ci', 'github-actions-ci.yml'), 'utf8');
    const job = wf.match(/^jobs:\n {2}([\w-]+):/m)?.[1];
    expect(job).toBe('test');
    expect(wf).not.toMatch(/^ {4}name:/m); // so the check run is named after the job id
    expect(before).toContain(`\`${job}\` **pass**`);
  });

  it('step 7 no longer carries a first push or the activation', () => {
    const s7 = section(/^7\. CI/).body;
    expect(s7).not.toContain('git push');
    expect(s7).not.toContain('gh pr checkout');
  });
});

describe('docs/SETUP.md runs the hosted Realtime check after enrollment (review round 3, P1-5)', () => {
  const s9 = section(/Synthetic test accounts/).body;
  const k = (s) => {
    const i = s9.indexOf(s);
    if (i < 0) throw new Error(`step 9 does not contain ${s}`);
    return i;
  };

  it('a runnable command, after the roster, the open gate and the synthetic projects', () => {
    expect(k('npm run realtime:check')).toBeGreaterThan(k('npm run roster:apply -- <roster file>'));
    expect(k('npm run realtime:check')).toBeGreaterThan(k('npm run access:open'));
    expect(k('npm run realtime:check')).toBeGreaterThan(k('SYNTHETIC Test cottage'));
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
    expect(pkg.scripts['realtime:check']).toBe('node scripts/realtime-check.mjs');
  });

  it('covers the manager, a same-workspace member and a signed-out client, changes in both workspaces, zero deliveries', () => {
    const step = s9.slice(k('Realtime acceptance check'));
    for (const s of ['Manager', 'Helper', 'signed-out client', 'home_building', 'stay_eden_ops', '0 changes delivered', 'realtime:check PASSED']) {
      expect(step).toContain(s);
    }
  });

  it('the acceptance map points at it, not at the publication and HTTP checks alone', () => {
    const stage = readFileSync(join(repoRoot, 'docs', 'STAGE1.md'), 'utf8');
    const row = stage.split('\n').find((l) => l.startsWith('| Realtime'));
    expect(row).toContain('npm run realtime:check');
    expect(row).toContain('§9.8');
    expect(row).not.toMatch(/§3, §6\)/);
  });
});

describe('docs/SETUP.md read-backs match this head (review round 3, P1-2 and P2-3)', () => {
  it('the migration read-back names every migration', () => {
    for (const f of migrationFiles()) expect(doc).toContain(`\`${f.split('_')[0]}\``);
    expect(doc).not.toContain('both Stage 1 migrations');
  });

  it('the drill carries the COMPLETE marker into the decrypted folder', () => {
    const drill = section(/Restore drill/).body;
    expect(drill).toContain('cp <private folder>/<timestamp>/COMPLETE <decrypted set folder>/COMPLETE');
    expect(drill.indexOf('/COMPLETE <decrypted set folder>/COMPLETE')).toBeLessThan(drill.indexOf('npm run restore:apply --'));
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
