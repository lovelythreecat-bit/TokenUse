import { DateTime } from 'luxon';
import type { Analytics, Bucket, CostEstimate, Grain, Part, PriceRule, Provider, Query, Tokens, UsageEvent } from '../shared/types';

const PARTS: Part[] = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'];

interface MutableBucket {
  bucket: Bucket;
  seen: Record<Part, boolean>;
  naturalStart?: DateTime;
  naturalEnd?: DateTime;
}

function blankTokens(): Tokens {
  return { input: null, output: null, cacheRead: null, cacheWrite: null, reasoning: null, total: null };
}

function mutableBucket(values: Omit<Bucket, 'total' | 'count' | 'unknownTotals' | 'parts' | 'costs' | 'unpriced'>): MutableBucket {
  return {
    bucket: { ...values, total: 0, count: 0, unknownTotals: 0, parts: blankTokens(), costs: {}, unpriced: 0 },
    seen: { input: false, output: false, cacheRead: false, cacheWrite: false, reasoning: false },
  };
}

function parseBoundary(value: string, zone: string): DateTime {
  const result = DateTime.fromISO(value, { zone });
  if (!result.isValid) throw new Error(`无效的查询时间：${value}`);
  return result;
}

function eventDateTime(event: UsageEvent, zone: string): DateTime | null {
  const result = DateTime.fromISO(event.timestamp, { setZone: true });
  return result.isValid ? result.setZone(zone) : null;
}

function localDateFor(event: UsageEvent, zone: string): string | null {
  if (event.precision === 'date' && event.localDate) return event.localDate;
  return eventDateTime(event, zone)?.toISODate() ?? null;
}

function providerFor(event: UsageEvent, providers: Provider[]): Provider | null {
  if (!event.providerId) return null;
  return providers.find((provider) => provider.id === event.providerId) ?? null;
}

function canonicalModel(eventModel: string, provider: Provider, rules: PriceRule[]): string | null {
  if (rules.some((rule) => rule.model === eventModel)) return eventModel;
  const direct = provider.aliases[eventModel];
  if (direct && rules.some((rule) => rule.model === direct)) return direct;
  const reverse = Object.entries(provider.aliases).find(([canonical, alias]) => alias === eventModel
    && rules.some((rule) => rule.model === canonical));
  return reverse?.[0] ?? null;
}

export function estimateCost(event: UsageEvent, providers: Provider[], prices: PriceRule[], zone: string): CostEstimate | null {
  const provider = providerFor(event, providers);
  if (!provider || !event.model) return null;
  const providerRules = prices.filter((rule) => rule.providerId === provider.id);
  const model = canonicalModel(event.model, provider, providerRules);
  if (!model) return null;
  const localDate = localDateFor(event, zone);
  if (!localDate) return null;
  const rule = providerRules
    .filter((candidate) => candidate.model === model && candidate.effectiveDate <= localDate)
    .sort((left, right) => right.effectiveDate.localeCompare(left.effectiveDate))[0];
  if (!rule) return null;

  const knownSum = PARTS.reduce((sum, part) => sum + (event.tokens[part] ?? 0), 0);
  if (event.tokens.total === null) {
    if (PARTS.some((part) => event.tokens[part] === null)) return null;
  } else if (Math.abs(knownSum - event.tokens.total) > 1e-9) {
    return null;
  }

  let amount = 0;
  for (const part of PARTS) {
    const tokens = event.tokens[part];
    if (tokens === null || tokens === 0) continue;
    let rate = rule.rates[part];
    if (part === 'reasoning' && rate === null && rule.reasoningFallback) rate = rule.rates.output;
    if (rate === null) return null;
    amount += tokens * rate / 1_000_000;
  }
  return { amount, currency: rule.currency };
}

function contribution(event: UsageEvent): { total: number; unknown: boolean } {
  if (event.tokens.total !== null) return { total: event.tokens.total, unknown: false };
  return { total: PARTS.reduce((sum, part) => sum + (event.tokens[part] ?? 0), 0), unknown: true };
}

function addToBucket(target: MutableBucket, event: UsageEvent, cost: CostEstimate | null): void {
  const value = contribution(event);
  target.bucket.total += value.total;
  target.bucket.count += 1;
  if (value.unknown) {
    target.bucket.unknownTotals += 1;
    target.bucket.partial = true;
  }
  for (const part of PARTS) {
    const amount = event.tokens[part];
    if (amount === null) continue;
    target.seen[part] = true;
    target.bucket.parts[part] = (target.bucket.parts[part] ?? 0) + amount;
  }
  target.bucket.parts.total = target.bucket.unknownTotals === 0 ? target.bucket.total : null;
  if (cost) target.bucket.costs[cost.currency] = (target.bucket.costs[cost.currency] ?? 0) + cost.amount;
  else target.bucket.unpriced += 1;
}

function floor(value: DateTime, grain: Grain): DateTime {
  if (grain === 'hour') return value.startOf('hour');
  if (grain === 'day') return value.startOf('day');
  if (grain === 'week') return value.startOf('week');
  return value.startOf('month');
}

function advance(value: DateTime, grain: Grain): DateTime {
  if (grain === 'hour') return value.plus({ hours: 1 });
  if (grain === 'day') return value.plus({ days: 1 });
  if (grain === 'week') return value.plus({ weeks: 1 });
  return value.plus({ months: 1 });
}

function label(value: DateTime, grain: Grain): string {
  if (grain === 'hour') return value.toFormat('yyyy-LL-dd HH:mm ZZZ');
  if (grain === 'day') return value.toFormat('yyyy-LL-dd');
  if (grain === 'week') return `${value.toFormat('yyyy-LL-dd')} 起`;
  return value.toFormat('yyyy-LL');
}

function timelineBuckets(start: DateTime, end: DateTime, grain: Grain): MutableBucket[] {
  const result: MutableBucket[] = [];
  let cursor = floor(start, grain);
  while (cursor < end) {
    const next = advance(cursor, grain);
    const effectiveStart = cursor < start ? start : cursor;
    const effectiveEnd = next > end ? end : next;
    const partial = effectiveStart.toMillis() !== cursor.toMillis() || effectiveEnd.toMillis() !== next.toMillis();
    const item = mutableBucket({
      key: cursor.toUTC().toISO()!, label: label(cursor, grain),
      start: effectiveStart.toUTC().toISO()!, end: effectiveEnd.toUTC().toISO()!, ...(partial ? { partial: true } : {}),
    });
    item.naturalStart = cursor;
    item.naturalEnd = next;
    result.push(item);
    if (result.length > 1000) throw new Error('时间趋势最多生成 1,000 个桶，请缩小范围或选择更粗粒度');
    cursor = next;
  }
  return result;
}

function hourBuckets(): MutableBucket[] {
  return Array.from({ length: 24 }, (_, hour) => mutableBucket({
    key: String(hour).padStart(2, '0'), label: `${String(hour).padStart(2, '0')}:00–${String(hour + 1).padStart(2, '0')}:00`,
    start: `${String(hour).padStart(2, '0')}:00`, end: `${String(hour + 1).padStart(2, '0')}:00`,
  }));
}

function periodBuckets(): MutableBucket[] {
  return [
    ['night', '凌晨', '00:00', '06:00'], ['morning', '上午', '06:00', '12:00'],
    ['afternoon', '下午', '12:00', '18:00'], ['evening', '晚上', '18:00', '24:00'],
  ].map(([key, periodLabel, start, end]) => mutableBucket({ key, label: periodLabel, start, end }));
}

function matchesClock(value: DateTime, start?: number, end?: number): boolean {
  if (start === undefined && end === undefined) return true;
  const clock = value.hour + value.minute / 60 + value.second / 3600;
  const lower = start ?? 0;
  const upper = end ?? 24;
  if (lower === upper) return true;
  return lower < upper ? clock >= lower && clock < upper : clock >= lower || clock < upper;
}

function datePrecisionInRange(event: UsageEvent, start: DateTime, end: DateTime): boolean {
  const date = event.localDate;
  if (!date) return false;
  const firstDate = start.toISODate()!;
  const endAtDayStart = end.equals(end.startOf('day'));
  const lastExclusive = endAtDayStart ? end.toISODate()! : end.plus({ days: 1 }).toISODate()!;
  return date >= firstDate && date < lastExclusive;
}

function resolvedProviderId(event: UsageEvent, providers: Provider[]): string | null {
  return event.providerId ?? providerFor(event, providers)?.id ?? null;
}

export function analyze(events: UsageEvent[], query: Query, providers: Provider[], prices: PriceRule[]): Analytics {
  const start = parseBoundary(query.start, query.zone);
  const end = parseBoundary(query.end, query.zone);
  if (end <= start) throw new Error('查询结束时间必须晚于开始时间');
  const timeline = timelineBuckets(start, end, query.grain);
  const hours = hourBuckets();
  const periods = periodBuckets();

  const filtered = events.filter((event) => {
    if (query.tool && event.tool !== query.tool) return false;
    if (query.sourceId && event.sourceId !== query.sourceId) return false;
    if (query.providerId && resolvedProviderId(event, providers) !== query.providerId) return false;
    if (query.model && event.model !== query.model) return false;
    if (query.project && event.project !== query.project) return false;
    if (event.precision === 'date') {
      if (query.exactTime || query.clockStart !== undefined || query.clockEnd !== undefined) return false;
      return datePrecisionInRange(event, start, end);
    }
    const local = eventDateTime(event, query.zone);
    return Boolean(local && local >= start && local < end && matchesClock(local, query.clockStart, query.clockEnd));
  }).sort((left, right) => left.timestamp.localeCompare(right.timestamp) || left.id.localeCompare(right.id));

  const aggregate = mutableBucket({ key: 'all', label: '全部', start: start.toUTC().toISO()!, end: end.toUTC().toISO()! });
  let excludedFromHours = 0;

  for (const event of filtered) {
    const cost = estimateCost(event, providers, prices, query.zone);
    addToBucket(aggregate, event, cost);
    if (event.precision === 'date') {
      excludedFromHours += 1;
      if (query.grain === 'hour') continue;
      const local = DateTime.fromISO(event.localDate!, { zone: query.zone }).startOf('day');
      const target = timeline.find((item) => local >= item.naturalStart! && local < item.naturalEnd!);
      if (target) addToBucket(target, event, cost);
      continue;
    }

    const local = eventDateTime(event, query.zone)!;
    const trend = timeline.find((item) => local >= item.naturalStart! && local < item.naturalEnd!);
    if (trend) addToBucket(trend, event, cost);
    addToBucket(hours[local.hour], event, cost);
    addToBucket(periods[Math.floor(local.hour / 6)], event, cost);
  }

  return {
    events: filtered,
    total: aggregate.bucket.total,
    parts: aggregate.bucket.parts,
    unknownTotals: aggregate.bucket.unknownTotals,
    costs: aggregate.bucket.costs,
    unpriced: aggregate.bucket.unpriced,
    timeline: timeline.map((item) => item.bucket),
    hours: hours.map((item) => item.bucket),
    periods: periods.map((item) => item.bucket),
    excludedFromHours,
  };
}
