import { DateTime } from 'luxon';
import type { ParseContext, ParseResult, ParseState, Part, Tokens, UsageEvent } from '../shared/types';

type JsonObject = Record<string, unknown>;
type RawCounters = Record<Part | 'total', number | null>;

const PARTS: Part[] = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'];

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
}

function at(value: unknown, ...path: string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    const record = object(current);
    if (!record) return undefined;
    current = record[key];
  }
  return current;
}

function first(value: unknown, paths: string[][]): unknown {
  for (const path of paths) {
    const candidate = at(value, ...path);
    if (candidate !== undefined && candidate !== null && candidate !== '') return candidate;
  }
  return undefined;
}

function textValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function counter(value: unknown, warnings: string[], label: string): number | null {
  if (value === undefined || value === null || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    warnings.push(`${label} 不是有效的非负数`);
    return null;
  }
  return parsed;
}

function fnv1a(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(36);
}

function stableId(prefix: string, ...values: unknown[]): string {
  return `${prefix}_${fnv1a(JSON.stringify(values))}`;
}

function hasCounters(counters: RawCounters | null): counters is RawCounters {
  return counters !== null && Object.values(counters).some((value) => value !== null);
}

function countersDiffer(left: RawCounters, right: RawCounters): boolean {
  return Object.keys(left).some((key) => {
    const leftValue = left[key as keyof RawCounters];
    const rightValue = right[key as keyof RawCounters];
    return leftValue !== null && rightValue !== null && leftValue !== rightValue;
  });
}

function timestamp(raw: unknown): string | null {
  const value = textValue(first(raw, [
    ['timestamp'], ['time'], ['created_at'], ['createdAt'], ['message', 'timestamp'],
  ]));
  if (!value) return null;
  const parsed = DateTime.fromISO(value, { setZone: true });
  return parsed.isValid ? parsed.toUTC().toISO({ suppressMilliseconds: false }) : null;
}

function readCounters(raw: unknown, style: 'snake' | 'camel', warnings: string[]): RawCounters {
  const names = style === 'snake'
    ? {
        input: ['input_tokens', 'input'], output: ['output_tokens', 'output'],
        cacheRead: ['cached_input_tokens', 'cache_read_input_tokens', 'cache_read_tokens', 'cacheRead'],
        cacheWrite: ['cache_creation_input_tokens', 'cache_write_input_tokens', 'cache_write_tokens', 'cacheWrite'],
        reasoning: ['reasoning_output_tokens', 'reasoning_tokens', 'reasoning'], total: ['total_tokens', 'totalTokens', 'total'],
      }
    : {
        input: ['input', 'inputTokens'], output: ['output', 'outputTokens'], cacheRead: ['cacheRead', 'cacheReadTokens'],
        cacheWrite: ['cacheWrite', 'cacheWriteTokens'], reasoning: ['reasoning', 'reasoningTokens'], total: ['totalTokens', 'total'],
      };
  const record = object(raw) ?? {};
  const pick = (keys: string[]) => keys.find((key) => record[key] !== undefined) ?? keys[0];
  return {
    input: counter(record[pick(names.input)], warnings, '输入 Token'),
    output: counter(record[pick(names.output)], warnings, '输出 Token'),
    cacheRead: counter(record[pick(names.cacheRead)], warnings, '缓存读取 Token'),
    cacheWrite: counter(record[pick(names.cacheWrite)], warnings, '缓存写入 Token'),
    reasoning: counter(record[pick(names.reasoning)], warnings, '推理 Token'),
    total: counter(record[pick(names.total)], warnings, '总 Token'),
  };
}

function normalizedTokens(raw: RawCounters, inclusions: { inputIncludesCache: boolean; outputIncludesReasoning: boolean }, warnings: string[]): Tokens {
  let input = raw.input;
  if (input !== null && inclusions.inputIncludesCache) {
    const deductions = [raw.cacheRead, raw.cacheWrite].filter((value): value is number => value !== null);
    const value = input - deductions.reduce((sum, item) => sum + item, 0);
    if (value < 0) {
      warnings.push('输入 Token 与缓存 Token 的包含关系矛盾');
      input = null;
    } else {
      input = value;
    }
  }

  let output = raw.output;
  if (output !== null && raw.reasoning !== null && inclusions.outputIncludesReasoning) {
    if (raw.reasoning > output) {
      warnings.push('输出 Token 与推理 Token 的包含关系矛盾');
      output = null;
    } else {
      output -= raw.reasoning;
    }
  }

  const tokens: Tokens = { input, output, cacheRead: raw.cacheRead, cacheWrite: raw.cacheWrite, reasoning: raw.reasoning, total: raw.total };
  const knownParts = PARTS.reduce((sum, part) => sum + (tokens[part] ?? 0), 0);
  if (tokens.total !== null && knownParts > tokens.total) warnings.push('总 Token 小于已知分项之和');
  return tokens;
}

function nextState(context: ParseContext, updates: Partial<ParseState>): ParseState {
  return { ...context.state, ...updates };
}

function baseEvent(context: ParseContext, values: {
  id: string; timestamp: string; model?: string | null; project?: string | null; providerHint?: string | null;
  tokens: Tokens; reportedCost?: UsageEvent['reportedCost']; warnings: string[];
}): UsageEvent {
  return {
    id: values.id,
    sourceId: context.source.id,
    tool: context.source.tool,
    timestamp: values.timestamp,
    precision: 'instant',
    model: values.model ?? context.state.model ?? null,
    project: values.project ?? context.state.project ?? null,
    providerId: null,
    ...(values.providerHint ? { providerHint: values.providerHint } : {}),
    tokens: values.tokens,
    reportedCost: values.reportedCost ?? null,
    warnings: values.warnings,
  };
}

function parseCodex(raw: JsonObject, context: ParseContext): ParseResult {
  const payload = object(raw.payload) ?? {};
  const nativeSession = textValue(first(raw, [['session_id'], ['sessionId'], ['payload', 'session_id'], ['payload', 'sessionId']]));
  const isSession = raw.type === 'session_meta' || payload.type === 'session_meta';
  const session = (isSession ? textValue(payload.id) : nativeSession) ?? context.state.session;
  const model = textValue(first(raw, [['model'], ['payload', 'model'], ['payload', 'info', 'model']])) ?? context.state.model;
  const project = textValue(first(raw, [['cwd'], ['payload', 'cwd'], ['payload', 'info', 'cwd']])) ?? context.state.project;
  const sessionChanged = Boolean(session && context.state.session && session !== context.state.session);
  let state = nextState(context, {
    ...(session ? { session } : {}), ...(model ? { model } : {}), ...(project ? { project } : {}),
    ...(sessionChanged ? { previousTotals: undefined, generation: 0 } : {}),
  });

  const info = object(first(raw, [['payload', 'info'], ['info']]));
  if (!info) {
    const knownNonUsage = isSession || raw.type === 'turn_context' || raw.type === 'response_item'
      || (raw.type === 'event_msg' && payload.type !== 'token_count');
    return { event: null, state, ...(knownNonUsage ? {} : { warning: '不是 Codex 用量记录' }) };
  }
  const cumulativeRaw = info.total_token_usage ?? info.totalTokenUsage;
  const lastRaw = info.last_token_usage ?? info.lastTokenUsage;
  if (!object(cumulativeRaw) && !object(lastRaw)) return { event: null, state, warning: '不是 Codex 用量记录' };

  const warnings: string[] = [];
  const cumulative = object(cumulativeRaw) ? readCounters(cumulativeRaw, 'snake', warnings) : null;
  const last = object(lastRaw) ? readCounters(lastRaw, 'snake', warnings) : null;
  const previous = state.previousTotals;
  let generation = state.generation ?? 0;
  let selected: RawCounters;
  let repeated = false;

  if (cumulative) {
    const current = Object.fromEntries(Object.entries(cumulative).filter(([, value]) => value !== null)) as Record<string, number>;
    if (previous) {
      const comparableKeys = Object.keys(current).filter((key) => previous[key] !== undefined);
      repeated = comparableKeys.length > 0 && comparableKeys.every((key) => current[key] === previous[key])
        && Object.keys(previous).every((key) => current[key] === previous[key]);
      const reset = !repeated && comparableKeys.some((key) => current[key] < previous[key]);
      if (reset) {
        generation += 1;
        warnings.push('检测到累计计数重置');
        selected = hasCounters(last) ? last : cumulative;
      } else if (!repeated) {
        const delta = Object.fromEntries(Object.keys(cumulative).map((key) => {
          const currentValue = cumulative[key as keyof RawCounters];
          const priorValue = previous[key];
          return [key, currentValue === null || priorValue === undefined ? null : currentValue - priorValue];
        })) as RawCounters;
        if (hasCounters(last)) {
          selected = last;
          if (countersDiffer(last, delta)) warnings.push('Codex 单次用量与累计增量不一致，已采用单次用量');
        } else {
          selected = delta;
        }
      } else {
        selected = cumulative;
      }
    } else {
      selected = hasCounters(last) ? last : cumulative;
    }
    state = { ...state, previousTotals: current, generation };
  } else {
    selected = last!;
  }

  if (repeated) return { event: null, state };
  const occurredAt = timestamp(raw);
  if (!occurredAt) return { event: null, state, warning: 'Codex 用量记录缺少有效时间' };
  const tokens = normalizedTokens(selected, { inputIncludesCache: true, outputIncludesReasoning: true }, warnings);
  const identity = cumulative
    ? state.session
      ? ['native', state.session, generation, state.previousTotals]
      : ['fallback', occurredAt, generation, state.previousTotals]
    : ['fallback', state.session ?? null, occurredAt, selected];
  return {
    event: baseEvent(context, {
      id: stableId('codex', context.source.id, identity), timestamp: occurredAt,
      model: state.model ?? null, project: state.project ?? null, tokens, warnings,
    }),
    state,
  };
}

function parseClaude(raw: JsonObject, context: ParseContext): ParseResult {
  const message = object(raw.message);
  const usage = message && object(message.usage);
  const model = textValue(message?.model) ?? textValue(raw.model) ?? context.state.model;
  const project = textValue(raw.cwd) ?? textValue(raw.project) ?? context.state.project;
  const state = nextState(context, { ...(model ? { model } : {}), ...(project ? { project } : {}) });
  if (!message || !usage) {
    const knownNonUsage = typeof raw.type === 'string' && ['user', 'assistant', 'system', 'summary', 'progress'].includes(raw.type);
    return { event: null, state, ...(knownNonUsage ? {} : { warning: '不是 Claude Code 用量记录' }) };
  }
  const occurredAt = timestamp(raw);
  if (!occurredAt) return { event: null, state, warning: 'Claude Code 用量记录缺少有效时间' };
  const warnings: string[] = [];
  const counters = readCounters(usage, 'snake', warnings);
  if (counters.total === null && [counters.input, counters.output, counters.cacheRead, counters.cacheWrite].every((value) => value !== null)) {
    counters.total = (counters.input ?? 0) + (counters.output ?? 0) + (counters.cacheRead ?? 0) + (counters.cacheWrite ?? 0);
  }
  const tokens = normalizedTokens(counters, { inputIncludesCache: false, outputIncludesReasoning: false }, warnings);
  const messageId = textValue(message.id);
  const requestId = textValue(raw.requestId) ?? textValue(raw.request_id);
  const providerHint = textValue(raw.provider) ?? textValue(message.provider);
  const identity = messageId || requestId
    ? ['native', messageId, requestId]
    : ['fallback', occurredAt, counters, model ?? null, project ?? null, providerHint];
  return {
    event: baseEvent(context, {
      id: stableId('claude', context.source.id, identity), timestamp: occurredAt,
      model, project, providerHint, tokens, warnings,
    }),
    state,
  };
}

function reportedCost(usage: JsonObject, message: JsonObject, warnings: string[]): UsageEvent['reportedCost'] {
  const cost = usage.cost;
  const costRecord = object(cost);
  const amountRaw = costRecord ? first(costRecord, [['total'], ['amount']]) : cost;
  if (amountRaw === undefined || amountRaw === null || amountRaw === '') return null;
  const amount = counter(amountRaw, warnings, '来源申报费用');
  if (amount === null) return null;
  const currency = textValue(first(costRecord ?? {}, [['currency']]))
    ?? textValue(usage.currency) ?? textValue(message.currency) ?? 'USD';
  return { amount, currency };
}

function parseOpenClaw(raw: JsonObject, context: ParseContext): ParseResult {
  const isSession = raw.type === 'session';
  const headerSession = isSession ? textValue(raw.id) ?? textValue(raw.sessionId) ?? textValue(raw.session_id) : null;
  const headerState = isSession && headerSession
    ? nextState(context, { session: headerSession, project: headerSession })
    : { ...context.state };
  const message = object(raw.message) ?? raw;
  const usage = object(message.usage) ?? object(raw.usage);
  if (!usage) {
    const knownNonUsage = object(raw.message) !== null || typeof raw.type === 'string';
    return { event: null, state: headerState, ...(knownNonUsage ? {} : { warning: '不是 OpenClaw 用量记录' }) };
  }
  const occurredAt = timestamp(raw) ?? timestamp(message);
  if (!occurredAt) return { event: null, state: headerState, warning: 'OpenClaw 用量记录缺少有效时间' };
  const warnings: string[] = [];
  const counters = readCounters(usage, 'camel', warnings);
  if (counters.total === null && [counters.input, counters.output, counters.cacheRead, counters.cacheWrite].every((value) => value !== null)) {
    counters.total = (counters.input ?? 0) + (counters.output ?? 0) + (counters.cacheRead ?? 0) + (counters.cacheWrite ?? 0);
  }
  const tokens = normalizedTokens(counters, { inputIncludesCache: false, outputIncludesReasoning: false }, warnings);
  const model = textValue(message.model) ?? textValue(raw.model) ?? headerState.model;
  const project = textValue(raw.agentId) ?? textValue(raw.agent_id) ?? textValue(raw.sessionId) ?? headerState.project;
  const providerHint = textValue(message.provider) ?? textValue(raw.provider);
  const state = { ...headerState, ...(model ? { model } : {}), ...(project ? { project } : {}) };
  const nativeId = textValue(message.id) ?? textValue(raw.id) ?? textValue(raw.messageId);
  const identity = nativeId
    ? ['native', nativeId]
    : ['fallback', occurredAt, counters, model ?? null, project ?? null, providerHint];
  return {
    event: baseEvent(context, {
      id: stableId('openclaw', context.source.id, identity),
      timestamp: occurredAt, model, project, providerHint, tokens, reportedCost: reportedCost(usage, message, warnings), warnings,
    }),
    state,
  };
}

export function parseLine(raw: unknown, context: ParseContext): ParseResult {
  let parsed = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { event: null, state: { ...context.state }, warning: 'JSON 格式无效' };
    }
  }
  const record = object(parsed);
  if (!record) return { event: null, state: { ...context.state }, warning: '记录不是 JSON 对象' };
  if (context.source.tool === 'codex') return parseCodex(record, context);
  if (context.source.tool === 'claude') return parseClaude(record, context);
  if (context.source.tool === 'openclaw') return parseOpenClaw(record, context);
  return { event: null, state: { ...context.state }, warning: 'Cursor 仅支持 CSV 导入' };
}
