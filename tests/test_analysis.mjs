import test from 'node:test';
import assert from 'node:assert/strict';
import * as A from '../assets/analysis-tools.mjs';

test('coupon estimate distinguishes unconditional discount, capped offer and sale text',()=>{
  assert.equal(A.couponEstimate(3000,'20%OFFクーポン ブラ').amount,2400);
  assert.equal(A.couponEstimate(3000,'クーポンで30%OFF').amount,2100);
  assert.equal(A.couponEstimate(3000,'クーポン利用で799円').amount,799);
  assert.equal(A.couponEstimate(3000,'500円OFFクーポン').amount,2500);
  for(const title of ['最大20%クーポン','先着3000名クーポンで30%OFF','2枚以上で20%OFFクーポン','50%OFF セール クーポン配布','100%OFFクーポン']){
    assert.equal(A.couponEstimate(3000,title).amount,null,title);
  }
});
test('review growth requires exact endpoints and preserves decreases',()=>{
  const series=[{day:'2026-09-01',reviews:100,rating:4.6},{day:'2026-09-08',reviews:98,rating:4.5}];
  assert.equal(A.reviewGrowth(series,'2026-09-08',7).count,-2);
  assert.equal(A.reviewGrowth(series,'2026-09-08',30).count,null);
});
test('streaks do not cross missing days and first top10 is bounded by recorded history',()=>{
  const points=[12,11,10,8].map((rank,i)=>({day:A.shiftDay('2026-09-01',i),rank}));
  assert.equal(A.momentum(points,'2026-09-04').rising,true);
  assert.equal(A.momentum(points.filter((_,i)=>i!==1),'2026-09-04').rising,false);
  assert.equal(A.momentum(points,'2026-09-04').firstTop10,false);
  assert.equal(A.momentum(points,'2026-09-03').firstTop10,true);
});
test('timeline gaps and unknown titles never fabricate changes or campaign dates',()=>{
  const series=[{day:'2026-09-01',hints:['20%OFFクーポン'],title:'old'},{day:'2026-09-03',hints:['20%OFFクーポン'],title:null},{day:'2026-09-04',hints:null,title:'new'}];
  assert.equal(A.promotionTimeline(series).length,3);
  assert.equal(A.titleChanges(series).length,0);
  assert.equal(A.activityComparison(series,'2026-09-03','2026-09-03')[0].observation,null);
});
test('shop and price summaries deduplicate products without altering original rows',()=>{
  const rows=[{itemCode:'s:1',shopName:'Shop',rank:1,itemPrice:2500,change:2},{itemCode:'s:1',shopName:'Shop',rank:3,itemPrice:2500,change:-1}];
  assert.equal(A.shopOverview(rows)[0].items,1);
  assert.equal(A.shopOverview(rows)[0].down,1);
  assert.equal(A.priceBands(rows)[1].count,1);
  assert.equal(rows.length,2);
});
test('coverage distinguishes failed genres, empty observations, absence and rank',()=>{
  const capture={genres:{a:{'s:1':100},b:{}}};
  assert.match(A.coverageLabel(capture,'c','s:1'),/未取得/);
  assert.match(A.coverageLabel(capture,'b','s:1'),/判定不可/);
  assert.match(A.coverageLabel(capture,'a','s:2'),/下架未確認/);
  assert.equal(A.coverageLabel(capture,'a','s:1'),'100位');
});
test('notebook validation strips unsafe evidence and round-trips groups notes tags events',()=>{
  const value={version:1,products:{'s:1':{group:'竞品',note:'memo',tags:['厚杯','厚杯'],pagePoints:[{rate:10,observedAt:'2026-09-01T15:00:00+09:00',url:'javascript:alert(1)'}]}},events:[{title:'Sale',start:'2026-09-01',end:'2026-09-02',source:'https://example.com/event'}]};
  const clean=A.cleanNotebook(value);
  assert.deepEqual(clean.products['s:1'].tags,['厚杯']);
  assert.deepEqual(clean.products['s:1'].pagePoints,[]);
  assert.equal(A.cleanNotebook(JSON.parse(JSON.stringify(clean))).events.length,1);
  assert.throws(()=>A.cleanNotebook({version:2,products:{}}));
});
