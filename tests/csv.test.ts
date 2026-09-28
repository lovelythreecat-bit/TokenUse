import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { exportCsv, parseCsv, previewCsv } from '../src/core/csv';
import type { CsvMapping, Source, UsageEvent } from '../src/shared/types';

const importText = readFileSync(fileURLToPath(new URL('./fixtures/import.csv', import.meta.url)), 'utf8');
const source: Source = { id: 'csv-source', name: 'CSV', tool: 'cursor', kind: 'csv', path: 'import.csv', enabled: true,
  included: true, defaultProviderId: 'default-provider', status: '', lastSync: null, recordCount: 0, warnings: [] };
const mapping: CsvMapping = { timestamp: 'when', total: 'total', input: 'input', output: 'output', model: 'model', id: 'record', cost: 'cost', currency: 'currency' };

describe('CSV import', () => {
  test('imports Cursor costs using the explicitly selected default currency',()=>{
    const result=parseCsv('Date,Total Tokens,Cost\n2026-09-14T09:00:00,100,0.03\n',{timestamp:'Date',total:'Total Tokens',cost:'Cost',currencyValue:'USD'},'Asia/Shanghai',source,false);
    expect(result.errors).toEqual([]);expect(result.events[0].reportedCost).toEqual({amount:0.03,currency:'USD'});
  });
  test('previews headers, rows, and export marker', () => {
    const preview = previewCsv(importText, 'import.csv');
    expect(preview).toMatchObject({ path: 'import.csv', rowCount: 5, markedExport: false });
    expect(preview.headers).toEqual(['when', 'total', 'input', 'output', 'model', 'record', 'cost', 'currency']);
    expect(preview.rows[0].when).toBe('2026-09-14T09:30:00');
    expect(previewCsv('# TokenUse Export v1\na,b\n1,2\n', 'export.csv').markedExport).toBe(true);
  });

  test('uses the selected zone, preserves date precision, and surfaces invalid rows', () => {
    const result = parseCsv(importText, mapping, 'Asia/Shanghai', source, false);
    expect(result.events).toHaveLength(2);
    expect(result.errors).toHaveLength(3);
    expect(result.errors[0]).toMatch(/第 3 行.*重复/);
    expect(result.errors[1]).toMatch(/第 5 行.*时间/);
    expect(result.errors[2]).toMatch(/第 6 行.*负数/);
    expect(result.events[0]).toMatchObject({ timestamp: '2026-09-14T01:30:00.000Z', precision: 'instant', providerId: null,
      reportedCost: { amount: 0.03, currency: 'USD' } });
    expect(result.events[1]).toMatchObject({ precision: 'date', localDate: '2026-09-15' });
    expect(result.events[1].tokens).toEqual({ input: null, output: null, cacheRead: null, cacheWrite: null, reasoning: null, total: 20 });
  });

  test('deduplicates identical normalized rows without native ids and reports the duplicate', () => {
    const first = parseCsv(importText, mapping, 'Asia/Shanghai', source, false).events;
    const second = parseCsv(importText, mapping, 'Asia/Shanghai', source, false).events;
    expect(first.map((item) => item.id)).toEqual(second.map((item) => item.id));
    expect(first).toHaveLength(2);
  });

  test('rejects marked exports unless explicitly allowed', () => {
    const text = '# TokenUse Export v1\nwhen,total\n2026-09-14T00:00:00Z,1\n';
    const denied = parseCsv(text, { timestamp: 'when', total: 'total' }, 'UTC', source, false);
    expect(denied).toMatchObject({ events: [], markedExport: true });
    expect(denied.errors[0]).toMatch(/TokenUse 导出/);
    expect(parseCsv(text, { timestamp: 'when', total: 'total' }, 'UTC', source, true).events).toHaveLength(1);
  });
});

describe('CSV export', () => {
  test('round-trips canonical fields without losing quoting or date precision', () => {
    const events: UsageEvent[] = [{
      id: 'id,quoted', sourceId: 'source', tool: 'cursor', timestamp: '2026-09-13T16:00:00.000Z', precision: 'date', localDate: '2026-09-14',
      model: 'model,"quoted"', project: null, providerId: 'provider', providerHint: 'hint',
      tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: null, reasoning: null, total: 3 },
      reportedCost: { amount: 0.5, currency: 'CNY' }, warnings: [],
    }];
    const text = exportCsv(events);
    expect(text.startsWith('# TokenUse Export v1\n')).toBe(true);
    const preview = previewCsv(text, 'roundtrip.csv');
    expect(preview.markedExport).toBe(true);
    const imported = parseCsv(text, {
      timestamp: 'timestamp', total: 'total', input: 'input', output: 'output', cacheRead: 'cacheRead', cacheWrite: 'cacheWrite',
      reasoning: 'reasoning', model: 'model', project: 'project', provider: 'provider', id: 'id', cost: 'cost', currency: 'currency',
    }, 'Asia/Shanghai', { ...source, defaultProviderId: null }, true);
    expect(imported.errors).toEqual([]);
    expect(imported.events[0]).toMatchObject({ id: expect.any(String), precision: 'date', localDate: '2026-09-14', model: 'model,"quoted"',
      project: null, providerHint: 'hint', reportedCost: { amount: 0.5, currency: 'CNY' } });
    expect(imported.events[0].tokens).toEqual(events[0].tokens);
  });
});
