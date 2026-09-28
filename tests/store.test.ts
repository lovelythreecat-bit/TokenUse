import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../electron/store';
import type { Source, UsageEvent } from '../src/shared/types';
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(d => fs.rmSync(d, { recursive: true, force: true })));
const source: Source = { id:'s', name:'测试', tool:'claude', kind:'local', path:'C:/logs', enabled:true, included:true, defaultProviderId:'p', status:'就绪',lastSync:null,recordCount:0,warnings:[] };
const event: UsageEvent = {id:'e',sourceId:'s',tool:'claude',timestamp:'2026-09-14T01:00:00Z',precision:'instant',model:'test',project:null,providerId:null,tokens:{input:10,output:5,cacheRead:0,cacheWrite:0,reasoning:0,total:15},reportedCost:null,warnings:[]};
describe('SQLite storage', () => {
  it('persists updates once and preserves assigned provider across rescans', async () => {
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tokenuse-store-'));dirs.push(dir);
    let store=await Store.open(path.join(dir,'usage.db'));
    store.saveSource(source); store.upsertEvents([event]); store.flush();
    store.saveSource({...source,defaultProviderId:'new'});
    store.upsertEvents([{...event,tokens:{...event.tokens,output:8,total:18}}]);store.close();
    store=await Store.open(path.join(dir,'usage.db'));
    expect(store.snapshot().events).toHaveLength(1);
    expect(store.snapshot().events[0].providerId).toBe('p');
    expect(store.snapshot().events[0].tokens.total).toBe(18);
    expect(store.snapshot().sources[0].defaultProviderId).toBe('new');store.close();
  });
  it('reassigns only requested source and half-open time range', async () => {
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tokenuse-store-'));dirs.push(dir);
    const store=await Store.open(path.join(dir,'usage.db'));store.saveSource(source);
    store.upsertEvents([event,{...event,id:'end',timestamp:'2026-09-14T02:00:00Z'}]);
    store.reassign('s','new','2026-09-14T01:00:00Z','2026-09-14T02:00:00Z');
    const records=store.snapshot().events;
    expect(records.find(e=>e.id==='e')?.providerId).toBe('new');
    expect(records.find(e=>e.id==='end')?.providerId).toBe('p');store.close();
  });
  it('does not downgrade a completed message when a rotated file repeats an older snapshot',async()=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tokenuse-store-'));dirs.push(dir);
    const store=await Store.open(path.join(dir,'usage.db'));store.saveSource(source);
    store.upsertEvents([{...event,tokens:{...event.tokens,output:20,total:30}}]);
    store.upsertEvents([event]);expect(store.snapshot().events[0].tokens.total).toBe(30);store.close();
  });
});
