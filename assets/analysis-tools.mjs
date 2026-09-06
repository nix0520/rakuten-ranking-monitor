import { validDay } from './insights.mjs';

export const NOTES_KEY = 'rakuten-ranking-notes-v1';
const finite = value => Number.isFinite(value) ? value : null;
export const shiftDay = (day, n) => validDay(day) ? new Date(Date.parse(day + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10) : null;

export function cleanNotebook(value) {
  if (!value || value.version !== 1 || typeof value.products !== 'object' || Array.isArray(value.products)) throw Error('分析メモの形式が不正です');
  const products = Object.create(null);
  for (const [code, p] of Object.entries(value.products || {}).slice(0, 5000)) {
    if (!p || typeof p !== 'object' || ['__proto__', 'constructor', 'prototype'].includes(code)) continue;
    products[code] = {
      group: String(p.group || '').slice(0, 60), note: String(p.note || '').slice(0, 2000),
      tags: [...new Set((Array.isArray(p.tags) ? p.tags : []).filter(t => typeof t === 'string').map(t => t.trim().slice(0, 40)).filter(Boolean))].slice(0, 20),
      pagePoints: (Array.isArray(p.pagePoints) ? p.pagePoints : []).filter(e => e && Number.isFinite(e.rate) && e.rate > 0 && e.rate <= 100 && Number.isFinite(Date.parse(e.observedAt)) && /^https:\/\/item\.rakuten\.co\.jp\//.test(e.url || '')).slice(-100)
        .map(e => ({rate:e.rate, observedAt:e.observedAt, url:e.url, source:'manual-page-confirmation'}))
    };
  }
  const events = (Array.isArray(value.events) ? value.events : []).filter(e => validDay(e.start) && validDay(e.end) && e.start <= e.end && e.title && /^https:\/\//.test(e.source || '')).slice(-200)
    .map(e => ({start:e.start,end:e.end,title:String(e.title).slice(0,120),source:String(e.source).slice(0,1000)}));
  return {version:1,products,events};
}
export function readNotebook(storage) {
  try { return cleanNotebook(JSON.parse(storage.getItem(NOTES_KEY))); }
  catch { return {version:1,products:Object.create(null),events:[]}; }
}

export function observationSeries(captures, genre, code, end = '9999-12-31') {
  const days = new Map();
  for (const c of [...captures].sort((a,b) => String(a.capturedAt).localeCompare(String(b.capturedAt)))) {
    const day = validDay(c.aggregateDate);
    if (!day || day > end) continue;
    const m = c.metrics?.[genre]?.[code] || {}, p = c.products?.[code] || c.analysisProducts?.[code] || {};
    days.set(day, {day, capturedAt:c.capturedAt, rank:finite(c.genres?.[genre]?.[code]),
      price:finite(m.itemPrice), points:finite(m.pointRate),
      reviews:finite(m.reviewCount ?? p.reviewCount), rating:finite(m.reviewAverage ?? p.reviewAverage),
      title:m.itemName ?? p.itemName ?? null, text:m.promotionText ?? (p.itemName ? [p.itemName,p.catchcopy].filter(Boolean).join(' ') : null),
      hints:Array.isArray(m.promotionHints) ? m.promotionHints : null, pointEvidence:m.pointEvidence || null});
  }
  return [...days.values()].sort((a,b) => a.day.localeCompare(b.day));
}

export function reviewGrowth(series, end, days) {
  const a = series.find(p => p.day === shiftDay(end,-days)), b = series.find(p => p.day === end);
  return {from:shiftDay(end,-days),to:end,count:a?.reviews != null && b?.reviews != null ? b.reviews-a.reviews : null,
    rating:a?.rating != null && b?.rating != null ? b.rating-a.rating : null};
}
export function momentum(series, day) {
  const current = series.find(p=>p.day===day);
  const consecutive = [3,2,1,0].map(n => series.find(p=>p.day===shiftDay(day,-n)));
  const rising = consecutive.every(p=>p?.rank != null) && consecutive.slice(1).every((p,i)=>p.rank<consecutive[i].rank);
  const past = series.filter(p=>p.day<day);
  const firstTop10 = current?.rank != null && current.rank<=10 && past.length>0 && past.every(p=>p.rank != null && p.rank>10);
  return {rising,firstTop10};
}
export function titleChanges(series) {
  const changes = [];
  for(let i=1;i<series.length;i++){
    const a=series[i-1],b=series[i];
    if(a.title != null && b.title != null && a.title!==b.title) changes.push({from:a.day,to:b.day,before:a.title,after:b.title,gap:shiftDay(a.day,1)!==b.day});
  }
  return changes;
}
export function promotionTimeline(series) {
  const out=[];
  for(const p of series){
    if(p.hints===null){out.push({start:p.day,end:p.day,label:'未記録',known:false,days:[p.day]});continue;}
    const label=[...p.hints].sort().join(' · ') || '販促文言なし';
    const last=out.at(-1);
    if(last?.known && last.label===label && shiftDay(last.end,1)===p.day){last.end=p.day;last.days.push(p.day);}
    else out.push({start:p.day,end:p.day,label,known:true,days:[p.day]});
  }
  return out;
}
export function couponEstimate(price, rawText) {
  const text=String(rawText || '').normalize('NFKC');
  const conditions=text.match(/[^【】\[\]＼／。]{0,40}(?:クーポン|限定|以上|最大)[^【】\[\]＼／。]{0,55}/g)?.join(' · ') || text.slice(0,160);
  if(!/クーポン/.test(text))return {amount:null,label:'券条件未記録',conditions};
  if(!Number.isFinite(price)||price<=0||/最大|先着|限定|以上|まとめ|併用|会員|\d+\s*(?:枚|点|個|セット)|上限|抽選/.test(text))return {amount:null,label:'条件付き・自動計算なし',conditions};
  const rates=[...text.matchAll(/(?:(\d+(?:\.\d+)?)\s*%\s*(?:OFF\s*)?クーポン|クーポン(?:利用)?で\s*(\d+(?:\.\d+)?)\s*%\s*OFF)/gi)].map(m=>Number(m[1]||m[2]));
  const amounts=[...text.matchAll(/(\d[\d,]*)\s*円\s*(?:OFF|引き|割引)\s*クーポン/gi)].map(m=>Number(m[1].replaceAll(',','')));
  const fixed=[...text.matchAll(/クーポン(?:利用)?で\s*(\d[\d,]*)\s*円/g)].map(m=>Number(m[1].replaceAll(',','')));
  if(rates.length+amounts.length+fixed.length!==1)return {amount:null,label:'券条件の確認が必要',conditions};
  const amount=rates.length ? price*(1-rates[0]/100) : amounts.length ? price-amounts[0] : fixed[0];
  if(amount<0 || amount>price || rates[0]>=100)return {amount:null,label:'券条件の確認が必要',conditions};
  return {amount:Math.round(amount),label:'券後参考額（適用可否・端数は店舗で確認）',conditions};
}
export function shopOverview(rows) {
  const stores=new Map();
  for(const r of rows.filter(r=>r.rank!=null)){
    const key=r.shopCode||r.itemCode.split(':')[0],s=stores.get(key)||{key,name:r.shopName||key,items:new Set(),top10:new Set(),top100:new Set(),up:new Set(),down:new Set()};
    s.items.add(r.itemCode);if(r.rank<=10)s.top10.add(r.itemCode);if(r.rank<=100)s.top100.add(r.itemCode);
    if(r.change>0)s.up.add(r.itemCode);if(r.change<0)s.down.add(r.itemCode);stores.set(key,s);
  }
  return [...stores.values()].map(s=>({...s,items:s.items.size,top10:s.top10.size,top100:s.top100.size,up:s.up.size,down:s.down.size})).sort((a,b)=>b.top10-a.top10||b.items-a.items);
}
export function priceBands(rows) {
  const bins=[{label:'～1,999円',min:0,max:2000},{label:'2,000～2,999円',min:2000,max:3000},{label:'3,000～3,999円',min:3000,max:4000},{label:'4,000～4,999円',min:4000,max:5000},{label:'5,000円～',min:5000,max:Infinity}];
  const unique=new Map(rows.filter(r=>r.rank!=null&&r.rank<=100&&Number.isFinite(r.itemPrice)).map(r=>[r.itemCode,r]));
  return bins.map(b=>({...b,count:[...unique.values()].filter(r=>r.itemPrice>=b.min&&r.itemPrice<b.max).length}));
}
export function activityComparison(series, start, end) {
  if(!validDay(start)||!validDay(end)||start>end)return [];
  return [{label:'活動前日',day:shiftDay(start,-1)},...series.filter(p=>p.day>=start&&p.day<=end).map(p=>({label:'活動中',day:p.day})),{label:'活動翌日',day:shiftDay(end,1)}]
    .map(p=>({...p,observation:series.find(s=>s.day===p.day)||null}));
}
export function dailyDigest(rows, before) {
  const old=new Map(before.map(r=>[r.category.id+':'+r.itemCode,r]));
  return rows.map(r=>{
    const p=old.get(r.category.id+':'+r.itemCode),messages=[];
    if(Number.isFinite(r.change)&&r.change!==0)messages.push(`順位 ${r.previousRank}→${r.rank}（${r.change>0?'↑':'↓'}${Math.abs(r.change)}）`);
    if(r.comparisonState==='entered')messages.push('収集範囲に登場');
    if(r.comparisonState==='exited')messages.push('収集範囲に不在');
    if(p&&Number.isFinite(p.itemPrice)&&Number.isFinite(r.itemPrice)&&p.itemPrice!==r.itemPrice)messages.push(`価格 ${p.itemPrice}→${r.itemPrice}円`);
    if(p&&Number.isFinite(p.pointRate)&&Number.isFinite(r.pointRate)&&p.pointRate!==r.pointRate)messages.push(`APIポイント ${p.pointRate}→${r.pointRate}倍`);
    if(p&&Array.isArray(p.promotionHints)&&Array.isArray(r.promotionHints)&&JSON.stringify([...p.promotionHints].sort())!==JSON.stringify([...r.promotionHints].sort()))messages.push(`販促 ${p.promotionHints.join('・')||'文言なし'}→${r.promotionHints.join('・')||'文言なし'}`);
    return {...r,messages};
  }).filter(r=>r.messages.length).sort((a,b)=>Math.abs(b.change||0)-Math.abs(a.change||0));
}

export function coverageLabel(snapshot, genre, code) {
  const ranks=snapshot?.genres?.[genre];
  if(!ranks)return '類目未取得';
  if(!Object.keys(ranks).length)return '空榜観測・商品不在は判定不可';
  if(Number.isFinite(ranks[code]))return `${ranks[code]}位`;
  return `収集範囲（～${Math.max(...Object.values(ranks))}位）に不在・下架未確認`;
}
