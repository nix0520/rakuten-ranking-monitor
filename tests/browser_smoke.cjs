// Optional local smoke test: node tests/browser_smoke.cjs (requires Playwright).
const {chromium}=require('playwright');
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const categories=JSON.parse(fs.readFileSync(path.join(root,'config/categories.json')));
const day='2026-09-06',genre='110854';
let revision=0;
const dates=Array.from({length:31},(_,i)=>new Date(Date.parse(day+'T00:00:00Z')-(30-i)*86400000).toISOString().slice(0,10));
const rows=n=>[1,2].map((i)=>({itemCode:'s:'+i,rank:i===1?Math.max(1,31-n):5,itemName:(n<29?'20%OFFクーポン':'30%OFFクーポン')+' P10倍 テストブラ '+i,catchcopy:'',itemPrice:3000,pointRate:1,reviewCount:100+n,reviewAverage:4.5,shopCode:'s',shopName:'Test shop',promotionHints:[n<29?'20%OFFクーポン':'30%OFFクーポン'],itemUrl:'https://item.rakuten.co.jp/test/product/',imageUrl:''}));
const snapshots=dates.map((d,n)=>({aggregateDate:d,capturedAt:d+'T15:06:00+09:00',genres:Object.fromEntries(categories.map(c=>[c.id,Object.fromEntries(rows(n).map(r=>[r.itemCode,r.rank]))])),metrics:Object.fromEntries(categories.map(c=>[c.id,Object.fromEntries(rows(n).map(r=>[r.itemCode,{itemPrice:r.itemPrice,pointRate:r.pointRate,itemName:r.itemName,promotionText:r.itemName,reviewCount:r.reviewCount,reviewAverage:r.reviewAverage,promotionHints:r.promotionHints}]))])),products:Object.fromEntries(rows(n).map(r=>[r.itemCode,r]))}));
const latest=()=>({aggregateDate:day,generatedAt:day+(revision?'T16:06:00+09:00':'T15:06:00+09:00'),collectionVersion:2,categories,rankings:Object.fromEntries(categories.map(c=>[c.id,rows(30)]))});
const server=http.createServer((req,res)=>{
  const file=path.resolve(root,'.'+new URL(req.url,'http://localhost').pathname.replace(/\/$/,'/index.html'));
  if(!file.startsWith(root+path.sep)||!fs.existsSync(file)){res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type',file.endsWith('.mjs')||file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');
  res.end(fs.readFileSync(file));
});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:1000}});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.addInitScript(()=>{window.testIntervals=[];window.setInterval=(fn,ms)=>{window.testIntervals.push({fn,ms});return 1;};});
    await page.route('**/data/**',route=>{
      const p=new URL(route.request().url()).pathname.split('/data/')[1];
      let data=null;
      if(p==='latest.json')data=latest();
      if(p==='publication.json')data={generatedAt:latest().generatedAt,aggregateDate:day};
      if(p==='history.json')data={captures:snapshots.slice(1)};
      if(p==='daily-update-log.json')data={days:[]};
      if(p==='realtime/latest.json')data=latest();
      if(p==='collection-status.json')data={status:'complete',aggregateDate:day,completed:17,total:17,genres:{},updatedAt:latest().generatedAt};
      if(p==='archive/index.json')data={captures:[{date:dates[0],file:'archive/ranks/'+dates[0]+'.json'}]};
      if(p==='archive/ranks/'+dates[0]+'.json')data={...snapshots[0],productsFile:'archive/products/'+dates[0]+'.json'};
      if(p==='archive/products/'+dates[0]+'.json')data={products:snapshots[0].products};
      route.fulfill({status:data?200:404,contentType:'application/json',body:JSON.stringify(data||{})});
    });
    await page.goto('http://127.0.0.1:'+server.address().port);
    await page.locator('#rankingBody tr').first().waitFor();
    await page.selectOption('#categorySelect',genre);
    assert.equal(await page.locator('#rankingBody tr').count(),2);
    await page.locator('#rankingBody [data-detail-code]').first().click();
    await page.locator('#productDialog').waitFor({state:'visible'});
    assert.match(await page.locator('#detailBody').innerText(),/促销与积分追溯/);
    await page.fill('#productGroup','直接竞品');
    await page.fill('#productTags','无钢圈,厚杯');
    await page.fill('#productNote','只比较同类目');
    await page.click('#saveProductNote');
    assert.match(await page.locator('#analysisDetailStatus').innerText(),/已保存/);
    await page.fill('#activityStart','2026-09-04');await page.fill('#activityEnd','2026-09-05');await page.click('#compareActivity');
    assert.match(await page.locator('#activityResult').innerText(),/活動前日/);
    await page.click('#closeDetail');
    await page.locator('summary').filter({hasText:'多商品日榜趋势对比'}).click();
    await page.selectOption('#compareProducts',[genre+'|s:1',genre+'|s:2']);await page.click('#drawMultiTrend');
    assert.equal(await page.locator('#multiTrend svg').count(),1);
    await page.selectOption('#signalFilter','rising');
    assert.equal(await page.locator('#rankingBody tr').count(),1);
    await page.selectOption('#signalFilter','');
    await page.selectOption('#noteGroupFilter','直接竞品');
    assert.equal(await page.locator('#rankingBody tr').count(),1);
    await page.selectOption('#noteGroupFilter','');
    await page.locator('summary').filter({hasText:'长期日榜归档'}).click();
    await page.fill('#archiveStart',dates[0]);await page.fill('#archiveEnd',dates[0]);await page.click('#loadArchive');
    await page.waitForFunction(()=>document.querySelector('#archiveStatus').textContent.includes('已载入 1'));
    await page.selectOption('#historyDate',dates[0]);
    await page.waitForFunction(d=>document.querySelector('#historyNote').textContent.includes(d),dates[0]);
    revision=1;
    await page.evaluate(async()=>{await window.testIntervals.find(t=>t.ms===120000).fn();});
    assert.equal(await page.inputValue('#historyDate'),dates[0]);
    assert.match(await page.locator('#autoRefreshStatus').innerText(),/自動読込/);
    await page.selectOption('#historyDate','latest');
    await page.screenshot({path:'/tmp/ranking-analysis-desktop.png',fullPage:true});
    await page.setViewportSize({width:390,height:844});
    await page.screenshot({path:'/tmp/ranking-analysis-mobile.png',fullPage:true});
    const overflow=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,
      boxes:[...document.querySelectorAll('body *')].filter(e=>{
        if(e.getBoundingClientRect().right<=innerWidth+1)return false;
        let p=e.parentElement;
        while(p && p!==document.body){if(['auto','scroll','hidden','clip'].includes(getComputedStyle(p).overflowX))return false;p=p.parentElement;}return true;
      }).slice(0,25).map(e=>({tag:e.tagName,id:e.id,cls:e.className,left:e.getBoundingClientRect().left,right:e.getBoundingClientRect().right,scroll:e.scrollWidth}))}));
    if(overflow.scroll>overflow.width+1)console.log('Mobile overflow diagnostics:',JSON.stringify(overflow));
    assert.equal(overflow.scroll>overflow.width+1,false,'no page overflow on mobile');
    assert.deepEqual(errors,[]);
    console.log('Browser smoke passed: detail, notes, filters, activity, chart, archive, refresh, mobile.');
  }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
