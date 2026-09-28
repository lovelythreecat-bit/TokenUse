import path from 'node:path';
import { DateTime } from 'luxon';
import type { Source, Provider, PriceRule, Part } from '../src/shared/types';
export function text(value:unknown,name:string,max=2048):string {if(typeof value!=='string'||value.length>max)throw new Error(`${name}格式无效`);return value.trim();}
export function id(value:unknown):string {const v=text(value,'标识',100);if(!/^[\w.-]+$/.test(v))throw new Error('标识无效');return v;}
const record=(value:unknown):Record<string,unknown>=>{if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('参数格式无效');return value as Record<string,unknown>;};
const url=(value:unknown):string=>{const v=text(value??'','网址');if(v&&!['https:','http:'].includes(new URL(v).protocol))throw new Error('网址必须使用 http 或 https');return v;};
export function validateSource(value:unknown):Source {
  const v=record(value);const rawPath=text(v.path,'路径');const p=/^(?:[a-z]:|[\\/]{2})/i.test(rawPath)?rawPath.replace(/\//g,'\\'):rawPath;const kind=v.kind;
  if(!['local','wsl','csv'].includes(kind as string)||!['claude','codex','openclaw','cursor'].includes(v.tool as string))throw new Error('数据源类型无效');
  if(!path.win32.isAbsolute(p)&&!path.posix.isAbsolute(p))throw new Error('请填写绝对路径');
  if(/^\\\\/.test(p)&&!/^\\\\wsl(?:\.localhost|\$)\\[^\\]+\\/i.test(p))throw new Error('只支持本机或 WSL 目录，不支持远程共享');
  const isWsl=/^\\\\wsl(?:\.localhost|\$)\\/i.test(p);
  if((kind==='wsl')!==isWsl&&kind!=='csv')throw new Error('WSL 路径请使用 WSL 数据源类型');
  const name=text(v.name,'名称',100);if(!name)throw new Error('请填写名称');
  return {id:id(v.id),name,tool:v.tool as Source['tool'],kind:kind as Source['kind'],path:p,enabled:!!v.enabled,included:!!v.included,defaultProviderId:v.defaultProviderId?id(v.defaultProviderId):null,status:'待同步',lastSync:null,recordCount:0,warnings:[]};
}
export function validateProvider(value:unknown):Provider {
  const v=record(value);const aliases=record(v.aliases||{});const clean:Record<string,string>={};
  if(Object.keys(aliases).length>500)throw new Error('模型别名过多');
  for(const [key,value] of Object.entries(aliases)){if(['__proto__','constructor','prototype'].includes(key))throw new Error('别名无效');clean[text(key,'模型名',200)]=text(value,'别名',200);}
  const name=text(v.name,'名称',100);if(!name)throw new Error('请填写名称');
  return {id:id(v.id),name,website:url(v.website),pricingUrl:url(v.pricingUrl),baseUrl:url(v.baseUrl),protocol:text(v.protocol??'','协议',200),enabled:!!v.enabled,deleted:!!v.deleted,aliases:clean,hints:Array.isArray(v.hints)?v.hints.slice(0,100).map(x=>text(x,'服务商标识',200)):[]};
}
export function validatePrice(value:unknown):PriceRule {
  const v=record(value);const rates=record(v.rates);const clean={} as PriceRule['rates'];
  for(const part of ['input','output','cacheRead','cacheWrite','reasoning'] as Part[]){const n=rates[part];if(n===null||n===undefined||n===''){clean[part]=null;continue;}if(typeof n!=='number'||!Number.isFinite(n)||n<0||n>1e9)throw new Error('单价必须是非负有限数');clean[part]=n;}
  const date=text(v.effectiveDate,'生效日期',10);if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!DateTime.fromISO(date).isValid)throw new Error('生效日期无效');
  const currency=text(v.currency,'币种',10).toUpperCase();if(!/^[A-Z]{3}$/.test(currency))throw new Error('币种使用 CNY、USD 等三个字母');
  const model=text(v.model,'模型',200);if(!model)throw new Error('请填写模型名称');
  return {id:id(v.id),providerId:id(v.providerId),model,currency,effectiveDate:date,rates:clean,reasoningFallback:!!v.reasoningFallback};
}
