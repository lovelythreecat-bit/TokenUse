import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { parseLine } from '../src/core/parsers';
import type { ParseContext, ParseState, Source } from '../src/shared/types';

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8')
  .trim().split(/\r?\n/).map((line) => JSON.parse(line));

function source(tool: Source['tool']): Source {
  return { id: `${tool}-source`, name: tool, tool, kind: 'local', path: 'fixture', enabled: true,
    included: true, defaultProviderId: null, status: '', lastSync: null, recordCount: 0, warnings: [] };
}

function parseAll(tool: Source['tool'], rows: unknown[]) {
  let state: ParseState = {};
  return rows.map((raw, index) => {
    const context: ParseContext = { source: source(tool), file: `${tool}.jsonl`, line: index + 1, state };
    const result = parseLine(raw, context);
    state = result.state;
    return result;
  });
}

describe('parseLine', () => {
  test('deduplicates Codex cumulative snapshots even when last usage repeats', () => {
    const results = parseAll('codex', fixture('codex.jsonl'));
    expect(results.map((result) => result.event?.tokens.total ?? null)).toEqual([null, null, 130, null, 60]);
    expect(results[2].event?.tokens).toEqual({ input: 80, output: 20, cacheRead: 20, cacheWrite: null, reasoning: 10, total: 130 });
    expect(results[4].event?.tokens).toEqual({ input: 40, output: 10, cacheRead: 10, cacheWrite: null, reasoning: 0, total: 60 });
    expect(results[2].event).toMatchObject({ model: 'gpt-5-codex', project: 'F:/work/demo' });
  });

  test('round-tripped Codex state and deterministic identity reproduce the same events', () => {
    const rows = fixture('codex.jsonl');
    const first = parseAll('codex', rows).flatMap((result) => result.event ? [result.event] : []);
    const second = parseAll('codex', rows).flatMap((result) => result.event ? [result.event] : []);
    expect(second).toEqual(first);
    expect(first[0].id).not.toBe(first[1].id);
  });

  test('keeps native adapter ids stable when a log file is renamed', () => {
    const codexHeader = { type: 'session_meta', payload: { id: 'native-session' } };
    const codexUsage = { timestamp: '2026-09-14T00:00:00Z', payload: { type: 'token_count', info: {
      total_token_usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      last_token_usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    } } };
    const codexId = (file: string) => {
      const initial = parseLine(codexHeader, { source: source('codex'), file, line: 1, state: {} });
      return parseLine(codexUsage, { source: source('codex'), file, line: 2, state: initial.state }).event!.id;
    };
    expect(codexId('session.jsonl')).toBe(codexId('session-old.jsonl'));

    const claudeUsage = { type: 'assistant', timestamp: '2026-09-14T01:00:00Z', requestId: 'req-native',
      message: { id: 'msg-native', model: 'm', usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } };
    const claudeId = (file: string) => parseLine(claudeUsage, { source: source('claude'), file, line: 1, state: {} }).event!.id;
    expect(claudeId('session.jsonl')).toBe(claudeId('session-old.jsonl'));

    const openClawUsage = fixture('openclaw.jsonl')[0];
    const openClawId = (file: string) => parseLine(openClawUsage, { source: source('openclaw'), file, line: 1, state: {} }).event!.id;
    expect(openClawId('session.jsonl')).toBe(openClawId('session-old.jsonl'));
  });

  test('prefers Codex last usage when it disagrees with the cumulative advance', () => {
    const rows = [
      { timestamp: '2026-09-14T01:00:00Z', payload: { type: 'token_count', info: {
        total_token_usage: { input_tokens: 100, output_tokens: 0, total_tokens: 100 },
        last_token_usage: { input_tokens: 20, output_tokens: 0, total_tokens: 20 },
      } } },
      { timestamp: '2026-09-14T02:00:00Z', payload: { type: 'token_count', info: {
        total_token_usage: { input_tokens: 200, output_tokens: 0, total_tokens: 200 },
        last_token_usage: { input_tokens: 30, output_tokens: 0, total_tokens: 30 },
      } } },
    ];
    const events = parseAll('codex', rows).map((result) => result.event!);
    expect(events.map((event) => event.tokens.total)).toEqual([20, 30]);
    expect(events[1].warnings).toContain('Codex 单次用量与累计增量不一致，已采用单次用量');
  });

  test('treats a lower Codex cumulative total as a reset and never emits a negative delta', () => {
    const rows = [
      { timestamp: '2026-09-14T00:00:00Z', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 50, output_tokens: 10, total_tokens: 60 } } } },
      { timestamp: '2026-09-14T00:01:00Z', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } } } },
    ];
    const events = parseAll('codex', rows).map((result) => result.event);
    expect(events.map((event) => event?.tokens.total)).toEqual([60, 7]);
    expect(events[1]?.warnings).toContain('检测到累计计数重置');
  });

  test('gives Claude updates one shared id and preserves known zero fields', () => {
    const events = parseAll('claude', fixture('claude.jsonl')).map((result) => result.event!);
    expect(events[0].id).toBe(events[1].id);
    expect(events[0].tokens).toEqual({ input: 10, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: null, total: 12 });
    expect(events[1].tokens.total).toBe(17);
  });

  test('parses OpenClaw provider hints and keeps reported cost separate', () => {
    const event = parseAll('openclaw', fixture('openclaw.jsonl'))[0].event!;
    expect(event).toMatchObject({ model: 'open-model', project: 'agent-one', providerHint: 'gateway-one',
      reportedCost: { amount: 0.02, currency: 'USD' } });
    expect(event.tokens).toEqual({ input: 11, output: 5, cacheRead: 3, cacheWrite: 1, reasoning: null, total: 20 });
  });

  test('retains an OpenClaw session header id as project metadata for later messages', () => {
    const header = parseLine({ type: 'session', id: 'session-42', cwd: 'F:/work/openclaw' }, {
      source: source('openclaw'), file: 'session.jsonl', line: 1, state: {},
    });
    expect(header).toEqual({ event: null, state: { session: 'session-42', project: 'session-42' } });
    const message = parseLine({ id: 'message-42', timestamp: '2026-09-14T03:00:00Z', message: {
      model: 'm', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
    } }, { source: source('openclaw'), file: 'session.jsonl', line: 2, state: header.state });
    expect(message.event?.project).toBe('session-42');
  });

  test('silently skips ordinary non-usage rows from supported logs', () => {
    const cases = [
      ['codex', { type: 'response_item', payload: { type: 'message', role: 'user', content: 'not retained' } }],
      ['claude', { type: 'user', message: { role: 'user', content: 'not retained' } }],
      ['openclaw', { type: 'message', message: { role: 'user', content: 'not retained' } }],
    ] as const;
    for (const [tool, raw] of cases) {
      const result = parseLine(raw, { source: source(tool), file: `${tool}.jsonl`, line: 1, state: {} });
      expect(result).toEqual({ event: null, state: {} });
      expect(JSON.stringify(result)).not.toContain('not retained');
    }
  });

  test('leaves provider attribution to persistence even when the source has a default', () => {
    const configured = { ...source('openclaw'), defaultProviderId: 'configured-provider' };
    const result = parseLine(fixture('openclaw.jsonl')[0], { source: configured, file: 'openclaw.jsonl', line: 1, state: {} });
    expect(result.event?.providerId).toBeNull();
    expect(result.event?.providerHint).toBe('gateway-one');
  });

  test('returns a warning without retaining arbitrary unsupported content', () => {
    const result = parseLine({ prompt: 'private text' }, { source: source('claude'), file: 'a.jsonl', line: 1, state: {} });
    expect(result.event).toBeNull();
    expect(result.warning).toBeTruthy();
    expect(JSON.stringify(result)).not.toContain('private text');
  });
});
