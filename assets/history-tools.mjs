import { jstDay, validDay } from './insights.mjs';

const numeric = value => Number.isFinite(value) ? value : null;
export function snapshotFromLatest(latest) {
  if (!latest?.generatedAt) return null;
  const products = {}, genres = {}, metrics = {};
  for (const [genre, rows] of Object.entries(latest.rankings || {})) {
    genres[genre] = {}; metrics[genre] = {};
    for (const row of rows) {
      genres[genre][row.itemCode] = row.rank;
      products[row.itemCode] = row;
      metrics[genre][row.itemCode] = { itemPrice: row.itemPrice, pointRate: row.pointRate, promotionHints: row.promotionHints };
    }
  }
  return { capturedAt: latest.generatedAt, aggregateDate: latest.aggregateDate, sourceBuildAt: latest.sourceBuildAt, genres, products, metrics };
}

export function archiveSnapshots(captures, latest) {
  const byKey = new Map();
  const all = [...(captures || []), snapshotFromLatest(latest)].filter(Boolean)
    .sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt));
  for (const capture of all) {
    const day = validDay(capture.aggregateDate) || jstDay(capture.capturedAt);
    if (!day) continue;
    const basis = validDay(capture.aggregateDate) ? 'aggregate' : 'capture';
    const key = basis === 'aggregate' ? day : `capture:${day}`;
    byKey.set(key, { ...capture, key, day, basis });
  }
  return [...byKey.values()].sort((a, b) => a.day.localeCompare(b.day));
}

export function referenceProducts(...latestSets) {
  const result = {};
  for (const latest of latestSets) for (const rows of Object.values(latest?.rankings || {})) {
    for (const row of rows) result[row.itemCode] = row;
  }
  return result;
}

export function previousSnapshot(archive, target, chosenKey = '') {
  if (target?.basis !== 'aggregate') return null;
  const options = archive.filter(s => s.basis === 'aggregate' && s.day < target.day);
  return chosenKey ? options.find(s => s.key === chosenKey) || null : options.at(-1) || null;
}

export function snapshotRows(target, previous, categories, reference = {}, includeMissing = false) {
  if (!target) return [];
  const allowed = previous && target.basis === 'aggregate' && previous.basis === 'aggregate' && previous.day < target.day;
  return categories.flatMap(category => {
    const genre = String(category.id);
    const now = target.genres?.[genre] || {};
    const before = allowed ? previous.genres?.[genre] || {} : {};
    const comparable = allowed && Object.keys(now).length > 0 && Object.keys(before).length > 0;
    const codes = new Set([...Object.keys(now), ...(includeMissing ? Object.keys(before) : [])]);
    return [...codes].map(code => {
      const rank = numeric(now[code]), previousRank = numeric(before[code]);
      const own = target.products?.[code];
      const fallback = reference[code] || previous?.products?.[code] || {};
      const info = own || fallback;
      const metric = target.metrics?.[genre]?.[code] || {};
      const oldMetric = allowed ? previous.metrics?.[genre]?.[code] || {} : {};
      const itemPrice = rank === null ? null : numeric(metric.itemPrice);
      const pointRate = rank === null ? null : numeric(metric.pointRate);
      const previousPrice = numeric(oldMetric.itemPrice), previousPointRate = numeric(oldMetric.pointRate);
      const status = !comparable ? 'unavailable' : rank === null ? 'exited' : previousRank === null ? 'entered' : 'matched';
      return {
        itemCode: code, category, rank, previousRank, comparisonState: status,
        change: status === 'matched' ? previousRank - rank : null,
        isNew: status === 'entered', comparisonDate: allowed ? previous.day : null,
        targetDate: target.day, targetDateBasis: target.basis,
        itemName: info.itemName || `商品名未記録 (${code})`, itemUrl: info.itemUrl || '', imageUrl: info.imageUrl || '',
        shopName: info.shopName || code.split(':')[0], shopUrl: info.shopUrl || '',
        metadataBasis: own ? 'snapshot' : info.itemName ? 'reference' : 'missing',
        catchcopy: own?.catchcopy || '',
        reviewAverage: own ? numeric(own.reviewAverage) : null,
        reviewCount: own ? numeric(own.reviewCount) : null,
        itemPrice, pointRate, previousPrice, previousPointRate,
        priceChange: comparable && rank !== null && previousRank !== null && itemPrice !== null && previousPrice !== null ? itemPrice - previousPrice : null,
        pointChange: comparable && rank !== null && previousRank !== null && pointRate !== null && previousPointRate !== null ? pointRate - previousPointRate : null,
        promotionHints: rank !== null && Array.isArray(metric.promotionHints) ? metric.promotionHints : [],
        couponMentioned: own?.couponMentioned ?? null
      };
    }).sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || (a.previousRank ?? Infinity) - (b.previousRank ?? Infinity));
  });
}

export function promotionMatches(row, filter) {
  const down = Number.isFinite(row.priceChange) && row.priceChange < 0;
  const up = Number.isFinite(row.pointChange) && row.pointChange > 0;
  if (filter === 'price-down') return down;
  if (filter === 'points-up') return up;
  if (filter === 'promo-rise') return Number.isFinite(row.change) && row.change > 0 && (down || up);
  return true;
}

export function dataHealth(daily, realtime, log, now = Date.now()) {
  const today = jstDay(now);
  const observations = (log?.days || []).flatMap(d => d.observations || [])
    .filter(o => Number.isFinite(Date.parse(o.capturedAt)) && Date.parse(o.capturedAt) <= now + 300000)
    .sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt));
  const last = observations.at(-1);
  const seen = observations.find(o => jstDay(o.capturedAt) === today && o.aggregateDate === today);
  const attempt = observations.filter(o => o.autoDailyFetch?.aggregateDate === today).at(-1)?.autoDailyFetch;
  const age = last ? now - Date.parse(last.capturedAt) : Infinity;
  const day = validDay(daily?.aggregateDate);
  let dailyState = 'unknown';
  if (day === today) dailyState = 'published';
  else if (seen) dailyState = 'pending';
  else if (last && jstDay(last.capturedAt) === today && age <= 2 * 3600000 && validDay(last.aggregateDate) && last.aggregateDate < today) dailyState = 'not-detected';
  const rtTime = Date.parse(realtime?.generatedAt);
  const realtimeState = !Number.isFinite(rtTime) ? 'unknown' : rtTime > now + 300000 ? 'clock' : now - rtTime > 45 * 60000 ? 'stale' : 'fresh';
  return { today, dailyState, publishedDay: day, lastObservation: last?.capturedAt || null, observedDay: last?.aggregateDate || null,
    firstSeen: seen?.capturedAt || null, observationStale: age > 2 * 3600000,
    autoFetchState: attempt?.status || null, autoFetchAt: attempt?.finishedAt || attempt?.startedAt || null,
    dailyStale: !!day && day < jstDay(now - 86400000), realtimeState, realtimeAt: realtime?.generatedAt || null };
}

export const WATCH_FORMAT = 'rakuten-ranking-watchlist';
export function parseWatchImport(text) {
  if (typeof text !== 'string' || text.length > 524288) throw new Error('ファイルは512KB以下のJSONにしてください。');
  let value;
  try { value = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { throw new Error('JSON形式を読み取れません。'); }
  const items = Array.isArray(value) ? value : value?.format === WATCH_FORMAT && value.version === 1 ? value.items : null;
  if (!Array.isArray(items) || items.length > 10000) throw new Error('対応するお気に入り形式ではありません（最大10,000件）。');
  if (items.some(code => typeof code !== 'string' || code.length > 200 || !/^[a-zA-Z0-9_.-]+:[a-zA-Z0-9_.-]+$/.test(code))) {
    throw new Error('不正な商品コードが含まれています。変更は行いません。');
  }
  return new Set(items);
}

export function exportWatchlist(watchlist, now = new Date()) {
  return JSON.stringify({ format: WATCH_FORMAT, version: 1, exportedAt: now.toISOString(), items: [...watchlist].sort() }, null, 2);
}
