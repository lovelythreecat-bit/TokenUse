import {spawn} from 'node:child_process';import fs from 'node:fs';import path from 'node:path';import net from 'node:net';import {chromium,expect} from '@playwright/test';
const base=path.resolve('.test-data');fs.mkdirSync(base,{recursive:true});const folder=fs.mkdtempSync(path.join(base,'portable-'));
const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));
const env={...process.env,TOKENUSE_DATA_DIR:path.join(folder,'profile')};delete env.ELECTRON_RUN_AS_NODE;delete env.TOKENUSE_DEV_URL;
const started=Date.now();const child=spawn(path.resolve(process.argv[2]),[`--remote-debugging-port=${port}`],{env,windowsHide:true,stdio:'ignore'});let exited=false;let exitCode=null;child.on('exit',code=>{exited=true;exitCode=code;});
let browser;let connected=false;
try{
 while(Date.now()-started<90_000){try{const response=await fetch(`http://127.0.0.1:${port}/json/version`,{signal:AbortSignal.timeout(1000)});if(response.ok){connected=true;break;}}catch{}if(exited)throw new Error(`Portable launcher exited before UI: ${exitCode}`);await new Promise(r=>setTimeout(r,400));}
 if(!connected)throw new Error('Portable debug endpoint did not become available within 90 seconds');
 browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);const context=browser.contexts()[0];let page=context.pages().find(p=>p.url().includes('index.html'));
 if(!page)page=await context.waitForEvent('page',{timeout:10000});await expect(page.getByRole('heading',{name:'用量总览',exact:true})).toBeVisible({timeout:15000});
 await expect(page.getByRole('heading',{name:'添加第一个数据源',exact:true})).toBeVisible();await page.getByRole('button',{name:'数据源设置',exact:true}).click();await expect(page.getByRole('button',{name:'检测本地数据源',exact:true})).toBeVisible();
 const snapshot=await page.evaluate(()=>window.tokenuse.snapshot());if(snapshot.events.length!==0)throw new Error('Portable fresh profile contains unexpected events');
 await page.screenshot({path:path.join(folder,'portable.png'),fullPage:true});
 fs.writeFileSync(path.join(folder,'report.json'),JSON.stringify({passed:true,seconds:(Date.now()-started)/1000,version:snapshot.version,events:snapshot.events.length},null,2));
 console.log(JSON.stringify({portableBoot:'passed',seconds:(Date.now()-started)/1000,folder}));
}finally{
 if(browser)void browser.close().catch(()=>{});
 if(!exited){if(process.platform==='win32')await new Promise(r=>{const timer=setTimeout(r,3000);const killer=spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});const done=()=>{clearTimeout(timer);r();};killer.once('exit',done);killer.once('error',done);});else child.kill();}
}
