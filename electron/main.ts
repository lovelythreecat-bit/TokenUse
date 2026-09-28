import { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, dialog, type IpcMainInvokeEvent } from 'electron';
import fs from 'node:fs';import path from 'node:path';import { pathToFileURL } from 'node:url';
import { DateTime } from 'luxon';
import { Store } from './store';import { Collector } from './collector';
import { discoverSources, canonicalPath } from './discovery';
import { previewCsv, exportCsv } from '../src/core/csv';
import { importUsageCsv } from './importer';
import { id, text, validateSource, validatePrice, validateProvider } from './validation';
import type { CsvMapping, Source } from '../src/shared/types';

if(process.env.TOKENUSE_DATA_DIR)app.setPath('userData',path.resolve(process.env.TOKENUSE_DATA_DIR));
let window:BrowserWindow|null=null;let tray:Tray|null=null;let quitting=false;let store:Store;let collector:Collector;
const selectedCsv=new Set<string>();
const development=!app.isPackaged&&process.env.TOKENUSE_DEV_URL==='http://127.0.0.1:5173';
const entry=path.resolve(__dirname,'../dist/index.html');
function changed(){if(window&&!window.isDestroyed())window.webContents.send('changed');}
function authorize(event:IpcMainInvokeEvent) {
  if(!window||event.sender.id!==window.webContents.id||event.senderFrame!==window.webContents.mainFrame)throw new Error('不允许的请求来源');
  const url=event.senderFrame?.url||'';if(development?!url.startsWith('http://127.0.0.1:5173/'):url!==pathToFileURL(entry).href)throw new Error('不允许的页面');
}
function handle(name:string,handler:(...args:any[])=>unknown) {ipcMain.handle(name,async(event,...args)=>{authorize(event);return handler(...args);});}
function snapshot(){store.flush();changed();return store.snapshot();}
function registerIpc() {
 handle('snapshot',()=>store.snapshot());handle('refresh',async()=>{await collector.refresh();return store.snapshot();});
 handle('discover',()=>discoverSources().filter(s=>!store.getSources().some(old=>canonicalPath(old.path)===canonicalPath(s.path))));
 handle('saveSource',(value:unknown)=>{
  const source=validateSource(value);const old=store.getSources().find(s=>s.id===source.id);
  if(store.getSources().some(s=>s.id!==source.id&&canonicalPath(s.path)===canonicalPath(source.path)))throw new Error('该路径已存在，不必重复添加');
  if(source.kind!=='csv'&&store.getSources().some(s=>{if(s.id===source.id||s.kind==='csv')return false;const a=canonicalPath(s.path).replace(/[\\/]$/,'')+'\\';const b=canonicalPath(source.path).replace(/[\\/]$/,'')+'\\';return a.startsWith(b)||b.startsWith(a);}))throw new Error('该目录与已有来源重叠，会重复采集；请选择互不重叠的日志目录');
  if(old&&(old.tool!==source.tool||canonicalPath(old.path)!==canonicalPath(source.path)))throw new Error('已添加来源的工具和路径不可修改，请新增来源');
  if(old)Object.assign(source,{lastSync:old.lastSync,recordCount:old.recordCount,status:old.status,warnings:old.warnings,csvZone:old.csvZone});
  store.saveSource(source);collector.start();return snapshot();
 });
 handle('removeSource',(value:unknown)=>{store.removeSource(id(value));collector.start();return snapshot();});
 handle('saveProvider',(value:unknown)=>{store.saveProvider(validateProvider(value));return snapshot();});
 handle('savePrice',(value:unknown)=>{
  const rule=validatePrice(value);if(!store.snapshot().providers.some(p=>p.id===rule.providerId))throw new Error('服务商不存在');
  if(store.snapshot().prices.some(p=>p.id!==rule.id&&p.providerId===rule.providerId&&p.model===rule.model&&p.effectiveDate===rule.effectiveDate))throw new Error('相同服务商、模型、生效日期已有价格规则，请编辑原规则');
  store.savePrice(rule);return snapshot();
 });
 handle('removePrice',(value:unknown)=>{store.removePrice(id(value));return snapshot();});
 handle('chooseDirectory',async()=>{const result=await dialog.showOpenDialog(window!,{properties:['openDirectory'],title:'选择用量日志目录'});return result.canceled?null:result.filePaths[0];});
 handle('chooseCsv',async()=>{
  const result=await dialog.showOpenDialog(window!,{properties:['openFile'],filters:[{name:'CSV',extensions:['csv']}],title:'导入 Cursor 或其他用量 CSV'});
  if(result.canceled)return null;const filename=result.filePaths[0];
  if(fs.statSync(filename).size>30*1024*1024)throw new Error('CSV 超过 30 MB，请按日期拆分后导入');
  selectedCsv.add(filename);const preview=previewCsv(fs.readFileSync(filename,'utf8'),filename);const source=store.getSources().find(s=>s.kind==='csv'&&canonicalPath(s.path)===canonicalPath(filename));return {...preview,rows:preview.rows.slice(0,5),zone:source?.csvZone};
 });
 handle('importCsv',(args:{path:string;mapping:CsvMapping;zone:string;source:Source;allowExport:boolean})=>{
  if(!args||!selectedCsv.has(args.path))throw new Error('请先通过文件选择器选择 CSV');
  const zone=text(args.zone,'时区',100);if(!DateTime.now().setZone(zone).isValid)throw new Error('时区无效');
  const source=validateSource({...args.source,path:args.path,kind:'csv',tool:'cursor'});
  if(fs.statSync(args.path).size>30*1024*1024)throw new Error('CSV 超过 30 MB');
  const result=importUsageCsv(store,{text:fs.readFileSync(args.path,'utf8'),mapping:args.mapping,zone,source,allowExport:!!args.allowExport});
  return {snapshot:snapshot(),...result};
 });
 handle('exportCsv',async(keys:unknown)=>{
  if(!Array.isArray(keys)||keys.length>1_000_000)throw new Error('导出选择无效');
  const selected=new Set(keys.map(k=>typeof k==='object'&&k?String(k.sourceId)+':'+String(k.id):''));
  const events=store.snapshot().events.filter(e=>selected.has(e.sourceId+':'+e.id));
  const result=await dialog.showSaveDialog(window!,{defaultPath:`TokenUse-${DateTime.now().toFormat('yyyy-MM-dd')}.csv`,filters:[{name:'CSV',extensions:['csv']}]});
  if(result.canceled||!result.filePath)return false;fs.writeFileSync(result.filePath,'\uFEFF'+exportCsv(events),'utf8');return true;
 });
 handle('reassign',(args:{sourceId:string;providerId:string|null;start:string;end:string})=>{
  const start=DateTime.fromISO(text(args.start,'开始时间')),end=DateTime.fromISO(text(args.end,'结束时间'));
  if(!start.isValid||!end.isValid||start>=end)throw new Error('请选择有效的起止时间');
  store.reassign(id(args.sourceId),args.providerId?id(args.providerId):null,start.toUTC().toISO()!,end.toUTC().toISO()!);return snapshot();
 });
}
function createWindow() {
 window=new BrowserWindow({width:1380,height:920,minWidth:1050,minHeight:720,title:'TokenUse',backgroundColor:'#f5f7fa',show:false,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
 window.removeMenu();window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
 window.webContents.on('will-navigate',(event)=>event.preventDefault());
 window.once('ready-to-show',()=>window?.show());
 window.on('close',(event)=>{if(!quitting){event.preventDefault();window?.hide();}});
 if(development)void window.loadURL('http://127.0.0.1:5173/');else void window.loadFile(entry);
 const pixels=Buffer.alloc(32*32*4);for(let y=0;y<32;y++)for(let x=0;x<32;x++){const n=(y*32+x)*4;const bar=(x>=7&&x<=11&&y>=17&&y<=25)||(x>=14&&x<=18&&y>=10&&y<=25)||(x>=21&&x<=25&&y>=6&&y<=25);pixels[n]=bar?255:79;pixels[n+1]=bar?255:93;pixels[n+2]=bar?255:230;pixels[n+3]=255;}
 tray=new Tray(nativeImage.createFromBitmap(pixels,{width:32,height:32}));tray.setToolTip('TokenUse · 个人用量看板');
 const open=()=>{window?.show();window?.focus();};
 tray.setContextMenu(Menu.buildFromTemplate([{label:'打开 TokenUse',click:open},{label:'立即刷新',click:()=>void collector.refresh().catch(showError)},{type:'separator'},{label:'退出',click:()=>{quitting=true;app.quit();}}]));tray.on('double-click',open);
}
function showError(error:unknown){dialog.showErrorBox('TokenUse',error instanceof Error?error.message:String(error));}
if(!app.requestSingleInstanceLock())app.quit();else {
 app.on('second-instance',()=>{window?.show();window?.focus();});
 app.whenReady().then(async()=>{
  const wasm=app.isPackaged?path.join(process.resourcesPath,'sql-wasm.wasm'):path.join(app.getAppPath(),'node_modules/sql.js/dist/sql-wasm.wasm');
  store=await Store.open(path.join(app.getPath('userData'),'tokenuse.sqlite'),wasm);collector=new Collector(store,changed);registerIpc();createWindow();collector.start();
  void collector.refresh().catch(showError);
 }).catch(error=>{showError(error);quitting=true;app.quit();});
 app.on('before-quit',()=>{quitting=true;collector?.stop();});
 app.on('will-quit',()=>{store?.close();tray?.destroy();});
 app.on('window-all-closed',()=>{if(quitting)app.quit();});
}
