import { useCallback, useEffect, useRef, useState } from 'react';
import { BarChart3, Database, List, RefreshCw, Settings as SettingsIcon, Sparkles } from 'lucide-react';
import { DateTime } from 'luxon';
import type { AppSnapshot, Query } from './shared/types';
import { Settings } from './components/Settings';
import { Dashboard, Details, type UsageFilters } from './components/UsageViews';

type Page = 'dashboard' | 'details' | 'settings';

const EMPTY_FILTERS: UsageFilters = {
  range: 'today',
  grain: 'hour',
  customStart: DateTime.now().toISODate()!,
  customEnd: DateTime.now().toISODate()!,
  precise: false,
  tool: '',
  sourceId: '',
  providerId: '',
  model: '',
  project: '',
};

export default function App() {
  const api = window.tokenuse;
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [page, setPage] = useState<Page>('dashboard');
  const [filters, setFiltersState] = useState<UsageFilters>(EMPTY_FILTERS);
  const [drillQuery, setDrillQuery] = useState<Query | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const requestRef = useRef(0);

  const acceptSnapshot = useCallback((value: AppSnapshot, request: number) => {
    if (request === requestRef.current) setSnapshot(value);
  }, []);

  const commitSnapshot = useCallback((value: AppSnapshot) => {
    requestRef.current += 1;
    setSnapshot(value);
  }, []);

  const loadSnapshot = useCallback(async () => {
    if (!api) return;
    const request = ++requestRef.current;
    try {
      acceptSnapshot(await api.snapshot(), request);
      setError(null);
    } catch (reason) {
      if (request === requestRef.current) setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [acceptSnapshot, api]);

  useEffect(() => {
    if (!api) return;
    let active = true;
    const refreshFromChange = () => {
      if (active) void loadSnapshot();
    };
    void loadSnapshot();
    const unsubscribe = api.onChanged(refreshFromChange);
    return () => {
      active = false;
      requestRef.current += 1;
      unsubscribe();
    };
  }, [api, loadSnapshot]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 3500);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const run = useCallback(async <T,>(operation: () => Promise<T>, success?: string): Promise<T | null> => {
    setBusy(true);
    setError(null);
    try {
      const value = await operation();
      if (success) setToast(success);
      return value;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    if (!api) return;
    const request = ++requestRef.current;
    const value = await run(() => api.refresh(), '数据已刷新');
    if (value) acceptSnapshot(value, request);
  }, [acceptSnapshot, api, run]);

  const setFilters = useCallback((next: UsageFilters | ((current: UsageFilters) => UsageFilters)) => {
    setFiltersState(next);
    setDrillQuery(null);
  }, []);

  const openDetails = useCallback((query: Query) => {
    setDrillQuery(query);
    setPage('details');
  }, []);

  if (!api) {
    return <main className="desktop-only">
      <div className="brand-icon"><Sparkles size={20} /></div>
      <h1>TokenUse 仅支持桌面端</h1>
      <p>请从 TokenUse 桌面应用打开此页面。本界面不会加载示例数据。</p>
    </main>;
  }

  const titles: Record<Page, [string, string]> = {
    dashboard: ['用量总览', '查看各类 AI 工具的 Token 使用趋势与费用估算'],
    details: ['用量明细', '检查筛选范围内的每一条原始用量记录'],
    settings: ['数据源设置', '管理日志来源、服务商归属和价格规则'],
  };
  const [title, subtitle] = titles[page];
  const lastSync = snapshot?.lastRefresh
    ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'medium' }).format(new Date(snapshot.lastRefresh))
    : '尚未同步';

  return <div className="shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-icon"><Sparkles size={18} /></span><span>TokenUse</span></div>
      <div className="sidebar-label">用量分析</div>
      <nav className="nav" aria-label="主导航">
        <button className={page === 'dashboard' ? 'active' : ''} onClick={() => setPage('dashboard')}><BarChart3 size={17} />用量总览</button>
        <button className={page === 'details' ? 'active' : ''} onClick={() => setPage('details')}><List size={17} />用量明细</button>
        <button className={page === 'settings' ? 'active' : ''} onClick={() => setPage('settings')}><SettingsIcon size={17} />数据源设置</button>
      </nav>
      <div className="sidebar-bottom">
        <div className="local-badge"><span className="status-dot" />数据仅保存在本机</div>
        <p>TokenUse {snapshot?.version ?? ''}<br />不会上传日志或用量记录</p>
      </div>
    </aside>
    <main className="content">
      <header className="page-header">
        <div><h1>{title}</h1><p>{subtitle}</p></div>
        <div className="header-actions"><span className="badge neutral">上次同步：{lastSync}</span><button onClick={() => void refresh()} disabled={busy || snapshot?.refreshing}><RefreshCw className={busy || snapshot?.refreshing ? 'spin' : ''} size={15} />刷新</button></div>
      </header>
      {error && <div className="notice error" role="alert">{error}<button aria-label="关闭错误" onClick={() => setError(null)}>×</button></div>}
      {!snapshot ? <div className="panel empty"><RefreshCw className="spin" size={28} /><h2>正在读取本机数据</h2></div> : page === 'settings'
        ? <Settings api={api} snapshot={snapshot} setSnapshot={commitSnapshot} busy={busy} run={run} notify={setToast} />
        : page === 'dashboard'
          ? <Dashboard snapshot={snapshot} filters={filters} setFilters={setFilters} onDrill={openDetails} onOpenSettings={() => setPage('settings')} />
          : <Details api={api} snapshot={snapshot} filters={filters} setFilters={setFilters} drillQuery={drillQuery} clearDrill={() => setDrillQuery(null)} busy={busy} run={run} />}
    </main>
    {toast && <div className="toast" role="status">{toast}</div>}
  </div>;
}
