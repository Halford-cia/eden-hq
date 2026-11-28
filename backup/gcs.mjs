// Minimal Cloud Storage JSON API client for the backup jobs. Credentials come
// from the Cloud Run job's own service account through the metadata server;
// nothing is stored on disk.

const METADATA_TOKEN = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';

let cached = null;
async function token() {
  if (cached && cached.expires > Date.now() + 60_000) return cached.value;
  const res = await fetch(METADATA_TOKEN, { headers: { 'Metadata-Flavor': 'Google' } });
  if (!res.ok) throw new Error(`metadata token request failed (${res.status})`);
  const body = await res.json();
  cached = { value: body.access_token, expires: Date.now() + body.expires_in * 1000 };
  return cached.value;
}

/**
 * Upload bytes. create: true (default) adds ifGenerationMatch=0 so an
 * existing object is never overwritten; false replaces (status/latest.json).
 */
export async function uploadObject(bucket, name, body, { create = true } = {}) {
  const q = new URLSearchParams({ uploadType: 'media', name });
  if (create) q.set('ifGenerationMatch', '0');
  const res = await fetch(`https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?${q}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/octet-stream' },
    body,
  });
  if (!res.ok) throw new Error(`upload refused (${res.status})`);
}

export async function readObject(bucket, name) {
  const res = await fetch(
    `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(name)}?alt=media`,
    { headers: { Authorization: `Bearer ${await token()}` } },
  );
  if (!res.ok) throw new Error(`read refused (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}
