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
const START_URLS = [
  'https://www.propertyfinder.ae/en/search?c=3&t=4&fu=0&rp=n&ob=nd',
  'https://www.propertyfinder.ae/en/commercial-buy/dubai/offices-for-sale.html',
  'https://www.bayut.com/for-sale/offices/dubai/',
  'https://www.dubizzle.com/property-for-sale/commercial/office/'
];
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

// Add stealth measures
const randomDelay = (min, max) => {
  const delay = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise(resolve => setTimeout(resolve, delay));
};

// Helper function to randomize user agents
function getRandomUserAgent() {
  const userAgents = [
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0'
  ];
  return userAgents[Math.floor(Math.random() * userAgents.length)];
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
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-blink-features=AutomationControlled'
      ]
    };
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
      launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    }
    
    console.log(`Launching browser in ${launchOptions.headless ? 'headless' : 'visible'} mode`);
    browser = await puppeteer.launch(launchOptions);
    
    // Try each site in our list until one works
    let successful = false;
    const results = [];
    const seenUrls = new Set();
    const TEST_PAGINATION = process.env.TEST_PAGINATION === 'true';
    const MAX_PAGES = process.env.MAX_PAGES ? parseInt(process.env.MAX_PAGES) : null;
    
    if (TEST_PAGINATION) {
      console.log('[PAGINATION TEST MODE]');
      if (MAX_PAGES) {
        console.log(`[TESTING ${MAX_PAGES} PAGES ONLY]`);
      }
    }
    
    for (const START_URL of START_URLS) {
      if (successful && !TEST_PAGINATION) break;
      
      console.log(`Trying site: ${START_URL}`);
      const page = await browser.newPage();
      
      // Hide automation
      await page.evaluateOnNewDocument(() => {
        // Override the navigator permissions
        const originalQuery = window.navigator.permissions.query;
        window.navigator.permissions.query = (parameters) => (
          parameters.name === 'notifications' ?
            Promise.resolve({ state: Notification.permission }) :
            originalQuery(parameters)
        );
        
        // Pass WebDriver test
        Object.defineProperty(navigator, 'webdriver', {
          get: () => false,
        });
        
        // Pass Chrome test
        window.navigator.chrome = {
          runtime: {},
        };
        
        // Pass plugins length test
        Object.defineProperty(navigator, 'plugins', {
          get: () => [
            {},
            {},
            {},
            {},
            {},
          ],
        });
        
        // Pass languages test
        Object.defineProperty(navigator, 'languages', {
          get: () => ['en-US', 'en', 'ar'],
        });
        
        // Spoof screen resolution
        Object.defineProperty(window.screen, 'width', { get: () => 1920 + Math.floor(Math.random() * 10) });
        Object.defineProperty(window.screen, 'height', { get: () => 1080 + Math.floor(Math.random() * 10) });
        Object.defineProperty(window.screen, 'availWidth', { get: () => 1920 + Math.floor(Math.random() * 10) });
        Object.defineProperty(window.screen, 'availHeight', { get: () => 1080 + Math.floor(Math.random() * 10) });
      });
      
      await page.setViewport({ 
        width: 1920 + Math.floor(Math.random() * 100), 
        height: 1080 + Math.floor(Math.random() * 100)
      });
      
      // Set a randomized user agent
      await page.setUserAgent(getRandomUserAgent());

      // Add extra headers to appear more like a normal browser
      await page.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Referer': 'https://www.google.com/',
        'Cache-Control': 'max-age=0',
        'Connection': 'keep-alive'
      });

      // Log console messages from the browser
      page.on('console', msg => console.log('BROWSER:', msg.text()));
      
      // Detect potential navigation issues
      page.on('error', err => console.error('PAGE ERROR:', err));
      page.on('pageerror', err => console.error('PAGE JS ERROR:', err));
      
      let siteDomain = new URL(START_URL).hostname;
      console.log(`Processing site: ${siteDomain}`);
      
      // Paginate through the site
      let pageFoundResults = false;
      
      try {
        // Paginate via URL param
        for (let currentPage = 1; ; currentPage++) {
          // Stop if we've reached the maximum number of pages to test
          if (MAX_PAGES && currentPage > MAX_PAGES) {
            console.log(`Reached maximum test pages (${MAX_PAGES}), stopping.`);
            break;
          }
          
          // Navigate to the appropriate page URL
          const url = currentPage === 1 
            ? START_URL 
            : `${START_URL}${START_URL.includes('?') ? '&' : '?'}page=${currentPage}`;
          
          console.log(`Loading page ${currentPage}: ${url}`);
          
          // Navigate with longer timeout and wait for network idle
          try {
            console.log(`Attempting to navigate to: ${url}`);
            
            // Navigate to target with random delays
            await page.goto(url, { 
              waitUntil: 'domcontentloaded', 
              timeout: 30000 
            });
            console.log('Page DOM loaded');
            
            // Simulate scrolling like a human would
            await randomDelay(1000, 3000);
            await page.evaluate(() => {
              const totalHeight = document.body.scrollHeight;
              let scrollPosition = 0;
              const scrollStep = Math.floor(Math.random() * 100) + 300;
              
              const scrollInterval = setInterval(() => {
                window.scrollBy(0, scrollStep);
                scrollPosition += scrollStep;
                
                if (scrollPosition >= totalHeight) {
                  clearInterval(scrollInterval);
                }
              }, 200);
              
              // Scroll for a few seconds
              return new Promise(resolve => setTimeout(resolve, 3000));
            });
            
            // Wait for network to settle with a random delay to appear more human-like
            await randomDelay(3000, 7000);
            console.log('Extra wait completed');
          } catch (navigationError) {
            console.error(`Navigation error: ${navigationError.message}`);
            break; // Stop pagination on this site on navigation errors
          }
          
          // Wait for listings to appear - use site-specific selectors based on domain
          let ITEM_SELECTOR = 'article, .card, [class*="Card"], [class*="card"], .property-card, .property-list-item, .listing-item, [class*="PropertyCard"], [class*="property-card"], [data-testid="card"], [data-testid="listing"]';
          
          // Add site-specific selectors
          if (siteDomain.includes('propertyfinder')) {
            ITEM_SELECTOR = '[data-qs="serp-card"], [data-cy="listing-card"], [data-testid="listing-card"], article, .card';
          } else if (siteDomain.includes('bayut')) {
            ITEM_SELECTOR = '[aria-label*="Listing"], [class*="listingCard"], .card, article[class*="ListItem"]';
          } else if (siteDomain.includes('dubizzle')) {
            ITEM_SELECTOR = '[data-testid="listing-card"], .listing, [class*="ListingItem"], article';
          }
          
          console.log(`Using site-specific selector for ${siteDomain}: ${ITEM_SELECTOR}`);
          
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
            
            if (elementsCount > 0) {
              pageFoundResults = true;
            }
            
            // If testing, take screenshot regardless of finding elements
            if (TEST_PAGINATION) {
              await page.screenshot({ path: `${siteDomain}-page-${currentPage}.png` });
              console.log(`Saved screenshot as ${siteDomain}-page-${currentPage}.png`);
            }
          } catch (e) {
            // Only treat TimeoutError as fatal if not in test mode
            console.error(`Error checking for listings: ${e.message}`);
            break; // Stop pagination on this site on element detection errors
          }
          
          // If no listings found, stop paginating
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
          const rawCount = await page.evaluate((selector) => document.querySelectorAll(selector).length, ITEM_SELECTOR);
          console.log(`Total raw listings found: ${rawCount}`);
          
          // Extract listing data using the same selector and data extraction approach from before
          const pageListings = await page.evaluate((selector) => {
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
          for (const item of pageListings) {
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
              // Store the parsed date for sorting later
              item.listedDate = listedDate;
              
              if (item.url) {
                // Visit detail page to get more info
                try {
                  const detailPage = await browser.newPage();
                  await detailPage.goto(item.url, { waitUntil: 'domcontentloaded' });
                  // Add random delay to appear more human-like
                  await randomDelay(2000, 5000);
                  
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
                } catch (detailErr) {
                  console.error(`Error visiting detail page: ${detailErr.message}`);
                  item.description = 'Failed to load';
                }
              }
              results.push(item);
              anyNew = true;
              console.log(`Found valid listing: ${item.title}`);
            }
          }

          // Throttle with random delay between page loads to appear more human-like
          await randomDelay(5000, 10000);
          
          // Stop if no new/in-threshold items found
          if (!anyNew) {
            console.log('No new or in-threshold listings on page, ending pagination');
            break;
          }
        }
        
        // If this site found results, consider it successful
        if (pageFoundResults) {
          successful = true;
          console.log(`Site ${siteDomain} successfully found listings`);
        } else {
          console.log(`Site ${siteDomain} did not find any listings, trying next site`);
        }
      } catch (siteError) {
        console.error(`Error processing site ${siteDomain}: ${siteError.message}`);
      } finally {
        await page.close();
      }
    }

    // Save results only if not in test mode
    if (!TEST_PAGINATION && results.length > 0) {
      // Sort results by date (newest first)
      results.sort((a, b) => {
        // Parse dates from the listings
        const dateA = a.listedDate || new Date();
        const dateB = b.listedDate || new Date();
        
        // Sort newest first
        return dateB - dateA;
      });
      
      console.log(`Sorted ${results.length} listings by date (newest first)`);
      
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
    } else if (TEST_PAGINATION) {
      console.log(`Test mode completed across ${START_URLS.length} sites.`);
    } else {
      console.log(`No results found across all ${START_URLS.length} sites.`);
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