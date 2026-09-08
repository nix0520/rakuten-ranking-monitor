const $ = id => document.getElementById(id);
function element(tag, text) {
  const node = document.createElement(tag);
  node.textContent = text;
  return node;
}
const value = v => v == null ? '未记录' : Array.isArray(v) ? v.join(' / ') || '未检出优惠文字' : String(v);
let report, shown = 30;
function render() {
  const rows = report.importantChanges.filter(e => !$('reportGenre').value || e.genreId === $('reportGenre').value);
  $('reportEvents').replaceChildren();
  $('eventCount').textContent = `共 ${rows.length} 条类目商品变化，显示 ${Math.min(shown, rows.length)} 条。同商品跨类目分别列出。`;
  if (!rows.length) $('reportEvents').append(element('p', report.status === 'ready' ? '当前范围没有触发规则的变化；请结合数据覆盖情况判断。' : '昨日记录缺失，未生成变化结论。'));
  for (const row of rows.slice(0, shown)) {
    const box = element('details', '');
    box.append(element('summary', `${row.itemName} · #${value(row.rankYesterday)} → #${value(row.rankToday)}`));
    box.append(element('p', `${row.genreId} / ${row.itemCode}：${row.facts.join('；')}`));
    for (const [field, label] of [['itemPrice','价格（JPY）'],['pointRate','API积分倍率'],['promotionHints','优惠原文'],['reviewCount','评论数'],['reviewAverage','评分']]) {
      box.append(element('p', `${label}：${value(row.yesterday[field])} → ${value(row.today[field])}`));
    }
    $('reportEvents').append(box);
  }
  $('more').hidden = rows.length <= shown;
}
try {
  const response = await fetch('../data/ai-reports/latest.json', {cache: 'no-store'});
  if (!response.ok) throw new Error('report unavailable');
  report = await response.json();
  $('reportStatus').textContent = `日榜集计日 ${report.date} / 比较日 ${report.comparisonDate || '昨日缺测'} / 资料采集时间 ${report.capturedAt || '未记录'}。${report.status === 'ready' ? '仅对两日均有记录的类目进行比较。' : '缺少昨日记录，不能计算昨日变化。'}`;
  for (const [label, count] of [['去重监控商品', report.summary.trackedProducts], ['异常涉及商品', report.summary.affectedProducts], ['类目商品变化', report.summary.eventRows]]) {
    const card = element('article', '');
    card.append(element('span', label), element('strong', count));
    $('reportSummary').append(card);
  }
  for (const genre of report.coverage) {
    const option = element('option', genre.genreName || genre.genreId);
    option.value = genre.genreId;
    $('reportGenre').append(option);
    $('coverage').append(element('p', `${genre.genreName || genre.genreId}：今日 ${genre.todayCount} / 昨日 ${genre.yesterdayCount}；${genre.comparable ? '可比较（仅已覆盖名次）' : '不可比较（缺测或空榜）'}`));
  }
  for (const line of report.limitations) $('coverage').append(element('p', line));
  $('coverage').append(element('p', `今日缺项（类目商品行数）：${JSON.stringify(report.missingFieldsByRankRow)}。规则：排名±20名、价格±5%、进入/离开TOP20/100、优惠原文或积分变化、评论日增≥50或减少。`));
  for (const line of report.suggestedActions) $('actions').append(element('li', line));
  $('download').href = '../data/ai-reports/ai-input.json';
  $('download').hidden = false;
  $('reportGenre').addEventListener('change', () => { shown = 30; render(); });
  $('more').addEventListener('click', () => { shown += 30; render(); });
  render();
} catch {
  $('reportStatus').textContent = '日报尚未生成或加载失败。排行榜仍可正常使用；请稍后刷新，或运行日报生成脚本。';
}
