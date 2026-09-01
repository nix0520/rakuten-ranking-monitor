import { WATCH_KEY, jstDay, dailySeries, filterAndSort, readWatchlist, rolloverWindow } from "./insights.mjs";

const state = { mode: "daily", dailyLatest: null, realtimeLatest: null, latest: null, history: null, updateLog: null, group: "bra", category: "all", query: "", days: 7, rows: [], movement: "all", watchedOnly: false, watchlist: new Set() };
try { state.watchlist = readWatchlist(window.localStorage); } catch { /* Storage can be disabled. */ }
const $ = (selector) => document.querySelector(selector);
const yen = new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY", maximumFractionDigits: 0 });
const dateTime = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
const trendDate = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "2-digit", day: "2-digit" });

const KEYWORD_PHRASES = [
  "ノンワイヤー", "ナイトブラ", "脇高", "補正下着", "スポーツブラ", "ブラトップ",
  "シームレス", "大きいサイズ", "小胸", "谷間", "盛れる", "育乳", "授乳",
  "マタニティ", "ストラップレス", "チューブトップ", "吸水", "サニタリー",
  "tバック", "ボクサー", "ヒップアップ", "上下セット", "レース", "綿100%",
  "オーガニックコットン", "接触冷感", "吸汗速乾", "抗菌防臭", "透け防止"
];
const KEYWORD_STOP_WORDS = new Set([
  "楽天", "市場", "公式", "送料無料", "送料込", "商品", "人気", "おすすめ", "ランキング",
  "レディース", "女性", "インナー", "ランジェリー", "下着", "ブラ", "ブラジャー",
  "ショーツ", "パンツ", "新作", "定番", "セール", "クーポン", "ポイント", "対象",
  "限定", "メール便", "ネコポス", "即納", "予約", "税込", "価格", "サイズ", "カップ",
  "off", "ブラック", "ホワイト", "カラー", "トップス"
].map((word) => word.toLocaleLowerCase("ja")));

function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

function extractKeywords(value = "") {
  const normalized = String(value).normalize("NFKC").toLocaleLowerCase("ja");
  const keywords = new Set();
  KEYWORD_PHRASES.forEach((phrase) => {
    const keyword = phrase.toLocaleLowerCase("ja");
    if (normalized.includes(keyword)) keywords.add(keyword);
  });
  const tokens = normalized.match(/[a-z][a-z0-9+.-]{1,}|[ァ-ヶー]{2,}|[一-龯々]{2,8}/giu) || [];
  tokens.forEach((rawToken) => {
    // The Japanese long-vowel mark "ー" is part of the word (e.g. インナー).
    // Trim only ASCII punctuation; removing "ー" creates broken tokens such as インナ.
    const token = rawToken.replace(/^[.-]+|[.-]+$/g, "");
    if (
      token.length < 2 ||
      token.length > 14 ||
      KEYWORD_STOP_WORDS.has(token) ||
      /^\d+(?:\.\d+)?$/.test(token)
    ) return;
    keywords.add(token);
  });
  return keywords;
}

function keywordSourceItems() {
  const unique = new Map();
  selectedCategories().forEach((category) => {
    (state.latest?.rankings?.[String(category.id)] || [])
      .filter((item) => item.rank <= 100)
      .forEach((item) => {
        const key = item.itemCode || `${category.id}:${item.rank}:${item.itemName}`;
        if (!unique.has(key)) unique.set(key, item);
      });
  });
  return [...unique.values()];
}

function frequentKeywords(items, limit = 20) {
  const counts = new Map();
  items.forEach((item) => {
    const keywords = extractKeywords(`${item.itemName || ""} ${item.catchcopy || ""}`);
    keywords.forEach((keyword) => counts.set(keyword, (counts.get(keyword) || 0) + 1));
  });
  return [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], "ja"))
    .slice(0, limit)
    .map(([keyword, count]) => ({ keyword, count }));
}

function renderKeywords() {
  const items = keywordSourceItems();
  const keywords = frequentKeywords(items);
  $("#keywordScope").textContent = `上位100位 · 重複除外 ${items.length.toLocaleString("ja-JP")}商品`;
  $("#keywordCloud").innerHTML = keywords.length
    ? keywords.map(({ keyword, count }, index) => {
        const active = state.query.trim().toLocaleLowerCase("ja") === keyword;
        const level = index < 3 ? "top" : index < 8 ? "high" : "";
        return `<button class="keyword-chip ${level} ${active ? "active" : ""}" type="button" data-keyword="${escapeHtml(keyword)}" aria-pressed="${active}"><span>${escapeHtml(keyword)}</span><strong>${count}</strong></button>`;
      }).join("")
    : '<span class="keyword-empty">集計できるキーワードがまだありません。</span>';
}

function categories() {
  return (state.latest?.categories || []).filter((category) => category.group === state.group);
}

function selectedCategories() {
  return state.category === "all" ? categories() : categories().filter((category) => String(category.id) === state.category);
}

function trendPoints(genreId, itemCode) {
  return dailySeries(state.history?.captures || [], genreId, itemCode, state.days);
}

function sparkline(points) {
  const ranked = points.filter(point => Number.isFinite(point.rank));
  if (!ranked.length) return '<span class="spark-empty">履歴蓄積中</span>';
  if (points.length < 2) return `<span class="spark-empty">${trendDate.format(new Date(points[0].at))} · ${points[0].rank}位</span>`;
  const width = 150, height = 42, pad = 3;
  const min = Math.min(...ranked.map((point) => point.rank));
  const max = Math.max(...ranked.map((point) => point.rank));
  const range = Math.max(max - min, 1);
  const startTime = Date.parse(points[0].at);
  const timeRange = Math.max(Date.parse(points.at(-1).at) - startTime, 86400000);
  const coordinates = points.map((point, index) => {
    if (!Number.isFinite(point.rank)) return null;
    const x = pad + (Date.parse(point.at) - startTime) * (width - pad * 2) / timeRange;
    const y = pad + (point.rank - min) * (height - pad * 2) / range;
    return [x, y];
  });
  const path = coordinates.map((coordinate, index) => coordinate ? `${index && coordinates[index - 1] && Date.parse(points[index].at) - Date.parse(points[index - 1].at) <= 86400000 ? "L" : "M"}${coordinate[0].toFixed(1)},${coordinate[1].toFixed(1)}` : "").join(" ");
  const last = coordinates.filter(Boolean).at(-1);
  const firstDate = trendDate.format(new Date(points[0].at));
  const lastDate = trendDate.format(new Date(points.at(-1).at));
  const label = `${firstDate}から${lastDate}: 最高${min}位 / 最低${max}位`;
  const hitPoints = coordinates.map((coordinate, index) => coordinate ?
    `<circle class="spark-node" cx="${coordinate[0]}" cy="${coordinate[1]}" r="1.5"/><circle class="spark-hit" cx="${coordinate[0]}" cy="${coordinate[1]}" r="5"><title>${points[index].day} · ${points[index].dateBasis === "aggregate" ? "集計日" : "取得日（集計日不明）"} · ${points[index].rank}位</title></circle>` : ""
  ).join("");
  return `<div class="trend-chart"><svg class="sparkline" viewBox="0 0 ${width} ${height}" role="img" aria-label="${label}"><path d="${path}"></path>${hitPoints}<circle class="spark-last" cx="${last[0]}" cy="${last[1]}" r="2.7"></circle></svg><div class="trend-dates"><span>${firstDate}</span><span>${lastDate}</span></div></div>`;
}

function movement(item) {
  if (item.isNew) return '<span class="movement new">NEW</span>';
  if (item.change > 0) return `<span class="movement up">▲ ${item.change}</span>`;
  if (item.change < 0) return `<span class="movement down">▼ ${Math.abs(item.change)}</span>`;
  return '<span class="movement stay">—</span>';
}

function filteredRows() {
  const query = state.query.trim().toLocaleLowerCase("ja");
  const rows = selectedCategories().flatMap((category) =>
    (state.latest.rankings?.[String(category.id)] || []).map((item) => ({ ...item, category }))
  ).filter(({ itemName, itemCode, shopName, catchcopy, promotionHints }) =>
    !query || `${itemName} ${itemCode} ${shopName} ${catchcopy || ""} ${(promotionHints || []).join(" ")}`.toLocaleLowerCase("ja").includes(query)
  );
  return filterAndSort(rows, state.movement, state.watchedOnly, state.watchlist);
}

function visibleRows(rows) {
  return state.query.trim() || state.watchedOnly ? rows : rows.filter((row) => row.rank <= 100);
}

function rowTemplate(row) {
  const image = row.imageUrl
    ? `<img src="${escapeHtml(row.imageUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
    : '<div class="image-placeholder" aria-hidden="true"></div>';
  return `<tr>
    <td><div class="rank"><span class="rank-number">${row.rank}</span>${movement(row)}</div></td>
    <td><div class="product">${image}<div><a class="product-name" href="${escapeHtml(row.itemUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(row.itemName)}</a><div class="meta">${escapeHtml(row.itemCode)}</div><span class="genre-chip">${escapeHtml(row.category.name)}</span></div></div></td>
    <td><a class="shop-link" href="${escapeHtml(row.shopUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(row.shopName)}</a></td>
    <td class="price">${yen.format(row.itemPrice)}${row.pointRate > 1 ? `<span class="promo">ポイント${row.pointRate}倍</span>` : ""}${row.promotionHints?.length ? `<span class="promo">${escapeHtml(row.promotionHints.join(" · "))}</span>` : ""}</td>
    <td><span class="rating">★ ${Number(row.reviewAverage).toFixed(2)}</span><span class="review-count">${Number(row.reviewCount).toLocaleString("ja-JP")}件</span></td>
    <td>${state.mode === "realtime" ? '<span class="spark-empty">前回取得比を順位横に表示</span>' : sparkline(trendPoints(row.category.id, row.itemCode))}
      <div class="row-actions"><button type="button" data-watch="${escapeHtml(row.itemCode)}" aria-pressed="${state.watchlist.has(row.itemCode)}">${state.watchlist.has(row.itemCode) ? "★ 保存済み" : "☆ お気に入り"}</button><button type="button" data-detail-code="${escapeHtml(row.itemCode)}" data-detail-genre="${row.category.id}">履歴詳細</button></div>
    </td>
  </tr>`;
}

function updateCategorySelect() {
  const options = ['<option value="all">すべてのジャンル</option>', ...categories().map((category) =>
    `<option value="${category.id}">P${category.priority} · ${escapeHtml(category.name)} (${category.id})</option>`
  )];
  $("#categorySelect").innerHTML = options.join("");
  $("#categorySelect").value = state.category;
}

function render() {
  renderKeywords();
  state.rows = visibleRows(filteredRows());
  $("#rankingBody").innerHTML = state.rows.map(rowTemplate).join("");
  $("#emptyState").hidden = state.rows.length > 0;
  $("#itemCount").textContent = state.rows.length.toLocaleString("ja-JP");
  $("#newCount").textContent = state.rows.filter((row) => row.isNew).length.toLocaleString("ja-JP");
  $("#categoryCount").textContent = selectedCategories().length;
  $("#captureLabel").textContent = state.mode === "realtime" ? "更新間隔" : "データ期間";
  $("#captureCount").textContent = state.mode === "realtime" ? "20分" : `${state.history?.captures?.length || 0} 回`;
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date());
  const updateDay = (state.updateLog?.days || []).find((day) => day.date === today) || state.updateLog?.days?.at(-1);
  $("#switchLabel").textContent = state.mode === "realtime" ? "リアルタイム元データ" : "日榜首次切替";
  $("#dailySwitch").textContent = state.mode === "realtime" ? (state.latest?.sourceBuildAt ? dateTime.format(new Date(state.latest.sourceBuildAt)) : "取得待ち") : (updateDay?.firstUpdateDetectedAt ? dateTime.format(new Date(updateDay.firstUpdateDetectedAt)) : "判定待ち");
  $("#dailySwitchDetail").textContent = state.mode === "realtime" ? "楽天API period=realtime" : (updateDay?.aggregateDate ? `集計日 ${updateDay.aggregateDate}` : "09:50 / 19:50から観測");
  const selected = selectedCategories();
  $("#categoryPath").textContent = selected.length === 1 ? `${selected[0].tracking} · ${selected[0].path}` : `${state.group === "bra" ? "Bra" : "ショーツ"}グループ · ${selected.length}ジャンル`;
  $("#comparisonNote").textContent = state.mode === "daily" ? "日榜：異なる集計日の比較（同日同士は比較しません）。通常は上位100位・検索/お気に入りは保存範囲内。" : "リアルタイム：前回の成功した取得との比較（通常20分間隔）。";
  $("#watchStatus").textContent = `${state.watchlist.size}商品を保存 · 現在のジャンル・検索条件・収集範囲に一致する商品だけ表示`;
  $("#watchManager").innerHTML = [...state.watchlist].map(code => `<div>${escapeHtml(code)} <button type="button" data-remove-watch="${escapeHtml(code)}">削除</button></div>`).join("") || "保存した商品はありません。";
  $("#rolloverPanel").hidden = state.mode !== "daily";
  renderRollover();
}

function formatStamp(value) {
  return value && Number.isFinite(Date.parse(value)) ? `${dateTime.format(new Date(value))} JST` : "未記録";
}

let renderedUpdateLog;
function renderRollover() {
  if (renderedUpdateLog === state.updateLog) return;
  renderedUpdateLog = state.updateLog;
  const days = [...(state.updateLog?.days || [])].sort((a, b) => b.date.localeCompare(a.date));
  $("#rolloverRows").innerHTML = days.length ? days.map(day => {
    const { first, old, observations, last } = rolloverWindow(day);
    const result = first ? (old ? `${formatStamp(old.capturedAt)} ～ ${formatStamp(first.capturedAt)}` : `初回検出 ${formatStamp(first.capturedAt)}（直前の旧榜なし・区間不明）`) : "新日榜は未検出";
    return `<details class="observation-day"><summary>${escapeHtml(day.date)} · ${escapeHtml(result)}</summary>
      <p>最後の旧榜：${escapeHtml(formatStamp(old?.capturedAt))} ／ 最初の新榜：${escapeHtml(formatStamp(first?.capturedAt))}</p>
      <p>最終観測：${escapeHtml(formatStamp(last?.capturedAt))} ／ API集計日：${escapeHtml(last?.aggregateDate || "不明")} ／ ${observations.length}回</p>
      <ul>${observations.map(o => `<li>${escapeHtml(formatStamp(o.capturedAt))} → 集計日 ${escapeHtml(o.aggregateDate || "不明")} ${o.aggregateDate === day.date ? "［新日榜］" : ""}</li>`).join("")}</ul></details>`;
  }).join("") : "観測記録がありません。";
}

function metricChart(points, key, title, unit, rankAxis = false) {
  const valid = points.filter(p => Number.isFinite(p[key]));
  if (!valid.length) return `<section class="metric-chart"><h3>${title}</h3><p>未記録 — 次回以降の完全日榜取得から蓄積します。</p></section>`;
  const min = Math.min(...valid.map(p => p[key])), max = Math.max(...valid.map(p => p[key]));
  const range = Math.max(max - min, 1);
  const start = Date.parse(points[0].at), duration = Math.max(Date.parse(points.at(-1).at) - start, 86400000);
  const coords = points.map(p => Number.isFinite(p[key]) ? [22 + (Date.parse(p.at) - start) / duration * 596, 18 + (rankAxis ? p[key] - min : max - p[key]) / range * 78] : null);
  const path = coords.map((c, i) => c ? `${i && coords[i - 1] && Date.parse(points[i].at) - Date.parse(points[i - 1].at) <= 86400000 ? "L" : "M"}${c[0]},${c[1]}` : "").join(" ");
  return `<section class="metric-chart"><h3>${title} <small>${min}${unit} ～ ${max}${unit}</small></h3><svg viewBox="0 0 640 115" role="img" aria-label="${title}。各日の値は下の表を参照"><path d="${path}"/>${coords.map((c, i) => c ? `<circle cx="${c[0]}" cy="${c[1]}" r="4"><title>${points[i].day} · ${points[i][key]}${unit}</title></circle>` : "").join("")}</svg><div class="trend-dates"><span>${points[0].day}</span><span>${points.at(-1).day}</span></div></section>`;
}

let detailRequest = 0;
function dailyChangeLabel(point) {
  const value = Number.isFinite(point.change)
    ? point.change > 0 ? `▲ ${point.change}位` : point.change < 0 ? `▼ ${Math.abs(point.change)}位` : "0位（変動なし）"
    : "比較不可";
  return `${value}<small>${point.comparisonDay ? `${point.comparisonDay} 比` : "前の集計日データなし"}</small>`;
}

async function openDetail(row) {
  const request = ++detailRequest;
  $("#detailTitle").textContent = row.itemName;
  if (state.mode === "daily") {
    const points = trendPoints(row.category.id, row.itemCode);
    $("#detailBody").innerHTML = `<h3>日榜履歴 · 前回の集計日との比較</h3><p>${escapeHtml(row.category.name)} · ${escapeHtml(row.itemCode)} · 過去${state.days}日</p>
    <p>日榜は楽天集計日で表示。集計日がない旧記録のみ取得日と明記します。欠測は線を切り、価格・ポイントの未記録分は補完しません。</p>
    <p>各集計日につき1件。順位変動は直前の保存済み集計日との比較で、比較日を表に明記します。同日内の取得やリアルタイム順位とは比較しません。</p>
    ${metricChart(points, "rank", "日榜順位", "位", true)}
    ${metricChart(points, "itemPrice", "日榜取得時の商品価格", "円")}
    ${metricChart(points, "pointRate", "日榜取得時の商品ポイント", "倍")}
    <div class="history-scroll"><table class="history-grid"><thead><tr><th>日付 / 基準</th><th>順位</th><th>前回日榜比</th><th>価格</th><th>ポイント</th><th>販促の手掛かり</th></tr></thead><tbody>${points.map(p => `<tr><td>${p.day}<small>${p.dateBasis === "aggregate" ? "集計日" : "取得日・集計日不明"}</small></td><td>${p.rank ?? "圏外 / 未取得"}</td><td>${dailyChangeLabel(p)}</td><td>${p.itemPrice === null ? "未記録" : yen.format(p.itemPrice)}</td><td>${p.pointRate === null ? "未記録" : `${p.pointRate}倍`}</td><td>${p.promotionHints === null ? "未記録" : escapeHtml(p.promotionHints.join(" · ") || "文言なし")}</td></tr>`).join("")}</tbody></table></div>
    <p>価格はAPIの商品価格です。券適用後の支払額や店舗共通ポイントを網羅しません。順位と販促の同時変化は因果関係を証明するものではありません。</p>`;
    $("#productDialog").showModal();
    return;
  }
  $("#detailBody").innerHTML = `<h3>リアルタイム榜履歴 · 前回取得との比較</h3><p>${escapeHtml(row.category.name)} · ${escapeHtml(row.itemCode)}</p>
    <p>リアルタイム榜は前回の成功した取得との比較（通常20分間隔）です。日榜の前日比ではありません。</p>
    <h3>最新取得日のリアルタイム変化ログ（JST）</h3><div id="realtimeDetail">読み込み中…</div>`;
  $("#productDialog").showModal();
  const rt = state.realtimeLatest;
  const day = rt?.generatedAt ? jstDay(rt.generatedAt) : null;
  if (!day) { $("#realtimeDetail").textContent = "リアルタイム記録がありません。"; return; }
  const current = (rt.rankings?.[String(row.category.id)] || []).find(item => item.itemCode === row.itemCode);
  const currentText = current ? `最新 ${formatStamp(rt.generatedAt)}：${current.rank}位 · ${yen.format(current.itemPrice)} · ${current.pointRate ?? "不明"}倍` : "最新の収集範囲にはありません。";
  try {
    // Load only one day on demand: realtime archives are change events, not daily snapshots.
    const response = await fetch(`data/realtime/${day}.json`, { cache: "no-store" });
    if (!response.ok) throw new Error("not available");
    const data = await response.json();
    if (request !== detailRequest || !$("#productDialog").open) return;
    const events = (data.events || []).map(event => {
      const changes = event.changes?.[String(row.category.id)] || {};
      const messages = [];
      for (const [key, label] of [["priceChanges", "価格"], ["pointChanges", "ポイント"], ["promotionChanges", "販促文言"]]) {
        const change = changes[key]?.find(item => item.itemCode === row.itemCode);
        if (change) messages.push(`${label}：${Array.isArray(change.before) ? change.before.join(" / ") || "なし" : change.before} → ${Array.isArray(change.after) ? change.after.join(" / ") || "なし" : change.after}`);
      }
      const moved = changes.moved?.find(item => item.itemCode === row.itemCode);
      if (moved) messages.unshift(`順位：${moved.previousRank} → ${moved.rank}位`);
      if (changes.entered?.some(item => item.itemCode === row.itemCode)) messages.unshift("収集範囲に登場");
      if (changes.disappeared?.some(item => item.itemCode === row.itemCode)) messages.unshift("収集範囲から消失（欠測の可能性あり）");
      return messages.length ? `<li>${escapeHtml(formatStamp(event.capturedAt))} — ${escapeHtml(messages.join(" · "))}</li>` : "";
    }).filter(Boolean);
    $("#realtimeDetail").innerHTML = `<p>${escapeHtml(currentText)}</p><p>${day}の記録済み変化のみ。変化なしの時刻や欠測は表示しません。</p>${events.length ? `<ul class="event-list">${events.reverse().join("")}</ul>` : "この商品に関する変化イベントはありません。"}`;
  } catch {
    if (request === detailRequest && $("#productDialog").open) $("#realtimeDetail").textContent = `${currentText} ／ 変化ログを取得できませんでした。閉じて再度お試しください。`;
  }
}

function renderUpdatedAt() {
  const sourceBuild = state.latest?.sourceBuildAt ? ` · 楽天元データ ${state.latest.sourceBuildAt}` : "";
  const modeLabel = state.mode === "realtime" ? "リアルタイム榜" : "日榜";
  $("#updatedAt").textContent = state.latest?.generatedAt ? `${modeLabel}更新 ${dateTime.format(new Date(state.latest.generatedAt))} JST${sourceBuild}` : `${modeLabel}の初回取得待ち`;
}

function selectMode(mode) {
  state.mode = mode;
  state.latest = mode === "realtime" ? state.realtimeLatest : state.dailyLatest;
  state.category = "all";
  document.querySelectorAll("[data-ranking-mode]").forEach((button) => button.classList.toggle("active", button.dataset.rankingMode === mode));
  $("#subtitle").textContent = mode === "realtime" ? "Bra・ショーツ17ジャンルのリアルタイムランキング上位100位を20分間隔で追跡" : "Bra & ショーツ、17ジャンルの日次ランキング最大1000位を追跡";
  $("#errorBox").hidden = Boolean(state.latest?.generatedAt);
  if (!state.latest?.generatedAt) $("#errorBox").textContent = "リアルタイム榜は初回采集后显示。新电脑更新程序并安装计划任务后会自动生成。";
  updateCategorySelect(); renderUpdatedAt(); render();
}

function csvCell(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function exportCsv() {
  const headers = ["group", "genreId", "genreName", "rank", "previousRank", "change", "new", "itemCode", "itemName", "shopName", "price", "pointRate", "promotionHints", "couponMentioned", "reviewAverage", "reviewCount", "itemUrl"];
  const exportRows = filteredRows();
  const lines = [headers, ...exportRows.map((row) => [row.category.group, row.category.id, row.category.name, row.rank, row.previousRank, row.change, row.isNew, row.itemCode, row.itemName, row.shopName, row.itemPrice, row.pointRate, (row.promotionHints || []).join(" | "), row.couponMentioned, row.reviewAverage, row.reviewCount, row.itemUrl])];
  const blob = new Blob(["\ufeff" + lines.map((line) => line.map(csvCell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(blob);
  anchor.download = `rakuten-ranking-${state.group}-${new Date().toISOString().slice(0, 10)}.csv`;
  anchor.click();
  URL.revokeObjectURL(anchor.href);
}

async function loadHistory(index) {
  const captures = await Promise.all((index?.captures || []).map(async (entry) => {
    if (entry.genres) return entry;
    if (!entry.file) return null;
    const response = await fetch(`data/${entry.file}`, { cache: "no-store" });
    return response.ok ? response.json() : null;
  }));
  return { captures: captures.filter(Boolean) };
}

function bindEvents() {
  $("#watchManager").addEventListener("click", event => {
    const button = event.target.closest("[data-remove-watch]");
    if (!button) return;
    state.watchlist.delete(button.dataset.removeWatch);
    let persisted = true;
    try { localStorage.setItem(WATCH_KEY, JSON.stringify([...state.watchlist])); } catch { persisted = false; }
    render();
    if (!persisted) $("#watchStatus").textContent = "保存できませんでした。削除は今回の閲覧中のみ有効です。";
  });
  document.querySelectorAll("[data-movement]").forEach(button => button.addEventListener("click", () => {
    state.movement = button.dataset.movement;
    document.querySelectorAll("[data-movement]").forEach(item => {
      item.classList.toggle("active", item === button);
      item.setAttribute("aria-pressed", String(item === button));
    });
    render();
  }));
  $("#watchedOnly").addEventListener("change", event => { state.watchedOnly = event.target.checked; render(); });
  $("#rankingBody").addEventListener("click", event => {
    const watch = event.target.closest("[data-watch]");
    if (watch) {
      const code = watch.dataset.watch;
      if (state.watchlist.has(code)) state.watchlist.delete(code); else state.watchlist.add(code);
      let persisted = true;
      try { localStorage.setItem(WATCH_KEY, JSON.stringify([...state.watchlist])); } catch { persisted = false; }
      render();
      if (!persisted) $("#watchStatus").textContent = "保存できませんでした。今回の閲覧中のみ有効です（ブラウザのストレージ設定をご確認ください）。";
      return;
    }
    const detail = event.target.closest("[data-detail-code]");
    if (detail) {
      const row = state.rows.find(item => item.itemCode === detail.dataset.detailCode && String(item.category.id) === detail.dataset.detailGenre);
      if (row) openDetail(row);
    }
  });
  $("#closeDetail").addEventListener("click", () => $("#productDialog").close());
  $("#productDialog").addEventListener("close", () => { detailRequest++; });
  document.querySelectorAll("[data-ranking-mode]").forEach((button) => button.addEventListener("click", () => selectMode(button.dataset.rankingMode)));
  document.querySelectorAll("[data-group]").forEach((button) => button.addEventListener("click", () => {
    document.querySelectorAll("[data-group]").forEach((item) => item.classList.toggle("active", item === button));
    state.group = button.dataset.group; state.category = "all"; updateCategorySelect(); render();
  }));
  document.querySelectorAll("[data-days]").forEach((button) => button.addEventListener("click", () => {
    document.querySelectorAll("[data-days]").forEach((item) => item.classList.toggle("active", item === button));
    state.days = Number(button.dataset.days); render();
  }));
  $("#categorySelect").addEventListener("change", (event) => { state.category = event.target.value; render(); });
  $("#searchInput").addEventListener("input", (event) => { state.query = event.target.value; render(); });
  $("#keywordCloud").addEventListener("click", (event) => {
    const button = event.target.closest("[data-keyword]");
    if (!button) return;
    const keyword = button.dataset.keyword;
    state.query = state.query.trim().toLocaleLowerCase("ja") === keyword ? "" : keyword;
    $("#searchInput").value = state.query;
    render();
  });
  $("#csvButton").addEventListener("click", exportCsv);
}

async function init() {
  try {
    const [latestResponse, historyResponse, updateResponse, realtimeResponse] = await Promise.all([fetch("data/latest.json", { cache: "no-store" }), fetch("data/history.json", { cache: "no-store" }), fetch("data/daily-update-log.json", { cache: "no-store" }), fetch("data/realtime/latest.json", { cache: "no-store" })]);
    if (!latestResponse.ok || !historyResponse.ok) throw new Error("ランキングデータを取得できませんでした。");
    const [latest, historyIndex] = await Promise.all([latestResponse.json(), historyResponse.json()]);
    state.dailyLatest = latest;
    state.realtimeLatest = realtimeResponse.ok ? await realtimeResponse.json() : { categories: latest.categories || [], rankings: {} };
    state.latest = state.dailyLatest;
    state.history = await loadHistory(historyIndex);
    state.updateLog = updateResponse.ok ? await updateResponse.json() : { days: [] };
    if (!state.latest.generatedAt) {
      $("#errorBox").hidden = false;
      $("#errorBox").textContent = "初回データ取得前です。GitHub Actionsを手動実行するとランキングが表示されます。";
    }
    updateCategorySelect(); bindEvents(); renderUpdatedAt(); render();
  } catch (error) {
    $("#errorBox").hidden = false;
    $("#errorBox").textContent = error.message;
    $("#updatedAt").textContent = "読込エラー";
  }
}

init();
