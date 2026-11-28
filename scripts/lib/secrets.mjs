// Key-shaped value detection shared by check:public and check:dist.
// Patterns are built from parts so this file never matches itself.

const SB_SECRET = new RegExp(['sb', 'secret', ''].join('_') + '[A-Za-z0-9_-]{16,}');
const GOOGLE_SECRET = new RegExp(['GOCSPX', ''].join('-') + '[A-Za-z0-9_-]{20,}');
const PEM = new RegExp('-----BEGIN ' + '([A-Z]+ )*PRIVATE KEY-----');
const AGE_SECRET = new RegExp(['AGE', 'SECRET', 'KEY', '1'].join('-') + '[0-9A-Z]{20,}');
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
// A postgres URL whose user part carries an inline secret (not a <placeholder>).
const PG_PASSWORD = /\bpostgres(?:ql)?:\/\/[^\s:/@'"]+:(?!<)[^\s@'"<>]{6,}@/;

function jwtRole(token) {
  try {
    const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(payload, 'base64').toString('utf8')).role || null;
  } catch {
    return null;
  }
}

/** Names of the key-shaped rules a text matches (never the matched text). */
export function keyShapedFindings(text) {
  const found = [];
  if (SB_SECRET.test(text)) found.push('Supabase secret key');
  if (GOOGLE_SECRET.test(text)) found.push('Google OAuth client secret');
  if (PEM.test(text)) found.push('private key block');
  if (AGE_SECRET.test(text)) found.push('age secret key');
  for (const m of text.match(JWT) || []) {
    if (jwtRole(m) === 'service_role') {
      found.push('JWT with a service_role claim');
      break;
    }
  }
  if (PG_PASSWORD.test(text)) found.push('database connection string with a password');
  return found;
}

export { jwtRole };
