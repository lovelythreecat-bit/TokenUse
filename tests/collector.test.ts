import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { Store } from '../electron/store';
import { Collector, canonicalPath } from '../electron/collector';
import type { Source } from '../src/shared/types';
const dirs: string[]=[];
afterEach(()=>dirs.splice(0).forEach(d=>fs.rmSync(d,{recursive:true,force:true})));
const row=(id:string,n:number)=>JSON.stringify({type:'assistant',timestamp:'2026-09-14T01:00:00Z',requestId:id,message:{id,model:'test',usage:{input_tokens:n,output_tokens:5,cache_creation_input_tokens:0,cache_read_input_tokens:0}}});
it('reads only complete lines, survives duplicate refresh and truncation without double counting',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tokenuse-collector-'));dirs.push(dir);
 const logdir=path.join(dir,'logs');fs.mkdirSync(logdir);const file=path.join(logdir,'session.jsonl');
 const s:Source={id:'s',name:'test',tool:'claude',kind:'local',path:logdir,enabled:true,included:true,defaultProviderId:null,status:'就绪',lastSync:null,recordCount:0,warnings:[]};
 const store=await Store.open(path.join(dir,'usage.db'));store.saveSource(s);const collector=new Collector(store);
 fs.writeFileSync(file,row('a',10)+'\n'+row('b',20).slice(0,30));
 await collector.refresh();await collector.refresh();expect(store.snapshot().events).toHaveLength(1);
 fs.appendFileSync(file,row('b',20).slice(30)+'\n');await collector.refresh();
 expect(store.snapshot().events).toHaveLength(2);
 fs.writeFileSync(file,row('a',10)+'\n');await collector.refresh();
 expect(store.snapshot().events).toHaveLength(2);collector.stop();store.close();
});
it('maps Windows mount aliases but keeps independent Linux logs distinct',()=>{
 expect(canonicalPath('C:\\Users\\me\\.claude')).toBe(canonicalPath('\\\\wsl.localhost\\Ubuntu\\mnt\\c\\Users\\me\\.claude'));
 expect(canonicalPath('\\\\wsl.localhost\\Ubuntu\\home\\me\\.claude')).not.toBe(canonicalPath('C:\\Users\\me\\.claude'));
});
it('keeps parse diagnostics visible on an unchanged refresh',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tokenuse-collector-'));dirs.push(dir);const logs=path.join(dir,'logs');fs.mkdirSync(logs);
 fs.writeFileSync(path.join(logs,'a.jsonl'),'{broken}\n'+row('ok',10)+'\n');
 const store=await Store.open(path.join(dir,'usage.db'));
 store.saveSource({id:'s',name:'test',tool:'claude',kind:'local',path:logs,enabled:true,included:true,defaultProviderId:null,status:'',lastSync:null,recordCount:0,warnings:[]});
 const collector=new Collector(store);await collector.refresh();expect(store.snapshot().sources[0].warnings.join()).toContain('无效 JSONL');
 await collector.refresh();expect(store.snapshot().sources[0].warnings.join()).toContain('无效 JSONL');collector.stop();store.close();
});
it.each(['claude','codex','openclaw'] as const)('does not duplicate %s when a real log file is renamed',async(tool)=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tokenuse-rename-'));dirs.push(dir);const logs=path.join(dir,'logs');fs.mkdirSync(logs);
 const log=path.join(logs,'session.jsonl');
 const content=tool==='claude'?row('native-id',10):tool==='openclaw'?JSON.stringify({type:'message',id:'native-id',timestamp:'2026-09-14T01:00:00Z',message:{usage:{input:10,output:5,cacheRead:0,cacheWrite:0,totalTokens:15}}}):JSON.stringify({type:'session_meta',payload:{id:'native-session'}})+'\n'+JSON.stringify({type:'event_msg',timestamp:'2026-09-14T01:00:00Z',payload:{type:'token_count',info:{total_token_usage:{input_tokens:10,output_tokens:5,total_tokens:15}}}});
 fs.writeFileSync(log,content+'\n');const store=await Store.open(path.join(dir,'usage.db'));
 store.saveSource({id:'s',name:'test',tool,kind:'local',path:logs,enabled:true,included:true,defaultProviderId:null,status:'',lastSync:null,recordCount:0,warnings:[]});
 const collector=new Collector(store);await collector.refresh();expect(store.snapshot().events).toHaveLength(1);
 fs.renameSync(log,path.join(logs,'session-old.jsonl'));await collector.refresh();expect(store.snapshot().events).toHaveLength(1);collector.stop();store.close();
});
it('continues past a very large conversation row to collect following usage',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tokenuse-large-'));dirs.push(dir);const logs=path.join(dir,'logs');fs.mkdirSync(logs);
 fs.writeFileSync(path.join(logs,'large.jsonl'),JSON.stringify({type:'user',content:'x'.repeat(5*1024*1024)})+'\n'+row('after-large',10)+'\n');
 const store=await Store.open(path.join(dir,'usage.db'));store.saveSource({id:'s',name:'test',tool:'claude',kind:'local',path:logs,enabled:true,included:true,defaultProviderId:null,status:'',lastSync:null,recordCount:0,warnings:[]});
 const collector=new Collector(store);await collector.refresh();expect(store.snapshot().events).toHaveLength(1);collector.stop();store.close();
});
it('runs a pending full refresh after a narrower refresh so another scope is not dropped',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tokenuse-scope-'));dirs.push(dir);const logs=path.join(dir,'logs');fs.mkdirSync(logs);fs.writeFileSync(path.join(logs,'a.jsonl'),row('a',10)+'\n');
 const store=await Store.open(path.join(dir,'usage.db'));store.saveSource({id:'s',name:'test',tool:'claude',kind:'local',path:logs,enabled:true,included:true,defaultProviderId:null,status:'',lastSync:null,recordCount:0,warnings:[]});
 const collector=new Collector(store);const narrow=collector.refresh('wsl');const all=collector.refresh();await Promise.all([narrow,all]);expect(store.snapshot().events).toHaveLength(1);collector.stop();store.close();
});
