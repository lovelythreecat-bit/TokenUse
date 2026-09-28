import { _electron as electron, expect } from '@playwright/test';
import fs from 'node:fs';import path from 'node:path';import {createRequire} from 'node:module';import {DateTime} from 'luxon';import assert from 'node:assert/strict';
if(process.argv.includes('--portable-boot')){await import('./portable-boot.mjs');process.exit(0);}
const require=createRequire(import.meta.url);const root=process.cwd();const base=path.join(root,'.test-data');fs.mkdirSync(base,{recursive:true});
if(process.argv[2])process.env.TOKENUSE_PACKAGED_EXE=path.resolve(process.argv[2]);
const data=fs.mkdtempSync(path.join(base,'desktop-'));const profiles=path.join(data,'profile');const logs=path.join(data,'logs');fs.mkdirSync(logs);
const today=DateTime.now().startOf('day');const iso=(hour,days=0)=>today.plus({days,hours:hour}).toUTC().toISO();
const makeDirectory=(name,lines)=>{const p=path.join(logs,name);fs.mkdirSync(p);fs.writeFileSync(path.join(p,'session.jsonl'),lines.map(JSON.stringify).join('\n')+'\n');return p;};
const codex=makeDirectory('codex',[{type:'session_meta',payload:{id:'e2e-session',cwd:'test-project'}},{type:'turn_context',payload:{model:'e2e-codex'}},...[[9,-1,50,20,10,5],[9,0,150,50,30,15]].map(([h,d,i,o,c,r])=>({type:'event_msg',timestamp:iso(h,d),payload:{type:'token_count',info:{total_token_usage:{input_tokens:i,output_tokens:o,cached_input_tokens:c,cache_write_input_tokens:0,reasoning_output_tokens:r,total_tokens:i+o}}}}))]);
const claude=makeDirectory('claude',[{type:'assistant',timestamp:iso(14),cwd:'test-project',requestId:'e2e-request',message:{id:'e2e-message',model:'e2e-claude',usage:{input_tokens:40,output_tokens:35,cache_read_input_tokens:10,cache_creation_input_tokens:10}}}]);
const openclaw=makeDirectory('openclaw',[{type:'session',id:'e2e-claw-session'},{type:'message',id:'e2e-claw-message',timestamp:iso(20),message:{model:'e2e-openclaw',usage:{input:80,output:40,cacheRead:20,cacheWrite:10,totalTokens:150}}}]);
const errors=[];const checks=[];const check=(name)=>{checks.push(name);console.log('PASS '+name);};
let app;let page;
async function launch(){const env={...process.env,TOKENUSE_DATA_DIR:profiles};delete env.ELECTRON_RUN_AS_NODE;delete env.TOKENUSE_DEV_URL;app=await electron.launch({executablePath:process.env.TOKENUSE_PACKAGED_EXE||require('electron'),args:process.env.TOKENUSE_PACKAGED_EXE?[]:[root],env,timeout:45000});page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));await page.waitForLoadState('domcontentloaded');await expect(page.getByRole('heading',{name:'用量总览',exact:true})).toBeVisible();await page.waitForFunction(()=>!!window.tokenuse);}
async function addSource(name,tool,p){await page.getByRole('button',{name:'数据源设置',exact:true}).click();await page.getByRole('button',{name:'手动添加',exact:true}).click();const modal=page.getByRole('dialog');await modal.getByLabel('名称',{exact:true}).fill(name);await modal.getByLabel(/^工具/).selectOption(tool);await modal.locator('input.mono').fill(p);await modal.getByLabel(/^默认服务商/).selectOption('deepseek');await modal.getByRole('button',{name:'保存并刷新',exact:true}).click();await expect(modal).toBeHidden({timeout:20000});}
async function snapshot(){return page.evaluate(()=>window.tokenuse.snapshot());}
try {
 await launch();await expect(page.getByRole('heading',{name:'添加第一个数据源',exact:true})).toBeVisible();check('fresh profile opens with empty state');
 await addSource('验收 Codex','codex',codex);await addSource('验收 Claude','claude',claude);await addSource('验收 OpenClaw','openclaw',openclaw);
 let s=await snapshot();assert.equal(s.events.length,4);assert.equal(s.events.reduce((n,e)=>n+e.tokens.total,0),445);check('three tools ingest 4 records / 445 tokens via UI');
 await page.getByRole('button',{name:'刷新',exact:true}).click();await expect(page.getByRole('button',{name:'刷新',exact:true})).toBeEnabled();s=await snapshot();assert.equal(s.events.length,4);check('manual refresh does not double count');
 await page.getByRole('button',{name:'用量总览',exact:true}).click();await expect(page.locator('.stat-value').first()).toHaveText('375');check('today summary totals 375');
 await page.getByRole('button',{name:'近 7 天',exact:true}).click();await expect(page.locator('.stat-value').first()).toHaveText('445');check('seven-day summary includes both dates');
 await page.screenshot({path:path.join(data,'dashboard.png'),fullPage:true});
 const hours=page.getByRole('img',{name:'一天内各小时已记录用量'});await hours.getByRole('button',{name:/^09:00/}).click();await expect(page.getByRole('heading',{name:'用量明细',exact:true})).toBeVisible();
 await expect(page.locator('tbody tr')).toHaveCount(2);check('hour drilldown includes both dates at 09:00');
 await page.getByRole('button',{name:/返回完整范围/}).click();await expect(page.locator('tbody tr')).toHaveCount(4);check('drilldown resets without losing date range');
 await page.getByRole('button',{name:'数据源设置',exact:true}).click();await page.getByRole('button',{name:'价格规则',exact:true}).click();await page.getByRole('button',{name:/添加价格/}).click();
 let modal=page.getByRole('dialog');await modal.getByLabel(/^服务商/).selectOption('deepseek');await modal.getByLabel('模型',{exact:true}).fill('e2e-codex');await modal.getByLabel('币种',{exact:true}).fill('USD');await modal.getByLabel('生效日期',{exact:true}).fill(today.minus({days:2}).toISODate());
 for(const label of ['输入','输出','缓存读取','缓存写入'])await modal.getByLabel(new RegExp('^'+label+'（')).fill('2');
 await modal.getByRole('button',{name:'保存',exact:true}).click();await expect(modal).toBeHidden();s=await snapshot();assert.equal(s.prices.length,1);check('price rule saved through UI');
 const csv=path.join(data,'cursor.csv');fs.writeFileSync(csv,'Date,Total Tokens,Model,Cost\n'+iso(10)+',50,e2e-cursor,0.01\n'+today.toISODate()+',20,e2e-cursor,\n');
 await app.evaluate(({dialog},filename)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[filename]});},csv);
 await page.getByRole('button',{name:'日志来源',exact:true}).click();await page.getByRole('button',{name:'导入 CSV',exact:true}).click();modal=page.getByRole('dialog');await expect(modal).toBeVisible();
 await modal.getByLabel(/^CSV 时间所在时区/).fill('UTC');
 await modal.getByRole('button',{name:'开始导入',exact:true}).click();await expect(modal).toBeHidden();s=await snapshot();assert.equal(s.events.length,6);assert.equal(s.events.find(e=>e.tool==='cursor'&&e.precision==='instant').reportedCost.currency,'USD');check('Cursor CSV preview/mapping/import with currency');
 await page.getByRole('button',{name:'导入 CSV',exact:true}).click();modal=page.getByRole('dialog');await expect(modal.getByLabel(/^CSV 时间所在时区/)).toHaveValue('UTC');check('CSV import restores the original timezone');await modal.getByRole('button',{name:'开始导入',exact:true}).click();await expect(modal).toBeHidden();assert.equal((await snapshot()).events.length,6);check('same CSV reimport is idempotent');
 await page.getByRole('button',{name:'用量总览',exact:true}).click();await page.getByRole('button',{name:'今日',exact:true}).click();
 await page.getByRole('img',{name:'已记录用量时间趋势',exact:true}).getByRole('button',{name:/09:00/}).click();await expect(page.locator('tbody tr')).toHaveCount(1);check('hourly timeline details exclude date-only records');
 await page.getByRole('button',{name:/返回完整范围/}).click();
 const exported=path.join(data,'export.csv');await app.evaluate(({dialog},filename)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:filename});},exported);
 await page.getByRole('button',{name:'用量明细',exact:true}).click();await page.getByRole('button',{name:'导出 CSV',exact:true}).click();await expect.poll(()=>fs.existsSync(exported)).toBe(true);assert(fs.readFileSync(exported,'utf8').includes('# TokenUse Export v1'));check('filtered records export with duplicate-protection marker');
 await page.screenshot({path:path.join(data,'details.png'),fullPage:true});
 await app.close();app=null;await launch();s=await snapshot();assert.equal(s.events.length,6);assert.equal(s.prices.length,1);assert.equal(s.sources.length,4);check('restart retains source configuration, events and prices');
 assert.deepEqual(errors,[]);check('no renderer exceptions');
 fs.writeFileSync(path.join(data,'report.json'),JSON.stringify({checks,errors,data,packaged:!!process.env.TOKENUSE_PACKAGED_EXE},null,2));
 console.log(JSON.stringify({passed:checks.length,data,packaged:!!process.env.TOKENUSE_PACKAGED_EXE}));
}catch(error){if(page)await page.screenshot({path:path.join(data,'failure.png'),fullPage:true}).catch(()=>{});console.error(error);console.error('Artifacts: '+data);process.exitCode=1;}finally{if(app)await app.close().catch(()=>{});}
