import { describe, expect, test } from 'vitest';
import { analyze, estimateCost } from '../src/core/analytics';
import type { PriceRule, Provider, Query, UsageEvent } from '../src/shared/types';

const tokens = (total: number | null, overrides: Partial<UsageEvent['tokens']> = {}): UsageEvent['tokens'] => ({
  input: null, output: null, cacheRead: null, cacheWrite: null, reasoning: null, total, ...overrides,
});
const event = (id: string, timestamp: string, total: number | null, overrides: Partial<UsageEvent> = {}): UsageEvent => ({
  id, sourceId: 's', tool: 'codex', timestamp, precision: 'instant', model: null, project: null, providerId: null,
  tokens: tokens(total), reportedCost: null, warnings: [], ...overrides,
});
const query = (overrides: Partial<Query> = {}): Query => ({
  start: '2026-09-13T00:00:00+08:00', end: '2026-09-15T00:00:00+08:00', zone: 'Asia/Shanghai', grain: 'day', ...overrides,
});

describe('analyze', () => {
  test('uses left-closed right-open ranges and separates hourly timeline from clock-hour distribution', () => {
    const events = [
      event('before', '2026-09-12T15:59:59Z', 99),
      event('a', '2026-09-13T01:00:00Z', 10),
      event('b', '2026-09-14T01:00:00Z', 20),
      event('end', '2026-09-14T16:00:00Z', 99),
    ];
    const result = analyze(events, query(), [], []);
    expect(result.total).toBe(30);
    expect(result.timeline.map((bucket) => bucket.total)).toEqual([10, 20]);
    expect(result.hours).toHaveLength(24);
    expect(result.hours[9].total).toBe(30);
  });

  test('puts 05:59 and 06:00 into non-overlapping periods', () => {
    const result = analyze([
      event('night', '2026-09-13T21:59:00Z', 10),
      event('morning', '2026-09-13T22:00:00Z', 20),
    ], query({ start: '2026-09-14T00:00:00+08:00', end: '2026-09-15T00:00:00+08:00' }), [], []);
    expect(result.periods.map((bucket) => bucket.total)).toEqual([10, 20, 0, 0]);
  });

  test('keeps date-only rows in daily totals but excludes them from exact and clock views', () => {
    const dateOnly = event('date', '2026-09-13T16:00:00Z', null, {
      precision: 'date', localDate: '2026-09-14', tokens: tokens(null, { input: 7 }),
    });
    const daily = analyze([dateOnly], query({ start: '2026-09-14', end: '2026-09-15' }), [], []);
    expect(daily.total).toBe(7);
    expect(daily.unknownTotals).toBe(1);
    expect(daily.timeline[0]).toMatchObject({ total: 7, unknownTotals: 1, partial: true });
    expect(daily.excludedFromHours).toBe(1);
    expect(daily.hours.every((bucket) => bucket.total === 0)).toBe(true);

    const exact = analyze([dateOnly], query({ start: '2026-09-14T00:00:00+08:00', end: '2026-09-15T00:00:00+08:00', exactTime: true }), [], []);
    expect(exact.events).toHaveLength(0);
  });

  test('applies dimension and daily clock filters together', () => {
    const events = [
      event('yes', '2026-09-14T01:00:00Z', 4, { tool: 'claude', sourceId: 'chosen', model: 'm', project: 'p', providerId: 'provider' }),
      event('wrong-clock', '2026-09-14T02:00:00Z', 8, { tool: 'claude', sourceId: 'chosen', model: 'm', project: 'p', providerId: 'provider' }),
      event('wrong-model', '2026-09-14T01:00:00Z', 16, { tool: 'claude', sourceId: 'chosen', model: 'other', project: 'p', providerId: 'provider' }),
    ];
    const result = analyze(events, query({ tool: 'claude', sourceId: 'chosen', model: 'm', project: 'p', providerId: 'provider', clockStart: 9, clockEnd: 10 }), [], []);
    expect(result.events.map((item) => item.id)).toEqual(['yes']);
  });

  test('keeps repeated DST hours as distinct timeline buckets with offsets', () => {
    const result = analyze([
      event('summer-offset', '2026-11-01T05:30:00Z', 10),
      event('winter-offset', '2026-11-01T06:30:00Z', 20),
    ], query({ start: '2026-11-01T00:00:00', end: '2026-11-01T04:00:00', zone: 'America/New_York', grain: 'hour' }), [], []);
    const occupied = result.timeline.filter((bucket) => bucket.count > 0);
    expect(occupied).toHaveLength(2);
    expect(occupied.map((bucket) => bucket.total)).toEqual([10, 20]);
    expect(new Set(occupied.map((bucket) => bucket.key)).size).toBe(2);
    expect(occupied[0].label).not.toBe(occupied[1].label);
    expect(result.hours[1].total).toBe(30);
  });

  test('rejects a timeline that would exceed 1000 buckets', () => {
    expect(() => analyze([], query({ start: '2026-01-01T00:00:00Z', end: '2026-02-12T00:00:00Z', zone: 'UTC', grain: 'hour' }), [], []))
      .toThrow(/1,000/);
  });
});

describe('estimateCost', () => {
  const providers: Provider[] = [{ id: 'p', name: 'P', website: '', pricingUrl: '', baseUrl: '', protocol: '', enabled: true,
    aliases: { 'model-alias': 'model-canonical' }, hints: ['gateway'] }];
  const prices: PriceRule[] = [
    { id: 'old', providerId: 'p', model: 'model-canonical', currency: 'USD', effectiveDate: '2026-01-01',
      rates: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, reasoning: null }, reasoningFallback: true },
    { id: 'new', providerId: 'p', model: 'model-canonical', currency: 'USD', effectiveDate: '2026-09-01',
      rates: { input: 2, output: 4, cacheRead: 1, cacheWrite: 3, reasoning: null }, reasoningFallback: true },
  ];

  test('uses model aliases, latest effective price, and reasoning fallback', () => {
    const item = event('priced', '2026-09-14T00:00:00Z', 2_000_000, {
      providerId: 'p', model: 'model-alias', providerHint: 'gateway', tokens: tokens(2_000_000, { input: 1_000_000, output: 500_000, reasoning: 500_000 }),
    });
    expect(estimateCost(item, providers, prices, 'Asia/Shanghai')).toEqual({ amount: 6, currency: 'USD' });
  });

  test('does not retroactively price an event that was stored without provider attribution', () => {
    const item = event('historically-unknown', '2026-09-14T00:00:00Z', 1_000_000, {
      model: 'model-canonical', providerHint: 'gateway', tokens: tokens(1_000_000, { input: 1_000_000 }),
    });
    expect(estimateCost(item, providers, prices, 'UTC')).toBeNull();
  });

  test('returns null when a used component lacks a rate or totals contradict known parts', () => {
    const missingRate = event('missing', '2026-09-14T00:00:00Z', 2, {
      providerId: 'p', model: 'model-canonical', tokens: tokens(2, { input: 1, cacheWrite: 1 }),
    });
    const noCacheWrite = prices.map((price) => ({ ...price, rates: { ...price.rates, cacheWrite: null } }));
    expect(estimateCost(missingRate, providers, noCacheWrite, 'UTC')).toBeNull();

    const contradictory = event('bad-total', '2026-09-14T00:00:00Z', 1, {
      providerId: 'p', model: 'model-canonical', tokens: tokens(1, { input: 1, output: 1 }),
    });
    expect(estimateCost(contradictory, providers, prices, 'UTC')).toBeNull();
  });

  test('aggregates known costs by currency and counts unpriced records', () => {
    const usd = event('usd', '2026-09-14T00:00:00Z', 1_000_000, {
      providerId: 'p', model: 'model-canonical', tokens: tokens(1_000_000, { input: 1_000_000 }),
    });
    const unknown = event('unknown', '2026-09-14T01:00:00Z', 1, { providerId: 'p', model: 'no-price', tokens: tokens(1, { input: 1 }) });
    const result = analyze([usd, unknown], query(), providers, prices);
    expect(result.costs).toEqual({ USD: 2 });
    expect(result.unpriced).toBe(1);
  });
});
