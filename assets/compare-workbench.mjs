import { archiveSnapshots } from './history-tools.mjs';

export const LOCAL_GROUPS_KEY = 'rakuten-ranking-local-comparisons-v1';
const COLORS = ['#166b60', '#b44e36', '#3b60a0', '#7b548d'];
const yen = value => Number.isFinite(value) ? '¥'+value.toLocaleString('ja-JP') : '价格未记录';

export function rakutenProductUrl(raw) {
  try {
    const u = new URL(raw);
    if (!['http:', 'https:'].includes(u.protocol) || u.hostname !== 'item.rakuten.co.jp' || u.username || u.password || u.port) return '';
    const parts = u.pathname.match(/^\/([a-z0-9][a-z0-9_-]*)\/([a-z0-9][a-z0-9_.-]*)\/?$/i);
    return parts ? 'https://item.rakuten.co.jp/'+parts[1]+'/'+parts[2]+'/' : '';
  } catch { return ''; }
}

export function braMatch(row, pack, ownPrice) {
  const title = String(row.itemName || '').normalize('NFKC');
  if (!/ノン[・\s-]?ワイヤー|ワイヤー[\s-]?(?:なし|無し|レス)/i.test(title)) return null;
  if (/小さく見せ|着痩せブラ|ナイトブラ|おやすみブラ|授乳ブラ|スポーツブラ/.test(title)) return null;
  const signals = title.match(/自然に盛れる|盛れる|盛りブラ|谷間(?:メイク)?|小胸|ボリュームアップ/g);
  if (!signals) return null;
  const bundle = /上下セット|ブラ\s*(?:&|と|・)?\s*ショーツ\s*セット|ブラ\s*ショーツ|2点セット|[2-9]枚セット|[2-9]枚組|[2-9]点組/i.test(title);
  if (pack === 'bundle' ? !bundle : bundle) return null;
  const gap = Number.isFinite(ownPrice) && ownPrice > 0 && Number.isFinite(row.itemPrice) ? Math.abs(row.itemPrice / ownPrice - 1) : null;
  return { signals: [...new Set(signals)], gap, score: new Set(signals).size*2 + (gap === null ? 0 : gap <= .25 ? 5 : gap <= .4 ? 2 : -5) };
}

export function promotionLabel(raw) {
  const text = String(raw || '').normalize('NFKC').trim();
  if (!text) return '';
  if (/^半額$/.test(text)) return '半价文案';
  if (/^セール$/.test(text)) return '促销文案';
  if (/^クーポン$/.test(text)) return '优惠券文案';
  const percent = text.match(/(\d{1,3}(?:\.\d+)?)\s*%\s*OFF/i);
  const amount = text.match(/([\d,]+)\s*円\s*OFF/i);
  const amountAfter = text.match(/クーポンで\s*([\d,]+)\s*円/i);
  const max = /最大|MAX/i.test(text) ? '最高 ' : '';
  const suffix = /クーポン/.test(text) ? '优惠券' : '文案';
  if (percent) return max+percent[1]+'% OFF '+suffix;
  if (amount) return max+'减 ¥'+amount[1]+' '+suffix;
  if (amountAfter) return '券后 ¥'+amountAfter[1]+' 文案';
  if (/クーポン/.test(text)) return '优惠券文案';
  if (/半額/.test(text)) return '半价文案';
  return '其他促销文案';
}

export function rankObservation(capture, genre, code) {
  const ranks = capture?.genres?.[genre];
  if (!ranks || !Object.keys(ranks).length) return { rank:null, label:'榜单数据不可用' };
  if (!code) return { rank:null, label:'未匹配到榜单商品' };
  const rank = Object.hasOwn(ranks, code) ? ranks[code] : null;
  return Number.isFinite(rank) ? { rank, label:'第 '+rank+' 名' } : { rank:null, label:'不在已保存范围' };
}

export function newSignals(now, before) {
  if (!now || !before) return [];
  const out = [];
  if (Number.isFinite(now.itemPrice) && Number.isFinite(before.itemPrice) && now.itemPrice !== before.itemPrice)
    out.push('标价 '+yen(before.itemPrice)+' → '+yen(now.itemPrice));
  if (Number.isFinite(now.pointRate) && Number.isFinite(before.pointRate) && now.pointRate !== before.pointRate)
    out.push('API 积分 '+before.pointRate+' → '+now.pointRate+' 倍');
  if (Array.isArray(now.promotionHints) && Array.isArray(before.promotionHints)) {
    const key = text => String(text).normalize('NFKC').replace(/\s/g,'').toUpperCase();
    const seen = new Set(before.promotionHints.map(key));
    const added = [...new Set(now.promotionHints.filter(v=>!seen.has(key(v))).map(promotionLabel))].filter(Boolean);
    if (added.length) out.push('新检测到 '+added.join('、')+'（条件未核实）');
  }
  return out;
}

// Both charts use the SVG coordinate system, so the cursor stays on the
// right date when the chart is resized or letterboxed.
export function bindRankHover(root) {
  const cache = new WeakMap();
  root.addEventListener('pointermove', event => {
    const svg = event.target.closest?.('svg[data-rank-hover]');
    if (!svg) return;
    let data = cache.get(svg);
    if (!data) { data = JSON.parse(svg.dataset.rankHover); cache.set(svg,data); }
    const matrix = svg.getScreenCTM();
    if (!matrix || !data.length) return;
    const point = svg.createSVGPoint();
    point.x=event.clientX; point.y=event.clientY;
    const x = point.matrixTransform(matrix.inverse()).x;
    const nearest = data.reduce((a,b)=>Math.abs(b[0]-x)<Math.abs(a[0]-x)?b:a);
    const line=svg.querySelector('.rank-hover-line'), tip=svg.parentElement.querySelector('.rank-hover-tip');
    line.setAttribute('x1',nearest[0]);line.setAttribute('x2',nearest[0]);line.removeAttribute('visibility');
    tip.textContent=nearest[1];tip.hidden=false;
  });
  root.addEventListener('pointerout', event => {
    const svg=event.target.closest?.('svg[data-rank-hover]');
    if (!svg || (event.relatedTarget?.nodeType && svg.contains(event.relatedTarget))) return;
    svg.querySelector('.rank-hover-line').setAttribute('visibility','hidden');
    svg.parentElement.querySelector('.rank-hover-tip').hidden=true;
  });
}

export function createWorkbench({state, esc, storage}) {
  const root=document.querySelector('#workbench');
  let groups=[], active=0, showing=false, candidates=[], products=[], lastSource=null;
  try {
    const saved=JSON.parse(storage.getItem(LOCAL_GROUPS_KEY));
    if(Array.isArray(saved))groups=saved.filter(g=>g && typeof g.name==='string' && /^\d+$/.test(g.genre) && Array.isArray(g.items)).slice(0,20).map(g=>({
      ...g,items:g.items.filter(i=>i && rakutenProductUrl(i.url)===i.url && typeof i.label==='string' && ['own','rival'].includes(i.role)).slice(0,4)
    }));
  } catch {}
  const $ = selector=>root.querySelector(selector);
  const status=text=>$('#workbenchStatus').textContent=text;
  const save=next=>{ try {storage.setItem(LOCAL_GROUPS_KEY,JSON.stringify(next));groups=next;return true;} catch {status('浏览器无法保存，请检查本地存储设置。');return false;} };
  const options=(values)=>values.map(([v,t])=>'<option value="'+esc(v)+'">'+esc(t)+'</option>').join('');
  function getProducts() {
    if (lastSource!==state.dailyLatest) {
      products=Object.entries(state.dailyLatest?.rankings||{}).flatMap(([genre,rows])=>rows.map(row=>({...row,genre,url:rakutenProductUrl(row.itemUrl)}))).filter(row=>row.url);
      lastSource=state.dailyLatest;
    }
    return products;
  }
  function render() {
    if (!showing) return;
    let group=groups[active];
    $('#compareGroups').innerHTML=options(groups.length?groups.map((g,i)=>[i,g.name]):[['','暂无对标组']]);
    $('#compareGroups').value=groups.length?String(active):'';
    const categories=(state.dailyLatest?.categories||[]).filter(c=>c.group==='bra');
    const prevGenre=$('#compareGenre').value;
    $('#compareGenre').innerHTML=options(categories.map(c=>[c.id,c.name]));
    if(categories.some(c=>String(c.id)===prevGenre))$('#compareGenre').value=prevGenre;
    $('#compareAdd').hidden=!group;
    $('#compareResults').hidden=!group;
    if(!group) return;
    const catalog=getProducts().filter(r=>r.genre===group.genre);
    const catalogByUrl=new Map(catalog.map(row=>[row.url,row]));
    const items=group.items.map(i=>!i.code&&catalogByUrl.has(i.url)?{...i,code:catalogByUrl.get(i.url).itemCode}:i);
    if(items.some((item,i)=>item!==group.items[i])){
      group={...group,items};
      save(groups.map((g,i)=>i===active?group:g));
    }
    const snaps=archiveSnapshots(state.history?.captures||[],state.dailyLatest).filter(s=>s.basis==='aggregate');
    const latest=snaps.at(-1), previous=snaps.at(-2);
    const samePeriod=latest&&previous&&Date.parse(latest.day)-Date.parse(previous.day)===86400000;
    const own=group.items.find(i=>i.role==='own');
    const ownPrice=catalogByUrl.get(own?.url)?.itemPrice;
    const ownShop=own?.url.split('/')[3];
    const tracked=group.items.map((item,i)=>{
      const current=catalogByUrl.get(item.url), code=current?.itemCode||item.code;
      const signals=samePeriod && code ? newSignals(latest.metrics?.[group.genre]?.[code],previous.metrics?.[group.genre]?.[code]) : [];
      const rank=rankObservation(latest,group.genre,code), prior=rankObservation(previous,group.genre,code);
      if(samePeriod && rank.rank!==null && rank.rank<=20 && prior.rank>20)signals.unshift('从第 '+prior.rank+' 名进入前 20');
      return {...item,code,rank,signals,price:current?.itemPrice,color:COLORS[i]};
    });
    const card=item=>'<article class="compare-card"><strong style="--series-color:'+item.color+'">'+esc(item.role==='own'?'自家款':'竞品')+' · <a href="'+esc(item.url)+'" target="_blank" rel="noopener noreferrer">'+esc(item.label)+'</a></strong><span>'+esc(item.rank.label)+' · '+esc(yen(item.price))+'</span><button type="button" data-remove-comparison="'+esc(item.url)+'">移出组</button></article>';
    $('#compareCards').innerHTML=tracked.map(card).join('')||'<p>先添加一条自家商品链接，再添加竞品。</p>';
    const events=tracked.flatMap(item=>item.signals.length?['<li><strong>'+esc(item.label)+'</strong>：'+esc(item.signals.join('；'))+'</li>']:[]);
    $('#compareChanges').innerHTML=events.length?'<ul>'+events.slice(0,3).join('')+'</ul>':'<p>没有可确认的新变化。</p>';
    $('#compareDateLabel').textContent=latest?'日榜 '+latest.day+'（日本时间）':'暂无日榜';
    $('#compareTrend').innerHTML=makeChart(tracked,snaps,group.genre,esc);
    candidates=catalog.filter(r=>r.url.split('/')[3]!==ownShop && !group.items.some(i=>i.url===r.url))
      .map(r=>({r,match:braMatch(r,group.pack,ownPrice)})).filter(v=>v.match && (v.match.gap===null || v.match.gap<=.4))
      .sort((a,b)=>b.match.score-a.match.score||a.r.rank-b.r.rank).slice(0,8);
    $('#compareCandidates').innerHTML=candidates.map(({r,match},i)=>'<li><div><a href="'+esc(r.url)+'" target="_blank" rel="noopener noreferrer">'+esc(r.itemName)+'</a><small>'+esc(r.shopName||r.url.split('/')[3])+' · 第 '+esc(r.rank)+' 名 · '+esc(yen(r.itemPrice))+' · '+esc(match.signals.join(' / '))+'</small></div><button type="button" data-compare-candidate="'+i+'">加入对标</button></li>').join('')||'<li>当前类目已发布商品中没有匹配候选，可手动添加链接。</li>';
  }
  function add(item) {
    const group=groups[active];
    if(!group||!item.url){status('请输入有效的乐天商品链接。');return;}
    if(group.items.some(i=>i.url===item.url)){status('该商品已在组内。');return;}
    if(group.items.filter(i=>i.role===item.role).length>=(item.role==='own'?1:3)){status('每组最多 1 款自家商品、3 款竞品。');return;}
    const items=[...group.items,item].sort((a,b)=>Number(b.role==='own')-Number(a.role==='own'));
    if(save(groups.map((g,i)=>i===active?{...g,items}:g))){render();status('已保存到当前浏览器。');}
  }
  $('#compareCreate').addEventListener('submit',event=>{
    event.preventDefault();
    const name=$('#compareGroupName').value.trim(), genre=$('#compareGenre').value;
    if(!name||!genre||groups.length>=20){status('填写组名和类目，最多可建 20 组。');return;}
    if(save([...groups,{name,genre,pack:$('#comparePack').value,items:[]}])){active=groups.length-1;event.target.reset();render();status('对标组已创建。');}
  });
  $('#compareAdd').addEventListener('submit',event=>{
    event.preventDefault();
    const url=rakutenProductUrl($('#compareUrl').value);
    const row=getProducts().find(r=>r.url===url && r.genre===groups[active]?.genre);
    add({url,label:$('#compareLabel').value.trim()||row?.itemName?.slice(0,50)||url.split('/')[4],role:$('#compareRole').value,code:row?.itemCode||''});
  });
  $('#compareGroups').addEventListener('change',event=>{active=Number(event.target.value);render();status('');});
  root.addEventListener('click',event=>{
    const button=event.target.closest('button');
    if(!button) return;
    if(button.dataset.compareCandidate!==undefined){
      const row=candidates[Number(button.dataset.compareCandidate)]?.r;
      if(row)add({url:row.url,label:row.itemName.slice(0,55),role:'rival',code:row.itemCode});
    }
    if(button.dataset.removeComparison){
      if(save(groups.map((g,i)=>i===active?{...g,items:g.items.filter(v=>v.url!==button.dataset.removeComparison)}:g)))render();
    }
    if(button.id==='compareDeleteGroup' && groups[active]){
      if(!window.confirm('删除当前浏览器中的这个对标组？'))return;
      if(save(groups.filter((_,i)=>i!==active))){active=0;render();status('对标组已删除。');}
    }
  });
  return {render,show(value){showing=value;render();}};
}

function makeChart(items,snaps,genre,esc) {
  if(!items.length||!snaps.length)return '';
  const end=Date.parse(snaps.at(-1).day);
  const byDay=new Map(snaps.map(s=>[s.day,s]));
  const days=Array.from({length:7},(_,i)=>new Date(end-(6-i)*86400000).toISOString().slice(0,10));
  const series=items.map(item=>days.map(day=>rankObservation(byDay.get(day),genre,item.code)));
  const ranks=series.flat().map(p=>p.rank).filter(Number.isFinite);
  const max=Math.max(20,Math.ceil(Math.max(...ranks,1)/10)*10);
  const x=i=>52+i*95, y=rank=>20+160*(rank-1)/(max-1);
  const changed = (item, day) => {
    if(!item.code) return [];
    const priorDay=new Date(Date.parse(day)-86400000).toISOString().slice(0,10);
    return newSignals(byDay.get(day)?.metrics?.[genre]?.[item.code],byDay.get(priorDay)?.metrics?.[genre]?.[item.code]);
  };
  const dailyEvents=days.map(day=>items.map(item=>changed(item,day)));
  const hover=days.map((day,i)=>[x(i),day.slice(5).replace('-','/')+' · '+items.map((item,j)=>item.label.slice(0,18)+'：'+series[j][i].label+(dailyEvents[i][j].length?'；'+dailyEvents[i][j].join('、'):'')).join(' · ')]);
  const plot=series.map((points,j)=>{
    const path=points.map((p,i)=>p.rank===null?'':(i&&points[i-1].rank!==null?'L':'M')+x(i)+','+y(p.rank)).join(' ');
    return '<path d="'+path+'" stroke="'+items[j].color+'"/>'+points.map((p,i)=>p.rank===null?'':'<circle cx="'+x(i)+'" cy="'+y(p.rank)+'" r="3" fill="'+items[j].color+'"/>').join('');
  }).join('');
  const grid=[1,max].map(rank=>'<line x1="52" x2="622" y1="'+y(rank)+'" y2="'+y(rank)+'" stroke="#ded8d1"/><text x="4" y="'+(y(rank)+4)+'">'+rank+' 名</text>').join('');
  return '<div class="comparison-chart"><svg viewBox="0 0 660 215" role="img" aria-label="近七日同类目排名对比" data-rank-hover="'+esc(JSON.stringify(hover))+'">'+grid+plot+'<line class="rank-hover-line" x1="0" x2="0" y1="12" y2="188" visibility="hidden"/>'+days.map((d,i)=>'<text x="'+x(i)+'" y="205" text-anchor="middle">'+d.slice(5).replace('-','/')+(dailyEvents[i].some(a=>a.length)?' ◆':'')+'</text>').join('')+'</svg><span class="rank-hover-tip" hidden></span><small>◆ 标价、积分或促销文案有新变化</small></div>';
}
