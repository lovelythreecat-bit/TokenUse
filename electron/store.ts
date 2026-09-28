import fs from 'node:fs';
import path from 'node:path';
import initSqlJs, { type Database } from 'sql.js';
import type { AppSnapshot, Source, Provider, PriceRule, UsageEvent, ParseState } from '../src/shared/types';

export interface Cursor { offset:number; line:number; state:ParseState; headHash:string; headLength:number; tailHash:string; hasUsage?:boolean; warnings?:string[]; }
const presets: Provider[] = [
  {id:'hanhe',name:'寒鹤中转站',website:'https://api.hanhegufei.online/',pricingUrl:'',baseUrl:'',protocol:'自定义',enabled:true,aliases:{},hints:[]},
  {id:'chenguang',name:'晨光号中转站',website:'https://api.chenguanghao.cn/',pricingUrl:'https://api.chenguanghao.cn/pricing',baseUrl:'',protocol:'自定义',enabled:true,aliases:{},hints:[]},
  {id:'penguin',name:'Penguin API',website:'https://penguinapi.vip/',pricingUrl:'',baseUrl:'',protocol:'自定义',enabled:true,aliases:{},hints:[]},
  {id:'deepseek',name:'DeepSeek 官方',website:'https://www.deepseek.com/',pricingUrl:'https://api-docs.deepseek.com/quick_start/pricing',baseUrl:'https://api.deepseek.com',protocol:'OpenAI 兼容',enabled:true,aliases:{},hints:['deepseek']},
];
export class Store {
  private dirty=false;
  refreshing=false;
  private constructor(private db:Database, private filename:string) {}
  static async open(filename:string,wasmPath?:string):Promise<Store> {
    const SQL=await initSqlJs({locateFile:()=>wasmPath || path.join(process.cwd(),'node_modules/sql.js/dist/sql-wasm.wasm')});
    fs.mkdirSync(path.dirname(filename),{recursive:true});
    const db=fs.existsSync(filename)?new SQL.Database(fs.readFileSync(filename)):new SQL.Database();
    db.run('CREATE TABLE IF NOT EXISTS config (kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(kind,id)); CREATE TABLE IF NOT EXISTS events (key TEXT PRIMARY KEY, source TEXT NOT NULL, timestamp TEXT NOT NULL, data TEXT NOT NULL); CREATE INDEX IF NOT EXISTS events_time ON events(timestamp); CREATE INDEX IF NOT EXISTS events_source ON events(source);');
    const store=new Store(db,filename);
    if(!store.get('meta','initialized')) {for(const p of presets)store.set('providers',p.id,p);store.set('meta','initialized',true);}
    store.flush();return store;
  }
  private get<T>(kind:string,id:string):T|undefined {
    const statement=this.db.prepare('SELECT data FROM config WHERE kind=? AND id=?');
    try {statement.bind([kind,id]);return statement.step()?JSON.parse(statement.getAsObject().data as string):undefined;} finally {statement.free();}
  }
  private all<T>(kind:string):T[] {
    const statement=this.db.prepare('SELECT data FROM config WHERE kind=? ORDER BY rowid');
    try {statement.bind([kind]);const rows:T[]=[];while(statement.step())rows.push(JSON.parse(statement.getAsObject().data as string));return rows;} finally {statement.free();}
  }
  private set(kind:string,id:string,value:unknown) {this.db.run('INSERT INTO config(kind,id,data) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data',[kind,id,JSON.stringify(value)]);this.dirty=true;}
  getSources() {return this.all<Source>('sources');}
  saveSource(source:Source) {this.set('sources',source.id,source);}
  removeSource(id:string) {const source=this.get<Source>('sources',id);if(source)this.saveSource({...source,enabled:false,status:'已停用'});}
  saveProvider(provider:Provider) {this.set('providers',provider.id,provider);}
  savePrice(price:PriceRule) {this.set('prices',price.id,price);}
  removePrice(id:string) {this.db.run('DELETE FROM config WHERE kind=? AND id=?',['prices',id]);this.dirty=true;}
  getCursor(key:string):Cursor|undefined {return this.get<Cursor>('cursor',key);}
  saveCursor(key:string,cursor:Cursor) {this.set('cursor',key,cursor);}
  upsertEvents(events:UsageEvent[]) {
    const sources=this.getSources();const providers=this.all<Provider>('providers');
    const lookup=this.db.prepare('SELECT data FROM events WHERE key=?');
    const write=this.db.prepare('INSERT INTO events(key,source,timestamp,data) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET timestamp=excluded.timestamp,data=excluded.data');
    this.db.run('BEGIN');
    try {
      for(const event of events) {
        const key=event.sourceId+':'+event.id;
        lookup.bind([key]);const previous=lookup.step()?JSON.parse(lookup.getAsObject().data as string) as UsageEvent:undefined;lookup.reset();
        if(previous && (Date.parse(event.timestamp)<Date.parse(previous.timestamp) ||
          (Date.parse(event.timestamp)===Date.parse(previous.timestamp)&&event.tokens.total!==null&&previous.tokens.total!==null&&event.tokens.total<previous.tokens.total)))continue;
        const source=sources.find(s=>s.id===event.sourceId);
        const mapped=providers.find(p=>p.enabled&&!p.deleted&&event.providerHint&&p.hints.includes(event.providerHint));
        const defaultProvider=providers.find(p=>p.id===source?.defaultProviderId);
        const defaultId=defaultProvider?defaultProvider.enabled&&!defaultProvider.deleted?defaultProvider.id:null:source?.defaultProviderId??null;
        // Existing attribution is a historical fact, even when explicitly unknown.
        const providerId=previous?previous.providerId:event.providerId||mapped?.id||defaultId;
        const value={...event,providerId};
        write.run([key,event.sourceId,event.timestamp,JSON.stringify(value)]);
      }
      this.db.run('COMMIT');if(events.length)this.dirty=true;
    } catch(error) {this.db.run('ROLLBACK');throw error;} finally {lookup.free();write.free();}
  }
  reassign(sourceId:string,providerId:string|null,start:string,end:string) {
    const events=this.readEvents().filter(e=>e.sourceId===sourceId&&e.timestamp>=new Date(start).toISOString()&&e.timestamp<new Date(end).toISOString());
    const statement=this.db.prepare('UPDATE events SET data=? WHERE key=?');
    try {for(const event of events)statement.run([JSON.stringify({...event,providerId}),event.sourceId+':'+event.id]);} finally {statement.free();}
    this.dirty=true;
  }
  private readEvents():UsageEvent[] {const rows=this.db.exec('SELECT data FROM events ORDER BY timestamp DESC');return rows.length?rows[0].values.map(r=>JSON.parse(r[0] as string)):[];}
  countForSource(id:string):number {const st=this.db.prepare('SELECT COUNT(*) as count FROM events WHERE source=?');try{st.bind([id]);st.step();return Number(st.getAsObject().count);}finally{st.free();}}
  markRefreshed() {this.set('meta','lastRefresh',new Date().toISOString());}
  snapshot():AppSnapshot {return {sources:this.getSources(),providers:this.all('providers'),prices:this.all('prices'),events:this.readEvents(),refreshing:this.refreshing,lastRefresh:this.get<string>('meta','lastRefresh')??null,version:'0.1.0'};}
  flush() {
    if(!this.dirty)return;
    const temporary=this.filename+'.tmp';
    const fd=fs.openSync(temporary,'w');try{fs.writeFileSync(fd,Buffer.from(this.db.export()));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    fs.renameSync(temporary,this.filename);this.dirty=false;
  }
  close() {this.flush();this.db.close();}
}
