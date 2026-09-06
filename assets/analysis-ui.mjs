import * as A from './analysis-tools.mjs';
import { snapshotRows } from './history-tools.mjs';

export function createAnalysis({state, $, escapeHtml:esc, refreshView, formatStamp, sparkline}) {
  let notebook = A.readNotebook(globalThis.localStorage), currentRow = null, busy = false;
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
  const rowLink = r => '<button type="button" data-analysis-detail="'+esc(r.itemCode)+'" data-genre="'+esc(r.category.id)+'">'+esc(r.itemName?.slice(0,65)||r.itemCode)+'</button><small>'+esc(r.category.name)+' · '+esc(r.itemCode)+'</small>';
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
  function render() {
    $('#analysisPanel').hidden=state.mode!=='daily';
    renderStatus(state.collectionStatus);
    if(state.mode!=='daily')return;
    const rows=state.rows||[], day=endDay();
    $('#analysisBasis').textContent='集计日 '+(day||'未记录')+'；以下统计采用当前类目、搜索和范围。店铺与价格带按商品去重，收藏列表继续保留类目记录。';
    const prior=snapshotRows(state.baselineSnapshot,null,state.latest?.categories||[]);
    const digest=A.dailyDigest(rows,prior);
    $('#dailyDigest').innerHTML=table(['商品','相对 '+(state.baselineSnapshot?.day||'前次集计日')+' 的变化'],digest.slice(0,30).map(r=>[rowLink(r),esc(r.messages.join(' · '))]))+'<small>共 '+digest.length+' 条变化，摘要展示前30条；完整排名表可筛选并导出CSV。</small>';
    const watched=digest.filter(r=>state.watchlist.has(r.itemCode));
    $('#watchDigest').innerHTML=table(['收藏商品','变化'],watched.map(r=>[rowLink(r),esc(r.messages.join(' · '))]));
    $('#shopOverview').innerHTML=textTable(['店铺','上榜商品','前10','前100','上涨','下跌'],A.shopOverview(rows).map(s=>[s.name,s.items,s.top10,s.top100,s.up,s.down]))+'<small>同商品跨类目去重；在不同类目一升一降时，会分别计入上涨和下跌。</small>';
    $('#priceBands').innerHTML=textTable(['API价格带（当前范围前100名）','商品数'],A.priceBands(rows).map(b=>[b.label,b.count]));
    const reviewRows=[...new Map(rows.filter(r=>r.rank!=null).map(r=>[r.itemCode,r])).values()].map(r=>({r,a:A.reviewGrowth(series(r),day,7),b:A.reviewGrowth(series(r),day,30)}));
    $('#reviewGrowth').innerHTML=table(['商品','7天评论增量','30天评论增量','7天评分变化'],reviewRows.sort((a,b)=>(b.a.count??-Infinity)-(a.a.count??-Infinity)).slice(0,30).map(({r,a,b})=>[rowLink(r),esc(a.count??'未记录'),esc(b.count??'未记录'),esc(a.rating===null?'未记录':a.rating.toFixed(2))]))+'<small>仅比较准确相隔7/30日的保存数据。负数可能来自评论清理；评论增量不等于销量。30日比较需31个日期，可通过归档加载补足。</small>';
    const allChanges=rows.flatMap(r=>A.titleChanges(series(r)).map(c=>({r,c}))).sort((a,b)=>b.c.to.localeCompare(a.c.to));
    $('#titleUpdates').innerHTML=table(['商品','观察日期','修改前','修改后'],allChanges.slice(0,30).map(({r,c})=>[rowLink(r),esc(c.from+' → '+c.to),esc(c.before),esc(c.after)]));
    const groups=[...new Set(Object.values(notebook.products).map(p=>p.group).filter(Boolean))];
    $('#noteGroupFilter').innerHTML='<option value="">全部收藏分组</option>'+groups.map(g=>'<option value="'+esc(g)+'">'+esc(g)+'</option>').join('');
    $('#noteGroupFilter').value=filters.group;
    $('#calendarRows').innerHTML=table(['活动','期间（JST日期）','确认来源','操作'],notebook.events.map((e,i)=>[esc(e.title),esc(e.start+' ～ '+e.end),'<a href="'+esc(e.source)+'" target="_blank" rel="noopener noreferrer">来源</a>','<button type="button" data-delete-event="'+i+'">删除</button>']));
    const options=[...new Map(rows.filter(r=>r.rank!=null).map(r=>[r.category.id+':'+r.itemCode,r])).values()];
    const selected=[...($('#compareProducts').selectedOptions||[])].map(o=>o.value);
    $('#compareProducts').innerHTML=options.map(r=>'<option value="'+esc(r.category.id+'|'+r.itemCode)+'"'+(selected.includes(r.category.id+'|'+r.itemCode)?' selected':'')+'>'+esc(r.category.name+' · '+r.itemCode+' · '+r.itemName?.slice(0,35))+'</option>').join('');
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
    for(const [id,key] of [['noteGroupFilter','group'],['tagFilter','tag'],['signalFilter','signal'],['priceMin','min'],['priceMax','max']]){
      $( '#'+id).addEventListener('change',event=>{filters[key]=event.target.value;refreshView();});
    }
    $('#analysisPanel').addEventListener('click',event=>{
      const btn=event.target.closest('[data-analysis-detail]');
      if(btn){const r=state.rows.find(r=>r.itemCode===btn.dataset.analysisDetail&&String(r.category.id)===btn.dataset.genre);if(r)openDetail(r);}
      const del=event.target.closest('[data-delete-event]');
      if(del){try{save({...notebook,events:notebook.events.filter((_,i)=>i!==Number(del.dataset.deleteEvent))});render();}catch{$('#calendarStatus').textContent='保存失败';}}
    });
    $('#addCalendarEvent').addEventListener('click',()=>{
      try{
        const event={title:$('#eventTitle').value.trim(),start:$('#eventStart').value,end:$('#eventEnd').value,source:$('#eventSource').value};
        if(!event.title||!A.shiftDay(event.start,0)||!A.shiftDay(event.end,0)||event.start>event.end||!/^https:\/\//.test(event.source))throw Error('请填写名称、有效日期和确认来源链接');
        save({...notebook,events:[...notebook.events,event]});render();$('#calendarStatus').textContent='已保存；多商品趋势图会标出活动日期。';
      }catch(e){$('#calendarStatus').textContent=e.message;}
    });
    $('#drawMultiTrend').addEventListener('click',compareProducts);
    $('#loadArchive').addEventListener('click',loadArchive);
    $('#exportAnalysis').addEventListener('click',()=>download('ranking-analysis-notes.json',notebook));
    $('#exportArchive').addEventListener('click',()=>download('ranking-loaded-history.json',{captures:captures()}));
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
