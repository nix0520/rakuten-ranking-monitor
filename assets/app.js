const state = { mode: "daily", dailyLatest: null, realtimeLatest: null, latest: null, history: null, updateLog: null, group: "bra", category: "all", query: "", days: 7, rows: [] };
const $ = (selector) => document.querySelector(selector);
const yen = new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY", maximumFractionDigits: 0 });
const dateTime = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });

function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

function categories() {
  return (state.latest?.categories || []).filter((category) => category.group === state.group);
}

function selectedCategories() {
  return state.category === "all" ? categories() : categories().filter((category) => String(category.id) === state.category);
}

function trendPoints(genreId, itemCode) {
  const cutoff = Date.now() - state.days * 86400000;
  return (state.history?.captures || [])
    .filter((capture) => new Date(capture.capturedAt).getTime() >= cutoff)
    .map((capture) => ({ at: capture.capturedAt, rank: capture.genres?.[String(genreId)]?.[itemCode] }))
    .filter((point) => Number.isFinite(point.rank));
}

function sparkline(points) {
  if (points.length < 2) return '<span class="spark-empty">履歴蓄積中</span>';
  const width = 150, height = 42, pad = 3;
  const min = Math.min(...points.map((point) => point.rank));
  const max = Math.max(...points.map((point) => point.rank));
  const range = Math.max(max - min, 1);
  const coordinates = points.map((point, index) => {
    const x = pad + index * (width - pad * 2) / Math.max(points.length - 1, 1);
    const y = pad + (point.rank - min) * (height - pad * 2) / range;
    return [x, y];
  });
  const path = coordinates.map(([x, y], index) => `${index ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const last = coordinates.at(-1);
  const label = `${state.days}日間: 最高${min}位 / 最低${max}位`;
  return `<svg class="sparkline" viewBox="0 0 ${width} ${height}" role="img" aria-label="${label}"><path d="${path}"></path><circle cx="${last[0]}" cy="${last[1]}" r="2.7"></circle></svg>`;
}

function movement(item) {
  if (item.isNew) return '<span class="movement new">NEW</span>';
  if (item.change > 0) return `<span class="movement up">▲ ${item.change}</span>`;
  if (item.change < 0) return `<span class="movement down">▼ ${Math.abs(item.change)}</span>`;
  return '<span class="movement stay">—</span>';
}

function filteredRows() {
  const query = state.query.trim().toLocaleLowerCase("ja");
  return selectedCategories().flatMap((category) =>
    (state.latest.rankings?.[String(category.id)] || []).map((item) => ({ ...item, category }))
  ).filter(({ itemName, itemCode, shopName }) =>
    !query || `${itemName} ${itemCode} ${shopName}`.toLocaleLowerCase("ja").includes(query)
  );
}

function visibleRows(rows) {
  return state.query.trim() ? rows : rows.filter((row) => row.rank <= 100);
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
    <td>${state.mode === "realtime" ? '<span class="spark-empty">20分前比を順位横に表示</span>' : sparkline(trendPoints(row.category.id, row.itemCode))}</td>
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
