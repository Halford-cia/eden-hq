#!/usr/bin/env node
// npm run realtime:check
//
// The hosted Realtime acceptance check (docs/SETUP.md step 9.8; review round
// 3, P1-5). Run it after the synthetic roster is applied and the gate is
// open. It asks, at hidden prompts, for the project URL, the publishable key
// and three access tokens copied from signed-in browser windows: Owner A
// (who makes the synthetic changes), the Manager (Stay Eden member) and the
// Helper (Home member). A fourth subscriber is signed out.
//
// Each of the three subscribers opens a channel on Postgres changes for
// every Eden table and every Eden schema. Owner A then creates, updates,
// moves to Done and archives one synthetic item in a SYNTHETIC project of
// each workspace. PASS needs every change made and zero deliveries to every
// subscriber. It prints subscriber names, channel states and counts only;
// tokens are never echoed, stored or logged (they expire within the hour).
// Exit 0 on PASS, 1 on FAIL, 2 on a usage problem.

import { createClient } from '@supabase/supabase-js';
import { promptHidden } from './lib/connect.mjs';
import { runRealtimeCheck } from './lib/realtime-core.mjs';

const url = (await promptHidden('Project URL (https://<ref>.supabase.co): ')).replace(/\/+$/, '');
if (!/^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(url)) {
  console.error('Refused: the project URL must look like https://<ref>.supabase.co.');
  process.exit(2);
}
const key = await promptHidden('Publishable key (sb_publishable_…, hidden): ');
if (!key.startsWith('sb_publishable_')) {
  console.error('Refused: use the publishable key, never the secret key.');
  process.exit(2);
}
const tokenFor = async (who) => {
  const t = await promptHidden(`${who}'s access token (hidden): `);
  if (t.split('.').length !== 3) {
    console.error(`Refused: that is not an access token for ${who} (docs/SETUP.md step 9.8 says where to copy it).`);
    process.exit(2);
  }
  return t;
};
const ownerToken = await tokenFor('Owner A');
const managerToken = await tokenFor('the Manager');
const helperToken = await tokenFor('the Helper');

const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
const signedIn = (token) => createClient(url, key, { ...options, accessToken: async () => token });
const result = await runRealtimeCheck({
  stamp: new Date().toISOString(),
  clients: {
    owner: signedIn(ownerToken),
    subscribers: [
      { name: 'signed-out client', client: createClient(url, key, options) },
      { name: 'Manager', client: signedIn(managerToken) },
      { name: 'Helper', client: signedIn(helperToken) },
    ],
  },
});
for (const line of result.lines) console.log(line);
process.exit(result.ok ? 0 : 1);
