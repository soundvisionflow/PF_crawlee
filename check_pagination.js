const puppeteer = require('puppeteer');

(async () => {
  const START_URL = 'https://www.propertyfinder.ae/en/search?l=1&c=3&t=4&fu=0&af=1500&ob=nd';
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  // Avoid 403 by setting a real User-Agent and Referer
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.5735.198 Safari/537.36');
  await page.setExtraHTTPHeaders({ 'referer': 'https://www.propertyfinder.ae/' });

  console.log('Testing pagination via URL param only (no scraping details)...');
  for (let pageNum = 1; ; pageNum++) {
    const url = `${START_URL}&page=${pageNum}`;
    console.log(`Loading page ${pageNum}: ${url}`);
    const response = await page.goto(url, { waitUntil: 'networkidle0' });
    console.log(`HTTP status: ${response.status()}`);
    // Count raw listing cards
    const count = await page.$$eval(
      'li[role="listitem"], article, div.ListingCard, div.card, div[data-cy="listing-card"]',
      els => els.length
    );
    console.log(`Found ${count} listing elements on page ${pageNum}`);
    if (count === 0) {
      console.log('No listings found, ending pagination check.');
      break;
    }
  }

  await browser.close();
  process.exit(0);
})(); 