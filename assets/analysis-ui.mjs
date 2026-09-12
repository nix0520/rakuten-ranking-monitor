import * as A from './analysis-tools.mjs';
import { snapshotRows } from './history-tools.mjs';

export function createAnalysis({state, $, escapeHtml:esc, refreshView, formatStamp, sparkline}) {
  let notebook = A.readNotebook(globalThis.localStorage), currentRow = null, busy = false;
  let selectedShopKey = '';
  let shopAnalysisQuery = '';
  let shopOverviewSort = {key:'top10', direction:'desc'};
  const titleProductCache = new Map();
  const SHOP_WATCH_KEY='rakuten-ranking-shop-watch-v1', ALERT_KEY='rakuten-ranking-alert-settings-v1';
  const readJson=(key,fallback)=>{try{return JSON.parse(globalThis.localStorage.getItem(key))??fallback;}catch{return fallback;}};
  let watchedShops=new Set(Array.isArray(readJson(SHOP_WATCH_KEY,[]))?readJson(SHOP_WATCH_KEY,[]):[]);
  let alertSettings={rankJump:50,pointRate:10,couponRate:30,...readJson(ALERT_KEY,{})};
  const filters = {group:'',tag:'',signal:'',min:'',max:''};
  const captures = () => state.archive?.length ? state.archive : state.history?.captures || [];
  const endDay = () => state.viewSnapshot?.day || state.latest?.aggregateDate;
  let seriesCaptures, seriesEnd, seriesCache=new Map();
  const series = row => {
    const current=captures(), end=endDay();
    if(current!==seriesCaptures||end!==seriesEnd){seriesCaptures=current;seriesEnd=end;seriesCache=new Map();}
    const key=row.category.id+'|'+row.itemCode;
    if(!seriesCache.has(key))seriesCache.set(key,A.observationSeries(current,row.category.id,row.itemCode,end));
    return seriesCache.get(key);
  };
  const amount = value => Number.isFinite(value) ? '￥'+value.toLocaleString('ja-JP') : '未記録';
  const table = (heads, rows) => '<div class="analysis-scroll"><table class="analysis-table"><thead><tr>'+heads.map(h=>'<th>'+esc(h)+'</th>').join('')+'</tr></thead><tbody>'+ (rows.length ? rows.map(row=>'<tr>'+row.map(v=>'<td>'+v+'</td>').join('')+'</tr>').join('') : '<tr><td colspan="'+heads.length+'">該当する記録がありません。</td></tr>')+'</tbody></table></div>';
  const textTable = (heads, rows) => table(heads,rows.map(row=>row.map(v=>esc(v ?? '未記録'))));
  const safeImage = value => {
    try { const url=new URL(value); return ['http:','https:'].includes(url.protocol) ? esc(url.href) : ''; }
    catch { return ''; }
  };
  const safeUrl = value => {
    try { const url=new URL(value); return ['http:','https:'].includes(url.protocol) ? esc(url.href) : ''; }
    catch { return ''; }
  };
  const rowLink = r => {
    const image=safeImage(r.imageUrl), url=safeImage(r.itemUrl);
    const picture=image ? '<img src="'+image+'" alt="" loading="lazy" referrerpolicy="no-referrer">' : '<span class="analysis-image-empty" aria-hidden="true">画像なし</span>';
    const title=esc(r.itemName?.slice(0,65)||r.itemCode);
    const linkedPicture=url ? '<a class="analysis-product-image-link" href="'+url+'" target="_blank" rel="noopener noreferrer" aria-label="乐天商品页面">'+picture+'</a>' : picture;
    const linkedTitle=url ? '<a class="analysis-product-title" href="'+url+'" target="_blank" rel="noopener noreferrer">'+title+'</a>' : '<span class="analysis-product-title">'+title+'</span>';
    const linkStatus=url ? '' : '<small class="analysis-link-missing">商品链接未记录</small>';
    return '<div class="analysis-product">'+linkedPicture+'<div>'+linkedTitle+'<small>'+
      esc(r.category.name)+' · '+esc(r.shopName||'店铺未记录')+' · '+esc(r.itemCode)+'</small>'+linkStatus+
      '<button class="analysis-detail-button" type="button" data-analysis-detail="'+esc(r.itemCode)+'" data-genre="'+esc(r.category.id)+'">历史详情</button></div></div>';
  };
  function save(next) {
    const clean=A.cleanNotebook(next);
    globalThis.localStorage.setItem(A.NOTES_KEY, JSON.stringify(clean));
    notebook=clean;
  }
  function matches(row) {
    const p=notebook.products[row.itemCode]||{};
    if(filters.group && p.group!==filters.group)return false;
    if(filters.tag && !(p.tags||[]).some(t=>t.toLowerCase().includes(filters.tag.toLowerCase())))return false;
    if(filters.min!=='' && (!Number.isFinite(row.itemPrice)||row.itemPrice<Number(filters.min)))return false;
    if(filters.max!=='' && (!Number.isFinite(row.itemPrice)||row.itemPrice>Number(filters.max)))return false;
    if(state.mode==='daily' && filters.signal) {
      const m=A.momentum(series(row),endDay());
      if(filters.signal==='rising'&&!m.rising || filters.signal==='top10'&&!m.firstTop10)return false;
    }
    return true;
  }
  function priceEvidence(row) {
    const historical = row.metadataBasis === 'reference' || row.metadataBasis === 'missing';
    const metric = state.viewSnapshot?.metrics?.[row.category.id]?.[row.itemCode];
    const saved=state.viewSnapshot?.analysisProducts?.[row.itemCode];
    const text = metric?.promotionText ?? (saved ? [saved.itemName,saved.catchcopy].filter(Boolean).join(' ') : historical ? '' : [row.itemName,row.catchcopy].filter(Boolean).join(' '));
    const estimate=A.couponEstimate(row.itemPrice,text);
    return '<span class="meta">'+esc(estimate.amount===null ? estimate.label : estimate.label+' '+amount(estimate.amount))+'</span>';
  }
  function renderStatus(status) {
    if(!status) {$('#collectionProgress').textContent='采集进度将在新版采集任务运行后记录。';return;}
    const labels={running:'采集中（上次同步状态）',validated:'校验通过，等待保存',complete:'完整采集已保存',retry_pending:'等待补采'};
    const reasons={source_day_not_current:'API仍为旧集计日',below_same_day_minimum:'少于当日已观察数量',count_drop:'数量突然减少',request_or_validation_error:'请求或日期校验失败'};
    $('#collectionProgress').innerHTML='<strong>'+esc(labels[status.status]||status.status)+' · '+esc(status.completed)+'/'+esc(status.total)+'类目</strong><p>集计日 '+esc(status.aggregateDate)+' · 状态同步 '+esc(formatStamp(status.updatedAt))+(status.nextRetryAt?' · 下次计划 '+esc(formatStamp(status.nextRetryAt)):'')+'</p>'+textTable(['类目','状态','条数','说明'],Object.entries(status.genres||{}).map(([id,g])=>[id+' '+g.name,g.status,g.count??'—',g.warning==='count_drop_confirmed_twice'?'数量减少，经两次采集复核':reasons[g.reason]||(g.resumed?'复用本次集计日成功记录':'')]))+'<small>网页显示最后上传的状态；采集中实时进度在本机终端。下次执行仍需电脑开机、登录和网络正常。</small>';
  }
  function shopRows() {
    return snapshotRows(state.viewSnapshot,state.baselineSnapshot,state.latest?.categories||[]);
  }
  function shopHistory(product) {
    return A.observationSeries(captures(),product.category.id,product.itemCode,endDay());
  }
  function renderShopOverview(rows) {
    const columns=[['name','店铺'],['items','上榜商品'],['top10','前10'],['top100','前100'],['up','上涨'],['down','下跌']];
    const shops=A.sortShopOverview(A.shopOverview(rows),shopOverviewSort.key,shopOverviewSort.direction);
    const headings=columns.map(([key,label])=>{
      const active=key===shopOverviewSort.key, arrow=active?(shopOverviewSort.direction==='asc'?'▲':'▼'):'';
      const aria=active?(shopOverviewSort.direction==='asc'?'ascending':'descending'):'none';
      return '<th aria-sort="'+aria+'"><button class="analysis-sort-button" type="button" data-shop-sort="'+key+'">'+esc(label)+'<span aria-hidden="true">'+arrow+'</span></button></th>';
    }).join('');
    const body=shops.length?shops.map(s=>'<tr>'+columns.map(([key])=>'<td>'+esc(s[key])+'</td>').join('')+'</tr>').join(''):'<tr><td colspan="'+columns.length+'">該当する記録がありません。</td></tr>';
    $('#shopOverview').innerHTML='<div class="analysis-scroll"><table class="analysis-table"><thead><tr>'+headings+'</tr></thead><tbody>'+body+'</tbody></table></div><small>表头可点击切换升序/降序。覆盖当前日榜全部34个类目并按商品去重；在不同类目一升一降时，会分别计入上涨和下跌。</small>';
  }
  function renderShopAnalysis(rows) {
    const allShops=A.shopOverview(rows), query=shopAnalysisQuery.trim().toLocaleLowerCase('ja');
    const shops=query ? allShops.filter(shop=>`${shop.name} ${shop.key}`.toLocaleLowerCase('ja').includes(query)) : allShops;
    const select=$('#shopAnalysisSelect');
    if(!shops.some(s=>s.key===selectedShopKey))selectedShopKey=shops[0]?.key||'';
    select.innerHTML=shops.length?shops.map(s=>'<option value="'+esc(s.key)+'"'+(s.key===selectedShopKey?' selected':'')+'>'+esc(s.name+' · '+s.items+'商品')+'</option>').join(''):'<option value="">暂无店铺</option>';
    const profile=A.shopProfile(rows,selectedShopKey,shopHistory);
    if(!profile){$('#shopAnalysis').innerHTML='<p>'+(query?'没有匹配“'+esc(shopAnalysisQuery.trim())+'”的店铺，请更换关键词。':'当前集计日没有可分析的店铺。')+'</p>';return;}
    const shopUrl=safeUrl(profile.url), heading=shopUrl?'<a href="'+shopUrl+'" target="_blank" rel="noopener noreferrer">'+esc(profile.name)+'</a>':esc(profile.name);
    const summary=[['上榜商品',profile.itemCount],['覆盖类目',profile.categoryCount],['前10名',profile.top10],['前30名',profile.top30],['前100名',profile.top100],['上涨商品',profile.rising],['新进榜',profile.entered],['有促销线索',profile.promoted]];
    const products=profile.products.slice().sort((a,b)=>b.heat.score-a.heat.score||a.product.bestRank-b.product.bestRank);
    const roleCounts=[...new Map(products.map(p=>[p.role,0])).keys()].map(role=>[role,products.filter(p=>p.role===role).length]);
    const promotionRows=products.flatMap(({product})=>A.promotionTimeline(shopHistory(product)).filter(p=>p.known&&p.label!=='販促文言なし').map(p=>({product,period:p}))).sort((a,b)=>b.period.end.localeCompare(a.period.end)).slice(0,50);
    const strongest=products.slice(0,3).map(p=>p.product.itemName?.slice(0,28)||p.product.itemCode).join('、')||'暂无';
    $('#shopAnalysis').innerHTML='<div class="shop-analysis-heading"><h3>'+heading+'</h3><div><small>店铺代码：'+esc(profile.key)+'</small> <button type="button" data-watch-shop="'+esc(profile.key)+'">'+(watchedShops.has(profile.key)?'★ 已关注店铺':'☆ 关注店铺')+'</button></div></div>'+
      '<div class="shop-kpis">'+summary.map(([label,value])=>'<article><span>'+esc(label)+'</span><strong>'+esc(value)+'</strong></article>').join('')+'</div>'+
      '<p><strong>系统观察：</strong>中位价格 '+esc(profile.medianPrice==null?'未记录':amount(profile.medianPrice))+'；价格范围 '+esc(profile.minPrice==null?'未记录':amount(profile.minPrice)+'～'+amount(profile.maxPrice))+'；API积分加倍商品 '+esc(profile.pointed)+'款。当前热度较高的商品：'+esc(strongest)+'。</p>'+
      '<h3>推测的商品角色与热度</h3>'+table(['商品','推测角色','推定热度','最好排名 / 覆盖','公开促销线索'],products.map(({product,role,reason,heat})=>[rowLink(product),'<strong>'+esc(role)+'</strong><small>'+esc(reason)+'</small>','<span class="heat heat-'+(heat.level==='高'?'high':heat.level==='中'?'mid':'low')+'">'+esc(heat.level+' '+heat.score)+'</span><small>'+esc(heat.reasons.join(' · ')||'信号不足')+'</small>',esc(product.bestRank+'位 / '+product.categoryCount+'类目'),esc((product.promotionHints||[]).join(' · ')||'未发现')]))+
      '<small>商品角色和热度是根据排名、类目覆盖、评论变化与促销线索推测，不代表真实销量。</small>'+
      '<h3>角色结构</h3>'+textTable(['推测角色','商品数'],roleCounts)+
      '<h3>店铺促销观察时间轴</h3>'+table(['商品','首次观察','最后观察','公开文字线索'],promotionRows.map(({product,period})=>[rowLink(product),esc(period.start),esc(period.end),esc(period.label)]))+
      '<p class="analysis-limit"><strong>数据边界：</strong>竞争店铺的真实销量、订单数和准确库存不公开。商品页若公开显示售罄或“剩余少量”，后续可记录为公开库存状态，但不会推算库存件数。</p>';

    const previous=[...($('#shopCompareSelect').selectedOptions||[])].map(o=>o.value);
    $('#shopCompareSelect').innerHTML=shops.map(s=>'<option value="'+esc(s.key)+'"'+(previous.includes(s.key)?' selected':'')+'>'+esc(s.name+' · '+s.items+'商品')+'</option>').join('');
  }
  function renderWatchedShopTrends(rows) {
    const shops=A.shopOverview(rows), names=new Map(shops.map(s=>[s.key,s.name]));
    const codes=[...watchedShops], trends=A.watchedShopTrend(captures(),codes,endDay());
    $('#watchedShopTrends').innerHTML=codes.length?table(['店铺','当前上榜','较7个记录前','当前前10','期间前10峰值','操作'],codes.map(code=>{
      const points=trends.get(code)||[],now=points.at(-1),before=points.at(-8)||points[0],peak=points.length?Math.max(...points.slice(-30).map(p=>p.top10)):0;
      return [esc(names.get(code)||code),esc(now?.items??'未记录'),esc(now&&before?(now.items-before.items>=0?'+':'')+(now.items-before.items):'未记录'),esc(now?.top10??'未记录'),esc(peak),'<button type="button" data-watch-shop="'+esc(code)+'">取消关注</button>'];
    }))+'<small>按每个集计日去重商品统计；“7个记录前”不是销量变化。店铺未在当前榜出现时仍保留关注。</small>':'尚未关注店铺。请在“单店深度分析”中选择店铺并点击“关注店铺”。';
  }
  function renderShopComparison() {
    const keys=[...$('#shopCompareSelect').selectedOptions].map(o=>o.value);
    if(keys.length<2||keys.length>5){$('#shopComparison').textContent='请选择2～5家店铺。';return;}
    const profiles=A.compareShops(shopRows(),keys,shopHistory);
    $('#shopComparison').innerHTML=textTable(['店铺','上榜商品','覆盖类目','前10','前100','上涨','促销线索','中位价格'],profiles.map(p=>[p.name,p.itemCount,p.categoryCount,p.top10,p.top100,p.rising,p.promoted,p.medianPrice==null?'未记录':amount(p.medianPrice)]))+'<small>按商品去重；这是当前集计日公开榜单表现，不等于店铺销量。</small>';
  }
  function render() {
    $('#analysisPanel').hidden=state.mode!=='daily';
    $('#today-intelligence').hidden=state.mode!=='daily';
    renderStatus(state.collectionStatus);
    if(state.mode!=='daily')return;
    const rows=state.rows||[], day=endDay();
    $('#analysisBasis').textContent='集计日 '+(day||'未记录')+'；以下统计采用当前类目、搜索和范围。店铺与价格带按商品去重，收藏列表继续保留类目记录。';
    const prior=snapshotRows(state.baselineSnapshot,null,state.latest?.categories||[]);
    const digest=A.dailyDigest(rows,prior);
    const alerts=A.priorityAlerts(rows,prior,state.watchlist,alertSettings);
    $('#alertRankJump').value=alertSettings.rankJump;$('#alertPointRate').value=alertSettings.pointRate;$('#alertCouponRate').value=alertSettings.couponRate;
    $('#alertCount').textContent=alerts.length+'条需要关注';
    $('#priorityAlerts').innerHTML=alerts.length?'<div class="priority-list">'+alerts.slice(0,20).map(a=>'<article class="priority-alert" data-level="'+a.level+'"><span class="alert-badge">'+esc(a.type)+'</span><div>'+rowLink(a.row)+'<small>'+esc(a.message)+' · '+esc(a.shopName)+(a.watched?' · ★收藏商品':'')+'</small></div></article>').join('')+'</div><small>共 '+alerts.length+' 条，优先显示收藏商品和高强度变化。提醒只依据保存数据。</small>':'<p>当前筛选范围没有达到提醒条件的变化。</p>';
    $('#dailyDigest').innerHTML=table(['商品','相对 '+(state.baselineSnapshot?.day||'前次集计日')+' 的变化'],digest.slice(0,30).map(r=>[rowLink(r),esc(r.messages.join(' · '))]))+'<small>共 '+digest.length+' 条变化，摘要展示前30条；完整排名表可筛选并导出CSV。</small>';
    const watched=digest.filter(r=>state.watchlist.has(r.itemCode));
    $('#watchDigest').innerHTML=table(['收藏商品','变化'],watched.map(r=>[rowLink(r),esc(r.messages.join(' · '))]));
    const allShopRows=shopRows();
    renderShopOverview(allShopRows);
    renderShopAnalysis(allShopRows);
    renderWatchedShopTrends(allShopRows);
    $('#priceBands').innerHTML=textTable(['API价格带（当前范围前100名）','商品数'],A.priceBands(rows).map(b=>[b.label,b.count]));
    const merged=A.consolidateProducts(rows);
    $('#mergedProducts').innerHTML=table(['商品','最好排名','覆盖类目','各类目排名'],merged.slice(0,200).map(r=>[rowLink(r),esc(r.bestRank+'位'),esc(r.categoryCount+'个 · '+r.categoryNames.join('、')),esc(r.ranks.sort((a,b)=>a.rank-b.rank).map(x=>x.name+' '+x.rank+'位').join(' / '))]))+'<small>当前筛选共 '+merged.length+' 个去重商品，表格显示前200个；完整数据可从导出中心下载。</small>';
    const reviewRows=[...new Map(rows.filter(r=>r.rank!=null).map(r=>[r.itemCode,r])).values()].map(r=>({r,a:A.reviewGrowth(series(r),day,7),b:A.reviewGrowth(series(r),day,30)}));
    $('#reviewGrowth').innerHTML=table(['商品','7天评论增量','30天评论增量','7天评分变化'],reviewRows.sort((a,b)=>(b.a.count??-Infinity)-(a.a.count??-Infinity)).slice(0,30).map(({r,a,b})=>[rowLink(r),esc(a.count??'未记录'),esc(b.count??'未记录'),esc(a.rating===null?'未记录':a.rating.toFixed(2))]))+'<small>仅比较准确相隔7/30日的保存数据。负数可能来自评论清理；评论增量不等于销量。30日比较需31个日期，可通过归档加载补足。</small>';
    const allChanges=rows.flatMap(r=>A.titleChanges(series(r)).map(c=>({r,c}))).sort((a,b)=>b.c.to.localeCompare(a.c.to));
    const titleDays=rows.flatMap(r=>series(r).filter(p=>p.title!=null).map(p=>p.day)).sort();
    const titleRange=titleDays.length ? titleDays[0]+' ～ '+titleDays.at(-1) : 'まだ記録なし';
    const availableTitleDays=captures().filter(c=>c.products||c.productsFile).map(c=>c.aggregateDate).filter(day=>A.shiftDay(day,0)).sort();
    const titleStart=$('#titleExportStart'),titleEnd=$('#titleExportEnd');
    if(availableTitleDays.length){
      titleStart.min=titleEnd.min=availableTitleDays[0];titleStart.max=titleEnd.max=availableTitleDays.at(-1);
      if(!A.shiftDay(titleStart.value,0))titleStart.value=availableTitleDays[0];
      if(!A.shiftDay(titleEnd.value,0))titleEnd.value=availableTitleDays.at(-1);
    }
    $('#titleUpdates').innerHTML=table(['商品','观察日期','修改前','修改后'],allChanges.slice(0,30).map(({r,c})=>[rowLink(r),esc(c.from+' → '+c.to),esc(c.before),esc(c.after)]))+
      '<small>当前载入的标题记录范围：'+esc(titleRange)+'。完整日榜会保存当天标题；超过30天后随日榜进入长期归档。载入更早归档后，这里的范围和修改记录会一起扩展。上线前没有保存的标题无法补回。</small>';
    const groups=[...new Set(Object.values(notebook.products).map(p=>p.group).filter(Boolean))];
    $('#noteGroupFilter').innerHTML='<option value="">全部收藏分组</option>'+groups.map(g=>'<option value="'+esc(g)+'">'+esc(g)+'</option>').join('');
    $('#noteGroupFilter').value=filters.group;
    $('#calendarRows').innerHTML=table(['活动','期间（JST日期）','确认来源','操作'],notebook.events.map((e,i)=>[esc(e.title),esc(e.start+' ～ '+e.end),'<a href="'+esc(e.source)+'" target="_blank" rel="noopener noreferrer">来源</a>','<button type="button" data-delete-event="'+i+'">删除</button>']));
    const options=[...new Map(rows.filter(r=>r.rank!=null).map(r=>[r.category.id+':'+r.itemCode,r])).values()];
    const selected=[...($('#compareProducts').selectedOptions||[])].map(o=>o.value);
    $('#compareProducts').innerHTML=options.map(r=>'<option value="'+esc(r.category.id+'|'+r.itemCode)+'"'+(selected.includes(r.category.id+'|'+r.itemCode)?' selected':'')+'>'+esc(r.category.name+' · 店铺 '+(r.shopName||'未记录')+' · '+r.itemCode+' · '+r.itemName?.slice(0,35))+'</option>').join('');
  }
  function pointSources(row, points) {
    const p=points.at(-1), ev=p?.pointEvidence;
    const claims=ev?.title || [...String(p?.text||'').normalize('NFKC').matchAll(/(?:P|ポイント)\s*(\d{1,2})\s*倍/gi)].map(m=>({rate:Number(m[1]),observedAt:p?.capturedAt}));
    const page=(notebook.products[row.itemCode]?.pagePoints||[]).filter(e=>e.observedAt.slice(0,10)<=endDay()).at(-1);
    return textTable(['积分来源','倍率','记录时间'],[
      ['排行榜API',p?.points==null?'未记录':p.points+'倍',formatStamp(ev?.api?.observedAt||p?.capturedAt)],
      ['商品标题宣称',claims.length?claims.map(c=>c.rate+'倍').join(' / '):'未记录',claims.length?formatStamp(claims[0].observedAt):'—'],
      ['商品页（手动核对）',page?page.rate+'倍':'未确认',page?formatStamp(page.observedAt):'—']
    ])+'<small>三种来源独立展示，不把标题倍率当作API值。商品页倍率不会自动推算或回填历史。</small>';
  }
  function extras(row) {
    currentRow=row;
    const points=series(row), meta=notebook.products[row.itemCode]||{}, p=points.at(-1);
    const estimate=A.couponEstimate(p?.price,p?.text);
    const periods=A.promotionTimeline(points), changes=A.titleChanges(points);
    const events=notebook.events.filter(e=>e.start<=endDay()&&e.end>=(points[0]?.day||endDay()));
    return '<section class="analysis-detail"><h3>促销与积分追溯</h3>'+pointSources(row,points)+
      '<p>'+esc(estimate.amount===null?estimate.label:estimate.label+' '+amount(estimate.amount))+'</p><p>原文条件：'+esc(estimate.conditions||'未记录')+'</p>'+
      textTable(['首次观察','最后观察','记录的优惠文字'],periods.map(p=>[p.start,p.end,p.label]))+
      '<p>上述日期是观察范围。标题注明的期限保留在下面原文中，未注明年份的日期不自动补全年份；未观察到文案不等于优惠已经结束。</p>'+
      '<details><summary>各日活动期限及条件原文</summary>'+textTable(['集计日','标题与Catch Copy原文'],points.map(p=>[p.day,p.text]))+'</details>'+
      '<h3>活动前后对比</h3><div class="analysis-controls"><label>活动开始<input id="activityStart" type="date" value="'+esc(endDay())+'"></label><label>活动结束<input id="activityEnd" type="date" value="'+esc(endDay())+'"></label><button id="compareActivity" type="button">比较</button></div><div id="activityResult"></div><small>比较实际保存值，不插值；活动与排名同变不证明因果关系。</small>'+
      '<h3>商品标题修改记录</h3>'+textTable(['上次观察','本次观察','原标题','新标题'],changes.map(c=>[c.from,c.to,c.before,c.after]))+
      '<h3>跨类目排名 / 采集范围</h3>'+textTable(['类目','选定集计日状态'],(state.latest?.categories||[]).map(c=>[c.name,A.coverageLabel(state.viewSnapshot,c.id,row.itemCode)]))+
      '<h3>已确认活动日历</h3>'+textTable(['活动','开始','结束'],events.map(e=>[e.title,e.start,e.end]))+
      '<h3>收藏分组、备注与相似款标签</h3><div class="analysis-controls"><label>分组<input id="productGroup" maxlength="60" value="'+esc(meta.group||'')+'" placeholder="直接竞品 / 价格参考"></label><label>标签（逗号分隔）<input id="productTags" value="'+esc((meta.tags||[]).join(', '))+'" placeholder="无钢圈, 厚杯, 套装"></label></div><label>备注<textarea id="productNote" maxlength="2000">'+esc(meta.note||'')+'</textarea></label><button id="saveProductNote" type="button">保存分组与备注</button>'+
      '<details><summary>登记商品页已核对的积分</summary><p>仅登记你实际查看的商品页，不代表自动抓取或长期有效。</p><div class="analysis-controls"><label>倍率<input id="pagePointRate" type="number" min="1" max="100"></label><label>核对时间（日本时间）<input id="pagePointAt" type="datetime-local"></label><label>商品页链接<input id="pagePointUrl" type="url" value="'+esc(row.itemUrl||'')+'"></label><button id="savePagePoints" type="button">保存核对记录</button></div></details><p id="analysisDetailStatus" role="status"></p></section>';
  }
  function bindDetail() {
    $('#saveProductNote').addEventListener('click',()=>{
      try{
        const code=currentRow.itemCode;
        const products={...notebook.products,[code]:{...notebook.products[code],group:$('#productGroup').value,note:$('#productNote').value,tags:$('#productTags').value.split(/[,，]/)}};
        save({...notebook,products});$('#analysisDetailStatus').textContent='已保存到此浏览器。可导出分析笔记备份。';render();
      }catch{$('#analysisDetailStatus').textContent='保存失败，请检查浏览器存储权限；原记录保留。';}
    });
    $('#savePagePoints').addEventListener('click',()=>{
      try{
        const code=currentRow.itemCode,rate=Number($('#pagePointRate').value),at=$('#pagePointAt').value,url=$('#pagePointUrl').value;
        if(!at||!Number.isFinite(Date.parse(at+'+09:00'))||Date.parse(at+'+09:00')>Date.now()||rate<1||rate>100||!/^https:\/\/item\.rakuten\.co\.jp\//.test(url))throw Error('请填写有效倍率、已发生的JST时间和乐天商品链接');
        const old=notebook.products[code]||{};
        save({...notebook,products:{...notebook.products,[code]:{...old,pagePoints:[...(old.pagePoints||[]),{rate,observedAt:at+'+09:00',url}]}}});
        $('#analysisDetailStatus').textContent='商品页核对记录已保存；重新打开详情查看。';
      }catch(e){$('#analysisDetailStatus').textContent=e.message;}
    });
    $('#compareActivity').addEventListener('click',()=>{
      const compared=A.activityComparison(series(currentRow),$('#activityStart').value,$('#activityEnd').value);
      $('#activityResult').innerHTML=textTable(['阶段','日期','排名','价格','API积分','优惠文案'],compared.map(p=>[p.label,p.day,p.observation?.rank,amount(p.observation?.price),p.observation?.points,p.observation?.hints?.join(' · ')]));
    });
  }
  function compareProducts() {
    const chosen=[...$('#compareProducts').selectedOptions].map(o=>o.value);
    if(chosen.length<2||chosen.length>5){$('#multiTrend').textContent='请选择2～5款同类目商品。';return;}
    const parts=chosen.map(v=>{const i=v.indexOf('|');return {genre:v.slice(0,i),code:v.slice(i+1)};});
    if(new Set(parts.map(p=>p.genre)).size!==1){$('#multiTrend').textContent='请选同一类目的商品，避免混用排名。';return;}
    const data=parts.map(p=>({...p,points:A.observationSeries(captures(),p.genre,p.code,endDay()).filter(p=>p.day>=A.shiftDay(endDay(),1-state.days))}));
    const dates=[...new Set(data.flatMap(d=>d.points.map(p=>p.day)))].sort();
    const ranks=data.flatMap(d=>d.points.map(p=>p.rank).filter(Number.isFinite));
    if(!ranks.length){$('#multiTrend').textContent='暂无可比较的日榜记录。';return;}
    const max=Math.max(...ranks,2),colors=['#c90000','#166b9b','#087d5d','#945bb0','#b97800'];
    const x=i=>45+i*650/Math.max(1,dates.length-1),y=r=>30+(r-1)*200/(max-1);
    const paths=data.map((d,i)=>{
      let path='',previous=null;
      dates.forEach((day,j)=>{const p=d.points.find(p=>p.day===day);
        if(p?.rank==null){previous=null;return;}
        const continuous=previous&&A.shiftDay(previous,1)===day;
        path+=(continuous?'L':'M')+x(j)+','+y(p.rank)+' ';previous=day;
      });
      return '<path fill="none" stroke="'+colors[i]+'" stroke-width="2" d="'+path+'"/>'+d.points.filter(p=>p.rank!=null).map(p=>'<circle cx="'+x(dates.indexOf(p.day))+'" cy="'+y(p.rank)+'" r="3" fill="'+colors[i]+'"><title>'+esc(d.code+' '+p.day+' '+p.rank+'位')+'</title></circle>').join('');
    }).join('');
    const markers=notebook.events.filter(e=>e.start<=dates.at(-1)&&e.end>=dates[0]).map(e=>{
      const indices=dates.map((d,i)=>d>=e.start&&d<=e.end?i:-1).filter(i=>i>=0);
      if(!indices.length)return '';
      return '<rect x="'+(x(indices[0])-3)+'" y="20" width="'+Math.max(6,x(indices.at(-1))-x(indices[0])+6)+'" height="215" fill="#d6a200" opacity=".12"><title>'+esc(e.title+' '+e.start+'～'+e.end)+'</title></rect>';
    }).join('');
    $('#multiTrend').innerHTML='<svg viewBox="0 0 740 270" role="img" aria-label="同类目日榜排名对比，活动日期以浅黄色标出">'+markers+'<text x="5" y="34">1位</text><text x="5" y="230">'+max+'位</text>'+paths+'<text x="45" y="255">'+esc(dates[0])+'</text><text x="600" y="255">'+esc(dates.at(-1))+'</text></svg><p>'+data.map((d,i)=>'<span style="color:'+colors[i]+'">'+esc(d.code)+'</span>').join(' · ')+'</p>'+textTable(['集计日',...data.map(d=>d.code)],dates.map(day=>[day,...data.map(d=>d.points.find(p=>p.day===day)?.rank??'未记录')]));
  }
  function download(name,value) {
    const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));
    const a=document.createElement('a');a.href=url;a.download=name;a.click();URL.revokeObjectURL(url);
  }
  function csvCell(value) {
    if(typeof value==='string' && /^[=+\-@\t\r]/.test(value))value="'"+value;
    return '"'+String(value??'').replaceAll('"','""')+'"';
  }
  function exportOperations() {
    const rows=state.rows||[],prior=snapshotRows(state.baselineSnapshot,null,state.latest?.categories||[]),alerts=A.priorityAlerts(rows,prior,state.watchlist,alertSettings),shops=A.shopOverview(shopRows()),merged=A.consolidateProducts(rows);
    const header=['记录类型','集计日','店铺名','店铺代码','商品编号','商品名','类目','排名','对比排名','变化','价格','API积分','提示/汇总','商品链接','数据来源'];
    const values=[];
    for(const r of rows)values.push(['商品排名',endDay(),r.shopName,r.shopCode||r.itemCode.split(':')[0],r.itemCode,r.itemName,r.category.name,r.rank,r.previousRank,r.change,r.itemPrice,r.pointRate,(r.promotionHints||[]).join(' | '),r.itemUrl,'楽天排行榜API保存值']);
    for(const s of shops)values.push(['店铺汇总',endDay(),s.name,s.key,'','','',s.items,s.top10,s.up-s.down,'','',`前10 ${s.top10} / 前100 ${s.top100} / 上涨 ${s.up} / 下跌 ${s.down}`,'','公开榜单推算']);
    for(const a of alerts)values.push(['今日提醒',endDay(),a.shopName,a.row.shopCode||a.row.itemCode.split(':')[0],a.row.itemCode,a.row.itemName,a.row.category.name,a.row.rank,a.row.previousRank,a.row.change,a.row.itemPrice,a.row.pointRate,a.type+'：'+a.message,a.row.itemUrl,'保存值规则判断']);
    for(const r of merged)values.push(['跨类目合并',endDay(),r.shopName,r.shopCode||r.itemCode.split(':')[0],r.itemCode,r.itemName,r.categoryNames.join(' | '),r.bestRank,'','',r.itemPrice,r.pointRate,`覆盖${r.categoryCount}类目`,r.itemUrl,'楽天排行榜API保存值']);
    const blob=new Blob(['\ufeff'+[header,...values].map(line=>line.map(csvCell).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='rakuten-operations-'+endDay()+'.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    $('#exportOperationsStatus').textContent='已导出 '+values.length+' 行，可用Excel打开并按“记录类型”筛选。';
  }
  async function exportTitleChanges() {
    const start=$('#titleExportStart').value,end=$('#titleExportEnd').value,status=$('#titleExportStatus');
    if(!A.shiftDay(start,0)||!A.shiftDay(end,0)||start>end){status.textContent='请选择有效的修改日期范围。';return;}
    if(busy)return;busy=true;status.textContent='正在读取每天的商品标题资料…';
    try{
      const source=captures().filter(c=>c.aggregateDate&&c.aggregateDate<=end);
      const hydrated=[];
      for(let i=0;i<source.length;i+=3){
        const batch=await Promise.all(source.slice(i,i+3).map(async capture=>{
          if(capture.products)return capture;
          if(!/^(history-products|archive\/products)\/\d{4}-\d{2}-\d{2}\.json$/.test(capture.productsFile||''))return capture;
          if(!titleProductCache.has(capture.productsFile)){
            const response=await fetch('data/'+capture.productsFile,{cache:'no-store'});
            if(!response.ok)throw Error('商品标题资料读取失败：'+capture.aggregateDate);
            const payload=await response.json();
            if(!payload.products||typeof payload.products!=='object'||Array.isArray(payload.products))throw Error('商品标题资料格式错误：'+capture.aggregateDate);
            titleProductCache.set(capture.productsFile,payload.products);
          }
          return {...capture,products:titleProductCache.get(capture.productsFile)};
        }));
        hydrated.push(...batch);status.textContent='正在读取商品标题资料：'+Math.min(i+3,source.length)+'/'+source.length+'日';
      }
      const rows=A.titleChangeRows(hydrated,start,end);
      const headers=['店铺名','店铺代码','商品编号','商品URL','修改日期（集计日）','上次观察日期','连续两日观察','修改前标题','修改后标题'];
      const values=rows.map(r=>[r.shopName,r.shopCode,r.itemCode,r.itemUrl,r.changedDate,r.previousObservedDate,r.continuous?'是':'否（中间有缺测或未进榜）',r.before,r.after]);
      const blob=new Blob(['\ufeff'+[headers,...values].map(line=>line.map(csvCell).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'});
      const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='rakuten-title-changes-by-shop-'+start+'-'+end+'.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
      status.textContent='已下载 '+rows.length+' 条标题修改记录（'+start+'～'+end+'）。CSV已按店铺名排序。';
    }catch(e){status.textContent=e.message+'；没有生成不完整文件，请重试。';}finally{busy=false;}
  }
  async function loadArchive() {
    const start=$('#archiveStart').value,end=$('#archiveEnd').value;
    if(!A.shiftDay(start,0)||!A.shiftDay(end,0)||start>end){$('#archiveStatus').textContent='请选择有效日期范围。';return;}
    if(busy)return;busy=true;
    $('#archiveStatus').textContent='读取归档中…';
    try{
      const response=await fetch('data/archive/index.json',{cache:'no-store'});
      if(response.status===404){$('#archiveStatus').textContent='尚无超过30天的归档。之后会自动保存；已删除的旧数据不会凭空补回。';return;}
      if(!response.ok)throw Error('归档索引读取失败');
      const index=await response.json(),entries=(index.captures||[]).filter(e=>e.date>=start&&e.date<=end);
      const loaded=[];
      // Bounded batches avoid hundreds of simultaneous requests.
      for(let i=0;i<entries.length;i+=4){
        const batch=await Promise.all(entries.slice(i,i+4).map(async e=>{
          if(!/^archive\/ranks\/\d{4}-\d{2}-\d{2}\.json$/.test(e.file))throw Error('归档路径无效');
          const r=await fetch('data/'+e.file,{cache:'no-store'});if(!r.ok)throw Error('归档日读取失败 '+e.date);
          const c=await r.json();if(!c.genres||!c.capturedAt)throw Error('归档内容无效');return c;
        }));loaded.push(...batch);
      }
      const merged=new Map([...(state.history?.captures||[]),...loaded].map(c=>[c.aggregateDate||c.capturedAt,c]));
      state.history={...state.history,captures:[...merged.values()]};
      await refreshView();$('#archiveStatus').textContent='已载入 '+loaded.length+' 个归档日，可在日榜日期选择中查看。';
    }catch(e){$('#archiveStatus').textContent=e.message+'；保留原来的数据，可重试。';}finally{busy=false;}
  }
  function bind(openDetail) {
    const openAnalysisDetail=event=>{
      const btn=event.target.closest('[data-analysis-detail]');if(!btn)return false;
      const r=shopRows().find(r=>r.itemCode===btn.dataset.analysisDetail&&String(r.category.id)===btn.dataset.genre);
      if(r)openDetail(r);else{btn.disabled=true;btn.textContent='历史资料不可用';}return true;
    };
    const toggleShop=code=>{if(!code)return;if(watchedShops.has(code))watchedShops.delete(code);else watchedShops.add(code);globalThis.localStorage.setItem(SHOP_WATCH_KEY,JSON.stringify([...watchedShops]));render();};
    for(const [id,key] of [['noteGroupFilter','group'],['tagFilter','tag'],['signalFilter','signal'],['priceMin','min'],['priceMax','max']]){
      $( '#'+id).addEventListener('change',event=>{filters[key]=event.target.value;refreshView();});
    }
    $('#analysisPanel').addEventListener('click',event=>{
      const shop=event.target.closest('[data-watch-shop]');if(shop){toggleShop(shop.dataset.watchShop);return;}
      const sort=event.target.closest('[data-shop-sort]');
      if(sort){
        const key=sort.dataset.shopSort;
        shopOverviewSort=shopOverviewSort.key===key
          ? {key,direction:shopOverviewSort.direction==='asc'?'desc':'asc'}
          : {key,direction:key==='name'?'asc':'desc'};
        renderShopOverview(shopRows());
        return;
      }
      const btn=event.target.closest('[data-analysis-detail]');
      if(btn){openAnalysisDetail(event);return;}
      const del=event.target.closest('[data-delete-event]');
      if(del){try{save({...notebook,events:notebook.events.filter((_,i)=>i!==Number(del.dataset.deleteEvent))});render();}catch{$('#calendarStatus').textContent='保存失败';}}
    });
    $('#today-intelligence').addEventListener('click',event=>{openAnalysisDetail(event);});
    $('#addCalendarEvent').addEventListener('click',()=>{
      try{
        const event={title:$('#eventTitle').value.trim(),start:$('#eventStart').value,end:$('#eventEnd').value,source:$('#eventSource').value};
        if(!event.title||!A.shiftDay(event.start,0)||!A.shiftDay(event.end,0)||event.start>event.end||!/^https:\/\//.test(event.source))throw Error('请填写名称、有效日期和确认来源链接');
        save({...notebook,events:[...notebook.events,event]});render();$('#calendarStatus').textContent='已保存；多商品趋势图会标出活动日期。';
      }catch(e){$('#calendarStatus').textContent=e.message;}
    });
    $('#drawMultiTrend').addEventListener('click',compareProducts);
    $('#shopAnalysisSelect').addEventListener('change',event=>{selectedShopKey=event.target.value;render();});
    $('#shopAnalysisSearch').addEventListener('input',event=>{shopAnalysisQuery=event.target.value;renderShopAnalysis(shopRows());});
    $('#compareShops').addEventListener('click',renderShopComparison);
    $('#loadArchive').addEventListener('click',loadArchive);
    $('#exportAnalysis').addEventListener('click',()=>download('ranking-analysis-notes.json',notebook));
    $('#exportArchive').addEventListener('click',()=>download('ranking-loaded-history.json',{captures:captures()}));
    $('#exportTitleChanges').addEventListener('click',exportTitleChanges);
    $('#exportOperations').addEventListener('click',exportOperations);
    $('#saveAlertSettings').addEventListener('click',()=>{
      alertSettings={rankJump:Math.max(1,Math.min(999,Number($('#alertRankJump').value)||50)),pointRate:Math.max(2,Math.min(100,Number($('#alertPointRate').value)||10)),couponRate:Math.max(1,Math.min(99,Number($('#alertCouponRate').value)||30))};
      globalThis.localStorage.setItem(ALERT_KEY,JSON.stringify(alertSettings));render();
    });
    $('#importAnalysis').addEventListener('change',async e=>{
      try{
        const file=e.target.files?.[0];if(!file)return;
        if(file.size>2000000)throw Error('文件超过2MB');
        const incoming=A.cleanNotebook(JSON.parse(await file.text()));
        const products={...notebook.products};
        for(const [code,p] of Object.entries(incoming.products)) {
          const old=products[code];
          products[code]=old?{group:old.group||p.group,note:old.note||p.note,tags:[...new Set([...old.tags,...p.tags])],pagePoints:[...old.pagePoints,...p.pagePoints]}:p;
        }
        const events=[...new Map([...notebook.events,...incoming.events].map(e=>[JSON.stringify(e),e])).values()];
        save({...notebook,products,events});await refreshView();$('#analysisTransferStatus').textContent='已合并笔记；已有分组和备注优先保留。';
      }catch(e){$('#analysisTransferStatus').textContent='导入失败：'+e.message;}
    });
  }
  return {render,matches,extras,bindDetail,bind,priceEvidence};
}
