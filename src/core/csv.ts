import { DateTime } from 'luxon';
import Papa from 'papaparse';
import type { CsvMapping, CsvPreview, CsvResult, Part, Source, Tokens, UsageEvent } from '../shared/types';

const MARKER = '# TokenUse Export v1';
const PARTS: Part[] = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'];

function marked(text: string): boolean {
  return text.replace(/^\uFEFF/, '').trimStart().startsWith(MARKER);
}

function withoutMarker(text: string): { text: string; offset: number } {
  const clean = text.replace(/^\uFEFF/, '');
  if (!clean.trimStart().startsWith(MARKER)) return { text: clean, offset: 0 };
  const markerStart = clean.search(/\S/);
  const lineEnd = clean.indexOf('\n', markerStart);
  return lineEnd < 0 ? { text: '', offset: 1 } : { text: clean.slice(lineEnd + 1), offset: 1 };
}

function parseRows(text: string) {
  const stripped = withoutMarker(text);
  const parsed = Papa.parse<Record<string, string>>(stripped.text, {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (header) => header.trim(),
  });
  return { parsed, offset: stripped.offset };
}

export function previewCsv(text: string, path: string): CsvPreview {
  const { parsed } = parseRows(text);
  const rows = parsed.data.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value == null ? '' : String(value)])));
  return {
    path,
    headers: parsed.meta.fields ?? [],
    rows,
    rowCount: rows.length,
    markedExport: marked(text),
  };
}

function fnv1a(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(36);
}

function stableId(...values: unknown[]): string {
  return `csv_${fnv1a(JSON.stringify(values))}`;
}

function cell(row: Record<string, string>, column?: string): string | null {
  if (!column) return null;
  const value = row[column];
  return value === undefined || value.trim() === '' ? null : value.trim();
}

function numberCell(row: Record<string, string>, column: string | undefined, label: string): number | null {
  const value = cell(row, column);
  if (value === null) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${label}不是有效数字`);
  if (number < 0) throw new Error(`${label}不能是负数`);
  return number;
}

function parseDate(value: string, zone: string): { timestamp: string; precision: UsageEvent['precision']; localDate?: string } {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const date = DateTime.fromISO(value, { zone });
    if (!date.isValid || date.toISODate() !== value) throw new Error('时间无效');
    return { timestamp: date.startOf('day').toUTC().toISO({ suppressMilliseconds: false })!, precision: 'date', localDate: value };
  }

  const hasOffset = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.test(value);
  const date = hasOffset ? DateTime.fromISO(value, { setZone: true }) : DateTime.fromISO(value, { zone });
  if (!date.isValid) throw new Error('时间无效');
  if (!hasOffset) {
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
    if (match && (date.year !== Number(match[1]) || date.month !== Number(match[2]) || date.day !== Number(match[3])
      || date.hour !== Number(match[4]) || date.minute !== Number(match[5]) || date.second !== Number(match[6] ?? 0))) {
      throw new Error('时间在所选时区中不存在');
    }
  }
  return { timestamp: date.toUTC().toISO({ suppressMilliseconds: false })!, precision: 'instant' };
}

function validateMapping(headers: string[], mapping: CsvMapping): string[] {
  const errors: string[] = [];
  const entries = Object.entries(mapping).filter((entry): entry is [string, string] => entry[0] !== 'currencyValue' && Boolean(entry[1]));
  for (const [name, column] of entries) {
    if (!headers.includes(column)) errors.push(`映射列不存在：${name} → ${column}`);
  }
  if (!mapping.total && !mapping.input && !mapping.output && !mapping.cacheRead && !mapping.cacheWrite && !mapping.reasoning) {
    errors.push('至少映射总 Token 或一个 Token 分项');
  }
  return errors;
}

export function parseCsv(text: string, mapping: CsvMapping, zone: string, source: Source, allowExport: boolean): CsvResult {
  const isExport = marked(text);
  if (isExport && !allowExport) {
    return { events: [], errors: ['该文件带有 TokenUse 导出标记；需明确选择“作为独立来源导入”'], markedExport: true };
  }
  const zoneCheck = DateTime.now().setZone(zone);
  if (!zoneCheck.isValid) return { events: [], errors: [`无效时区：${zone}`], markedExport: isExport };

  const { parsed, offset } = parseRows(text);
  const errors = validateMapping(parsed.meta.fields ?? [], mapping);
  for (const error of parsed.errors) {
    const line = (error.row ?? 0) + 2 + offset;
    errors.push(`第 ${line} 行：${error.message}`);
  }
  if (errors.length > 0 && validateMapping(parsed.meta.fields ?? [], mapping).length > 0) {
    return { events: [], errors, markedExport: isExport };
  }

  const events: UsageEvent[] = [];
  const fingerprints = new Map<string, number>();
  parsed.data.forEach((row, index) => {
    const line = index + 2 + offset;
    try {
      const rawTimestamp = cell(row, mapping.timestamp);
      if (!rawTimestamp) throw new Error('时间不能为空');
      const time = parseDate(rawTimestamp, zone);
      const tokens: Tokens = {
        input: numberCell(row, mapping.input, '输入 Token'),
        output: numberCell(row, mapping.output, '输出 Token'),
        cacheRead: numberCell(row, mapping.cacheRead, '缓存读取 Token'),
        cacheWrite: numberCell(row, mapping.cacheWrite, '缓存写入 Token'),
        reasoning: numberCell(row, mapping.reasoning, '推理 Token'),
        total: numberCell(row, mapping.total, '总 Token'),
      };
      if (tokens.total === null && PARTS.every((part) => tokens[part] === null)) throw new Error('总 Token 和 Token 分项不能同时为空');
      const knownParts = PARTS.reduce((sum, part) => sum + (tokens[part] ?? 0), 0);
      if (tokens.total !== null && knownParts > tokens.total) throw new Error('总 Token 小于已知分项之和');

      const cost = numberCell(row, mapping.cost, '费用');
      const currency = (cell(row, mapping.currency) || mapping.currencyValue?.trim() || '').toUpperCase();
      if (cost !== null && !currency) throw new Error('有费用时币种不能为空');
      if (cost !== null && !/^[A-Z]{3}$/.test(currency)) throw new Error('费用币种须使用 CNY、USD 等三个字母');
      const reportedCost = cost === null ? null : { amount: cost, currency: currency! };
      const nativeId = cell(row, mapping.id);
      const identity = [time.precision === 'date' ? time.localDate : time.timestamp, tokens, cell(row, mapping.model),
        cell(row, mapping.project), cell(row, mapping.provider), reportedCost];
      const fingerprint = JSON.stringify(identity);
      if (!nativeId) {
        const firstLine = fingerprints.get(fingerprint);
        if (firstLine !== undefined) {
          errors.push(`第 ${line} 行：与第 ${firstLine} 行的规范化记录重复，已跳过`);
          return;
        }
        fingerprints.set(fingerprint, line);
      }

      events.push({
        id: stableId(source.id, nativeId ? ['native', nativeId] : ['row', identity]),
        sourceId: source.id,
        tool: source.tool,
        timestamp: time.timestamp,
        precision: time.precision,
        ...(time.localDate ? { localDate: time.localDate } : {}),
        model: cell(row, mapping.model),
        project: cell(row, mapping.project),
        providerId: null,
        ...(cell(row, mapping.provider) ? { providerHint: cell(row, mapping.provider)! } : {}),
        tokens,
        reportedCost,
        warnings: [],
      });
    } catch (error) {
      errors.push(`第 ${line} 行：${error instanceof Error ? error.message : String(error)}`);
    }
  });
  return { events, errors, markedExport: isExport };
}

export function exportCsv(events: UsageEvent[]): string {
  const rows = events.map((event) => ({
    timestamp: event.precision === 'date' && event.localDate ? event.localDate : event.timestamp,
    total: event.tokens.total,
    input: event.tokens.input,
    output: event.tokens.output,
    cacheRead: event.tokens.cacheRead,
    cacheWrite: event.tokens.cacheWrite,
    reasoning: event.tokens.reasoning,
    model: event.model,
    project: event.project,
    provider: event.providerHint ?? event.providerId,
    id: event.id,
    cost: event.reportedCost?.amount ?? null,
    currency: event.reportedCost?.currency ?? null,
  }));
  const csv = Papa.unparse(rows, {
    columns: ['timestamp', 'total', 'input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'model', 'project', 'provider', 'id', 'cost', 'currency'],
    newline: '\n',
  });
  return `${MARKER}\n${csv}\n`;
}
