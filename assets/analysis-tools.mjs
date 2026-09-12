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

export function titleChangeRows(captures, start, end) {
  if (!validDay(start) || !validDay(end) || start > end) return [];
  const byDay = new Map();
  for (const capture of [...(captures || [])].sort((a,b) => String(a.capturedAt || '').localeCompare(String(b.capturedAt || '')))) {
    const day = validDay(capture.aggregateDate);
    if (day && day <= end && capture.products && typeof capture.products === 'object') byDay.set(day, capture);
  }
  const previous = new Map(), changes = [];
  for (const [day,capture] of [...byDay].sort(([a],[b]) => a.localeCompare(b))) {
    for (const [itemCode,product] of Object.entries(capture.products || {})) {
      const title = typeof product?.itemName === 'string' ? product.itemName.trim() : '';
      if (!title) continue;
      const prior = previous.get(itemCode);
      if (day >= start && prior && prior.title !== title) changes.push({
        shopName: product.shopName || prior.shopName || itemCode.split(':')[0],
        shopCode: product.shopCode || prior.shopCode || itemCode.split(':')[0],
        itemCode,
        itemUrl: product.itemUrl || prior.itemUrl || '',
        changedDate: day,
        previousObservedDate: prior.day,
        continuous: shiftDay(prior.day,1) === day,
        before: prior.title,
        after: title
      });
      previous.set(itemCode,{day,title,shopName:product.shopName,shopCode:product.shopCode,itemUrl:product.itemUrl});
    }
  }
  return changes.sort((a,b) => String(a.shopName).localeCompare(String(b.shopName),'ja') || a.changedDate.localeCompare(b.changedDate) || a.itemCode.localeCompare(b.itemCode));
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

export function sortShopOverview(shops, key = 'top10', direction = 'desc') {
  const allowed = new Set(['name','items','top10','top100','up','down']);
  const sortKey = allowed.has(key) ? key : 'top10';
  const sign = direction === 'asc' ? 1 : -1;
  return [...shops].sort((a,b) => {
    const comparison = sortKey === 'name'
      ? String(a.name || '').localeCompare(String(b.name || ''), 'ja')
      : (Number(a[sortKey]) || 0) - (Number(b[sortKey]) || 0);
    return comparison * sign || String(a.name || '').localeCompare(String(b.name || ''), 'ja');
  });
}

const bestRank = rows => Math.min(...rows.map(r=>r.rank).filter(Number.isFinite), Infinity);
const median = values => {
  const sorted=values.filter(Number.isFinite).sort((a,b)=>a-b);
  if(!sorted.length)return null;
  const middle=Math.floor(sorted.length/2);
  return sorted.length%2 ? sorted[middle] : Math.round((sorted[middle-1]+sorted[middle])/2);
};

export function shopProducts(rows, shopKey) {
  const products=new Map();
  for(const row of rows.filter(r=>(r.shopCode||r.itemCode.split(':')[0])===shopKey&&r.rank!=null)){
    const product=products.get(row.itemCode)||{...row,categories:[],ranks:[],bestRank:Infinity,bestPreviousRank:Infinity};
    product.categories.push(row.category);product.ranks.push({genre:String(row.category.id),name:row.category.name,rank:row.rank,previousRank:row.previousRank,change:row.change,comparisonState:row.comparisonState});
    if(row.rank<product.bestRank){Object.assign(product,row);product.bestRank=row.rank;}
    if(Number.isFinite(row.previousRank))product.bestPreviousRank=Math.min(product.bestPreviousRank,row.previousRank);
    products.set(row.itemCode,product);
  }
  return [...products.values()].map(p=>({...p,bestPreviousRank:Number.isFinite(p.bestPreviousRank)?p.bestPreviousRank:null,categoryCount:new Set(p.categories.map(c=>String(c.id))).size})).sort((a,b)=>a.bestRank-b.bestRank);
}

export function inferProductRole(product, history=[]) {
  const latest=history.at(-1), previous=history.at(-2);
  const reviewDelta=latest?.reviews!=null&&previous?.reviews!=null?latest.reviews-previous.reviews:null;
  const promoted=(product.promotionHints||[]).length>0;
  const rising=product.ranks.some(r=>Number.isFinite(r.change)&&r.change>0);
  const entered=product.ranks.some(r=>r.comparisonState==='entered');
  let role='稳定观察款',reason='已进榜，暂未出现明确的强变化信号';
  if(product.bestRank<=10){role='核心排名款';reason=`当前最好${product.bestRank}位，承担店铺排名曝光`;}
  else if(promoted&&rising){role='活动冲榜款';reason='带促销线索且排名同时上涨';}
  else if(entered){role='新进榜测试款';reason='相对上一集计日首次进入已采集范围';}
  else if(rising){role='上升潜力款';reason='至少一个类目排名上涨';}
  else if(promoted){role='促销测试款';reason='存在优惠券或促销文字，排名尚未形成强势位置';}
  else if(reviewDelta>0){role='口碑积累款';reason=`最近两个有效记录间评论增加${reviewDelta}条`;}
  return {role,reason};
}

export function productHeat(product, history=[]) {
  const rank=product.bestRank;
  let score=Number.isFinite(rank)?Math.max(0,45-Math.min(45,Math.log10(Math.max(rank,1))*18)):0;
  const reasons=[];
  if(rank<=10){score+=20;reasons.push(`最好${rank}位`);}else if(rank<=100){score+=10;reasons.push(`最好${rank}位`);}
  if(product.categoryCount>=3){score+=10;reasons.push(`覆盖${product.categoryCount}个类目`);}
  if(product.ranks.some(r=>Number.isFinite(r.change)&&r.change>0)){score+=10;reasons.push('排名上涨');}
  const last=history.at(-1), prior=history.at(-2);
  if(last?.reviews!=null&&prior?.reviews!=null&&last.reviews>prior.reviews){score+=10;reasons.push(`评论+${last.reviews-prior.reviews}`);}
  if((product.promotionHints||[]).length){score+=5;reasons.push('存在促销线索');}
  score=Math.max(0,Math.min(100,Math.round(score)));
  return {score,level:score>=70?'高':score>=45?'中':'低',reasons};
}

export function shopProfile(rows, shopKey, historyFor=()=>[]) {
  const products=shopProducts(rows,shopKey);
  if(!products.length)return null;
  const categories=new Set(products.flatMap(p=>p.categories.map(c=>String(c.id))));
  const promoted=products.filter(p=>(p.promotionHints||[]).length);
  const pointed=products.filter(p=>Number.isFinite(p.pointRate)&&p.pointRate>1);
  const roles=products.map(p=>({product:p,...inferProductRole(p,historyFor(p)),heat:productHeat(p,historyFor(p))}));
  const prices=products.map(p=>p.itemPrice).filter(Number.isFinite);
  return {key:shopKey,name:products[0].shopName||shopKey,url:products[0].shopUrl||'',products:roles,
    itemCount:products.length,categoryCount:categories.size,top10:products.filter(p=>p.bestRank<=10).length,
    top30:products.filter(p=>p.bestRank<=30).length,top100:products.filter(p=>p.bestRank<=100).length,
    rising:products.filter(p=>p.ranks.some(r=>Number.isFinite(r.change)&&r.change>0)).length,
    falling:products.filter(p=>p.ranks.some(r=>Number.isFinite(r.change)&&r.change<0)).length,
    entered:products.filter(p=>p.ranks.some(r=>r.comparisonState==='entered')).length,
    promoted:promoted.length,pointed:pointed.length,medianPrice:median(prices),minPrice:prices.length?Math.min(...prices):null,maxPrice:prices.length?Math.max(...prices):null};
}

export function compareShops(rows, keys, historyFor=()=>[]) {
  return keys.map(key=>shopProfile(rows,key,historyFor)).filter(Boolean).sort((a,b)=>b.top10-a.top10||b.itemCount-a.itemCount);
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

export function priorityAlerts(rows, before = [], watchlist = new Set(), thresholds = {}) {
  const jump = Number.isFinite(Number(thresholds.rankJump)) ? Number(thresholds.rankJump) : 50;
  const pointRate = Number.isFinite(Number(thresholds.pointRate)) ? Number(thresholds.pointRate) : 10;
  const couponRate = Number.isFinite(Number(thresholds.couponRate)) ? Number(thresholds.couponRate) : 30;
  const prior = new Map(before.map(r=>[String(r.category.id)+'|'+r.itemCode,r]));
  const alerts=[];
  for(const row of rows.filter(r=>r.rank!=null)){
    const old=prior.get(String(row.category.id)+'|'+row.itemCode), watched=watchlist.has(row.itemCode);
    const base={row,watched,shopName:row.shopName||row.shopCode||'店铺未记录'};
    if(Number.isFinite(row.change)&&row.change>=jump)alerts.push({...base,type:'排名大涨',level:'high',message:`${row.previousRank}→${row.rank}位（↑${row.change}）`,score:100+row.change});
    if(row.rank<=10 && Number.isFinite(row.previousRank) && row.previousRank>10)alerts.push({...base,type:'进入前10',level:'high',message:`${row.previousRank}→${row.rank}位`,score:180-row.rank});
    if(row.isNew)alerts.push({...base,type:'新进榜',level:'normal',message:`首次出现在已采集范围，当前${row.rank}位`,score:70-row.rank/100});
    if(Number.isFinite(row.priceChange)&&row.priceChange<0)alerts.push({...base,type:'降价',level:'normal',message:`￥${row.previousPrice?.toLocaleString('ja-JP')}→￥${row.itemPrice?.toLocaleString('ja-JP')}`,score:85+Math.min(30,Math.abs(row.priceChange)/100)});
    if(Number.isFinite(row.pointRate)&&row.pointRate>=pointRate&&(row.pointChange>0||old?.pointRate!==row.pointRate))alerts.push({...base,type:'积分提高',level:'high',message:`API积分${row.pointRate}倍`,score:110+row.pointRate});
    const text=[row.itemName,...(row.promotionHints||[])].join(' ').normalize('NFKC');
    const rates=[...text.matchAll(/(\d{1,2}(?:\.\d+)?)\s*%\s*(?:OFF)?/gi)].map(m=>Number(m[1]));
    const best=rates.length?Math.max(...rates):null;
    if(best!=null&&best>=couponRate&&/クーポン/.test(text))alerts.push({...base,type:'大额优惠券',level:'high',message:`标题/促销文字检测到${best}%券`,score:120+best});
    if(old&&Number.isFinite(old.reviewCount)&&Number.isFinite(row.reviewCount)&&row.reviewCount-old.reviewCount>=20)alerts.push({...base,type:'评论增长',level:'normal',message:`评论+${row.reviewCount-old.reviewCount}`,score:60+Math.min(30,row.reviewCount-old.reviewCount)});
  }
  const dedup=new Map();
  for(const alert of alerts){const key=alert.type+'|'+alert.row.itemCode;const existing=dedup.get(key);if(!existing||alert.score>existing.score)dedup.set(key,alert);}
  return [...dedup.values()].sort((a,b)=>(b.watched-a.watched)||b.score-a.score||a.row.rank-b.row.rank);
}

export function consolidateProducts(rows) {
  const map=new Map();
  for(const row of rows.filter(r=>r.rank!=null)){
    const current=map.get(row.itemCode)||{...row,bestRank:Infinity,categories:new Map(),ranks:[]};
    current.categories.set(String(row.category.id),row.category.name);
    current.ranks.push({genre:String(row.category.id),name:row.category.name,rank:row.rank,change:row.change});
    if(row.rank<current.bestRank){Object.assign(current,row);current.bestRank=row.rank;}
    map.set(row.itemCode,current);
  }
  return [...map.values()].map(p=>({...p,categoryCount:p.categories.size,categoryNames:[...p.categories.values()]})).sort((a,b)=>a.bestRank-b.bestRank||b.categoryCount-a.categoryCount);
}

export function watchedShopTrend(captures, shopCodes, end = '9999-12-31') {
  const codes=new Set(shopCodes||[]), result=new Map([...codes].map(code=>[code,[]]));
  const days=new Map();
  for(const capture of [...(captures||[])].sort((a,b)=>String(a.capturedAt||'').localeCompare(String(b.capturedAt||'')))){
    const day=validDay(capture.aggregateDate);if(day&&day<=end)days.set(day,capture);
  }
  for(const [day,capture] of [...days].sort(([a],[b])=>a.localeCompare(b))){
    for(const shopCode of codes){
      const items=new Map();
      for(const ranks of Object.values(capture.genres||{}))for(const [itemCode,rank] of Object.entries(ranks||{})){
        if(itemCode.startsWith(shopCode+':'))items.set(itemCode,Math.min(items.get(itemCode)??Infinity,rank));
      }
      result.get(shopCode).push({day,items:items.size,top10:[...items.values()].filter(rank=>rank<=10).length,top100:[...items.values()].filter(rank=>rank<=100).length});
    }
  }
  return result;
}

export function coverageLabel(snapshot, genre, code) {
  const ranks=snapshot?.genres?.[genre];
  if(!ranks)return '類目未取得';
  if(!Object.keys(ranks).length)return '空榜観測・商品不在は判定不可';
  if(Number.isFinite(ranks[code]))return `${ranks[code]}位`;
  return `収集範囲（～${Math.max(...Object.values(ranks))}位）に不在・下架未確認`;
}
