const puppeteer = require('puppeteer');
const fs = require('fs');
const { parse } = require('json2csv');

// Helper: convert relative time (e.g., "8 hours ago") to absolute Date
function parseRelativeTime(relativeStr, baseDate = new Date()) {
  if (!relativeStr) return null;
  const lower = relativeStr.toLowerCase();
  const regex = /(\d+)\s*(minute|hour|day|week|month|year)s?\s+ago/;
  const match = lower.match(regex);
  if (match) {
    const value = parseInt(match[1], 10);
    const unit = match[2];
    const date = new Date(baseDate);
    switch (unit) {
      case 'minute': date.setMinutes(date.getMinutes() - value); break;
      case 'hour':   date.setHours(date.getHours() - value); break;
      case 'day':    date.setDate(date.getDate() - value); break;
      case 'week':   date.setDate(date.getDate() - (value * 7)); break;
      case 'month':  date.setMonth(date.getMonth() - value); break;
      case 'year':   date.setFullYear(date.getFullYear() - value); break;
      default: return null;
    }
    return date;
  }
  return null;
}

// Configuration
const START_URL = 'https://www.propertyfinder.ae/en/search?l=1&c=3&t=4&fu=0&af=1500&ob=nd';
const MIN_AREA_SQFT = 1500;
const MONTHS_TO_LOOKBACK = 2;
const META_FILE = 'lastRun.json';
// Mode: 'initial' scrapes last 2 months; 'update' scrapes only since last run
const MODE = process.env.MODE || 'initial';
let thresholdDate;
if (MODE === 'update' && fs.existsSync(META_FILE)) {
  const meta = JSON.parse(fs.readFileSync(META_FILE, 'utf-8'));
  thresholdDate = new Date(meta.lastRun);
  console.log(`Update mode: using last run date ${thresholdDate}`);
} else {
  // initial mode: last 2 months
  thresholdDate = (() => {
    const d = new Date();
    d.setMonth(d.getMonth() - MONTHS_TO_LOOKBACK);
    return d;
  })();
  console.log(`Initial mode: using cutoff date ${thresholdDate}`);
}

async function runScraper() {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  // Paginate via URL param, stop when no listings or older than threshold
  const results = [];
  const seenUrls = new Set();
  for (let currentPage = 1; ; currentPage++) {
    const url = `${START_URL}&page=${currentPage}`;
    console.log(`Loading page ${currentPage}: ${url}`);
    await page.goto(url, { waitUntil: 'networkidle0' });

    // Wait for listings to load
    await page.waitForSelector('li[role="listitem"], article, div.ListingCard, div.card, div[data-cy="listing-card"]');

    // Count raw listing elements; break if none
    const rawCount = await page.$$eval('li[role="listitem"], article, div.ListingCard, div.card, div[data-cy="listing-card"]', els => els.length);
    if (rawCount === 0) {
      console.log('No listings found; ending pagination.');
      break;
    }
    console.log(`Total raw listings found: ${rawCount}`);

    // Extract listings
    const listings = await page.evaluate(() => {
      const sel = 'li[role="listitem"], article, div.ListingCard, div.card, div[data-cy="listing-card"]';
      const elements = document.querySelectorAll(sel);
      return Array.from(elements).map(el => {
        const title = el.querySelector('h2')?.innerText.trim() || null;
        const location = el.querySelector('[class*="location"]')?.innerText.trim() || null;
        const price = el.querySelector('[class*="price"]')?.innerText.trim() || null;
        let area = null;
        const allTexts = Array.from(el.querySelectorAll('*')).map(e => e.innerText || '');
        for (const txt of allTexts) {
          const match = txt.replace(/,/g, '').match(/(\d+)\s*sq[\s\.]*ft/i);
          if (match) { area = parseInt(match[1], 10); break; }
        }
        // Extract listing date
        let listed = el.querySelector('time')?.innerText.trim() || el.querySelector('time')?.getAttribute('datetime') || null;
        if (!listed) {
          for (const raw of allTexts) {
            const t = raw.replace(/\s+/g, ' ').trim();
            if (/\d+\s*(minute|hour|day|week|month|year)s?\s+ago/i.test(t) || !isNaN(Date.parse(t))) {
              listed = t;
              break;
            }
          }
        }
        const url = el.querySelector('a')?.href || null;
        return { title, location, price, area, listed, url };
      });
    });

    // Process items and dedupe
    let anyNew = false;
    for (const item of listings) {
      if (!item.area || item.area < MIN_AREA_SQFT) continue;
      if (seenUrls.has(item.url)) continue;
      seenUrls.add(item.url);

      // Parse date
      let listedDate = null;
      if (item.listed) {
        const cs = item.listed.replace(/listed\s*/i, '').trim();
        listedDate = parseRelativeTime(cs);
        if (!listedDate) {
          const ad = new Date(cs);
          if (!isNaN(ad)) listedDate = ad;
        }
      }

      if (listedDate && listedDate >= thresholdDate) {
        if (item.url) {
          const detailPage = await browser.newPage();
          await detailPage.goto(item.url, { waitUntil: 'networkidle0' });
          const description = await detailPage.evaluate(() => {
            const descEl = document.querySelector('#description');
            if (descEl) {
              const btn = descEl.querySelector('button');
              if (btn) btn.click();
              return descEl.innerText.trim();
            }
            return null;
          });
          item.description = description;
          await detailPage.close();
        }
        results.push(item);
        anyNew = true;
        console.log(`Found valid listing: ${item.title}`);
      }
    }

    // throttle
    await page.waitForTimeout(2000);
    // if this page had no new items and beyond threshold, stop
    if (!anyNew) {
      console.log('No new or in-threshold listings on page, ending pagination');
      break;
    }
  }

  await browser.close();

  // Save to CSV
  const fields = ['title','location','price','area','description','listed','url'];
  fs.writeFileSync('results.csv', parse(results, { fields }));
  console.log(`Completed: ${results.length} listings saved to results.csv`);
  // Persist last run timestamp
  fs.writeFileSync(META_FILE, JSON.stringify({ lastRun: new Date().toISOString() }));
  console.log(`Updated last run timestamp to now`);
}

runScraper(); 