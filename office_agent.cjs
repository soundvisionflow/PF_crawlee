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
// Adjusted URL to bypass potential captchas/anti-bot measures
const START_URL = 'https://www.propertyfinder.ae/en/search?c=3&t=4&fu=0&af=1500&ob=nd&rp=y&l=1&pt=3&pt=1';
const MIN_AREA_SQFT = 1500;
const MONTHS_TO_LOOKBACK = 2;
const META_FILE = 'lastRun.json';
// Mode: 'initial' scrapes last 2 months; 'update' scrapes only since last run
const MODE = process.env.MODE || 'initial';
const isInitial = MODE === 'initial';
const NAVIGATION_TIMEOUT = 120000; // 2 minutes for navigation timeout
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
  let retryCount = 0;
  const MAX_RETRIES = 3;
  
  while (retryCount < MAX_RETRIES) {
    try {
      return await runScraperWithRetries();
    } catch (error) {
      retryCount++;
      console.log(`Scraper failed, attempt ${retryCount} of ${MAX_RETRIES}: ${error.message}`);
      if (retryCount >= MAX_RETRIES) {
        console.log(`Max retries (${MAX_RETRIES}) reached. Giving up.`);
        throw error;
      }
      console.log(`Waiting 10 seconds before next retry...`);
      await new Promise(resolve => setTimeout(resolve, 10000));
    }
  }
}

async function runScraperWithRetries() {
  // Configure Puppeteer launch options
  const launchOptions = {
    headless: 'new',
    args: [
      '--no-sandbox', 
      '--disable-setuid-sandbox', 
      '--disable-dev-shm-usage', 
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-blink-features=AutomationControlled', // Try to avoid detection
      '--disable-extensions',
      '--disable-component-extensions-with-background-pages',
      '--disable-default-apps',
      '--mute-audio',
      '--no-default-browser-check',
      '--no-first-run',
      '--no-pings',
      '--window-size=1920,1080',
      '--ignore-certificate-errors',
      '--ignore-certificate-errors-spki-list',
      '--proxy-bypass-list=*'
    ]
  };
  
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  console.log('Launching browser with options:', launchOptions);
  const browser = await puppeteer.launch(launchOptions);
  
  try {
    // Create a new page with more realistic browser settings
    const page = await browser.newPage();
    
    // Set a more realistic user agent
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    // Set default navigation timeout
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT);
    
    // Set viewport to a common desktop resolution
    await page.setViewport({ width: 1920, height: 1080 });
    
    // Spoof webdriver to avoid detection
    await page.evaluateOnNewDocument(() => {
      delete Object.getPrototypeOf(navigator).webdriver;
      // Add other spoofing as needed to bypass detection
      window.navigator.chrome = { runtime: {} };
    });
    
    // Enable request interception for debugging
    await page.setRequestInterception(true);
    page.on('request', request => {
      // Skip images, fonts and stylesheets to speed up loading
      const resourceType = request.resourceType();
      if (resourceType === 'image' || resourceType === 'font' || resourceType === 'stylesheet') {
        request.abort();
      } else {
        request.continue();
      }
    });
    
    // Log navigation events for debugging
    page.on('response', response => {
      const status = response.status();
      if (status >= 400) {
        console.log(`Error ${status} for URL: ${response.url()}`);
      }
    });

    // Log console messages from the page
    page.on('console', msg => console.log('BROWSER CONSOLE:', msg.text()));

    // Log any page errors
    page.on('pageerror', err => console.log('PAGE ERROR:', err.message));

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
        console.log('No existing CSV found or error downloading:', e.message);
      }
    }
    
    await downloadExistingCSV();

    // First visit the homepage to set cookies
    console.log('Visiting homepage first to establish session and accept cookies...');
    try {
      await page.goto('https://www.propertyfinder.ae/', { 
        waitUntil: 'networkidle2',
        timeout: NAVIGATION_TIMEOUT 
      });
      
      // Accept cookies if the dialog appears
      try {
        const cookieAcceptSelector = 'button[data-testid="cookie-consent-accept"], .cookie-consent-accept, button:contains("Accept")';
        await page.waitForSelector(cookieAcceptSelector, { timeout: 5000 });
        await page.click(cookieAcceptSelector);
        console.log('Accepted cookies');
      } catch (e) {
        console.log('No cookie consent dialog found or error accepting cookies');
      }
      
      // Wait a moment before proceeding
      await page.waitForTimeout(3000);
      
    } catch (navError) {
      console.log('Error visiting homepage:', navError.message);
      // Continue anyway
    }

    for (let currentPage = 1; currentPage <= maxPages; currentPage++) {
      const url = `${START_URL}&page=${currentPage}`;
      console.log(`Loading page ${currentPage}: ${url}`);
      
      try {
        // Navigate with longer timeout and wait until network is mostly idle
        await page.goto(url, { 
          waitUntil: 'networkidle2',
          timeout: NAVIGATION_TIMEOUT 
        });
      } catch (navError) {
        console.log(`Navigation error on page ${currentPage}: ${navError.message}`);
        
        // Take a screenshot to debug
        try {
          const screenshotPath = `page-${currentPage}-error.png`;
          await page.screenshot({ path: screenshotPath, fullPage: true });
          console.log(`Saved error screenshot to ${screenshotPath}`);
          
          if (bucketName) {
            await storage.bucket(bucketName).upload(screenshotPath, { destination: screenshotPath });
            console.log(`Uploaded error screenshot to bucket`);
          }
        } catch (ssError) {
          console.log(`Failed to save error screenshot: ${ssError.message}`);
        }
        
        if (currentPage === 1) {
          // First page failed - might be a critical problem
          throw new Error(`First page navigation failed: ${navError.message}`);
        } else {
          // Skip this page and try the next one
          console.log(`Skipping page ${currentPage} due to navigation error`);
          continue;
        }
      }

      // Wait for listings to appear
      // More comprehensive selector to catch various listing formats
      const ITEM_SELECTOR = 'li[role="listitem"], article, div.PropertyCard, div.ListingCard, div.card, div[data-cy="listing-card"], div[data-testid="listing-card"], div.property-card, .property-list-item, [data-testid="property-card"], div.Card, .listing-item';
      let listingsExist = false;
      
      try {
        // In test mode, just check if container exists quickly
        // In scrape mode, wait longer for actual items
        console.log(`Waiting for selector: ${ITEM_SELECTOR}`);
        const waitOptions = { timeout: TEST_PAGINATION ? 5000 : 60000 };
        await page.waitForSelector(ITEM_SELECTOR, waitOptions);
        listingsExist = true;
      } catch (e) {
        console.log(`Error waiting for selector: ${e.name} - ${e.message}`);
        
        // Take a screenshot to see what's on the page
        try {
          const screenshotPath = `screenshot-page-${currentPage}.png`;
          await page.screenshot({ path: screenshotPath, fullPage: true });
          
          // Upload screenshot to Cloud Storage
          if (bucketName) {
            await storage.bucket(bucketName).upload(screenshotPath, { destination: screenshotPath });
            console.log(`Screenshot saved to Cloud Storage: ${screenshotPath}`);
          }
          
          // Debug page content
          const pageContent = await page.content();
          fs.writeFileSync(`page-${currentPage}-content.html`, pageContent);
          if (bucketName) {
            await storage.bucket(bucketName).upload(`page-${currentPage}-content.html`, 
              { destination: `page-${currentPage}-content.html` });
            console.log(`Page HTML saved to Cloud Storage: page-${currentPage}-content.html`);
          }
        } catch (screenshotError) {
          console.log(`Failed to save debug info: ${screenshotError.message}`);
        }
        
        // Only treat TimeoutError as fatal if not in test mode
        if (!TEST_PAGINATION && e.name === 'TimeoutError') {
          console.log(`Timeout waiting for items on page ${currentPage}.`);
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
        console.log(`Found ${elements.length} matching elements`);
        return Array.from(elements).map(el => {
          const title = el.querySelector('h2, h3, [class*="title"], .property-title, [data-testid="title"]')?.innerText.trim() || null;
          const location = el.querySelector('[class*="location"], [data-testid="location"], .property-location, .card-location, [class*="LocationLabel"]')?.innerText.trim() || null;
          const price = el.querySelector('[class*="price"], [data-testid="price"], .property-price, .card-price, .PriceLabel')?.innerText.trim() || null;
          
          let area = null;
          const allTexts = Array.from(el.querySelectorAll('*')).map(e => e.innerText || '');
          
          // Try different area patterns
          for (const txt of allTexts) {
            // First try sq ft pattern
            let match = txt.replace(/,/g, '').match(/(\d+)\s*sq[\s\.]*ft/i);
            if (match) { area = parseInt(match[1], 10); break; }
            
            // Also try m² pattern (convert to sq ft)
            match = txt.replace(/,/g, '').match(/(\d+)\s*m[\s\.]*²/i);
            if (match) { area = Math.round(parseInt(match[1], 10) * 10.764); break; }
            
            // Also look for sqft without space
            match = txt.replace(/,/g, '').match(/(\d+)sqft/i);
            if (match) { area = parseInt(match[1], 10); break; }
          }
          
          // Extract listing date with more patterns
          let listed = el.querySelector('time, [class*="date"], [data-testid="date"], .listing-date')?.innerText.trim() 
            || el.querySelector('time')?.getAttribute('datetime') || null;
          
          if (!listed) {
            for (const raw of allTexts) {
              const t = raw.replace(/\s+/g, ' ').trim();
              if (/\d+\s*(minute|hour|day|week|month|year)s?\s+ago/i.test(t) || 
                  /listed:?\s+\w+/i.test(t) ||
                  !isNaN(Date.parse(t))) {
                listed = t;
                break;
              }
            }
          }
          
          // Try multiple ways to get the URL
          const url = el.querySelector('a')?.href || 
                     el.closest('a')?.href || 
                     el.querySelector('[data-testid="property-link"]')?.href || null;
                   
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
  } finally {
    // Always close the browser to avoid memory leaks
    if (browser) {
      await browser.close();
      console.log('Browser closed');
    }
  }
}

runScraper().catch(err => {
  console.error('Fatal error in scraper:', err);
  process.exit(1);
});