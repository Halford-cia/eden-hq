// Minimal RFC 4180 CSV reader for the private roster and project register.

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const s = text.replace(/^﻿/, '');
  while (i < s.length) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }
    if (c === '"' && field === '') {
      quoted = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
    i += 1;
  }
  if (quoted) throw new Error('unterminated quoted field');
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ''));
}

/** Parse with a required header; returns objects keyed by header names. */
export function parseCsvRecords(text, requiredHeaders) {
  const rows = parseCsv(text);
  if (!rows.length) throw new Error('the file is empty');
  const header = rows[0].map((h) => h.trim().toLowerCase());
  for (const h of requiredHeaders) {
    if (!header.includes(h)) throw new Error(`missing column "${h}" in the header line`);
  }
  return rows.slice(1).map((r, idx) => {
    const rec = { lineNumber: idx + 2 };
    header.forEach((h, j) => {
      rec[h] = (r[j] ?? '').trim();
    });
    return rec;
  });
}
