const puppeteer = require('puppeteer');
const fs = require('fs');
const { Storage } = require('@google-cloud/storage');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;

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
const START_URL = 'https://www.example.com';
const MIN_AREA_SQFT = 1500;
const MONTHS_TO_LOOKBACK = 2;
const META_FILE = 'lastRun.json';
const BUCKET_NAME = process.env.BUCKET_NAME || 'office-agent-results';
// Mode: 'initial' scrapes last 2 months; 'update' scrapes only since last run
const MODE = process.env.MODE || 'initial';
let thresholdDate;
if (fs.existsSync(META_FILE)) {
  try {
    const meta = JSON.parse(fs.readFileSync(META_FILE, 'utf-8'));
    const lastRunDate = new Date(meta.lastRun);
    if (!isNaN(lastRunDate)) {
      thresholdDate = lastRunDate;
      console.log(`Using last run date: ${thresholdDate}`);
    } else {
      throw new Error("Invalid date format");
    }
  } catch (e) {
    // Default to lookback period if lastRun parsing fails
    thresholdDate = new Date();
    thresholdDate.setMonth(thresholdDate.getMonth() - MONTHS_TO_LOOKBACK);
    console.log(`Using default lookback (${MONTHS_TO_LOOKBACK} months): ${thresholdDate}`);
  }
} else {
  // No lastRun file, use lookback period
  thresholdDate = new Date();
  thresholdDate.setMonth(thresholdDate.getMonth() - MONTHS_TO_LOOKBACK);
  console.log(`Using default lookback (${MONTHS_TO_LOOKBACK} months): ${thresholdDate}`);
}

async function uploadToGCS(filename) {
  try {
    if (!process.env.BUCKET_NAME) {
      console.log('No BUCKET_NAME specified, skipping upload');
      return;
    }
    
    const storage = new Storage();
    const bucket = storage.bucket(BUCKET_NAME);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const destination = `${filename.split('.')[0]}-${timestamp}.${filename.split('.')[1]}`;
    
    await bucket.upload(filename, {
      destination,
      metadata: {
        contentType: filename.endsWith('.csv') ? 'text/csv' : 'application/json'
      }
    });
    
    console.log(`${filename} uploaded to ${BUCKET_NAME}/${destination}`);
    return true;
  } catch (error) {
    console.error(`Error uploading to GCS: ${error.message}`);
    return false;
  }
}

async function runScraper() {
  let browser = null;
  try {
    // Configure Puppeteer launch options
    const launchOptions = {
      headless: process.env.TEST_PAGINATION === 'true' ? false : 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    };
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
      launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    }
    
    console.log(`Launching browser in ${launchOptions.headless ? 'headless' : 'visible'} mode`);
    browser = await puppeteer.launch(launchOptions);
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    
    // Set a common browser user agent
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

    // Log console messages from the browser
    page.on('console', msg => console.log('BROWSER:', msg.text()));
    
    // Detect potential navigation issues
    page.on('error', err => console.error('PAGE ERROR:', err));
    page.on('pageerror', err => console.error('PAGE JS ERROR:', err));

    const TEST_PAGINATION = process.env.TEST_PAGINATION === 'true';
    const MAX_PAGES = process.env.MAX_PAGES ? parseInt(process.env.MAX_PAGES) : null;
    
    if (TEST_PAGINATION) {
      console.log('[PAGINATION TEST MODE]');
      if (MAX_PAGES) {
        console.log(`[TESTING ${MAX_PAGES} PAGES ONLY]`);
      }
    }

    // Paginate via URL param
    const results = [];
    const seenUrls = new Set();
    for (let currentPage = 1; ; currentPage++) {
      // Stop if we've reached the maximum number of pages to test
      if (MAX_PAGES && currentPage > MAX_PAGES) {
        console.log(`Reached maximum test pages (${MAX_PAGES}), stopping.`);
        break;
      }
      
      // Navigate to the appropriate page URL
      const url = currentPage === 1 
        ? START_URL 
        : `${START_URL}?page=${currentPage}`;
      
      console.log(`Loading page ${currentPage}: ${url}`);
      
      // Navigate with longer timeout and wait for network idle
      try {
        console.log(`Attempting to navigate to: ${url}`);
        await page.goto(url, { 
          waitUntil: 'domcontentloaded', 
          timeout: 30000 
        });
        console.log('Page DOM loaded');
        
        // Wait for network to settle
        await new Promise(resolve => setTimeout(resolve, 5000));
        console.log('Extra wait completed');
      } catch (navigationError) {
        console.error(`Navigation error: ${navigationError.message}`);
        if (TEST_PAGINATION) {
          await page.screenshot({ path: `page-${currentPage}-error.png` });
          console.log(`Saved error screenshot as page-${currentPage}-error.png`);
        }
        break; // Stop on navigation errors
      }

      // Wait for listings to appear - try simpler selectors for testing
      const ITEM_SELECTOR = 'p, div, h1';
      
      console.log(`Waiting for elements matching selector: ${ITEM_SELECTOR}`);
      
      let listingsExist = false;
      try {
        // First check if the page has content
        const bodyText = await page.evaluate(() => document.body.innerText);
        console.log(`Page body has ${bodyText.length} characters of text`);
        
        // Check if any elements actually exist using querySelectorAll directly
        const elementsCount = await page.evaluate((selector) => {
          const elements = document.querySelectorAll(selector);
          console.log(`Found ${elements.length} elements matching ${selector}`);
          return elements.length;
        }, ITEM_SELECTOR);
        
        listingsExist = elementsCount > 0;
        console.log(`Found ${elementsCount} listing elements on page ${currentPage}`);
        
        // If testing, take screenshot regardless of finding elements
        if (TEST_PAGINATION) {
          await page.screenshot({ path: `page-${currentPage}.png` });
          console.log(`Saved screenshot as page-${currentPage}.png`);
        }
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
        await new Promise(resolve => setTimeout(resolve, 1000)); // Brief pause before next page in test
        continue;
      }
      // --- Full Scrape Logic --- 
      const rawCount = await page.$$eval(ITEM_SELECTOR, els => els.length);
      console.log(`Total raw listings found: ${rawCount}`);
      const listings = await page.evaluate(selector => {
        const elements = document.querySelectorAll(selector);
        return Array.from(elements).map(el => {
          // Title - try different possible selectors
          const titleSelectors = ['h2', '[data-qs="serp-property-title"]', '.property-title', '.listing-title'];
          let title = null;
          for (const sel of titleSelectors) {
            const titleEl = el.querySelector(sel);
            if (titleEl) {
              title = titleEl.innerText.trim();
              break;
            }
          }
          
          // Location - try different possible selectors
          const locationSelectors = ['[class*="location"]', '[data-qs="serp-property-location"]', '.location', '.listing-location'];
          let location = null;
          for (const sel of locationSelectors) {
            const locEl = el.querySelector(sel);
            if (locEl) {
              location = locEl.innerText.trim();
              break;
            }
          }
          
          // Price - try different possible selectors
          const priceSelectors = ['[class*="price"]', '[data-qs="serp-property-price"]', '.price', '.listing-price'];
          let price = null;
          for (const sel of priceSelectors) {
            const priceEl = el.querySelector(sel);
            if (priceEl) {
              price = priceEl.innerText.trim();
              break;
            }
          }
          
          // Area extraction
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
          
          // URL extraction
          const url = el.querySelector('a')?.href || null;
          
          console.log(`Extracted: ${title || 'No title'} - ${area || 'No area'} sqft`);
          return { title, location, price, area, listed, url };
        });
      }, ITEM_SELECTOR);

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

      // Throttle only in full scrape mode
      if (!TEST_PAGINATION) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      } else {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      // Stop if no new/in-threshold items found (only in full scrape mode)
      if (!TEST_PAGINATION && !anyNew) {
        console.log('No new or in-threshold listings on page, ending pagination');
        break;
      }
    }

    // Save results only if not in test mode
    if (!TEST_PAGINATION) {
      const csvWriter = createCsvWriter({
        path: 'results.csv',
        header: [
          {id: 'title', title: 'Title'},
          {id: 'location', title: 'Location'},
          {id: 'price', title: 'Price'},
          {id: 'area', title: 'Area'},
          {id: 'description', title: 'Description'},
          {id: 'listed', title: 'Listed'},
          {id: 'url', title: 'URL'}
        ]
      });
      
      await csvWriter.writeRecords(results);
      console.log(`Completed: ${results.length} listings saved to results.csv`);
      
      // Upload to GCS if configured
      await uploadToGCS('results.csv');
      
      // Persist last run timestamp
      fs.writeFileSync(META_FILE, JSON.stringify({ lastRun: new Date().toISOString() }));
      console.log(`Updated last run timestamp to now`);
      
      // Upload last run metadata to GCS
      await uploadToGCS(META_FILE);
    }
  } catch (error) {
    console.error(`Scraper error: ${error.message}`);
    console.error(error.stack);
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

runScraper().catch(err => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
}); 