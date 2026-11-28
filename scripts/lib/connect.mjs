// Database connections for the operator scripts. The connection string is
// typed at a hidden prompt; it is never echoed, stored or logged.

import pg from 'pg';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Refuse a remote connection string that does not verify the server. */
export function checkConnectionString(conn) {
  let url;
  try {
    url = new URL(conn);
  } catch {
    return 'that is not a postgresql:// connection string';
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    return 'that is not a postgresql:// connection string';
  }
  if (LOCAL_HOSTS.has(url.hostname)) return null;
  const mode = url.searchParams.get('sslmode');
  if (mode !== 'verify-full' || !url.searchParams.get('sslrootcert')) {
    return 'a remote connection must end with ?sslmode=verify-full&sslrootcert=<path to the Supabase CA certificate> (docs/SETUP.md)';
  }
  return null;
}

export async function connect(conn) {
  const problem = checkConnectionString(conn);
  if (problem) throw new Error(problem);
  const client = new pg.Client({ connectionString: conn, application_name: 'eden-hq-operator' });
  await client.connect();
  return client;
}

let stdinLines;

async function nextStdinLine() {
  if (!stdinLines) {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    stdinLines = Buffer.concat(chunks).toString('utf8').split(/\r?\n/);
  }
  return stdinLines.shift() ?? '';
}

/** Prompt on stderr and read a line without echoing it. */
export async function promptHidden(question) {
  process.stderr.write(question);
  if (!process.stdin.isTTY) {
    const line = await nextStdinLine();
    process.stderr.write('\n');
    return line.trim();
  }
  return new Promise((resolve) => {
    const stdin = process.stdin;
    let buf = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stderr.write('\n');
          resolve(buf.trim());
          return;
        }
        if (ch === '\u0003') {
          stdin.setRawMode(false);
          process.stderr.write('\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1);
        else buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}
