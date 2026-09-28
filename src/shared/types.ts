export type Tool = 'codex' | 'claude' | 'openclaw' | 'cursor';
export type Part = 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'reasoning';
export type Tokens = Record<Part, number | null> & { total: number | null };
export interface UsageEvent {
  id: string; sourceId: string; tool: Tool; timestamp: string; precision: 'instant' | 'date';
  localDate?: string; model: string | null; project: string | null; providerId: string | null;
  providerHint?: string; tokens: Tokens; reportedCost: { amount: number; currency: string } | null;
  warnings: string[];
}
export interface Source {
  id: string; name: string; tool: Tool; kind: 'local' | 'wsl' | 'csv'; path: string;
  enabled: boolean; included: boolean; defaultProviderId: string | null;
  status: string; lastSync: string | null; recordCount: number; warnings: string[]; csvZone?: string;
}
export interface Provider {
  id: string; name: string; website: string; pricingUrl: string; baseUrl: string;
  protocol: string; enabled: boolean; deleted?: boolean;
  aliases: Record<string, string>; hints: string[];
}
export interface PriceRule {
  id: string; providerId: string; model: string; currency: string; effectiveDate: string;
  rates: Record<Part, number | null>; reasoningFallback: boolean;
}
export interface AppSnapshot {
  sources: Source[]; providers: Provider[]; prices: PriceRule[]; events: UsageEvent[];
  refreshing: boolean; lastRefresh: string | null; version: string;
}
export type Grain = 'hour' | 'day' | 'week' | 'month';
export interface Query {
  start: string; end: string; zone: string; grain: Grain;
  tool?: string; sourceId?: string; providerId?: string; model?: string; project?: string;
  clockStart?: number; clockEnd?: number; exactTime?: boolean;
}
export interface CostEstimate { amount: number; currency: string }
export interface Bucket {
  key: string; label: string; start: string; end: string; total: number;
  count: number; unknownTotals: number; parts: Tokens; costs: Record<string, number>;
  unpriced: number; partial?: boolean;
}
export interface Analytics {
  events: UsageEvent[]; total: number; parts: Tokens; unknownTotals: number;
  costs: Record<string, number>; unpriced: number; timeline: Bucket[];
  hours: Bucket[]; periods: Bucket[]; excludedFromHours: number;
}
export interface ParseState {
  session?: string; model?: string; project?: string;
  previousTotals?: Record<string, number>; generation?: number;
}
export interface ParseContext { source: Source; file: string; line: number; state: ParseState }
export interface ParseResult { event: UsageEvent | null; state: ParseState; warning?: string }
export interface CsvMapping {
  timestamp: string; total?: string; input?: string; output?: string; cacheRead?: string;
  cacheWrite?: string; reasoning?: string; model?: string; project?: string;
  provider?: string; id?: string; cost?: string; currency?: string; currencyValue?: string;
}
export interface CsvPreview { path: string; headers: string[]; rows: Record<string, string>[]; rowCount: number; markedExport: boolean; zone?: string }
export interface CsvResult { events: UsageEvent[]; errors: string[]; markedExport: boolean }
export interface TokenUseApi {
  snapshot(): Promise<AppSnapshot>;
  refresh(): Promise<AppSnapshot>;
  discover(): Promise<Source[]>;
  saveSource(source: Source): Promise<AppSnapshot>;
  removeSource(id: string): Promise<AppSnapshot>;
  saveProvider(provider: Provider): Promise<AppSnapshot>;
  savePrice(price: PriceRule): Promise<AppSnapshot>;
  removePrice(id: string): Promise<AppSnapshot>;
  chooseDirectory(): Promise<string | null>;
  chooseCsv(): Promise<CsvPreview | null>;
  importCsv(args: { path: string; mapping: CsvMapping; zone: string; source: Source; allowExport: boolean }): Promise<{ snapshot: AppSnapshot; imported: number; errors: string[] }>;
  exportCsv(events: UsageEvent[]): Promise<boolean>;
  reassign(args: { sourceId: string; providerId: string | null; start: string; end: string }): Promise<AppSnapshot>;
  onChanged(callback: () => void): () => void;
}
declare global { interface Window { tokenuse?: TokenUseApi } }
