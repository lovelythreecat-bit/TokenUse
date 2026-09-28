import { DateTime } from 'luxon';
import type { Grain, Query, Tokens } from './shared/types';
export const toolNames:Record<string,string>={codex:'Codex',claude:'Claude Code',openclaw:'OpenClaw',cursor:'Cursor'};
export const partNames:Record<keyof Tokens,string>={input:'未缓存输入',output:'输出',cacheRead:'缓存读取',cacheWrite:'缓存写入',reasoning:'推理',total:'总 Token'};
export const number=(n:number|null|undefined)=>n==null?'—':new Intl.NumberFormat('zh-CN',{maximumFractionDigits:2}).format(n);
export const compact=(n:number)=>n>=1_000_000?(n/1_000_000).toFixed(2)+'M':n>=1000?(n/1000).toFixed(1)+'K':number(n);
export const money=(n:number,currency:string)=>`${currency} ${new Intl.NumberFormat('zh-CN',{maximumFractionDigits:6}).format(n)}`;
export interface ViewOptions {range:string;grain:Grain;zone:string;customStart:string;customEnd:string;filters:Partial<Query>}
export function makeQuery(options:ViewOptions,now:DateTime=DateTime.now()):Query {
  const today=now.setZone(options.zone).startOf('day');let start=today,end=today.plus({days:1});let exactTime=false;
  if(options.range==='yesterday'){start=today.minus({days:1});end=today;}
  if(options.range==='7d')start=today.minus({days:6});
  if(options.range==='30d')start=today.minus({days:29});
  if(options.range==='month')start=today.startOf('month');
  if(options.range==='custom'){
    start=DateTime.fromISO(options.customStart,{zone:options.zone});end=DateTime.fromISO(options.customEnd,{zone:options.zone});
    exactTime=options.customStart.includes('T')||options.customEnd.includes('T');
    if(!options.customEnd.includes('T'))end=end.plus({days:1}).startOf('day');
  }
  if(!start.isValid||!end.isValid||end<=start)throw new Error('请选择有效的起止日期，结束时间需要晚于开始时间。');
  return {...options.filters,start:start.toUTC().toISO()!,end:end.toUTC().toISO()!,zone:options.zone,grain:options.grain,exactTime};
}
