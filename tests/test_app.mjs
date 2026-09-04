import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as insights from '../assets/insights.mjs';
import * as historyTools from '../assets/history-tools.mjs';

function app() {
  const elements = new Map();
  function element(selector) {
    if (!elements.has(selector)) elements.set(selector, {
      innerHTML: '', textContent: '', hidden: false, open: false, dataset: {}, handlers: {},
      classList: { toggle() {} }, setAttribute() {},
      addEventListener(name, handler) { this.handlers[name] = handler; },
      showModal() { this.open = true; }, close() { this.open = false; this.handlers.close?.(); }
    });
    return elements.get(selector);
  }
  const storage = { value: '[]', getItem() { return this.value; }, setItem(_, value) { this.value = value; } };
  const context = vm.createContext({ ...insights, ...historyTools, watchlistJson: historyTools.exportWatchlist, document: { querySelector: element, querySelectorAll: () => [] },
    window: { localStorage: storage }, localStorage: storage, Intl, Date, console, URL,
    fetch: async () => ({ ok: true, json: async () => ({ events: [] }) }) });
  const source = readFileSync(new URL('../assets/app.js', import.meta.url), 'utf8')
    .replace(/^import .*?;\n/gm, '').replace(/\ninit\(\);\s*$/, '');
  vm.runInContext(source, context);
  vm.runInContext(`state.latest = { rankings: { 1: [{ itemCode: 'a', itemName: '<script>bad</script>', rank: 1, change: 5, itemPrice: 1000, pointRate: 2 }] }, categories: [{ id: 1, group: 'bra', name: 'Bra' }] }; state.history = { captures: [] }; state.updateLog = { days: [] };`, context);
  return { context, element, storage, run: code => vm.runInContext(code, context) };
}

test('page templates escape titles and render favorite and history buttons', () => {
  const a = app();
  a.run('render()');
  const html = a.element('#rankingBody').innerHTML;
  assert.match(html, /data-watch="a"/);
  assert.match(html, /data-detail-code="a"/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.equal(a.element('#rolloverPanel').hidden, false);
  a.run("state.mode = 'realtime'; render()");
  assert.equal(a.element('#rolloverPanel').hidden, true);
});

test('favorite click persists, only-watched filter works, manager removes absent entries', () => {
  const a = app();
  a.run('bindEvents(); render()');
  a.element('#rankingBody').handlers.click({ target: { closest: selector => selector === '[data-watch]' ? { dataset: { watch: 'a' } } : null } });
  assert.deepEqual(JSON.parse(a.storage.value), ['a']);
  a.element('#watchedOnly').handlers.change({ target: { checked: true } });
  assert.equal(a.run('state.rows.length'), 1);
  a.run('state.latest.rankings[1] = []; render()');
  assert.match(a.element('#watchManager').innerHTML, /data-remove-watch="a"/);
  a.element('#watchManager').handlers.click({ target: { closest: () => ({ dataset: { removeWatch: 'a' } }) } });
  assert.deepEqual(JSON.parse(a.storage.value), []);
});

test('detail dialog renders charts, explicit missing values, safe title and closes', async () => {
  const a = app();
  a.run(`const day = jstDay(Date.now()); state.history.captures = [{ aggregateDate: day, capturedAt: day + 'T18:00:00+09:00', genres: {1: {a: 2}} }]; bindEvents(); render();`);
  await a.run('openDetail(state.rows[0])');
  assert.equal(a.element('#productDialog').open, true);
  assert.equal(a.element('#detailTitle').textContent, '<script>bad</script>');
  assert.match(a.element('#detailBody').innerHTML, /未記録/);
  assert.match(a.element('#detailBody').innerHTML, /集計日/);
  assert.doesNotMatch(a.element('#detailBody').innerHTML, /NaN/);
  a.element('#closeDetail').handlers.click();
  assert.equal(a.element('#productDialog').open, false);
});

test('selected daily date shows coupon amount and observed date range', async () => {
  const a = app();
  a.run(`state.dailyLatest = {generatedAt:'2026-09-02T15:10:00+09:00',aggregateDate:'2026-09-02',categories:state.latest.categories,
    rankings:{1:[{itemCode:'a',itemName:'20%OFFクーポン対象',rank:1,itemPrice:1000,pointRate:1,promotionHints:['20%OFFクーポン']}]}}; 
    state.history.captures=[
      {capturedAt:'2026-09-01T15:10:00+09:00',aggregateDate:'2026-09-01',genres:{1:{a:2}},metrics:{1:{a:{itemPrice:1200,pointRate:1,promotionHints:['20%OFFクーポン']}}}},
      {capturedAt:'2026-09-02T15:10:00+09:00',aggregateDate:'2026-09-02',genres:{1:{a:1}},metrics:{1:{a:{itemPrice:1000,pointRate:1,promotionHints:['20%OFFクーポン']}}}}
    ]; refreshView()`);
  assert.match(a.element('#rankingBody').innerHTML, /20%OFFクーポン/);
  assert.match(a.element('#rankingBody').innerHTML, /検出期間 2026-09-01～2026-09-02/);
  await a.run('openDetail(state.rows[0])');
  assert.match(a.element('#detailBody').innerHTML, /クーポン検出履歴/);
  assert.match(a.element('#detailBody').innerHTML, /2026-09-01～2026-09-02に連続検出/);
});

test('zero-rank history and gaps produce no invalid SVG coordinates', () => {
  const a = app();
  assert.match(a.run('sparkline([])'), /履歴蓄積中/);
  const chart = a.run(`sparkline([{at:'2026-08-30T00:00:00+09:00',day:'2026-08-30',rank:2,dateBasis:'aggregate'},{at:'2026-08-31T00:00:00+09:00',day:'2026-08-31',rank:null,dateBasis:'aggregate'},{at:'2026-09-01T00:00:00+09:00',day:'2026-09-01',rank:1,dateBasis:'aggregate'}])`);
  assert.doesNotMatch(chart, /NaN/);
  assert.doesNotMatch(chart.match(/<path d="([^"]*)"/)[1], /L/);
});

test('daily detail never requests or renders realtime event logs', async () => {
  const a = app();
  let requests = 0;
  a.context.fetch = async () => { requests++; throw Error('daily detail must not fetch'); };
  a.run(`state.realtimeLatest = { generatedAt: new Date().toISOString(), rankings: {} }; render();`);
  await a.run('openDetail(state.rows[0])');
  assert.equal(requests, 0);
  assert.match(a.element('#detailBody').innerHTML, /前回日榜比/);
  assert.doesNotMatch(a.element('#detailBody').innerHTML, /realtimeDetail|リアルタイム変化ログ/);
});

test('realtime detail displays interval events without any daily chart or table', async () => {
  const a = app();
  const urls = [];
  a.context.fetch = async url => {
    urls.push(url);
    return { ok: true, json: async () => ({ events: [{ capturedAt: '2026-09-01T15:05:00+09:00', changes: { 1: { moved: [{ itemCode: 'a', previousRank: 2, rank: 1 }] } } }] }) };
  };
  a.run(`state.mode = 'realtime'; state.realtimeLatest = { generatedAt: '2026-09-01T16:05:00+09:00', rankings: state.latest.rankings }; render();`);
  await a.run('openDetail(state.rows[0])');
  assert.deepEqual(urls, ['data/realtime/2026-09-01.json']);
  assert.doesNotMatch(a.element('#detailBody').innerHTML, /metric-chart|history-grid|前回日榜比/);
  assert.match(a.element('#realtimeDetail').innerHTML, /順位：2 → 1位/);
});

test('pending realtime request cannot leak into a subsequently opened daily detail', async () => {
  const a = app();
  let finish;
  a.context.fetch = () => new Promise(resolve => { finish = resolve; });
  a.run(`bindEvents(); state.mode = 'realtime'; state.realtimeLatest = { generatedAt: '2026-09-01T16:05:00+09:00', rankings: {} }; render();`);
  const pending = a.run('openDetail(state.rows[0])');
  a.element('#productDialog').close();
  a.run(`state.mode = 'daily';`);
  await a.run('openDetail(state.rows[0])');
  finish({ ok: true, json: async () => ({ events: [] }) });
  await pending;
  assert.equal(a.element('#realtimeDetail').innerHTML, '');
  assert.match(a.element('#detailBody').innerHTML, /前回日榜比/);
});

function historicalApp() {
  const a = app();
  a.run(`state.dailyLatest = { generatedAt: '2026-09-01T18:00:00+09:00', aggregateDate: '2026-09-01', categories: state.latest.categories,
    rankings: {1: [{itemCode:'shop:a', itemName:'Current name', rank:1, itemPrice:900, pointRate:5}]}};
    state.history.captures = [
      {capturedAt:'2026-08-30T18:00:00+09:00', aggregateDate:'2026-08-30', genres:{1:{'shop:a':8,'shop:b':9}}, metrics:{1:{'shop:a':{itemPrice:1200,pointRate:1}}}},
      {capturedAt:'2026-08-31T18:00:00+09:00', aggregateDate:'2026-08-31', genres:{1:{'shop:a':3,'shop:c':101}}, metrics:{1:{'shop:a':{itemPrice:1000,pointRate:2}}}, productsFile:'history-products/2026-08-31.json'}
    ];`);
  return a;
}

test('empty genre with same-day positive probe is labeled missing, not a search problem', async () => {
  const a = historicalApp();
  a.run(`const day = jstDay(Date.now()); state.dailyLatest.aggregateDate=day;
    state.dailyLatest.generatedAt=new Date().toISOString(); state.dailyLatest.rankings={1:[]};
    state.updateLog={days:[{observations:[{capturedAt:new Date().toISOString(),aggregateDate:day,ranks:{1:{'shop:a':1}}}]}]};`);
  await a.run('refreshView()');
  assert.match(a.element('#healthTitle').textContent, /数据缺失/);
  assert.match(a.element('#emptyState').textContent, /采集异常/);
  assert.equal(a.element('#dataHealth').dataset.level, 'bad');
});

test('failed automatic daily fetch warns about retry, but published data clears the warning', () => {
  const a = app();
  a.run(`const now = new Date().toISOString(); const today = jstDay(Date.now());
    state.dailyLatest = {aggregateDate:jstDay(Date.now()-86400000)};
    state.updateLog = {days:[{date:today,observations:[{capturedAt:now,aggregateDate:today,
      autoDailyFetch:{aggregateDate:today,status:'failed',finishedAt:now}}]}]}; renderHealth();`);
  assert.match(a.element('#healthTitle').textContent, /自动完整采集失败/);
  assert.equal(a.element('#dataHealth').dataset.level, 'bad');
  a.run('state.dailyLatest.aggregateDate = jstDay(Date.now()); renderHealth()');
  assert.match(a.element('#healthTitle').textContent, /今日已更新/);
  assert.equal(a.element('#dataHealth').dataset.level, 'good');
});

test('historical date lazily loads its own metadata and compares only prior daily data', async () => {
  const a = historicalApp();
  const urls = [];
  a.context.fetch = async url => { urls.push(url); return {ok:true, json:async()=>({products:{'shop:a':{itemName:'Old name'}}})}; };
  await a.run('refreshView()');
  assert.deepEqual(urls, []);
  assert.equal(a.run('state.rows[0].change'), 2);
  await a.run("state.selectedDay='2026-08-31'; refreshView()");
  assert.deepEqual(urls, ['data/history-products/2026-08-31.json']);
  assert.equal(a.run('state.rows[0].itemName'), 'Old name');
  assert.equal(a.run('state.rows[0].itemPrice'), 1000);
  assert.equal(a.run('state.rows[0].change'), 5);
  assert.equal(a.run('state.rows[0].comparisonDate'), '2026-08-30');
  assert.equal(a.element('#keywordPanel').hidden, true);
  a.run("state.rankScope='all'; render()");
  assert.equal(a.run('state.rows.length'), 3);
  a.run("state.promotionFilter='promo-rise'; render()");
  assert.equal(a.run('state.rows.length'), 1);
  assert.equal(a.run('state.rows[0].priceChange'), -200);
  a.run("state.promotionFilter='all'; state.movement='exited'; render()");
  assert.equal(a.run('state.rows[0].itemCode'), 'shop:b');
  assert.equal(a.run('state.rows[0].rank'), null);
});

test('switching to realtime cancels pending historical view and resets exit-only filter', async () => {
  const a = historicalApp();
  let finish;
  a.context.fetch = () => new Promise(resolve => {finish=resolve;});
  const pending = a.run("state.selectedDay='2026-08-31'; refreshView()");
  a.run("state.realtimeLatest = {generatedAt:'2026-09-01T18:05:00+09:00',categories:state.dailyLatest.categories,rankings:{1:[]}}; state.movement='exited'");
  await a.run("selectMode('realtime')");
  finish({ok:true,json:async()=>({products:{}})});
  await pending;
  assert.equal(a.run('state.mode'), 'realtime');
  assert.equal(a.run('state.viewSnapshot'), null);
  assert.equal(a.run('state.viewLoading'), false);
  assert.equal(a.run('state.movement'), 'all');
});

test('failed historical metadata never substitutes current prices or reviews', async () => {
  const a = historicalApp();
  a.context.fetch = async () => ({ok:false});
  await a.run("state.selectedDay='2026-08-31'; delete state.history.captures[1].metrics; refreshView()");
  assert.equal(a.run('state.rows[0].itemPrice'), null);
  assert.equal(a.run('state.rows[0].reviewAverage'), null);
  assert.equal(a.run('state.rows[0].metadataBasis'), 'reference');
  assert.match(a.element('#historyNote').textContent, /取得できません/);
});

test('favorite import merges codes, keeps per-genre rows, and preserves state on failures', async () => {
  const a = app();
  a.run("state.watchlist = new Set(['shop:a']); state.latest.rankings = {1:[{itemCode:'shop:a',rank:1}],2:[{itemCode:'shop:a',rank:3}]}; state.latest.categories.push({id:2,group:'bra',name:'Other'}); state.watchedOnly=true");
  a.context.file = {size:30,text:async()=> '["shop:a","shop:b"]'};
  await a.run('importFavorites(file)');
  assert.deepEqual(JSON.parse(a.storage.value), ['shop:a','shop:b']);
  assert.equal(a.run('state.rows.length'), 2);
  a.storage.setItem = () => {throw Error('quota');};
  a.context.file = {size:12,text:async()=> '["shop:c"]'};
  await a.run('importFavorites(file)');
  assert.equal(a.run('state.watchlist.has("shop:c")'), false);
  assert.match(a.element('#watchTransferStatus').textContent, /変更していません/);
  a.context.file = {size:524289,text:async()=> {throw Error('must not read');}};
  await a.run('importFavorites(file)');
  assert.match(a.element('#watchTransferStatus').textContent, /512KB/);
});

test('history partial failures do not discard healthy dates or request external paths', async () => {
  const a = app();
  const urls = [];
  a.context.fetch = async url => { urls.push(url); return {ok:true,json:async()=>({capturedAt:'2026-08-31T18:00:00+09:00',genres:{}})}; };
  const history = await a.run("loadHistory({captures:[{file:'history/2026-08-31.json'},{file:'https://example.com/data'}]})");
  assert.equal(history.captures.length, 1);
  assert.equal(history.failures.length, 1);
  assert.deepEqual(urls, ['data/history/2026-08-31.json']);
  assert.equal(a.run("safeUrl('javascript:alert(1)')"), '');
  assert.equal(a.run("csvCell('=1+1')"), '"\'=1+1"');
});
