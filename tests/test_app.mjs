import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as insights from '../assets/insights.mjs';

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
  const context = vm.createContext({ ...insights, document: { querySelector: element, querySelectorAll: () => [] },
    window: { localStorage: storage }, localStorage: storage, Intl, Date, console,
    fetch: async () => ({ ok: true, json: async () => ({ events: [] }) }) });
  const source = readFileSync(new URL('../assets/app.js', import.meta.url), 'utf8')
    .replace(/^import .*?;\n/, '').replace(/\ninit\(\);\s*$/, '');
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
