import {expect,it,afterEach} from 'vitest';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {Store} from '../electron/store';import {importUsageCsv} from '../electron/importer';import type {Source} from '../src/shared/types';
const dirs:string[]=[];afterEach(()=>dirs.splice(0).forEach(d=>fs.rmSync(d,{recursive:true,force:true})));
it('reuses same-file imports and excludes overlapping new files from the total by default',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tokenuse-import-'));dirs.push(dir);const store=await Store.open(path.join(dir,'usage.db'));
 const source:Source={id:'a',name:'CSV',tool:'cursor',kind:'csv',path:path.join(dir,'a.csv'),enabled:true,included:true,defaultProviderId:null,status:'',lastSync:null,recordCount:0,warnings:[]};
 const args={text:'time,total\n2026-09-14T09:00:00,10\n',mapping:{timestamp:'time',total:'total'},zone:'Asia/Shanghai',source,allowExport:false};
 expect(importUsageCsv(store,args).imported).toBe(1);expect(importUsageCsv(store,args).imported).toBe(0);
 expect(store.snapshot().sources[0].csvZone).toBe('Asia/Shanghai');
 expect(()=>importUsageCsv(store,{...args,zone:'UTC'})).toThrow(/时区/);
 const copy=importUsageCsv(store,{...args,source:{...source,id:'copy',path:path.join(dir,'copy.csv')}});
 expect(copy.errors.join()).toContain('重叠');expect(store.snapshot().sources.find(s=>s.id==='copy')?.included).toBe(false);
 store.close();
});
it('allows correcting timezone when an initial CSV attempt saved no records',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tokenuse-import-'));dirs.push(dir);const store=await Store.open(path.join(dir,'usage.db'));
 const source:Source={id:'a',name:'CSV',tool:'cursor',kind:'csv',path:path.join(dir,'a.csv'),enabled:true,included:true,defaultProviderId:null,status:'',lastSync:null,recordCount:0,warnings:[]};
 const args={text:'time,total\nbad,10\n',mapping:{timestamp:'time',total:'total'},zone:'UTC',source,allowExport:false};
 expect(importUsageCsv(store,args).imported).toBe(0);
 expect(importUsageCsv(store,{...args,text:'time,total\n2026-09-14T09:00:00,10\n',zone:'Asia/Shanghai'}).imported).toBe(1);store.close();
});
