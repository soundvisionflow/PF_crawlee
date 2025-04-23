const puppeteer = require('puppeteer');

(async () => {
  const START_URL = 'https://www.propertyfinder.ae/en/search?l=1&c=3&t=4&fu=0&af=1500&ob=nd';
  // XPATH matching either <a> or <button> within the pagination controls
  const NEXT_XPATH = '//*[@id="root_element"]/main/div[5]/div[1]/div[4]/*[name()="a" or name()="button"]';

  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  await page.goto(START_URL, { waitUntil: 'networkidle0' });
  let pageNum = 1;
  console.log(`Page ${pageNum}: ${page.url()}`);
  // Debug: log pagination container and anchors on first page
  const containers = await page.$$eval('div[class*="pagination-styles-module_container"]', els => els.map(el => el.outerHTML));
  console.log('Found pagination containers:', containers.length);
  const anchors = await page.$$eval('div[class*="pagination-styles-module_container"] a', els => els.map(a => a.outerHTML));
  console.log('Found pagination anchors:', anchors.length, anchors);

  // Debug: scroll and log anchors on first page to locate pagination
  await page.waitForTimeout(2000);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(2000);
  const allAnchors = await page.$$eval('a', as => as.map(a => ({ href: a.href, text: a.textContent.trim(), class: a.className })));
  console.log('All <a> elements on page:', allAnchors);

  while (true) {
    // Wait briefly
    await page.waitForTimeout(1000);
    // Debug anchors each page
    if (pageNum === 1) {
      const pageAnchors = await page.$$eval('div[class*="pagination-styles-module_container"] a', els => els.map(a => a.href));
      console.log('Pagination hrefs:', pageAnchors);
    }
    // Locate pagination refresh container and next anchor via partial class name
    const nextSelector = 'div[class*="pagination-styles-module_container--refresh"] > a';
    await page.waitForSelector(nextSelector, { visible: true, timeout: 5000 }).catch(() => null);
    const nextEl = await page.$(nextSelector);
    if (!nextEl) {
      console.log('No next page link found; pagination test complete.');
      break;
    }
    // Click and wait for navigation to next page
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle0' }),
      nextEl.click()
    ]);
    pageNum++;
    console.log(`Page ${pageNum}: ${page.url()}`);
  }

  await browser.close();
  process.exit(0);
})(); 