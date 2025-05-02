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
const isInitial = MODE === 'initial';
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
  // Configure Puppeteer launch options
  const launchOptions = {
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  };
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  console.log('Launching browser with options:', launchOptions);
  const browser = await puppeteer.launch(launchOptions);
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  const TEST_PAGINATION = process.env.TEST_PAGINATION === 'true';
  if (TEST_PAGINATION) {
    console.log('[PAGINATION TEST MODE]');
  }

  // Paginate via URL param
  const results = [];
  const seenKeys = new Set();
  let maxPages = isInitial ? 15 : 3;

  // Load existing results for deduplication (from Cloud Storage if available)
  let existingRows = [];
  const csvFile = 'results.csv';
  const { Storage } = require('@google-cloud/storage');
  const storage = new Storage();
  const bucketName = process.env.BUCKET_NAME;
  const fsPromises = fs.promises;
  async function downloadExistingCSV() {
    if (!bucketName) return;
    try {
      await storage.bucket(bucketName).file(csvFile).download({ destination: csvFile });
      const data = fs.readFileSync(csvFile, 'utf-8');
      existingRows = data.split('\n').filter(Boolean).map(line => line.split(','));
      // Build seenKeys set for deduplication
      for (const row of existingRows.slice(1)) { // skip header
        if (row.length < 7) continue;
        const key = row.slice(0, 7).join('|');
        seenKeys.add(key);
      }
    } catch (e) {
      // No existing file, skip
    }
  }
  await downloadExistingCSV();

  for (let currentPage = 1; currentPage <= maxPages; currentPage++) {
    const url = `${START_URL}&page=${currentPage}`;
    console.log(`Loading page ${currentPage}: ${url}`);
    await page.goto(url, { waitUntil: 'networkidle0' });

    // Wait for listings to appear
    const ITEM_SELECTOR = 'li[role="listitem"], article, div.ListingCard, div.card, div[data-cy="listing-card"], div[data-testid="listing-card"]';
    let listingsExist = false;
    try {
      // In test mode, just check if container exists quickly
      // In scrape mode, wait longer for actual items
      const waitOptions = { timeout: TEST_PAGINATION ? 5000 : 60000 };
      await page.waitForSelector(ITEM_SELECTOR, waitOptions);
      listingsExist = true;
    } catch (e) {
      // Only treat TimeoutError as fatal if not in test mode
      if (!TEST_PAGINATION && e.name === 'TimeoutError') {
        console.log(`Timeout waiting for items on page ${currentPage}.`);
        // Optionally add screenshot/HTML save here if needed for debug
        break;
      } else if (TEST_PAGINATION && e.name === 'TimeoutError') {
        console.log(`Quick check failed for items on page ${currentPage}. Assuming end of results for test.`);
        listingsExist = false; // Continue to break below
      } else {
        break; // Break on other errors
      }
    }
    // If no listings found (or test mode timeout), stop paginating
    if (!listingsExist) {
      console.log('No listings found; ending pagination.');
      break;
    }
    console.log(`Listings container found on page ${currentPage}`);
    // Skip actual scraping in test mode
    if (TEST_PAGINATION) {
      await page.waitForTimeout(1000); // Brief pause before next page in test
      continue;
    }
    // --- Full Scrape Logic --- 
    const rawCount = await page.$$eval(ITEM_SELECTOR, els => els.length);
    console.log(`Total raw listings found: ${rawCount}`);
    const listings = await page.evaluate(selector => {
      const elements = document.querySelectorAll(selector);
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
    }, ITEM_SELECTOR);

    // Process items and dedupe
    let anyNew = false;
    for (const item of listings) {
      if (!item.area || item.area < MIN_AREA_SQFT) continue;
      // Composite key for deduplication
      const key = [item.title, item.location, item.area, item.price, item.listed, item.url].join('|');
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);

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

    // Throttle only in full scrape mode
    await page.waitForTimeout(2000);
    // Stop if no new/in-threshold items found (only in full scrape mode)
    if (!TEST_PAGINATION && !anyNew && !isInitial) {
      console.log('No new or in-threshold listings on page, ending pagination');
      break;
    }
  }

  await browser.close();

  // Save results only if not in test mode
  if (!TEST_PAGINATION) {
    const fields = ['title','location','price','area','description','listed','url'];
    // Append new results to existing CSV
    let appendRows = results.map(r => fields.map(f => (r[f] || '').replace(/\n/g, ' ')).join(','));
    let writeHeader = false;
    try {
      await fsPromises.access(csvFile);
    } catch {
      writeHeader = true;
    }
    const toWrite = (writeHeader ? fields.join(',') + '\n' : '') + appendRows.join('\n') + (appendRows.length ? '\n' : '');
    fs.appendFileSync(csvFile, toWrite);
    console.log(`Appended: ${results.length} new listings to results.csv`);
    // Upload to Cloud Storage
    if (bucketName) {
      await storage.bucket(bucketName).upload(csvFile, { destination: csvFile });
      console.log('results.csv uploaded to Cloud Storage');
    }
    // Persist last run timestamp
    fs.writeFileSync(META_FILE, JSON.stringify({ lastRun: new Date().toISOString() }));
    console.log(`Updated last run timestamp to now`);
  }
}

runScraper();