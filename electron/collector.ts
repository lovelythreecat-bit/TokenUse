import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Store, type Cursor } from './store';
import { canonicalPath, runningDistros, wslDistro } from './discovery';
import { parseLine } from '../src/core/parsers';
import type { Source, UsageEvent } from '../src/shared/types';
export { canonicalPath } from './discovery';
const hash=(value:Buffer)=>createHash('sha256').update(value).digest('hex');
const MAX_CHUNK=4*1024*1024;
export class Collector {
  private pending:Promise<void>|null=null;
  private requested=new Set<'local'|'wsl'|'all'>();
  private timers:ReturnType<typeof setInterval>[]=[];
  private watchers:fs.FSWatcher[]=[];
  private debounce:ReturnType<typeof setTimeout>|null=null;
  constructor(private store:Store,private changed:()=>void=()=>{}){}
  refresh(kind?:'local'|'wsl'):Promise<void> {
    this.requested.add(kind||'all');
    if(this.pending)return this.pending;
    this.pending=Promise.resolve().then(async()=>{
      while(this.requested.size){const scopes=[...this.requested];this.requested.clear();await this.run(scopes.includes('all')||scopes.length>1?undefined:scopes[0] as 'local'|'wsl');}
    }).finally(()=>{this.pending=null;this.store.refreshing=false;this.changed();});return this.pending;
  }
  private async run(kind?:'local'|'wsl') {
    this.store.refreshing=true;this.changed();
    const sources=this.store.getSources().filter(s=>s.enabled&&s.kind!=='csv'&&(!kind||s.kind===kind));
    const running=sources.some(s=>s.kind==='wsl')?runningDistros():[];
    const seen=new Set<string>();
    for(const source of sources) {
      const distro=wslDistro(source.path);
      if(distro&&!running.some(d=>d.toLowerCase()===distro.toLowerCase())) {this.update(source,'WSL 未运行', ['发行版未运行，保留历史统计。']);continue;}
      const canonical=canonicalPath(source.path);
      if(seen.has(canonical)){this.update(source,'重复路径',['该路径已由另一个来源采集。']);continue;}seen.add(canonical);
      try {
        if(!fs.statSync(source.path).isDirectory())throw new Error('请选择日志目录');
        const files=this.listFiles(source.path);let warnings:string[]=[];let usageFiles=0;let processed=0;
        for(const file of files) {
          const result=await this.readFile(source,file);warnings.push(...result.warnings);if(result.hasUsage)usageFiles++;
          if(++processed%20===0)await new Promise<void>(r=>setImmediate(r));
        }
        if(!files.length)warnings.push('目录中没有 JSONL 记录。');
        if(files.length>usageFiles)warnings.push(`${files.length-usageFiles} 个文件没有已识别用量，不能据此认定没有消耗。`);
        this.update(source,files.length===0?'暂无记录':warnings.length?'已同步 · 部分数据':'已同步',Array.from(new Set(warnings)).slice(0,12),true);
      } catch(error) {this.update(source,'路径不可访问',[error instanceof Error?error.message:'读取失败']);}
      this.store.flush();
    }
    this.store.markRefreshed();this.store.flush();
  }
  private update(source:Source,status:string,warnings:string[],success=false) {
    const current=this.store.getSources().find(s=>s.id===source.id)||source;
    this.store.saveSource({...current,status,warnings,lastSync:success?new Date().toISOString():current.lastSync,recordCount:this.store.countForSource(source.id)});
  }
  private listFiles(root:string):string[] {
    const result:string[]=[];const pending=[root];
    while(pending.length){const directory=pending.pop()!;for(const item of fs.readdirSync(directory,{withFileTypes:true})) {
      const full=path.join(directory,item.name);
      if(item.isDirectory()&&!item.isSymbolicLink())pending.push(full);
      else if(item.isFile()&&item.name.endsWith('.jsonl'))result.push(full);
    }}
    return result.sort();
  }
  private async readFile(source:Source,file:string):Promise<{warnings:string[];hasUsage:boolean}> {
    const key=source.id+':'+canonicalPath(file);let cursor=this.store.getCursor(key);
    const fd=fs.openSync(file,'r');const size=fs.fstatSync(fd).size;const warnings:string[]=[];
    const read=(start:number,length:number)=>{const b=Buffer.alloc(length);fs.readSync(fd,b,0,length,start);return b;};
    try {
      if(cursor) {
        const head=read(0,Math.min(cursor.headLength,size));
        const tailStart=Math.max(0,cursor.offset-128);
        if(size<cursor.offset||hash(head)!==cursor.headHash||hash(read(tailStart,Math.max(0,Math.min(size,cursor.offset)-tailStart)))!==cursor.tailHash)cursor=undefined;
      }
      let c:Cursor=cursor||{offset:0,line:0,state:{},headHash:hash(Buffer.alloc(0)),headLength:0,tailHash:hash(Buffer.alloc(0))};
      warnings.push(...(c.warnings||[]));
      let hasUsage=!!c.state.previousTotals;
      // Keep a stable snapshot endpoint; concurrently appended data is picked up next time.
      while(c.offset<size) {
        let data=read(c.offset,Math.min(MAX_CHUNK,size-c.offset));
        while(data.indexOf(10)<0&&data.length<32*1024*1024&&c.offset+data.length<size){data=Buffer.concat([data,read(c.offset+data.length,Math.min(MAX_CHUNK,size-c.offset-data.length))]);await new Promise<void>(r=>setImmediate(r));}
        const end=data.lastIndexOf(10);
        if(end<0){
          if(data.length>=32*1024*1024){
            let skip=c.offset+data.length,complete=false;
            while(skip<size){const next=read(skip,Math.min(MAX_CHUNK,size-skip));const newline=next.indexOf(10);if(newline>=0){c.offset=skip+newline+1;c.line++;complete=true;warnings.push('单行超过 32 MB，已跳过该行，后续用量继续采集。');break;}skip+=next.length;await new Promise<void>(r=>setImmediate(r));}
            if(complete)continue;
          }
          break;
        }
        const lines=data.subarray(0,end+1).toString('utf8').split('\n');lines.pop();const events:UsageEvent[]=[];
        for(const text of lines) {
          c.line++;if(!text.trim())continue;
          try {
            const result=parseLine(JSON.parse(text),{source,file:canonicalPath(file),line:c.line,state:c.state});
            c.state=result.state;if(result.warning)warnings.push(result.warning);
            if(result.event){events.push(result.event);hasUsage=true;}
          }catch{warnings.push('存在无效 JSONL 行，已跳过；其他记录继续采集。');}
        }
        this.store.upsertEvents(events);c.offset+=end+1;await new Promise<void>(r=>setImmediate(r));
      }
      c.headLength=Math.min(c.offset,256);c.headHash=hash(read(0,c.headLength));c.tailHash=hash(read(Math.max(0,c.offset-128),Math.min(c.offset,128)));
      // Persist usage detection without retaining any source content.
      const persisted=c;persisted.hasUsage=hasUsage||cursor?.hasUsage||false;persisted.warnings=Array.from(new Set(warnings)).slice(0,12);
      this.store.saveCursor(key,persisted);return {warnings,hasUsage:persisted.hasUsage};
    }finally {fs.closeSync(fd);}
  }
  start() {
    this.stop();
    this.timers.push(setInterval(()=>void this.refresh('local').catch(()=>{}),30_000),setInterval(()=>void this.refresh('wsl').catch(()=>{}),120_000));
    for(const source of this.store.getSources().filter(s=>s.enabled&&s.kind==='local')) {
      try {const watcher=fs.watch(source.path,{recursive:true},()=>{if(this.debounce)clearTimeout(this.debounce);this.debounce=setTimeout(()=>void this.refresh('local').catch(()=>{}),800);});watcher.on('error',()=>watcher.close());this.watchers.push(watcher);}catch{}
    }
  }
  stop(){this.timers.splice(0).forEach(clearInterval);this.watchers.splice(0).forEach(w=>w.close());if(this.debounce)clearTimeout(this.debounce);}
}
