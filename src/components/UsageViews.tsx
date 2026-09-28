import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, BarChart3, CalendarRange, Database, Download, FilterX, Gauge, HardDrive, Layers3, MousePointerClick } from 'lucide-react';
import { DateTime } from 'luxon';
import type { Analytics, AppSnapshot, Grain, Query, TokenUseApi, UsageEvent } from '../shared/types';
import { analyze, estimateCost } from '../core/analytics';
import { compact, makeQuery, money, number, toolNames } from '../view';
import { Chart } from './Chart';

export interface UsageFilters {
  range: string;
  grain: Grain;
  customStart: string;
  customEnd: string;
  precise: boolean;
  tool: string;
  sourceId: string;
  providerId: string;
  model: string;
  project: string;
}

type FilterSetter = (value: UsageFilters | ((current: UsageFilters) => UsageFilters)) => void;
type Run = <T>(operation: () => Promise<T>, success?: string) => Promise<T | null>;

const RANGE_OPTIONS = [
  ['today', '今日'], ['yesterday', '昨日'], ['7d', '近 7 天'], ['30d', '近 30 天'], ['month', '本月'], ['custom', '自定义'],
] as const;

function selectedFilters(filters: UsageFilters): Partial<Query> {
  return {
    ...(filters.tool ? { tool: filters.tool } : {}),
    ...(filters.sourceId ? { sourceId: filters.sourceId } : {}),
    ...(filters.providerId ? { providerId: filters.providerId } : {}),
    ...(filters.model ? { model: filters.model } : {}),
    ...(filters.project ? { project: filters.project } : {}),
  };
}

function buildQuery(filters: UsageFilters, zone: string, range = filters.range): Query {
  return makeQuery({
    range,
    grain: range === 'today' || range === 'yesterday' ? 'hour' : filters.grain,
    zone,
    customStart: filters.customStart,
    customEnd: filters.customEnd,
    filters: selectedFilters(filters),
  });
}

function includedEvents(snapshot: AppSnapshot): UsageEvent[] {
  const included = new Set(snapshot.sources.filter((source) => source.included).map((source) => source.id));
  return snapshot.events.filter((event) => included.has(event.sourceId));
}

function unique(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

function FilterBar({ snapshot, filters, setFilters }: { snapshot: AppSnapshot; filters: UsageFilters; setFilters: FilterSetter }) {
  const events = useMemo(() => includedEvents(snapshot), [snapshot.events, snapshot.sources]);
  const tools = useMemo(() => unique(events.map((event) => event.tool)), [events]);
  const models = useMemo(() => unique(events.map((event) => event.model)), [events]);
  const projects = useMemo(() => unique(events.map((event) => event.project)), [events]);
  const update = <K extends keyof UsageFilters>(key: K, value: UsageFilters[K]) => setFilters((current) => ({ ...current, [key]: value }));
  const selectRange = (range: string) => setFilters((current) => ({
    ...current,
    range,
    grain: range === 'today' || range === 'yesterday' ? 'hour' : 'day',
  }));
  const clear = () => setFilters((current) => ({ ...current, tool: '', sourceId: '', providerId: '', model: '', project: '' }));
  const sourceOptions = snapshot.sources.filter((source) => source.included || source.id === filters.sourceId);
  const providers = snapshot.providers;
  const hasFilters = Boolean(filters.tool || filters.sourceId || filters.providerId || filters.model || filters.project);

  return <>
    <div className="toolbar">
      <div className="range-tabs" aria-label="日期范围">
        {RANGE_OPTIONS.map(([value, label]) => <button key={value} className={filters.range === value ? 'active' : ''} onClick={() => selectRange(value)}>{label}</button>)}
      </div>
      <div className="select-row"><label htmlFor="grain">统计粒度</label><select id="grain" value={filters.grain} onChange={(event) => update('grain', event.target.value as Grain)} disabled={filters.range === 'today' || filters.range === 'yesterday'}><option value="hour">小时</option><option value="day">天</option><option value="week">周</option><option value="month">月</option></select></div>
    </div>
    {filters.range === 'custom' && <div className="custom-range">
      <CalendarRange size={15} />
      <label>开始 <input type={filters.precise ? 'datetime-local' : 'date'} value={filters.customStart} onChange={(event) => update('customStart', event.target.value)} /></label>
      <span>至</span>
      <label>结束 <input type={filters.precise ? 'datetime-local' : 'date'} value={filters.customEnd} onChange={(event) => update('customEnd', event.target.value)} /></label>
      <label className="checkbox-row"><input type="checkbox" checked={filters.precise} onChange={(event) => {
        const precise = event.target.checked;
        setFilters((current) => ({ ...current, precise, customStart: precise ? `${current.customStart.slice(0, 10)}T00:00` : current.customStart.slice(0, 10), customEnd: precise ? `${current.customEnd.slice(0, 10)}T23:59` : current.customEnd.slice(0, 10) }));
      }} />精确到时间</label>
    </div>}
    <div className="filters">
      <span className="filter-label"><Layers3 size={14} />筛选</span>
      <select aria-label="工具筛选" value={filters.tool} onChange={(event) => update('tool', event.target.value)}><option value="">全部工具</option>{tools.map((tool) => <option key={tool} value={tool}>{toolNames[tool] ?? tool}</option>)}</select>
      <select aria-label="数据源筛选" value={filters.sourceId} onChange={(event) => update('sourceId', event.target.value)}><option value="">全部数据源</option>{sourceOptions.map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}</select>
      <select aria-label="服务商筛选" value={filters.providerId} onChange={(event) => update('providerId', event.target.value)}><option value="">全部服务商</option>{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select>
      <select aria-label="模型筛选" value={filters.model} onChange={(event) => update('model', event.target.value)}><option value="">全部模型</option>{models.map((model) => <option key={model}>{model}</option>)}</select>
      <select aria-label="项目筛选" value={filters.project} onChange={(event) => update('project', event.target.value)}><option value="">全部项目</option>{projects.map((project) => <option key={project}>{project}</option>)}</select>
      {hasFilters && <button className="ghost small" onClick={clear}><FilterX size={14} />清除筛选</button>}
    </div>
  </>;
}

function getAnalytics(snapshot: AppSnapshot, query: Query, events: UsageEvent[]): Analytics {
  return analyze(events, query, snapshot.providers, snapshot.prices);
}

function metricValue(bucket: Analytics['periods'][number], currency: string): number {
  return currency ? bucket.costs[currency] ?? 0 : bucket.total;
}

function metricLabel(value: number, currency: string): string {
  return currency ? money(value, currency) : `${compact(value)} Token`;
}

function Costs({ analytics }: { analytics: Analytics }) {
  const entries = Object.entries(analytics.costs).sort(([left], [right]) => left.localeCompare(right));
  return <div className="fee-summary">
    <span className="muted">估算费用</span>
    {entries.length ? entries.map(([currency, amount]) => <strong key={currency}>{money(amount, currency)}</strong>) : <strong>暂无可估算费用</strong>}
    {analytics.unpriced > 0 && <span className="warning-text">{analytics.unpriced} 条记录未计价，费用不完整</span>}
  </div>;
}

function StatCard({ title, value, foot, icon }: { title: string; value: string; foot: string; icon: React.ReactNode }) {
  return <div className="stat"><div className="stat-top"><span>{title}</span><span className="stat-icon">{icon}</span></div><div className="stat-value">{value}</div><div className="stat-foot">{foot}</div></div>;
}

function recordedTotal(event: UsageEvent): number {
  return event.tokens.total ?? (event.tokens.input ?? 0) + (event.tokens.output ?? 0) + (event.tokens.cacheRead ?? 0) + (event.tokens.cacheWrite ?? 0) + (event.tokens.reasoning ?? 0);
}

export function Dashboard({ snapshot, filters, setFilters, onDrill, onOpenSettings }: { snapshot: AppSnapshot; filters: UsageFilters; setFilters: FilterSetter; onDrill: (query: Query) => void; onOpenSettings: () => void }) {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [currency, setCurrency] = useState('');
  const allIncluded = useMemo(() => includedEvents(snapshot), [snapshot.events, snapshot.sources]);
  const view = useMemo(() => {
    try {
      const query = buildQuery(filters, zone);
      return { query, analytics: getAnalytics(snapshot, query, allIncluded), error: '' };
    } catch (reason) {
      return { query: null, analytics: null, error: reason instanceof Error ? reason.message : String(reason) };
    }
  }, [allIncluded, filters, snapshot.prices, snapshot.providers, zone]);
  const currencies = useMemo(() => unique(snapshot.prices.map((price) => price.currency)), [snapshot.prices]);
  useEffect(() => {
    if (currency && !currencies.includes(currency)) setCurrency('');
  }, [currencies.join('|'), currency]);
  const summaries = useMemo(() => {
    if (!allIncluded.length) return { today: null, month: null };
    try {
      const todayQuery = buildQuery(filters, zone, 'today');
      const monthQuery = buildQuery(filters, zone, 'month');
      return { today: getAnalytics(snapshot, todayQuery, allIncluded), month: getAnalytics(snapshot, monthQuery, allIncluded) };
    } catch { return { today: null, month: null }; }
  }, [allIncluded, filters, snapshot.prices, snapshot.providers, zone]);
  const byTool = useMemo(() => {
    const groups = new Map<string, { total: number; unknownTotals: number }>();
    for (const event of view.analytics?.events ?? []) {
      const current = groups.get(event.tool) ?? { total: 0, unknownTotals: 0 };
      current.total += recordedTotal(event);
      if (event.tokens.total === null) current.unknownTotals += 1;
      groups.set(event.tool, current);
    }
    return [...groups].sort(([left], [right]) => left.localeCompare(right)).map(([tool, data]) => ({ tool, data }));
  }, [view.analytics]);
  const missingParts = useMemo(() => {
    let input = 0, output = 0, cache = 0;
    for (const event of view.analytics?.events ?? []) {
      if (event.tokens.input === null) input += 1;
      if (event.tokens.output === null) output += 1;
      if (event.tokens.cacheRead === null || event.tokens.cacheWrite === null) cache += 1;
    }
    return { input, output, cache };
  }, [view.analytics]);
  if (snapshot.sources.length === 0 || allIncluded.length === 0) {
    return <><FilterBar snapshot={snapshot} filters={filters} setFilters={setFilters} /><section className="panel empty welcome"><Database size={38} /><h2>{snapshot.sources.length ? '还没有可统计的记录' : '添加第一个数据源'}</h2><p>{snapshot.sources.length ? '当前数据源尚未产生记录，或所有数据源都已排除在统计之外。刷新后仍为空时，请检查数据源路径和纳入统计开关。' : 'TokenUse 会从你选择的本机日志中统计真实用量。数据始终保存在这台电脑上。'}</p><button className="primary" onClick={onOpenSettings}>前往数据源设置</button></section></>;
  }
  const { query, analytics } = view;
  if (!query || !analytics) return <><FilterBar snapshot={snapshot} filters={filters} setFilters={setFilters} /><div className="notice error">{view.error}</div></>;
  const { today, month } = summaries;
  const cache = analytics.parts.cacheRead !== null && analytics.parts.cacheWrite !== null ? analytics.parts.cacheRead + analytics.parts.cacheWrite : null;
  const totalFoot = analytics.unknownTotals ? `已知分项小计；${analytics.unknownTotals} 条总量未知` : `${analytics.events.length} 条记录`;
  const metricTotal = analytics.periods.reduce((sum, bucket) => sum + metricValue(bucket, currency), 0);

  return <>
    <FilterBar snapshot={snapshot} filters={filters} setFilters={setFilters} />
    <div className="summary-pills">
      {filters.range !== 'today' && today && <span>今日 <strong>{compact(today.total)} Token{today.unknownTotals ? '（已知小计）' : ''}</strong></span>}
      {filters.range !== 'month' && month && <span>本月 <strong>{compact(month.total)} Token{month.unknownTotals ? '（已知小计）' : ''}</strong></span>}
    </div>
    <div className="stats">
      <StatCard title="已记录总量" value={compact(analytics.total)} foot={totalFoot} icon={<Gauge size={16} />} />
      <StatCard title="输入 Token" value={analytics.parts.input === null ? '未知' : compact(analytics.parts.input)} foot={missingParts.input ? `已知小计；${missingParts.input} 条未提供输入分项` : '未缓存输入'} icon={<HardDrive size={16} />} />
      <StatCard title="输出 Token" value={analytics.parts.output === null ? '未知' : compact(analytics.parts.output)} foot={missingParts.output ? `已知小计；${missingParts.output} 条未提供输出分项` : '模型输出'} icon={<BarChart3 size={16} />} />
      <StatCard title="缓存读写" value={cache === null ? '未知' : compact(cache)} foot={missingParts.cache ? `${cache === null ? '缺少；' : '已知小计；'}${missingParts.cache} 条未提供完整缓存分项` : '缓存读取 + 缓存写入'} icon={<Layers3 size={16} />} />
    </div>
    <Costs analytics={analytics} />
    <section className="panel">
      <div className="panel-heading"><div><h2>时间趋势</h2><p>点击时间桶查看对应的全部记录</p></div><select className="metric-select" aria-label="图表指标" value={currency} onChange={(event) => setCurrency(event.target.value)}><option value="">Token</option>{currencies.map((item) => <option key={item} value={item}>{item} 估算费用</option>)}</select></div>
      {filters.grain === 'hour' && analytics.excludedFromHours > 0 && <div className="notice warning">{analytics.excludedFromHours} 条仅有日期的记录已计入总量，但无法放入小时趋势图。</div>}
      <Chart buckets={analytics.timeline} currency={currency || undefined} onSelect={(bucket) => onDrill({ ...query!, start: bucket.start, end: bucket.end, exactTime: query!.exactTime || query!.grain === 'hour' })} />
    </section>
    <div className="two-columns">
      <section className="panel">
        <div className="panel-heading"><div><h2>24 小时分布</h2><p>汇总所选日期范围内相同小时的用量</p></div></div>
        {analytics.excludedFromHours > 0 && <p className="chart-note">{analytics.excludedFromHours} 条仅有日期的记录未参与小时分布。</p>}
        <Chart buckets={analytics.hours} currency={currency || undefined} hourly onSelect={(_, index) => onDrill({ ...query!, clockStart: index, clockEnd: index + 1 })} />
      </section>
      <section className="panel">
        <div className="panel-heading"><div><h2>时段分布</h2><p>点击时段查看原日期范围内的明细</p></div></div>
        <div className="period-grid">{analytics.periods.map((bucket, index) => {
          const value = metricValue(bucket, currency);
          const percent = metricTotal > 0 ? value / metricTotal * 100 : null;
          return <button className="period-card" key={bucket.key} onClick={() => onDrill({ ...query!, clockStart: index * 6, clockEnd: (index + 1) * 6 })}><span className="period-title"><span>{bucket.label}</span><span>{percent === null || !bucket.count ? '—' : `${percent.toFixed(1)}%`}</span></span><strong>{bucket.count ? metricLabel(value, currency) : '无记录'}</strong><span className="period-track"><span style={{ width: `${percent ?? 0}%` }} /></span><small>{bucket.count} 条记录</small></button>;
        })}</div>
      </section>
    </div>
    <section className="panel">
      <div className="panel-heading"><div><h2>按工具统计</h2><p>当前筛选范围内各工具的已记录总量</p></div></div>
      <div className="source-distribution">{byTool.map(({ tool, data }) => <div className="distribution-row" key={tool}><span className="tool-tag"><span className="tool-dot" />{toolNames[tool] ?? tool}</span><span className="distribution-bar"><span style={{ width: `${analytics!.total > 0 ? Math.min(100, data.total / analytics!.total * 100) : 0}%` }} /></span><strong>{compact(data.total)}{data.unknownTotals ? ' *' : ''}</strong></div>)}</div>
    </section>
  </>;
}

function formatEventTime(event: UsageEvent, zone: string): string {
  if (event.precision === 'date') return event.localDate ?? event.timestamp.slice(0, 10);
  const value = DateTime.fromISO(event.timestamp, { setZone: true }).setZone(zone);
  return value.isValid ? value.toFormat('yyyy-LL-dd HH:mm:ss') : event.timestamp;
}

export function Details({ api, snapshot, filters, setFilters, drillQuery, clearDrill, busy, run }: { api: TokenUseApi; snapshot: AppSnapshot; filters: UsageFilters; setFilters: FilterSetter; drillQuery: Query | null; clearDrill: () => void; busy: boolean; run: Run }) {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [page, setPage] = useState(1);
  const allIncluded = useMemo(() => includedEvents(snapshot), [snapshot.events, snapshot.sources]);
  const view = useMemo(() => {
    try {
      const query = drillQuery ?? buildQuery(filters, zone);
      return { query, analytics: getAnalytics(snapshot, query, allIncluded), error: '' };
    } catch (reason) {
      return { query: null, analytics: null, error: reason instanceof Error ? reason.message : String(reason) };
    }
  }, [allIncluded, drillQuery, filters, snapshot.prices, snapshot.providers, zone]);
  const queryKey = view.query ? JSON.stringify(view.query) : view.error;
  useEffect(() => setPage(1), [queryKey]);
  const descending = useMemo(() => [...(view.analytics?.events ?? [])].sort((left, right) => right.timestamp.localeCompare(left.timestamp) || right.id.localeCompare(left.id)), [view.analytics]);
  const sourceNames = useMemo(() => new Map(snapshot.sources.map((source) => [source.id, source.name])), [snapshot.sources]);
  const providerNames = useMemo(() => new Map(snapshot.providers.map((provider) => [provider.id, provider.name])), [snapshot.providers]);
  const { query, analytics } = view;
  if (!query || !analytics) return <><FilterBar snapshot={snapshot} filters={filters} setFilters={setFilters} /><div className="notice error">{view.error}</div></>;
  const pages = Math.max(1, Math.ceil(descending.length / 50));
  const safePage = Math.min(page, pages);
  const rows = descending.slice((safePage - 1) * 50, safePage * 50);
  const exportRecords = async () => { await run(() => api.exportCsv(descending), 'CSV 已导出'); };

  return <>
    <FilterBar snapshot={snapshot} filters={filters} setFilters={setFilters} />
    {drillQuery && <div className="notice drill-notice"><MousePointerClick size={16} /><span>正在查看图表所选范围：{DateTime.fromISO(drillQuery.start).setZone(zone).toFormat('yyyy-LL-dd HH:mm')} 至 {DateTime.fromISO(drillQuery.end).setZone(zone).toFormat('yyyy-LL-dd HH:mm')}{drillQuery.clockStart !== undefined ? `，每日 ${String(drillQuery.clockStart).padStart(2, '0')}:00–${String(drillQuery.clockEnd).padStart(2, '0')}:00` : ''}</span><button onClick={clearDrill}>返回完整范围</button></div>}
    <section className="panel">
      <div className="panel-heading"><div className="details-title"><div><h2>原始记录</h2><p>缺失的 Token 分项保持为空，不按零计算</p></div><span className="record-count">{descending.length} 条</span></div><button className="primary" disabled={busy || descending.length === 0} onClick={() => void exportRecords()}><Download size={15} />导出 CSV</button></div>
      {descending.length === 0 ? <div className="empty"><Database size={30} /><h2>当前范围没有记录</h2><p>调整日期范围或清除筛选条件后再试。</p></div> : <>
        <div className="table-scroll"><table className="table details-table"><thead><tr><th>时间</th><th>工具 / 数据源</th><th>模型 / 项目</th><th>服务商</th><th className="numeric">输入</th><th className="numeric">输出</th><th className="numeric">缓存读</th><th className="numeric">缓存写</th><th className="numeric">推理</th><th className="numeric">总量</th><th className="numeric">估算费用</th><th className="numeric">上报费用</th><th>警告</th></tr></thead><tbody>{rows.map((event) => {
          const estimate = estimateCost(event, snapshot.providers, snapshot.prices, zone);
          return <tr key={event.id}><td>{formatEventTime(event, zone)}{event.precision === 'date' && <span className="badge neutral date-badge">仅日期</span>}</td><td><div>{toolNames[event.tool] ?? event.tool}</div><div className="muted truncate" title={sourceNames.get(event.sourceId) ?? event.sourceId}>{sourceNames.get(event.sourceId) ?? event.sourceId}</div></td><td><div className="truncate" title={event.model ?? '未知模型'}>{event.model ?? '—'}</div><div className="muted truncate" title={event.project ?? '未记录项目'}>{event.project ?? '—'}</div></td><td className="truncate" title={event.providerId ? providerNames.get(event.providerId) ?? event.providerId : event.providerHint ?? '未归属'}>{event.providerId ? providerNames.get(event.providerId) ?? event.providerId : event.providerHint ?? '未归属'}</td><td className="numeric">{number(event.tokens.input)}</td><td className="numeric">{number(event.tokens.output)}</td><td className="numeric">{number(event.tokens.cacheRead)}</td><td className="numeric">{number(event.tokens.cacheWrite)}</td><td className="numeric">{number(event.tokens.reasoning)}</td><td className="numeric">{number(event.tokens.total)}</td><td className="numeric">{estimate ? money(estimate.amount, estimate.currency) : '未计价'}</td><td className="numeric">{event.reportedCost ? money(event.reportedCost.amount, event.reportedCost.currency) : '—'}</td><td>{event.warnings.length ? <span className="warning-icon" title={event.warnings.join('\n')}><AlertTriangle size={15} />{event.warnings.length}</span> : '—'}</td></tr>;
        })}</tbody></table></div>
        <div className="pagination"><span>第 {safePage} / {pages} 页，每页 50 条</span><div><button className="small" disabled={safePage <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>上一页</button><button className="small" disabled={safePage >= pages} onClick={() => setPage((value) => Math.min(pages, value + 1))}>下一页</button></div></div>
      </>}
    </section>
  </>;
}
