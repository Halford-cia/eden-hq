// Unit tests for CSV writing, routing and error mapping.

import { describe, it, expect } from 'vitest';
import { escapeCell, neutralize, toCsv, operationalExport, TASK_COLUMNS } from '../../src/csv.js';
import { parseRoute, projectUrl, filtersFromRoute } from '../../src/router.js';
import { toApiError } from '../../src/api.js';
import { fmtRange } from '../../src/format.js';
import { parseCsv } from '../../scripts/lib/csv.mjs';

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

describe('CSV', () => {
  it('escapes delimiters, quotes and newlines', () => {
    expect(escapeCell('plain')).toBe('plain');
    expect(escapeCell('a,b')).toBe('"a,b"');
    expect(escapeCell('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCell('two\nlines')).toBe('"two\nlines"');
    expect(escapeCell(null)).toBe('');
  });

  it('neutralizes spreadsheet formulas at the start of user text', () => {
    for (const s of ['=1+1', '+1', '-1', '@SUM(A1)', '\tx', '\rx']) expect(neutralize(s)).toBe(`'${s}`);
    expect(neutralize('Frame walls = done')).toBe('Frame walls = done');
  });

  it('round-trips through a CSV reader with stable columns and UTF-8', () => {
    const files = operationalExport({
      project: { name: 'SYNTHETIC Café, "Build"' },
      tasks: [{ id: ID, kind: 'task', title: 'Multi\nline, "x"', status: 'ready', archived: false, start_on: '2031-06-08' }],
      updates: [],
    });
    const rows = parseCsv(files[0].text);
    expect(rows[0].map((h) => h.replace(/^﻿/, ''))).toEqual(TASK_COLUMNS);
    expect(rows[1][TASK_COLUMNS.indexOf('title')]).toBe('Multi\nline, "x"');
    expect(rows[1][TASK_COLUMNS.indexOf('project')]).toBe('SYNTHETIC Café, "Build"');
    expect(rows[1][TASK_COLUMNS.indexOf('archived')]).toBe('no');
    expect(files[0].text.endsWith('\r\n')).toBe(true);
    expect(toCsv(['a'], [])).toBe('﻿a\r\n');
  });
});

describe('routes', () => {
  it('parses project URLs and drops unknown values', () => {
    const r = parseRoute(`/p/${ID}`, '?view=board&status=bogus&col=done&task=new&assignee=none');
    expect(r).toMatchObject({ name: 'project', projectId: ID, view: 'board', status: '', column: 'done', task: 'new', assignee: 'none' });
    expect(parseRoute('/p/not-a-uuid').name).toBe('unavailable');
    expect(parseRoute(`/p/${ID}`, '?task=../../x').task).toBeNull();
    expect(parseRoute('/auth/callback').name).toBe('callback');
  });

  it('builds URLs that keep filters', () => {
    expect(projectUrl(ID, { view: 'list', status: 'done', assignee: 'none', task: ID }))
      .toBe(`/p/${ID}?status=done&assignee=none&task=${ID}`);
    expect(filtersFromRoute({ status: 'ready', assignee: `member:${ID}`, archived: true }))
      .toEqual({ status: 'ready', assignee_user_id: ID, include_archived: true });
  });
});

describe('errors', () => {
  it('maps database errors without leaking details', () => {
    expect(toApiError({ code: 'P0002', message: 'unavailable' }).kind).toBe('unavailable');
    expect(toApiError({ code: 'PT409', message: 'stale' }).kind).toBe('conflict');
    expect(toApiError({ code: '42501', message: 'owners only' }).kind).toBe('forbidden');
    expect(toApiError({ code: '42501', message: 'permission denied for schema eden_api' }).kind).toBe('signed_out');
    expect(toApiError({ code: '23514', message: 'new row violates check constraint "tasks_start_before_due"' }).message)
      .toBe('Start must be on or before the due date.');
    expect(toApiError({ message: 'Failed to fetch' }).kind).toBe('network');
  });
});

describe('dates', () => {
  it('formats calendar dates without shifting time zones', () => {
    expect(fmtRange('2031-06-08', '2031-06-12')).toBe('Jun 8 – Jun 12');
    expect(fmtRange(null, '2031-01-01')).toBe('Due Jan 1');
    expect(fmtRange('2031-12-31', null)).toBe('Starts Dec 31');
    expect(fmtRange(null, null)).toBe('');
  });
});
