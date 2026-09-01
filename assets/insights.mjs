export const WATCH_KEY = "rakuten-ranking-watchlist-v1";

export function jstDay(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(date);
}

export function validDay(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : null;
}

export function dailySeries(captures, genre, code, days, now = Date.now()) {
  const today = jstDay(now);
  const cutoff = jstDay(now - (days - 1) * 86400000);
  const byDay = new Map();
  [...captures].sort((a, b) => String(a.capturedAt).localeCompare(String(b.capturedAt))).forEach(capture => {
    const aggregate = validDay(capture.aggregateDate);
    const day = aggregate || jstDay(capture.capturedAt);
    if (!day || day < cutoff || day > today) return;
    const metrics = capture.metrics?.[String(genre)]?.[code] || {};
    const rank = capture.genres?.[String(genre)]?.[code];
    byDay.set(day, { at: `${day}T00:00:00+09:00`, day, capturedAt: capture.capturedAt,
      dateBasis: aggregate ? "aggregate" : "capture", rank: Number.isFinite(rank) ? rank : null,
      itemPrice: metrics.itemPrice ?? null, pointRate: metrics.pointRate ?? null,
      promotionHints: metrics.promotionHints ?? null });
  });
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}

export function filterAndSort(rows, filter, watchedOnly, watchlist) {
  const selected = rows.filter(row => (!watchedOnly || watchlist.has(row.itemCode)) &&
    (filter === "all" || (filter === "new" ? row.isNew :
      !row.isNew && Number.isFinite(row.change) && (filter === "up" ? row.change > 0 : row.change < 0))));
  if (filter === "up") selected.sort((a, b) => b.change - a.change || a.rank - b.rank);
  if (filter === "down") selected.sort((a, b) => a.change - b.change || a.rank - b.rank);
  return selected;
}

export function readWatchlist(storage) {
  try {
    const value = JSON.parse(storage.getItem(WATCH_KEY) || "[]");
    return new Set(Array.isArray(value) ? value.filter(code => typeof code === "string") : []);
  } catch { return new Set(); }
}

export function rolloverWindow(day) {
  // Never trust legacy firstUpdateDetectedAt values caused by rank-only changes.
  const observations = (day.observations || []).filter(o => Number.isFinite(Date.parse(o.capturedAt)))
    .sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt));
  const first = observations.find(o => validDay(o.aggregateDate) === day.date);
  const old = observations.filter(o => validDay(o.aggregateDate) && o.aggregateDate < day.date &&
    (!first || Date.parse(o.capturedAt) < Date.parse(first.capturedAt))).at(-1);
  return { first, old, observations, last: observations.at(-1) };
}
