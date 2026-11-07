import test from 'node:test';
import assert from 'node:assert/strict';
import { bindRankHover, braMatch, newSignals, promotionLabel, rakutenProductUrl, rankObservation } from '../assets/compare-workbench.mjs';

test('recommendation requires wireless and fuller bust, and separates packs',()=>{
  assert.ok(braMatch({itemName:'ノンワイヤー 自然に盛れる 小胸',itemPrice:3000},'single',3100));
  assert.equal(braMatch({itemName:'ノンワイヤー 盛れる ブラ&ショーツセット'},'single'),null);
  assert.ok(braMatch({itemName:'ノンワイヤー 盛れる ブラ＆ショーツセット'},'bundle'));
  assert.equal(braMatch({itemName:'ノンワイヤー ナイトブラ 盛れる'},'single'),null);
  assert.equal(braMatch({itemName:'小胸 盛れる ワイヤー入り'},'single'),null);
});

test('promotion is shown as a clue, unchanged promotions are not repeated',()=>{
  assert.equal(promotionLabel('最大２０％ＯＦＦクーポン'),'最高 20% OFF 优惠券');
  const before={itemPrice:3000,pointRate:1,promotionHints:['20%OFFクーポン']};
  assert.deepEqual(newSignals(before,before),[]);
  assert.deepEqual(newSignals(before,null),[]);
  assert.match(newSignals({...before,promotionHints:['30%OFFクーポン']},before)[0],/新检测到 30% OFF 优惠券/);
});

test('missing data and absence in a recorded category are different',()=>{
  assert.equal(rankObservation(null,'12','shop:4').label,'榜单数据不可用');
  assert.equal(rankObservation({genres:{12:{'shop:3':2}}},'12','shop:4').label,'不在已保存范围');
  assert.equal(rankObservation({genres:{12:{'shop:4':110}}},'12','shop:4').rank,110);
});

test('only canonical Rakuten product URLs can be stored',()=>{
  assert.equal(rakutenProductUrl('https://item.rakuten.co.jp/test/product/?scid=test'),'https://item.rakuten.co.jp/test/product/');
  assert.equal(rakutenProductUrl('https://item.rakuten.co.jp.example.com/a/b/'),'');
  assert.equal(rakutenProductUrl('https://username@item.rakuten.co.jp/a/b/'),'');
});

test('hover snaps to the nearest date in SVG coordinates and hides on exit',()=>{
  const events={}, attrs={visibility:'hidden'}, tip={hidden:true};
  const line={setAttribute:(k,v)=>attrs[k]=v,removeAttribute:k=>delete attrs[k]};
  const svg={
    dataset:{rankHover:JSON.stringify([[10,'11/06 · 第 56 名'],[100,'11/07 · 第 46 名']])},
    getScreenCTM:()=>({inverse:()=>({})}), createSVGPoint:()=>({matrixTransform(){return {x:(this.x-20)/2};}}),
    querySelector:()=>line,parentElement:{querySelector:()=>tip}
  };
  const target={closest:()=>svg};
  bindRankHover({addEventListener:(name,handler)=>events[name]=handler});
  events.pointermove({target,clientX:215,clientY:24});
  assert.equal(attrs.x1,100);
  assert.equal(tip.textContent,'11/07 · 第 46 名');
  assert.equal(tip.hidden,false);
  events.pointermove({target,clientX:30,clientY:24});
  assert.equal(attrs.x1,10);
  events.pointerout({target,relatedTarget:null});
  assert.equal(attrs.visibility,'hidden');
  assert.equal(tip.hidden,true);
});
