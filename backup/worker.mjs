#!/usr/bin/env node
// Cloud Run job `eden-backup` (docs/SPEC.md, "Hosted daily set"), Stage 1.
//
// Order: (1) close the gate of every superseded project that answers;
// (2) [Stage 2: claim stale receipt reservations]; (3) in one repeatable-read
// snapshot dump roles, schema and data (leaving out the access gate's data)
// and record row counts and applied migrations; (4) [Stage 2: receipt
// manifest]; (5) encrypt every file with the age public key, upload, write
// the manifest, then COMPLETE last; (6) [Stage 2: disposal]; then the status
// record. A failure writes a failed status that keeps the previous recovery
// point, and exits non-zero (Cloud Monitoring alerts Hank).
//
// Environment (Secret Manager versions pinned on the job, never `latest`):
//   EDEN_DB_URL               serving project's connection string (secret eden-db-url)
//   EDEN_SUPERSEDED_DB_URLS   newline-separated former projects (secret eden-superseded-db-urls)
//   EDEN_AGE_RECIPIENT        age public key (not secret)
//   EDEN_DB_CA_PEM            Supabase CA certificate text (public, not secret)
//   EDEN_BACKUP_BUCKET        eden-hq-backups-<suffix>
//   EDEN_STATUS_BUCKET        eden-hq-backup-status-<suffix>
// Logs name no project, row, total or object key.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import pg from 'pg';
import {
  setTimestamp, setObjectNames, snapshotFacts, buildManifest, edenRolesOnly, statusRecord, closeSuperseded, dumpCommands,
} from './lib.mjs';
import { uploadObject, readObject } from './gcs.mjs';

const STAGE = 1;

function log(message, extra = {}, severity = 'INFO') {
  process.stdout.write(`${JSON.stringify({ severity, message, ...extra })}\n`);
}

function need(name) {
  const v = process.env[name];
  if (!v) throw new Error(`missing environment variable ${name}`);
  return v;
}

function run(cmd, args, { input, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    let errText = '';
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => { errText += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      // Tool stderr can name objects; report the tool and exit code only.
      else reject(new Error(`${cmd} exited ${code}${errText ? ' (details suppressed)' : ''}`));
    });
    if (input) child.stdin.end(input); else child.stdin.end();
  });
}

const encrypt = (buf, recipient) => run('age', ['-r', recipient], { input: buf });

// The Supabase CA certificate (public, from the dashboard) arrives as
// EDEN_DB_CA_PEM; every database connection verifies the server against it.
const CA_PATH = '/tmp/eden-supabase-ca.crt';
let caPem = null;
function tlsSetup() {
  caPem = need('EDEN_DB_CA_PEM');
  writeFileSync(CA_PATH, caPem, { mode: 0o600 });
  process.env.PGSSLMODE = 'verify-full';
  process.env.PGSSLROOTCERT = CA_PATH;
}

async function connect(url) {
  const client = new pg.Client({
    connectionString: url,
    application_name: 'eden-backup',
    connectionTimeoutMillis: 15000,
    ssl: { ca: caPem, rejectUnauthorized: true },
  });
  await client.connect();
  return client;
}

async function main() {
  const startedAt = new Date();
  const ts = setTimestamp(startedAt);
  const names = setObjectNames(ts);
  const backupBucket = need('EDEN_BACKUP_BUCKET');
  const statusBucket = need('EDEN_STATUS_BUCKET');
  let previous = null;
  try {
    previous = JSON.parse((await readObject(statusBucket, names.latest)).toString('utf8'));
  } catch {
    previous = null;
  }

  let fileCount = 0;
  let encryptedBytes = 0;
  try {
    const dbUrl = need('EDEN_DB_URL');
    const recipient = need('EDEN_AGE_RECIPIENT');
    tlsSetup();

    // 1. Superseded projects.
    // One connection string per line; lines starting with # are ignored (the
    // first version of the secret holds only "# none").
    const superseded = (process.env.EDEN_SUPERSEDED_DB_URLS || '').split('\n').map((s) => s.trim())
      .filter((s) => s && !s.startsWith('#'));
    for (const url of superseded) {
      const msg = await closeSuperseded(() => connect(url));
      log(msg, {}, msg === 'eden_superseded_was_open' ? 'WARNING' : 'INFO');
    }

    // 3. One repeatable-read snapshot for the dump and the facts.
    const db = await connect(dbUrl);
    const files = [];
    let facts;
    try {
      await db.query('begin isolation level repeatable read read only');
      const { rows: [{ snap }] } = await db.query('select pg_export_snapshot() as snap');
      facts = await snapshotFacts(db);
      // The same commands the local clean-restore test runs (dumpCommands).
      for (const step of dumpCommands({ dbUrl, snapshot: snap })) {
        let buf = await run(step.cmd, step.args);
        if (step.name === 'roles.sql') buf = Buffer.from(edenRolesOnly(buf.toString('utf8')));
        files.push({ name: step.name, buf, bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') });
      }
      await db.query('commit');
    } finally {
      await db.end();
    }

    // 5. Encrypt and upload; manifest; COMPLETE last.
    for (const f of files) {
      const enc = await encrypt(f.buf, recipient);
      await uploadObject(backupBucket, names.file(f.name), enc);
      fileCount += 1;
      encryptedBytes += enc.length;
    }
    const manifest = Buffer.from(JSON.stringify(buildManifest({ stage: STAGE, facts, files }), null, 2));
    const encManifest = await encrypt(manifest, recipient);
    await uploadObject(backupBucket, names.manifest, encManifest);
    fileCount += 1;
    encryptedBytes += encManifest.length;
    await uploadObject(backupBucket, names.complete, Buffer.from('complete\n'));

    const status = statusRecord({
      startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(), state: 'complete',
      lastComplete: facts.recoveryPoint, fileCount, encryptedBytes,
    });
    await uploadObject(statusBucket, names.status, Buffer.from(JSON.stringify(status)), { create: true });
    await uploadObject(statusBucket, names.latest, Buffer.from(JSON.stringify(status)), { create: false });
    log('eden_backup_complete', { file_count: fileCount });
  } catch (e) {
    log('eden_backup_failed', { reason: String(e.message).split('\n')[0] }, 'ERROR');
    const status = statusRecord({
      startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(), state: 'failed',
      lastComplete: previous?.last_complete_recovery_point || null, fileCount, encryptedBytes,
    });
    try {
      await uploadObject(statusBucket, names.status, Buffer.from(JSON.stringify(status)), { create: true });
      await uploadObject(statusBucket, names.latest, Buffer.from(JSON.stringify(status)), { create: false });
    } catch {
      log('eden_backup_status_write_failed', {}, 'ERROR');
    }
    process.exit(1);
  }
}

main();
