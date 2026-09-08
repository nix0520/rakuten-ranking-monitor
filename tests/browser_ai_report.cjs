// Run after generate_ai_report.py and start a local HTTP server on port 8765.
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({headless:true, ...(process.env.BROWSER_CHANNEL ? {channel:process.env.BROWSER_CHANNEL} : {})});
  try {
    const page = await browser.newPage({viewport:{width:1440,height:1000}});
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto('http://127.0.0.1:8765/assets/ai-operations.html');
    await page.locator('#download').waitFor({state:'visible'});
    assert.match(await page.locator('#reportStatus').innerText(), /日榜集计日/);
    assert.equal(await page.locator('#reportEvents details').count(), 30);
    await page.locator('#more').click();
    assert.equal(await page.locator('#reportEvents details').count(), 60);
    await page.locator('#reportEvents summary').first().click();
    assert.match(await page.locator('#reportEvents details').first().innerText(), /API积分倍率/);
    await page.selectOption('#reportGenre', {index:1});
    assert.ok(await page.locator('#reportEvents details').count() <= 30);
    await page.screenshot({path:process.env.AI_SCREENSHOT || '../ai-operations-desktop.png'});
    await page.setViewportSize({width:390,height:844});
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.route('**/data/ai-reports/latest.json', route => route.fulfill({status:404,body:'{}'}));
    await page.reload();
    await page.getByText('日报尚未生成或加载失败。', {exact:false}).waitFor();
    assert.equal(await page.locator('a[href="../index.html"]').count(),1);
    assert.deepEqual(errors, []);
    console.log('AI report browser checks passed: real data, paging, details, filter, mobile, missing report.');
  } finally { await browser.close(); }
})().catch(error => {console.error(error); process.exitCode=1;});
