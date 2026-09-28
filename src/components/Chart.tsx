import {useState} from 'react';
import type {Bucket} from '../shared/types';
import {compact,number,money} from '../view';
export function Chart({buckets,currency,onSelect,hourly=false}:{buckets:Bucket[];currency?:string;onSelect:(b:Bucket,index:number)=>void;hourly?:boolean}) {
 const [hover,setHover]=useState<number|null>(null);
 const values=buckets.map(b=>currency?(b.costs[currency]??0):b.total);const maximum=Math.max(1,...values);const width=940,height=215,left=58,bottom=32,top=18,plot=height-top-bottom;const step=(width-left-12)/Math.max(1,buckets.length);const barWidth=Math.max(1,Math.min(34,step*.66));
 const format=(n:number)=>currency?money(n,currency):number(n)+' Token';
 return <div className="chart-wrap"><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={hourly?'一天内各小时已记录用量':'已记录用量时间趋势'}>
  {[0,.25,.5,.75,1].map(p=><g key={p}><line x1={left} x2={width-10} y1={top+plot*(1-p)} y2={top+plot*(1-p)} className="grid-line"/><text x={left-10} y={top+plot*(1-p)+4} textAnchor="end" className="axis-text">{compact(maximum*p)}</text></g>)}
  {buckets.map((b,i)=>{const h=values[i]/maximum*plot;const x=left+i*step+(step-barWidth)/2;const label=hourly?String(i).padStart(2,'0'):b.label.includes(':')?b.label.slice(11,16):b.label.slice(5,10);return <g key={b.key}>
   <rect x={x-3} y={top} width={Math.max(6,barWidth+6)} height={plot} fill="transparent"/>
   <rect x={x} y={top+plot-Math.max(b.count?2:0,h)} width={barWidth} height={Math.max(b.count?2:0,h)} rx={Math.min(4,barWidth/2)} className={`chart-bar ${hover===i?'active':''}`} />
   <rect x={left+i*step} y={top} width={step} height={plot+10} fill="transparent" tabIndex={0} role="button" aria-label={`${b.label} ${b.count?format(values[i]):'无记录'}`} onMouseEnter={()=>setHover(i)} onMouseLeave={()=>setHover(null)} onFocus={()=>setHover(i)} onBlur={()=>setHover(null)} onClick={()=>onSelect(b,i)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();onSelect(b,i);}}}><title>{`${b.label}\n${b.count?format(values[i]):'无记录'}${b.unknownTotals?'（含已知分项小计）':''}\n${b.count} 条记录${b.unpriced?` · ${b.unpriced} 条未计价`:''}`}</title></rect>
   {(i%Math.max(1,Math.ceil(buckets.length/12))===0||i===buckets.length-1)&&<text x={x+barWidth/2} y={height-8} textAnchor="middle" className="axis-text">{label}</text>}
  </g>;})}
 </svg><div className="chart-caption">{hover!==null&&buckets[hover]?<><strong>{buckets[hover].label}</strong><span>{buckets[hover].count?format(values[hover]):'无记录'}</span><span>{buckets[hover].count} 条记录</span></>:<><span className="legend-dot"/> <span>已记录用量</span><span className="muted">点击柱状图查看对应明细</span></>}</div></div>;
}
