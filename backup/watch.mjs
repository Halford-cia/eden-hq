#!/usr/bin/env node
// Cloud Run job `eden-backup-watch`, run hourly. Reads status/latest.json and
// writes one structured log line: eden_backup_watch_ok, or eden_backup_stale
// when the last complete set is older than STALE_AFTER_HOURS (default 26) or
// the record is missing or unreadable. The line carries the age only.

import { readObject } from './gcs.mjs';
import { watchVerdict } from './lib.mjs';

const bucket = process.env.EDEN_STATUS_BUCKET;
const staleAfter = Number(process.env.STALE_AFTER_HOURS || 26);
let text = '';
try {
  text = (await readObject(bucket, 'status/latest.json')).toString('utf8');
} catch {
  text = '';
}
const v = watchVerdict(text, new Date(), staleAfter);
process.stdout.write(`${JSON.stringify({
  severity: v.message === 'eden_backup_watch_ok' ? 'INFO' : 'WARNING', ...v,
})}\n`);
