import test from 'node:test';
import assert from 'node:assert/strict';
import { dailySeries, filterAndSort, readWatchlist, rolloverWindow, validDay, jstDay } from '../assets/insights.mjs';

test('daily dates use aggregate dates, deduplicate same day and preserve missing prices', () => {
  const captures = [
    { aggregateDate: '2026-08-30', capturedAt: '2026-08-31T01:00:00+09:00', genres: { 1: { a: 5 } } },
    { aggregateDate: '2026-08-30', capturedAt: '2026-08-31T02:00:00+09:00', genres: { 1: { a: 6 } } },
    { aggregateDate: '2026-08-31', capturedAt: '2026-08-31T18:00:00+09:00', genres: { 1: { a: 2 } }, metrics: { 1: { a: { itemPrice: 1000, pointRate: 5 } } } }
  ];
  const series = dailySeries(captures, 1, 'a', 7, Date.parse('2026-09-01T01:00:00+09:00'));
  assert.deepEqual(series.map(p => p.day), ['2026-08-30', '2026-08-31']);
  assert.equal(series[0].rank, 6);
  assert.equal(series[0].itemPrice, null);
  assert.equal(series[1].pointRate, 5);
});

test('legacy history is explicitly labeled as capture date and missing ranks stay null', () => {
  const series = dailySeries([{ capturedAt: '2026-08-31T16:00:00Z', genres: {} }], 1, 'a', 1, Date.parse('2026-09-01T02:00:00+09:00'));
  assert.equal(series[0].day, '2026-09-01');
  assert.equal(series[0].dateBasis, 'capture');
  assert.equal(series[0].rank, null);
});

test('date validation and JST cutoff reject invalid and future dates', () => {
  assert.equal(validDay('2026-13-02'), null);
  assert.equal(validDay('2026-02-30'), null);
  assert.equal(jstDay('bad'), null);
  assert.deepEqual(dailySeries([], 1, 'a', 30), []);
});

test('movement filters sort magnitudes and never include new entries in rises', () => {
  const rows = [{ itemCode: 'a', rank: 5, change: 2 }, { itemCode: 'b', rank: 1, change: 10 }, { itemCode: 'c', rank: 2, change: -12 }, { itemCode: 'd', rank: 3, isNew: true, change: 99 }];
  assert.deepEqual(filterAndSort(rows, 'up', false, new Set()).map(r => r.itemCode), ['b', 'a']);
  assert.deepEqual(filterAndSort(rows, 'down', false, new Set()).map(r => r.itemCode), ['c']);
  assert.deepEqual(filterAndSort(rows, 'new', false, new Set()).map(r => r.itemCode), ['d']);
  assert.deepEqual(filterAndSort(rows, 'all', true, new Set(['a'])).map(r => r.itemCode), ['a']);
  assert.equal(rows[0].itemCode, 'a');
});

test('watchlist tolerates invalid data and denied storage', () => {
  assert.deepEqual([...readWatchlist({ getItem: () => '["a",42]' })], ['a']);
  assert.equal(readWatchlist({ getItem: () => '{broken' }).size, 0);
  assert.equal(readWatchlist({ getItem: () => { throw Error('denied'); } }).size, 0);
});

test('rollover ignores legacy false positives and bounds only before first new day', () => {
  const result = rolloverWindow({ date: '2026-08-31', firstUpdateDetectedAt: '2026-08-31T09:50:00+09:00', observations: [
    { capturedAt: '2026-08-31T18:00:00+09:00', aggregateDate: '2026-08-31' },
    { capturedAt: '2026-08-31T17:00:00+09:00', aggregateDate: '2026-08-30' },
    { capturedAt: '2026-08-31T19:00:00+09:00', aggregateDate: '2026-08-30' }
  ] });
  assert.equal(result.old.capturedAt, '2026-08-31T17:00:00+09:00');
  assert.equal(result.first.capturedAt, '2026-08-31T18:00:00+09:00');
  assert.equal(rolloverWindow({ date: '2026-08-31', observations: [{ capturedAt: '2026-08-31T10:00:00+09:00', aggregateDate: null }] }).first, undefined);
});

test('first observation already new leaves lower bound unknown', () => {
  const result = rolloverWindow({ date: '2026-08-31', observations: [{ capturedAt: '2026-08-31T18:00:00+09:00', aggregateDate: '2026-08-31' }] });
  assert.ok(result.first);
  assert.equal(result.old, undefined);
});

test('daily changes compare unique aggregate dates, including baseline outside display period', () => {
  const capture = (day, rank, hour = '18') => ({ aggregateDate: day, capturedAt: `${day}T${hour}:00:00+09:00`, genres: { 1: { a: rank } } });
  const captures = [capture('2026-08-30', 10), capture('2026-08-31', 4, '18'), capture('2026-08-31', 3, '20'), capture('2026-09-01', 3)];
  const series = dailySeries(captures, 1, 'a', 2, Date.parse('2026-09-01T21:00:00+09:00'));
  assert.equal(series.length, 2);
  assert.equal(series[0].change, 7);
  assert.equal(series[0].comparisonDay, '2026-08-30');
  assert.equal(series[1].change, 0);
  assert.equal(series[1].comparisonDay, '2026-08-31');
});

test('missing or unknown aggregate-day baselines never create fabricated daily movements', () => {
  const captures = [
    { capturedAt: '2026-08-29T18:00:00+09:00', genres: { 1: { a: 100 } } },
    { aggregateDate: '2026-08-30', capturedAt: '2026-08-30T18:00:00+09:00', genres: { 1: { a: 10 } } },
    { aggregateDate: '2026-08-31', capturedAt: '2026-08-31T18:00:00+09:00', genres: { 1: {} } },
    { aggregateDate: '2026-09-01', capturedAt: '2026-09-01T18:00:00+09:00', genres: { 1: { a: 5 } } }
  ];
  const series = dailySeries(captures, 1, 'a', 7, Date.parse('2026-09-01T21:00:00+09:00'));
  assert.equal(series[1].change, null);
  assert.equal(series[1].comparisonDay, null);
  assert.equal(series[3].change, null);
  assert.equal(series[3].comparisonDay, '2026-08-31');
});
