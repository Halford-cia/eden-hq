#!/usr/bin/env node
// Prints the schema and grant inventory of a fresh local database built only
// from supabase/migrations/, as a JavaScript module. A migration author runs
//   npm run --silent inventory:print > tests/db/inventory.expected.mjs
// reviews every changed line in the diff, and commits it with the migration.

import { freshDb } from '../tests/db/harness.mjs';
import { collectInventory } from '../backup/inventory.mjs';

const db = await freshDb();
const inv = await collectInventory(db);
const lines = [
  '// Reviewed schema and grant inventory (docs/SPEC.md, "Schema and grant inventory").',
  '// Regenerate with `npm run --silent inventory:print > tests/db/inventory.expected.mjs` and',
  '// review every changed line. Any difference from this file fails the tests.',
  '',
  'export default {',
];
for (const [key, rows] of Object.entries(inv)) {
  lines.push(`  ${key}: [`);
  for (const r of rows) lines.push(`    ${JSON.stringify(r)},`);
  lines.push('  ],');
}
lines.push('};');
process.stdout.write(lines.join('\n') + '\n');
await db.close();
