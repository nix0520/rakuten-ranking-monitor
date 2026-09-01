import test from 'node:test';
import assert from 'node:assert/strict';
import { archiveSnapshots, previousSnapshot, snapshotRows, promotionMatches, dataHealth, parseWatchImport, exportWatchlist } from '../assets/history-tools.mjs';

const categories = [{ id: 1, name: 'Bra' }, { id: 2, name: 'Parent' }];
const snap = (day, genres, extra = {}) => ({ day, key: day, basis: 'aggregate', aggregateDate: day, capturedAt: `${day}T20:30:00+09:00`, genres, ...extra });

test('auto-fetch outcomes remain visible until the new daily snapshot is published', () => {
  const now = Date.parse('2026-09-01T16:00:00+09:00');
  const failed = { capturedAt: '2026-09-01T15:00:00+09:00', aggregateDate: '2026-09-01',
    autoDailyFetch: {aggregateDate:'2026-09-01',status:'failed',finishedAt:'2026-09-01T15:10:00+09:00'} };
  const log = {days:[{observations:[failed]}]};
  let health = dataHealth({aggregateDate:'2026-08-31'}, null, log, now);
  assert.equal(health.dailyState, 'pending');
  assert.equal(health.autoFetchState, 'failed');
  log.days[0].observations.push({...failed,capturedAt:'2026-09-01T15:30:00+09:00',autoDailyFetch:{aggregateDate:'2026-09-01',status:'succeeded'}});
  health = dataHealth({aggregateDate:'2026-09-01'}, null, log, now);
  assert.equal(health.dailyState, 'published');
  assert.equal(health.autoFetchState, 'succeeded');
});

test('archive indexes by aggregate date, labels legacy capture dates and latest supersedes same-day file', () => {
  const archive = archiveSnapshots([snap('2026-08-30', { 1: { a: 4 } }), { capturedAt: '2026-08-29T16:00:00Z', genres: {} }], {
    aggregateDate: '2026-08-30', generatedAt: '2026-08-31T01:00:00+09:00', rankings: { 1: [{ itemCode: 'a', rank: 2, itemPrice: 1200 }] }
  });
  assert.equal(archive.length, 2);
  assert.equal(archive.find(s => s.key === '2026-08-30').genres[1].a, 2);
  assert.equal(archive.find(s => s.key === 'capture:2026-08-30').basis, 'capture');
});

test('baseline must be strictly earlier and have a known aggregate date', () => {
  const a = [snap('2026-08-28', {}), snap('2026-08-29', {}), snap('2026-08-30', {})];
  assert.equal(previousSnapshot(a, a[2]).day, '2026-08-29');
  assert.equal(previousSnapshot(a, a[2], '2026-08-28').day, '2026-08-28');
  assert.equal(previousSnapshot(a, a[2], '2026-08-30'), null);
  assert.equal(previousSnapshot(a, { ...a[2], basis: 'capture' }), null);
});

test('history keeps original ranks and metrics; current identity references never become historical prices', () => {
  const target = snap('2026-08-30', { 1: { 'shop:a': 4 } });
  const rows = snapshotRows(target, null, categories, { 'shop:a': { itemName: 'current name', itemPrice: 99, pointRate: 10, reviewCount: 999 } });
  assert.equal(rows[0].rank, 4);
  assert.equal(rows[0].itemPrice, null);
  assert.equal(rows[0].pointRate, null);
  assert.equal(rows[0].reviewCount, null);
  assert.equal(rows[0].metadataBasis, 'reference');
  assert.equal(rows[0].itemName, 'current name');
  assert.equal(rows[0].change, null);
});

test('two dates produce matched, entered and exited rows without merging genres', () => {
  const before = snap('2026-08-29', { 1: { a: 10, gone: 2 }, 2: { a: 5 } });
  const target = snap('2026-08-30', { 1: { a: 4, fresh: 3 }, 2: { a: 1 } });
  const rows = snapshotRows(target, before, categories, {}, true);
  assert.equal(rows.filter(r => r.itemCode === 'a').length, 2);
  assert.equal(rows.find(r => r.itemCode === 'a' && r.category.id === 1).change, 6);
  assert.equal(rows.find(r => r.itemCode === 'fresh').comparisonState, 'entered');
  assert.equal(rows.find(r => r.itemCode === 'gone').comparisonState, 'exited');
  assert.equal(rows.find(r => r.itemCode === 'gone').rank, null);
});

test('empty or missing genre data never becomes a mass exit/entry signal', () => {
  const before = snap('2026-08-29', { 1: { a: 4 } });
  const target = snap('2026-08-30', { 1: {} });
  const rows = snapshotRows(target, before, categories, {}, true);
  assert.equal(rows[0].comparisonState, 'unavailable');
  assert.equal(rows[0].isNew, false);
  const entries = snapshotRows(before, { ...target, day: '2026-08-28' }, categories);
  assert.equal(entries[0].comparisonState, 'unavailable');
});

test('price/point filtering uses the exact selected comparison dates and excludes missing values', () => {
  const before = snap('2026-08-29', { 1: { a: 10 } }, { metrics: { 1: { a: { itemPrice: 2000, pointRate: 1 } } } });
  const target = snap('2026-08-30', { 1: { a: 4 } }, { metrics: { 1: { a: { itemPrice: 1500, pointRate: 5 } } } });
  const row = snapshotRows(target, before, categories)[0];
  assert.equal(row.priceChange, -500);
  assert.equal(row.pointChange, 4);
  for (const key of ['price-down', 'points-up', 'promo-rise']) assert.ok(promotionMatches(row, key));
  assert.equal(promotionMatches({ ...row, change: -1 }, 'promo-rise'), false);
  assert.equal(promotionMatches({}, 'price-down'), false);
});

test('health distinguishes published, detected pending, recent old and stale unknown', () => {
  const now = Date.parse('2026-09-01T18:30:00+09:00');
  const log = aggregateDate => ({ days: [{ observations: [{ capturedAt: '2026-09-01T18:00:00+09:00', aggregateDate }] }] });
  assert.equal(dataHealth({ aggregateDate: '2026-09-01' }, null, null, now).dailyState, 'published');
  assert.equal(dataHealth({ aggregateDate: '2026-08-31' }, null, log('2026-09-01'), now).dailyState, 'pending');
  assert.equal(dataHealth({ aggregateDate: '2026-08-31' }, null, log('2026-08-31'), now).dailyState, 'not-detected');
  assert.equal(dataHealth({}, null, log('2026-08-31'), now + 3 * 3600000).dailyState, 'unknown');
  assert.equal(dataHealth({}, null, null, now).dailyState, 'unknown');
});

test('realtime freshness and clock warnings use elapsed time independent of local timezone', () => {
  const now = Date.parse('2026-09-01T09:30:00Z');
  assert.equal(dataHealth({}, { generatedAt: '2026-09-01T18:05:00+09:00' }, {}, now).realtimeState, 'fresh');
  assert.equal(dataHealth({}, { generatedAt: '2026-09-01T17:25:00+09:00' }, {}, now).realtimeState, 'stale');
  assert.equal(dataHealth({}, { generatedAt: '2026-09-01T19:00:00+09:00' }, {}, now).realtimeState, 'clock');
});

test('watchlist JSON round-trips, deduplicates and supports legacy arrays', () => {
  const saved = new Set(['shop:b', 'shop:a']);
  assert.deepEqual([...parseWatchImport(exportWatchlist(saved))], ['shop:a', 'shop:b']);
  assert.deepEqual([...parseWatchImport('["shop:a","shop:a"]')], ['shop:a']);
});

test('malformed, oversized, unsupported and unsafe imports are rejected atomically', () => {
  for (const text of ['bad', '{}', '[null]', '["shop:a","<script>"]', 'x'.repeat(524289), '{"format":"rakuten-ranking-watchlist","version":2,"items":[]}']) {
    assert.throws(() => parseWatchImport(text));
  }
});
