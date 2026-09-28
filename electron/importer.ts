import { Store } from './store';
import { canonicalPath } from './discovery';
import { parseCsv } from '../src/core/csv';
import type { CsvMapping, Source, UsageEvent } from '../src/shared/types';
const signature=(e:UsageEvent)=>JSON.stringify([e.precision==='date'?e.localDate:e.timestamp,e.tokens,e.model,e.project,e.providerHint??null,e.reportedCost]);
export function importUsageCsv(store:Store,args:{text:string;mapping:CsvMapping;zone:string;source:Source;allowExport:boolean}) {
 const source={...args.source};const beforeSnapshot=store.snapshot();
 const existing=beforeSnapshot.sources.find(s=>s.kind==='csv'&&canonicalPath(s.path)===canonicalPath(source.path));
 if(existing?.csvZone&&existing.csvZone!==args.zone&&store.countForSource(existing.id)>0)throw new Error(`此文件之前按 ${existing.csvZone} 时区导入，请使用原时区，避免同一记录因时间偏移被重复统计。`);
 if(existing){source.id=existing.id;source.included=existing.included;}
 source.csvZone=args.zone;
 const result=parseCsv(args.text,args.mapping,args.zone,source,args.allowExport);
 if(!existing&&result.events.length){
   const csvSources=new Set(beforeSnapshot.sources.filter(s=>s.kind==='csv').map(s=>s.id));
   const previous=new Set(beforeSnapshot.events.filter(e=>csvSources.has(e.sourceId)).map(signature));
   const overlap=result.events.filter(e=>previous.has(signature(e))).length;
   if(overlap){source.included=false;result.errors.unshift(`检测到 ${overlap} 条记录与其他 CSV 来源重叠，此来源默认不参与汇总；确认独立后可在设置中启用。`);}
 }
 const before=store.countForSource(source.id);store.saveSource(source);store.upsertEvents(result.events);
 source.recordCount=store.countForSource(source.id);source.status=result.errors.length?'已导入 · 请检查提示':'已导入';source.warnings=result.errors.slice(0,10);source.lastSync=new Date().toISOString();store.saveSource(source);store.flush();
 return {imported:source.recordCount-before,errors:result.errors};
}
