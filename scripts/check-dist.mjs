#!/usr/bin/env node
// npm run check:dist
// Scans the built files for source maps, key-shaped values and test markers.
// Markers come from EDEN_DIST_MARKERS (comma-separated). Reports name the file
// and rule, never the matched text.

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { keyShapedFindings } from './lib/secrets.mjs';

export function scanDist(dir, markers = []) {
  const problems = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else {
        const rel = relative(dir, p);
        if (name.endsWith('.map')) problems.push(`${rel} · source map in a production build`);
        const text = readFileSync(p).toString('utf8');
        if (/sourceMappingURL=/.test(text)) problems.push(`${rel} · source map reference`);
        for (const f of keyShapedFindings(text)) problems.push(`${rel} · key-shaped value: ${f}`);
        if (markers.some((m) => m && text.includes(m))) problems.push(`${rel} · planted test marker`);
      }
    }
  };
  walk(dir);
  return problems;
}

function main() {
  const dir = resolve(process.cwd(), 'dist');
  if (!existsSync(dir)) {
    console.error('check:dist: no dist/ to check (run npm run build first).');
    process.exit(2);
  }
  const markers = (process.env.EDEN_DIST_MARKERS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const problems = scanDist(dir, markers);
  if (problems.length) {
    console.error('check:dist FAILED:');
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log('check:dist passed.');
}

if (process.argv[1]?.endsWith('check-dist.mjs')) main();
