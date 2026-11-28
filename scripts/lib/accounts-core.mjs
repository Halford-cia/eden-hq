// Who is in a restored copy (review round 2, P1-2). A backup set holds every
// Auth user and identity, including a Google account that signed in once and
// never got a membership, so roster:show (memberships) cannot prove a set is
// synthetic. A drill copy opens only when its Auth rows are exactly the
// expected test accounts: one Google identity each, nothing else.
//
// The expected-accounts file lives outside this repository (Hank's password
// manager), header `user_id,google_subject`, one line per test account,
// copied from `roster:pending` (docs/SETUP.md step 9.2). Reports say how many
// rows differ and how, never an identifier, subject or address.

import { parseCsvRecords } from './csv.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function parseExpectedAccounts(text) {
  const errors = [];
  let recs;
  try {
    recs = parseCsvRecords(text, ['user_id', 'google_subject']);
  } catch (e) {
    return { accounts: [], errors: [e.message] };
  }
  const seenIds = new Set();
  const seenSubjects = new Set();
  const accounts = [];
  for (const r of recs) {
    const id = r.user_id.toLowerCase();
    const subject = r.google_subject;
    if (!UUID_RE.test(id)) errors.push(`line ${r.lineNumber}: user_id is not a UUID`);
    if (!subject) errors.push(`line ${r.lineNumber}: google_subject is empty`);
    if (seenIds.has(id)) errors.push(`line ${r.lineNumber}: the same user_id appears twice`);
    if (subject && seenSubjects.has(subject)) errors.push(`line ${r.lineNumber}: the same google_subject appears twice`);
    seenIds.add(id);
    if (subject) seenSubjects.add(subject);
    accounts.push({ id, subject });
  }
  if (!recs.length) errors.push('the file lists no accounts');
  return { accounts, errors };
}

const n = (count, one, many) => `${count} ${count === 1 ? one : many}`;

/**
 * Compare the database's auth.users and auth.identities with the expected
 * accounts. Returns { ok, problems } with counts only.
 */
export async function checkAccounts(db, expected) {
  const problems = [];
  if (!expected || !expected.length) return { ok: false, problems: ['no expected accounts were given'] };
  const byId = new Map(expected.map((a) => [a.id, a]));

  const { rows: users } = await db.query('select id::text as id from auth.users');
  const { rows: identities } = await db.query(
    'select user_id::text as user_id, provider, provider_id from auth.identities');

  const userIds = new Set(users.map((u) => u.id));
  const strangers = users.filter((u) => !byId.has(u.id)).length;
  if (strangers) problems.push(`${n(strangers, 'Auth user is', 'Auth users are')} not an expected test account`);
  const missing = expected.filter((a) => !userIds.has(a.id)).length;
  if (missing) problems.push(`${n(missing, 'expected test account is', 'expected test accounts are')} not in Auth`);

  let foreign = 0;
  const googleFor = new Map();
  for (const i of identities) {
    const want = byId.get(i.user_id);
    if (!want || i.provider !== 'google' || i.provider_id !== want.subject) {
      foreign += 1;
      continue;
    }
    googleFor.set(i.user_id, (googleFor.get(i.user_id) || 0) + 1);
  }
  // An identity that is not the expected account's own Google identity:
  // another person's, a second provider, or a different Google subject.
  if (foreign) problems.push(`${n(foreign, 'identity is', 'identities are')} not an expected test account`);
  const without = expected.filter((a) => userIds.has(a.id) && googleFor.get(a.id) !== 1).length;
  if (without) problems.push(`${n(without, 'expected test account has', 'expected test accounts have')} no single matching Google identity`);

  return { ok: problems.length === 0, problems };
}
