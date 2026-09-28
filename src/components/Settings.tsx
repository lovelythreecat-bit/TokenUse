import { useMemo, useState } from 'react';
import { AlertTriangle, Database, FileSpreadsheet, FolderOpen, Pencil, Plus, RefreshCw, Search, StopCircle, Trash2, Upload } from 'lucide-react';
import { DateTime } from 'luxon';
import type { AppSnapshot, CsvMapping, CsvPreview, PriceRule, Provider, Source, TokenUseApi, Tool } from '../shared/types';
import { money, number, toolNames } from '../view';

type Run = <T>(operation: () => Promise<T>, success?: string) => Promise<T | null>;
type MappingDraft = CsvMapping & { currencyValue?: string };
type MappingColumn = Exclude<keyof CsvMapping, 'currencyValue'>;

interface SettingsProps {
  api: TokenUseApi;
  snapshot: AppSnapshot;
  setSnapshot: (snapshot: AppSnapshot) => void;
  busy: boolean;
  run: Run;
  notify: (message: string) => void;
}

const PROVIDER_PRESETS = ['OpenAI', 'Anthropic', 'Google', 'DeepSeek', 'OpenRouter', '阿里云百炼'];
const MAPPING_FIELDS: Array<[MappingColumn, string]> = [
  ['timestamp', '时间'], ['total', '总 Token'], ['input', '输入 Token'], ['output', '输出 Token'],
  ['cacheRead', '缓存读取'], ['cacheWrite', '缓存写入'], ['reasoning', '推理 Token'],
  ['model', '模型'], ['project', '项目'], ['provider', '服务商'], ['id', '记录 ID'], ['cost', '费用'], ['currency', '费用币种列'],
];
const TOKEN_COLUMNS: MappingColumn[] = ['total', 'input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'];

function id(prefix: string): string {
  return `${prefix}_${typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function Modal({ title, wide = false, locked = false, children, footer, onClose }: { title: string; wide?: boolean; locked?: boolean; children: React.ReactNode; footer: React.ReactNode; onClose: () => void }) {
  return <div className="modal-overlay" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
    <section className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
      <header className="modal-header"><h2>{title}</h2><button className="ghost" aria-label="关闭" disabled={locked} onClick={onClose}>×</button></header>
      <div className="modal-body">{children}</div>
      <footer className="modal-footer">{footer}</footer>
    </section>
  </div>;
}

function blankSource(): Source {
  return { id: id('source'), name: '', tool: 'codex', kind: 'local', path: '', enabled: true, included: true, defaultProviderId: null, status: '尚未同步', lastSync: null, recordCount: 0, warnings: [] };
}

function blankProvider(): Provider {
  return { id: id('provider'), name: '', website: '', pricingUrl: '', baseUrl: '', protocol: '', enabled: true, aliases: {}, hints: [] };
}

function blankPrice(providerId = ''): PriceRule {
  return { id: id('price'), providerId, model: '', currency: 'USD', effectiveDate: DateTime.now().toISODate()!, rates: { input: null, output: null, cacheRead: null, cacheWrite: null, reasoning: null }, reasoningFallback: true };
}

function linesToAliases(value: string): Record<string, string> {
  const result: Record<string, string> = {};
  value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).forEach((line) => {
    const split = line.indexOf('=');
    if (split < 1 || split === line.length - 1) throw new Error(`模型别名格式无效：${line}`);
    result[line.slice(0, split).trim()] = line.slice(split + 1).trim();
  });
  return result;
}

function aliasesToLines(aliases: Record<string, string>): string {
  return Object.entries(aliases).map(([alias, canonical]) => `${alias}=${canonical}`).join('\n');
}

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function autoMapping(headers: string[]): MappingDraft {
  const find = (...names: string[]) => headers.find((header) => names.includes(normalizeHeader(header))) ?? '';
  return {
    timestamp: find('timestamp', 'date', 'time', 'datetime'),
    total: find('total tokens', 'total token', 'total'),
    input: find('input (w/o cache write)', 'input tokens', 'input token', 'input'),
    output: find('output tokens', 'output token', 'output'),
    cacheRead: find('cache read', 'cache read tokens', 'cached input tokens'),
    cacheWrite: find('input (w/ cache write)', 'cache write', 'cache write tokens'),
    reasoning: find('reasoning tokens', 'reasoning token', 'reasoning'),
    model: find('model', 'model name'),
    project: find('project', 'project name'),
    provider: find('provider', 'provider name'),
    id: find('id', 'record id', 'request id'),
    cost: find('cost', 'amount'),
    currency: find('currency', 'cost currency'),
    currencyValue: 'USD',
  };
}

function sourceTime(value: string | null): string {
  if (!value) return '尚未同步';
  const parsed = DateTime.fromISO(value, { setZone: true }).toLocal();
  return parsed.isValid ? parsed.toFormat('yyyy-LL-dd HH:mm') : value;
}

export function Settings({ api, snapshot, setSnapshot, busy, run, notify }: SettingsProps) {
  const [tab, setTab] = useState<'sources' | 'providers' | 'prices'>('sources');
  const [candidates, setCandidates] = useState<Source[]>([]);
  const [sectionError, setSectionError] = useState('');
  const [saving, setSaving] = useState(false);
  const [dialogError, setDialogError] = useState('');

  const [sourceDraft, setSourceDraft] = useState<Source | null>(null);
  const [sourceIsNew, setSourceIsNew] = useState(false);
  const [providerDraft, setProviderDraft] = useState<Provider | null>(null);
  const [aliasesText, setAliasesText] = useState('');
  const [hintsText, setHintsText] = useState('');
  const [priceDraft, setPriceDraft] = useState<PriceRule | null>(null);

  const [csvPreview, setCsvPreview] = useState<CsvPreview | null>(null);
  const [csvMapping, setCsvMapping] = useState<MappingDraft | null>(null);
  const [csvZone, setCsvZone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [csvName, setCsvName] = useState('Cursor CSV');
  const [csvProvider, setCsvProvider] = useState('');
  const [allowExport, setAllowExport] = useState(false);
  const [csvResult, setCsvResult] = useState<{ imported: number; errors: string[] } | null>(null);

  const [reassignOpen, setReassignOpen] = useState(false);
  const [reassignSource, setReassignSource] = useState('');
  const [reassignProvider, setReassignProvider] = useState('');
  const [reassignStart, setReassignStart] = useState(DateTime.now().startOf('month').toISODate()!);
  const [reassignEnd, setReassignEnd] = useState(DateTime.now().toISODate()!);
  const [reassignConfirmed, setReassignConfirmed] = useState(false);

  const providers = snapshot.providers;
  const visibleProviders = providers.filter((provider) => !provider.deleted);
  const priceProvider = (providerId: string) => providers.find((provider) => provider.id === providerId)?.name ?? providerId;

  const closeDialogs = () => {
    if (saving) return;
    setSourceDraft(null); setProviderDraft(null); setPriceDraft(null); setCsvPreview(null); setCsvMapping(null); setReassignOpen(false); setDialogError(''); setCsvResult(null);
  };

  const performDialog = async <T,>(operation: () => Promise<T>): Promise<T | null> => {
    setSaving(true); setDialogError('');
    try { return await operation(); }
    catch (reason) { setDialogError(errorMessage(reason)); return null; }
    finally { setSaving(false); }
  };

  const discover = async () => {
    setSectionError('');
    const found = await run(() => api.discover());
    if (found) {
      const paths = new Set(snapshot.sources.map((source) => source.path.toLowerCase()));
      setCandidates(found.filter((source) => !paths.has(source.path.toLowerCase())));
      if (!found.length) notify('没有检测到新的本机数据源');
    }
  };

  const addAllCandidates = async () => {
    if (!candidates.length) return;
    setSaving(true); setSectionError('');
    try {
      let latest = snapshot;
      for (const candidate of candidates) latest = await api.saveSource(candidate);
      latest = await api.refresh();
      setSnapshot(latest); setCandidates([]); notify(`已添加 ${candidates.length} 个数据源`);
    } catch (reason) { setSectionError(errorMessage(reason)); }
    finally { setSaving(false); }
  };

  const openSource = (source: Source, isNew = false) => {
    setDialogError(''); setSourceIsNew(isNew); setSourceDraft({ ...source, warnings: [...source.warnings] });
  };

  const saveSource = async () => {
    if (!sourceDraft) return;
    if (!sourceDraft.name.trim()) { setDialogError('请输入数据源名称。'); return; }
    if (!sourceDraft.path.trim()) { setDialogError('请选择或输入日志路径。'); return; }
    const result = await performDialog(async () => {
      await api.saveSource({ ...sourceDraft, name: sourceDraft.name.trim(), path: sourceDraft.path.trim() });
      return api.refresh();
    });
    if (result) { setSnapshot(result); setSourceDraft(null); setCandidates((current) => current.filter((candidate) => candidate.path !== sourceDraft.path)); notify('数据源已保存并刷新'); }
  };

  const updateSource = async (source: Source, changes: Partial<Source>, success: string) => {
    setSectionError('');
    const result = await run(async () => {
      await api.saveSource({ ...source, ...changes });
      return api.refresh();
    }, success);
    if (result) setSnapshot(result);
  };

  const stopCollection = async (source: Source) => {
    setSectionError('');
    const result = await run(() => api.removeSource(source.id), '已停止采集，历史记录仍保留');
    if (result) setSnapshot(result);
  };

  const chooseCsv = async () => {
    setSectionError('');
    const preview = await run(() => api.chooseCsv());
    if (!preview) return;
    const existing = snapshot.sources.find((source) => source.kind === 'csv' && source.path.toLowerCase() === preview.path.toLowerCase());
    setCsvPreview(preview); setCsvMapping(autoMapping(preview.headers)); setCsvName(existing?.name ?? 'Cursor CSV'); setCsvProvider(existing?.defaultProviderId ?? ''); setCsvZone(preview.zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone); setAllowExport(false); setCsvResult(null); setDialogError('');
  };

  const csvValidation = useMemo(() => {
    if (!csvPreview || !csvMapping) return '';
    if (!DateTime.now().setZone(csvZone).isValid) return `无效时区：${csvZone}`;
    if (!csvMapping.timestamp) return '必须映射时间列。';
    if (!TOKEN_COLUMNS.some((field) => Boolean(csvMapping[field]))) return '至少映射总 Token 或一个 Token 分项。';
    const used = TOKEN_COLUMNS.map((field) => csvMapping[field]).filter(Boolean);
    if (new Set(used).size !== used.length) return '不同 Token 分项不能映射到同一列。';
    if (!csvName.trim()) return '请输入数据源名称。';
    if (csvMapping.cost && !csvMapping.currency && !csvMapping.currencyValue?.trim()) return '映射费用后，需要费用币种列或默认费用币种。';
    if (csvMapping.currencyValue && !/^[A-Za-z]{3}$/.test(csvMapping.currencyValue.trim())) return '默认费用币种应为 3 位 ISO 代码，例如 USD。';
    if (csvPreview.markedExport && !allowExport) return '这是 TokenUse 导出文件，请明确勾选“作为独立来源导入”。';
    return '';
  }, [allowExport, csvMapping, csvName, csvPreview, csvZone]);

  const importCsv = async () => {
    if (!csvPreview || !csvMapping) return;
    if (csvValidation) { setDialogError(csvValidation); return; }
    const existing = snapshot.sources.find((source) => source.kind === 'csv' && source.path.toLowerCase() === csvPreview.path.toLowerCase());
    const source: Source = existing ? { ...existing, name: csvName.trim(), defaultProviderId: csvProvider || null, enabled: true, included: true } : {
      id: id('csv'), name: csvName.trim(), tool: 'cursor', kind: 'csv', path: csvPreview.path,
      enabled: true, included: true, defaultProviderId: csvProvider || null, status: '待导入', lastSync: null, recordCount: 0, warnings: [],
    };
    const result = await performDialog(() => api.importCsv({ path: csvPreview.path, mapping: { ...csvMapping, currencyValue: csvMapping.currencyValue?.toUpperCase() }, zone: csvZone, source, allowExport }));
    if (!result) return;
    setSnapshot(result.snapshot); setCsvResult({ imported: result.imported, errors: result.errors });
    if (result.errors.length === 0) { notify(`成功导入 ${result.imported} 条记录`); setCsvPreview(null); setCsvMapping(null); }
  };

  const openProvider = (provider: Provider) => {
    setProviderDraft({ ...provider, aliases: { ...provider.aliases }, hints: [...provider.hints] }); setAliasesText(aliasesToLines(provider.aliases)); setHintsText(provider.hints.join(', ')); setDialogError('');
  };

  const saveProvider = async () => {
    if (!providerDraft) return;
    if (!providerDraft.name.trim()) { setDialogError('请输入服务商名称。'); return; }
    let aliases: Record<string, string>;
    try { aliases = linesToAliases(aliasesText); } catch (reason) { setDialogError(errorMessage(reason)); return; }
    const result = await performDialog(() => api.saveProvider({ ...providerDraft, name: providerDraft.name.trim(), aliases, hints: hintsText.split(/[\n,]/).map((hint) => hint.trim()).filter(Boolean) }));
    if (result) { setSnapshot(result); setProviderDraft(null); notify('服务商已保存'); }
  };

  const softDeleteProvider = async (provider: Provider) => {
    setSectionError('');
    const result = await run(() => api.saveProvider({ ...provider, enabled: false, deleted: true }), '服务商已停用；历史记录保留原归属');
    if (result) setSnapshot(result);
  };

  const savePrice = async () => {
    if (!priceDraft) return;
    if (!priceDraft.providerId || !priceDraft.model.trim() || !priceDraft.effectiveDate) { setDialogError('请选择服务商，并填写模型和生效日期。'); return; }
    if (!/^[A-Za-z]{3}$/.test(priceDraft.currency.trim())) { setDialogError('币种应为 3 位 ISO 代码，例如 CNY 或 USD。'); return; }
    if (Object.values(priceDraft.rates).some((rate) => rate !== null && (!Number.isFinite(rate) || rate < 0))) { setDialogError('价格必须是大于或等于零的有效数字，空值表示无法估算。'); return; }
    const result = await performDialog(() => api.savePrice({ ...priceDraft, model: priceDraft.model.trim(), currency: priceDraft.currency.toUpperCase() }));
    if (result) { setSnapshot(result); setPriceDraft(null); notify('价格规则已保存'); }
  };

  const removePrice = async (price: PriceRule) => {
    setSectionError('');
    const result = await run(() => api.removePrice(price.id), '价格规则已删除');
    if (result) setSnapshot(result);
  };

  const openReassign = (sourceId = '') => {
    setReassignSource(sourceId || snapshot.sources[0]?.id || ''); setReassignProvider(''); setReassignConfirmed(false); setReassignOpen(true); setDialogError('');
  };

  const reassign = async () => {
    if (!reassignSource || !reassignStart || !reassignEnd) { setDialogError('请选择数据源和起止日期。'); return; }
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const start = DateTime.fromISO(reassignStart, { zone }).startOf('day');
    const end = DateTime.fromISO(reassignEnd, { zone }).plus({ days: 1 }).startOf('day');
    if (!start.isValid || !end.isValid || end <= start) { setDialogError('请选择有效的日期范围。'); return; }
    const result = await performDialog(() => api.reassign({ sourceId: reassignSource, providerId: reassignProvider || null, start: start.toUTC().toISO()!, end: end.toUTC().toISO()! }));
    if (result) { setSnapshot(result); setReassignOpen(false); notify('历史记录归属已更新'); }
  };

  return <>
    <div className="tabs" role="tablist"><button className={tab === 'sources' ? 'active' : ''} onClick={() => setTab('sources')}>日志来源</button><button className={tab === 'providers' ? 'active' : ''} onClick={() => setTab('providers')}>服务商</button><button className={tab === 'prices' ? 'active' : ''} onClick={() => setTab('prices')}>价格规则</button></div>
    {sectionError && <div className="notice error" role="alert">{sectionError}<button aria-label="关闭错误" onClick={() => setSectionError('')}>×</button></div>}

    {tab === 'sources' && <section className="panel">
      <div className="panel-heading"><div><h2>日志来源</h2><p>“启用采集”控制后续读取，“纳入统计”控制历史记录是否参与汇总。</p></div><div className="settings-actions"><button onClick={() => void chooseCsv()} disabled={busy || saving}><Upload size={15} />导入 CSV</button><button onClick={() => openReassign()} disabled={!snapshot.sources.length}><Database size={15} />调整历史归属</button><button onClick={() => openSource(blankSource(), true)}><Plus size={15} />手动添加</button><button className="primary" onClick={() => void discover()} disabled={busy || saving}><Search size={15} />检测本地数据源</button></div></div>
      <div className="notice">首次读取较大的日志目录可能需要约一分钟；保存数据源或点击刷新时，旋转图标会持续到读取完成。后续刷新通常会快很多。</div>
      {candidates.length > 0 && <div className="candidate-box"><div className="candidate-header"><div><h3>检测到 {candidates.length} 个新来源</h3><p>请选择要添加的路径。</p></div><button className="small primary" disabled={saving} onClick={() => void addAllCandidates()}>添加全部</button></div>{candidates.map((candidate) => <div className="candidate-row" key={`${candidate.tool}:${candidate.path}`}><div><strong>{toolNames[candidate.tool]} · {candidate.name}</strong><p className="mono">{candidate.path}</p></div><button className="small" onClick={() => openSource(candidate, true)}><Plus size={13} />添加</button></div>)}</div>}
      {!snapshot.sources.length ? <div className="empty"><Database size={32} /><h2>尚未添加数据源</h2><p>点击“检测本地数据源”查找常见日志目录，或手动选择路径。检测结果不会自动添加。</p></div> : <div className="source-list">{snapshot.sources.map((source) => <article className="source-card" key={source.id}>
        <span className="source-icon"><FileSpreadsheet size={18} /></span><div className="source-body"><div className="source-heading"><h3>{source.name}</h3><span className={`badge ${source.enabled ? '' : 'neutral'}`}>{source.enabled ? source.status || '已启用' : '已停止采集'}</span><span className={`badge ${source.included ? '' : 'neutral'}`}>{source.included ? '纳入统计' : '排除统计'}</span></div><p>{toolNames[source.tool]} · {source.recordCount} 条记录 · 上次同步 {sourceTime(source.lastSync)}</p><p className="mono">{source.path}</p>{source.warnings.map((warning, index) => <div className="source-warning" key={index}><AlertTriangle size={13} />{warning}</div>)}</div>
        <div className="actions"><label className="switch-label"><input type="checkbox" checked={source.enabled} onChange={(event) => void updateSource(source, { enabled: event.target.checked }, event.target.checked ? '已启用采集' : '已暂停采集')} />采集</label><label className="switch-label"><input type="checkbox" checked={source.included} onChange={(event) => void updateSource(source, { included: event.target.checked }, event.target.checked ? '已纳入统计' : '已排除统计')} />统计</label><button className="small" onClick={() => openSource(source)}><Pencil size={13} />编辑</button><button className="small" onClick={() => openReassign(source.id)}>历史归属</button><button className="small danger" disabled={!source.enabled} onClick={() => void stopCollection(source)}><StopCircle size={13} />停止采集</button></div>
      </article>)}</div>}
    </section>}

    {tab === 'providers' && <section className="panel">
      <div className="panel-heading"><div><h2>服务商</h2><p>用于识别日志归属和匹配价格；不会发起网络连接。</p></div><button className="primary" onClick={() => openProvider(blankProvider())}><Plus size={15} />添加服务商</button></div>
      {!visibleProviders.length ? <div className="empty"><Database size={30} /><h2>尚未配置服务商</h2><p>添加服务商后，可以为日志设置默认归属并配置估算价格。</p></div> : <div className="provider-grid">{visibleProviders.map((provider) => <article className="provider-card" key={provider.id}><h3><span>{provider.name}</span><span className={`badge ${provider.enabled ? '' : 'neutral'}`}>{provider.enabled ? '已启用' : '已停用'}</span></h3><p>{provider.website || '未填写官网'}<br />API 地址：{provider.baseUrl || '未填写'}<br />协议：{provider.protocol || '未填写'}<br />识别提示：{provider.hints.join(', ') || '无'}</p><div className="actions"><button className="small" onClick={() => void updateProviderEnabled(provider, !provider.enabled)}>{provider.enabled ? '停用' : '启用'}</button><button className="small" onClick={() => openProvider(provider)}><Pencil size={13} />编辑</button><button className="small danger" onClick={() => void softDeleteProvider(provider)}><Trash2 size={13} />停用并隐藏</button></div></article>)}</div>}
      <p className="footer-note">停用并隐藏服务商不会删除历史记录。已保存的服务商名称仍会用于历史筛选和明细展示。</p>
    </section>}

    {tab === 'prices' && <section className="panel">
      <div className="panel-heading"><div><h2>价格规则</h2><p>单价单位为每百万 Token；估算结果用于用量参考，并非账单。</p></div><button className="primary" onClick={() => setPriceDraft(blankPrice(visibleProviders[0]?.id))} disabled={!visibleProviders.length}><Plus size={15} />添加价格</button></div>
      <div className="notice">价格按记录所在日期匹配当日已生效的最新规则，不在一天内按时间切换。空单价表示该分项无法估算。</div>
      {!snapshot.prices.length ? <div className="empty"><Database size={30} /><h2>尚未添加价格规则</h2><p>先添加服务商，再为具体模型设置各 Token 分项的价格。</p></div> : <div className="table-scroll"><table className="table"><thead><tr><th>服务商</th><th>模型</th><th>生效日期</th><th>币种</th><th className="numeric">输入</th><th className="numeric">输出</th><th className="numeric">缓存读</th><th className="numeric">缓存写</th><th className="numeric">推理</th><th>推理回退</th><th>操作</th></tr></thead><tbody>{[...snapshot.prices].sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate)).map((price) => <tr key={price.id}><td>{priceProvider(price.providerId)}</td><td>{price.model}</td><td>{price.effectiveDate}</td><td>{price.currency}</td><td className="numeric">{number(price.rates.input)}</td><td className="numeric">{number(price.rates.output)}</td><td className="numeric">{number(price.rates.cacheRead)}</td><td className="numeric">{number(price.rates.cacheWrite)}</td><td className="numeric">{number(price.rates.reasoning)}</td><td>{price.reasoningFallback ? '使用输出价' : '否'}</td><td><div className="row-actions"><button className="small" onClick={() => setPriceDraft({ ...price, rates: { ...price.rates } })}><Pencil size={13} />编辑</button><button className="small danger" onClick={() => void removePrice(price)}><Trash2 size={13} />删除</button></div></td></tr>)}</tbody></table></div>}
    </section>}

    {sourceDraft && <Modal title={sourceIsNew ? '添加数据源' : '编辑数据源'} locked={saving} onClose={closeDialogs} footer={<><button onClick={closeDialogs} disabled={saving}>取消</button><button className="primary" onClick={() => void saveSource()} disabled={saving}>{saving && <RefreshCw className="spin" size={14} />}{saving ? '保存并刷新中…' : '保存并刷新'}</button></>}><div className="form-grid">
      {dialogError && <div className="notice error field full" role="alert">{dialogError}</div>}
      <label className="field">名称<input value={sourceDraft.name} onChange={(event) => setSourceDraft({ ...sourceDraft, name: event.target.value })} /></label>
      <label className="field">工具<select value={sourceDraft.tool} disabled={!sourceIsNew} onChange={(event) => setSourceDraft({ ...sourceDraft, tool: event.target.value as Tool })}><option value="codex">Codex</option><option value="claude">Claude Code</option><option value="openclaw">OpenClaw</option>{!sourceIsNew && <option value="cursor">Cursor</option>}</select><small>{!sourceIsNew ? '已保存数据源不能更改工具。' : 'Cursor 日志请使用 CSV 导入。'}</small></label>
      <label className="field">来源类型<select value={sourceDraft.kind} disabled={!sourceIsNew} onChange={(event) => setSourceDraft({ ...sourceDraft, kind: event.target.value as Source['kind'] })}><option value="local">本机目录</option><option value="wsl">WSL 路径</option>{!sourceIsNew && <option value="csv">CSV 文件</option>}</select></label>
      <label className="field">默认服务商<select value={sourceDraft.defaultProviderId ?? ''} onChange={(event) => setSourceDraft({ ...sourceDraft, defaultProviderId: event.target.value || null })}><option value="">不指定</option>{visibleProviders.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select><small>修改默认服务商只影响新记录，不会自动改写历史。</small></label>
      <label className="field full">日志路径<div className="inline-input"><input className="mono" value={sourceDraft.path} disabled={!sourceIsNew} onChange={(event) => setSourceDraft({ ...sourceDraft, path: event.target.value })} /><button type="button" disabled={saving || !sourceIsNew || sourceDraft.kind === 'csv'} onClick={() => void chooseSourceDirectory()}><FolderOpen size={15} />选择目录</button></div><small>{sourceDraft.kind === 'wsl' ? '手动路径示例：\\\\wsl.localhost\\Ubuntu\\home\\user\\.openclaw\\agents' : !sourceIsNew ? '已保存数据源不能更改路径。' : '路径仅用于读取本机日志。'}</small></label>
      <label className="checkbox-row"><input type="checkbox" checked={sourceDraft.enabled} onChange={(event) => setSourceDraft({ ...sourceDraft, enabled: event.target.checked })} />启用采集</label><label className="checkbox-row"><input type="checkbox" checked={sourceDraft.included} onChange={(event) => setSourceDraft({ ...sourceDraft, included: event.target.checked })} />纳入汇总统计</label>
      {!sourceIsNew && <div className="field full reassign-shortcut"><span>需要修改已有记录的服务商归属？</span><button type="button" disabled={saving} onClick={() => { const sourceId = sourceDraft.id; setSourceDraft(null); openReassign(sourceId); }}>调整历史归属</button></div>}
    </div></Modal>}

    {providerDraft && <Modal title={providers.some((provider) => provider.id === providerDraft.id) ? '编辑服务商' : '添加服务商'} locked={saving} onClose={closeDialogs} footer={<><button onClick={closeDialogs} disabled={saving}>取消</button><button className="primary" onClick={() => void saveProvider()} disabled={saving}>{saving ? '保存中…' : '保存'}</button></>}><div className="form-grid">
      {dialogError && <div className="notice error field full" role="alert">{dialogError}</div>}
      <label className="field">名称<input list="provider-presets" value={providerDraft.name} onChange={(event) => setProviderDraft({ ...providerDraft, name: event.target.value })} /><datalist id="provider-presets">{PROVIDER_PRESETS.map((preset) => <option key={preset} value={preset} />)}</datalist></label>
      <label className="field">协议<input placeholder="例如 OpenAI compatible" value={providerDraft.protocol} onChange={(event) => setProviderDraft({ ...providerDraft, protocol: event.target.value })} /></label>
      <label className="field">官网<input type="url" placeholder="https://…" value={providerDraft.website} onChange={(event) => setProviderDraft({ ...providerDraft, website: event.target.value })} /></label>
      <label className="field">价格页面<input type="url" placeholder="https://…" value={providerDraft.pricingUrl} onChange={(event) => setProviderDraft({ ...providerDraft, pricingUrl: event.target.value })} /></label>
      <label className="field full">API 地址（可选）<input type="url" placeholder="https://api.example.com" value={providerDraft.baseUrl} onChange={(event) => setProviderDraft({ ...providerDraft, baseUrl: event.target.value })} /><small>仅作为服务商资料保存，TokenUse 不会用它发起连接。</small></label>
      <label className="field full">模型别名<textarea placeholder={'日志别名=价格规则中的规范模型\n例如 claude-sonnet-4=claude-sonnet-4-20250514'} value={aliasesText} onChange={(event) => setAliasesText(event.target.value)} /><small>每行一个“别名=规范模型”。</small></label>
      <label className="field full">日志识别提示<textarea placeholder="例如 openai, api.openai.com" value={hintsText} onChange={(event) => setHintsText(event.target.value)} /><small>填写日志中明确出现的服务商标识，用逗号或换行分隔。</small></label>
      <label className="checkbox-row"><input type="checkbox" checked={providerDraft.enabled} onChange={(event) => setProviderDraft({ ...providerDraft, enabled: event.target.checked })} />启用服务商</label>
    </div></Modal>}

    {priceDraft && <Modal title={snapshot.prices.some((price) => price.id === priceDraft.id) ? '编辑价格规则' : '添加价格规则'} locked={saving} onClose={closeDialogs} footer={<><button onClick={closeDialogs} disabled={saving}>取消</button><button className="primary" onClick={() => void savePrice()} disabled={saving}>{saving ? '保存中…' : '保存'}</button></>}><div className="form-grid">
      {dialogError && <div className="notice error field full" role="alert">{dialogError}</div>}
      <label className="field">服务商<select value={priceDraft.providerId} onChange={(event) => setPriceDraft({ ...priceDraft, providerId: event.target.value })}><option value="">请选择</option>{providers.filter((provider) => !provider.deleted || provider.id === priceDraft.providerId).map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select></label>
      <label className="field">模型<input value={priceDraft.model} onChange={(event) => setPriceDraft({ ...priceDraft, model: event.target.value })} /></label>
      <label className="field">币种<input value={priceDraft.currency} maxLength={3} placeholder="USD" onChange={(event) => setPriceDraft({ ...priceDraft, currency: event.target.value.toUpperCase() })} /></label>
      <label className="field">生效日期<input type="date" value={priceDraft.effectiveDate} onChange={(event) => setPriceDraft({ ...priceDraft, effectiveDate: event.target.value })} /></label>
      {(['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'] as const).map((part) => <label className="field" key={part}>{part === 'input' ? '输入' : part === 'output' ? '输出' : part === 'cacheRead' ? '缓存读取' : part === 'cacheWrite' ? '缓存写入' : '推理'}（每百万 Token）<input type="number" min="0" step="any" value={priceDraft.rates[part] ?? ''} placeholder="空 = 无法估算" onChange={(event) => setPriceDraft({ ...priceDraft, rates: { ...priceDraft.rates, [part]: event.target.value === '' ? null : Number(event.target.value) } })} /></label>)}
      <label className="checkbox-row field full"><input type="checkbox" checked={priceDraft.reasoningFallback} onChange={(event) => setPriceDraft({ ...priceDraft, reasoningFallback: event.target.checked })} />推理价格为空时使用输出价格</label>
      <p className="footer-note field full">费用为本地估算值，不代表服务商账单。价格按日期生效，不支持一天内按时刻切换。</p>
    </div></Modal>}

    {reassignOpen && <Modal title="调整历史记录归属" locked={saving} onClose={closeDialogs} footer={<><button onClick={closeDialogs} disabled={saving}>取消</button><button className="primary" onClick={() => void reassign()} disabled={saving || !reassignConfirmed}>{saving ? '处理中…' : '确认调整'}</button></>}><div className="form-grid">
      {dialogError && <div className="notice error field full" role="alert">{dialogError}</div>}
      <label className="field">数据源<select value={reassignSource} onChange={(event) => { setReassignSource(event.target.value); setReassignConfirmed(false); }}><option value="">请选择</option>{snapshot.sources.map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}</select></label>
      <label className="field">改为服务商<select value={reassignProvider} onChange={(event) => { setReassignProvider(event.target.value); setReassignConfirmed(false); }}><option value="">清除归属</option>{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}{provider.deleted ? '（已停用）' : ''}</option>)}</select></label>
      <label className="field">开始日期<input type="date" value={reassignStart} onChange={(event) => { setReassignStart(event.target.value); setReassignConfirmed(false); }} /></label><label className="field">结束日期（包含当天）<input type="date" value={reassignEnd} onChange={(event) => { setReassignEnd(event.target.value); setReassignConfirmed(false); }} /></label>
      <div className="notice warning field full">这会修改所选数据源在该日期范围内已有记录的服务商归属。更改数据源的默认服务商不会执行此操作。</div>
      <label className="checkbox-row field full"><input type="checkbox" checked={reassignConfirmed} onChange={(event) => setReassignConfirmed(event.target.checked)} />我确认要修改以上范围内的历史记录</label>
    </div></Modal>}

    {csvPreview && csvMapping && <Modal title="导入 Cursor CSV" wide locked={saving} onClose={closeDialogs} footer={<><button onClick={closeDialogs} disabled={saving}>取消</button><button className="primary" onClick={() => void importCsv()} disabled={saving || Boolean(csvValidation)}>{saving && <RefreshCw className="spin" size={14} />}{saving ? '导入中…' : '开始导入'}</button></>}><div className="csv-dialog">
      {dialogError && <div className="notice error" role="alert">{dialogError}</div>}
      {csvResult && <div className={`notice ${csvResult.errors.length ? 'warning' : ''}`}><div><strong>已导入 {csvResult.imported} 条记录</strong>{csvResult.errors.length > 0 && <><p>{csvResult.errors.length} 个问题：</p><ul>{csvResult.errors.slice(0, 20).map((error, index) => <li key={index}>{error}</li>)}</ul>{csvResult.errors.length > 20 && <p>另有 {csvResult.errors.length - 20} 个问题未展开。</p>}</>}</div></div>}
      <div className="notice">不同 CSV 文件可能包含重叠记录。导入后请检查数据源警告；检测到跨文件重叠时，新来源会默认排除统计。你也可以用数据源的“统计”开关避免重复汇总。</div>
      <div className="csv-meta"><span>文件</span><strong className="mono" title={csvPreview.path}>{csvPreview.path}</strong><span>数据行</span><strong>{csvPreview.rowCount}</strong><span>导出标记</span><strong>{csvPreview.markedExport ? 'TokenUse 导出文件' : '无'}</strong></div>
      <h3>前 {Math.min(5, csvPreview.rows.length)} 行预览</h3><div className="table-scroll csv-preview"><table className="table"><thead><tr>{csvPreview.headers.map((header) => <th key={header}>{header}</th>)}</tr></thead><tbody>{csvPreview.rows.slice(0, 5).map((row, index) => <tr key={index}>{csvPreview.headers.map((header) => <td key={header} className="truncate" title={row[header]}>{row[header]}</td>)}</tr>)}</tbody></table></div>
      <div className="csv-grid"><div><h3>列映射</h3><div className="mapping-grid">{MAPPING_FIELDS.map(([field, label]) => <label className="field" key={field}>{label}{field === 'timestamp' ? ' *' : ''}<select value={csvMapping[field] ?? ''} onChange={(event) => setCsvMapping({ ...csvMapping, [field]: event.target.value || undefined })}><option value="">不导入</option>{csvPreview.headers.map((header) => <option key={header} value={header} disabled={TOKEN_COLUMNS.includes(field) && TOKEN_COLUMNS.some((other) => other !== field && csvMapping[other] === header)}>{header}</option>)}</select></label>)}</div></div>
        <div><h3>导入设置</h3><div className="form-stack"><label className="field">数据源名称<input value={csvName} onChange={(event) => setCsvName(event.target.value)} /></label><label className="field">默认服务商<select value={csvProvider} onChange={(event) => setCsvProvider(event.target.value)}><option value="">不指定</option>{visibleProviders.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select></label><label className="field">CSV 时间所在时区<input value={csvZone} onChange={(event) => setCsvZone(event.target.value)} /><small>无时区的时间会按此 IANA 时区解释，默认使用系统时区。</small></label><label className="field">默认费用币种<input value={csvMapping.currencyValue ?? ''} maxLength={3} onChange={(event) => setCsvMapping({ ...csvMapping, currencyValue: event.target.value.toUpperCase() })} /><small>没有逐行币种列时使用，例如 USD。逐行币种优先。</small></label>{csvPreview.markedExport && <label className="checkbox-row"><input type="checkbox" checked={allowExport} onChange={(event) => setAllowExport(event.target.checked)} />作为独立来源导入 TokenUse 导出文件</label>} {csvValidation && <div className="notice warning">{csvValidation}</div>}</div></div>
      </div>
    </div></Modal>}
  </>;

  async function chooseSourceDirectory() {
    const path = await performDialog(() => api.chooseDirectory());
    if (path && sourceDraft) setSourceDraft({ ...sourceDraft, path });
  }

  async function updateProviderEnabled(provider: Provider, enabled: boolean) {
    setSectionError('');
    const result = await run(() => api.saveProvider({ ...provider, enabled }), enabled ? '服务商已启用' : '服务商已停用');
    if (result) setSnapshot(result);
  }
}
