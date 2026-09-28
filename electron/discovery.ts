import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { Source, Tool } from '../src/shared/types';
export function runningDistros():string[] {
  if(process.platform!=='win32')return [];
  try {return execFileSync('wsl.exe',['--list','--running','--quiet'],{timeout:5000,windowsHide:true}).toString('utf16le').replace(/\u0000|\uFEFF/g,'').split(/\r?\n/).map(v=>v.trim()).filter(Boolean);} catch{return [];}
}
export function wslDistro(p:string) {return p.replace(/\//g,'\\').match(/^\\\\wsl(?:\.localhost|\$)\\([^\\]+)/i)?.[1]??null;}
export function canonicalPath(p:string):string {
  let value=p.replace(/\//g,'\\').replace(/\\+$/,'');
  value=value.replace(/^\\\\wsl\$\\/i,'\\\\wsl.localhost\\');
  const mount=value.match(/^\\\\wsl\.localhost\\[^\\]+\\mnt\\([a-z])(?:\\(.*))?$/i);
  if(mount)value=mount[1]+':\\'+(mount[2]||'');
  if(!wslDistro(value)) {
    try {value=fs.realpathSync.native(value);}catch{/* A not-yet-created path can still be compared lexically. */}
    return process.platform==='win32'?value.toLowerCase():p.includes('\\')?value.toLowerCase():path.resolve(p);
  }
  return value.replace(/^\\\\wsl\.localhost\\([^\\]+)/i,(_,d)=>'\\\\wsl.localhost\\'+d.toLowerCase());
}
export function discoverSources():Source[] {
  const result:Source[]=[];
  const add=(tool:Tool,p:string,kind:'local'|'wsl',label:string)=>{
    try{if(!fs.statSync(p).isDirectory())return;fs.accessSync(p,fs.constants.R_OK);}catch{return;}
    result.push({id:createHash('sha256').update(canonicalPath(p)).digest('hex').slice(0,20),name:label,tool,kind,path:p,enabled:true,included:true,defaultProviderId:null,status:'待添加',lastSync:null,recordCount:0,warnings:[]});
  };
  const home=os.homedir();
  add('codex',path.join(process.env.CODEX_HOME||path.join(home,'.codex'),'sessions'),'local','Codex · Windows');
  add('claude',path.join(process.env.CLAUDE_CONFIG_DIR||path.join(home,'.claude'),'projects'),'local','Claude Code · Windows');
  for(const folder of ['.openclaw','.clawdbot','.moltbot','.moldbot'])add('openclaw',path.join(home,folder,'agents'),'local',`OpenClaw · Windows${folder==='.openclaw'?'':' · '+folder}`);
  for(const distro of runningDistros()) {
    const base='\\\\wsl.localhost\\'+distro;
    const homes:string[]=[];
    try{for(const item of fs.readdirSync(base+'\\home',{withFileTypes:true}))if(item.isDirectory())homes.push(base+'\\home\\'+item.name);}catch{}
    homes.push(base+'\\root');
    for(const h of homes) {
      add('codex',h+'\\.codex\\sessions','wsl',`Codex · ${distro} · ${path.win32.basename(h)}`);
      add('claude',h+'\\.claude\\projects','wsl',`Claude Code · ${distro} · ${path.win32.basename(h)}`);
      for(const folder of ['.openclaw','.clawdbot','.moltbot','.moldbot'])add('openclaw',h+'\\'+folder+'\\agents','wsl',`OpenClaw · ${distro} · ${path.win32.basename(h)}`);
    }
  }
  return result.filter((s,i,a)=>a.findIndex(v=>canonicalPath(v.path)===canonicalPath(s.path))===i);
}
