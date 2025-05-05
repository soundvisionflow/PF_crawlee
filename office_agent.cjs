const puppeteer = require('puppeteer');
const fs = require('fs');
const { Storage } = require('@google-cloud/storage');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const http = require('http');

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
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:123.0) Gecko/20100101 Firefox/123.0',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
  ];
  return userAgents[Math.floor(Math.random() * userAgents.length)];
}

// Enhanced navigation with built-in retry mechanism
async function safeNavigate(page, url, options = {}) {
  const maxAttempts = 3;
  let attempts = 0;
  
  // Default navigation options with longer timeouts
  const defaultOptions = {
    waitUntil: ['domcontentloaded', 'networkidle2'],
    timeout: 60000
  };
  
  const navigationOptions = { ...defaultOptions, ...options };
  
  while (attempts < maxAttempts) {
    try {
      console.log(`Navigation attempt ${attempts + 1} to: ${url}`);
      
      // Clear cookies between attempts if not first attempt
      if (attempts > 0) {
        const client = await page.target().createCDPSession();
        await client.send('Network.clearBrowserCookies');
        await client.send('Network.clearBrowserCache');
      }
      
      const response = await page.goto(url, navigationOptions);
      
      if (!response) {
        throw new Error('No response received from navigation');
      }
      
      const status = response.status();
      console.log(`Navigation response status: ${status}`);
      
      if (status >= 400) {
        throw new Error(`Navigation failed with status: ${status}`);
      }
      
      // Add random delay to appear more human-like
      await randomDelay(3000, 7000);
      
      // Check for common bot detection patterns
      const isBlocked = await page.evaluate(() => {
        const body = document.body.innerText.toLowerCase();
        return (
          body.includes('access denied') || 
          body.includes('captcha') || 
          body.includes('suspicious activity') ||
          body.includes('blocked') ||
          body.includes('security check') ||
          (document.title && document.title.toLowerCase().includes('captcha'))
        );
      });
      
      if (isBlocked) {
        console.log('Bot detection detected, retrying with new identity');
        throw new Error('Bot detection encountered');
      }
      
      return true;
    } catch (error) {
      attempts++;
      console.error(`Navigation error (attempt ${attempts}): ${error.message}`);
      
      if (attempts >= maxAttempts) {
        console.error(`Navigation failed after ${maxAttempts} attempts`);
        return false;
      }
      
      // Randomized exponential backoff
      const backoffTime = Math.floor(Math.random() * 3000) + 5000 * Math.pow(2, attempts);
      console.log(`Retrying in ${backoffTime}ms...`);
      await new Promise(resolve => setTimeout(resolve, backoffTime));
    }
  }
  
  return false;
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

// Add proxy rotation functionality
const FREE_PROXIES = [
  // These are example public proxies - replace with real ones or a proxy service
  // Format: { host: 'ip', port: port, protocol: 'http' }
  // For real deployment, consider a paid proxy service with an API
];

// Get a random proxy from the list
function getRandomProxy() {
  // If using a real proxy service, this would make an API call
  if (FREE_PROXIES.length === 0) {
    console.log('No proxies available, proceeding without proxy');
    return null;
  }
  
  return FREE_PROXIES[Math.floor(Math.random() * FREE_PROXIES.length)];
}

// Apply proxy to browser if available
async function applyProxy(browser, proxyConfig) {
  if (!proxyConfig) return;
  
  try {
    // Create a new page with the proxy
    const page = await browser.newPage();
    await page.authenticate({
      username: proxyConfig.username || '',
      password: proxyConfig.password || ''
    });
    
    console.log(`Applied proxy: ${proxyConfig.host}:${proxyConfig.port}`);
    return page;
  } catch (error) {
    console.error(`Error applying proxy: ${error.message}`);
    return null;
  }
}

// Check if we should use proxies (can be controlled via env variable)
const USE_PROXIES = process.env.USE_PROXIES === 'true';

// Configure Puppeteer launch options with proxy support
const launchOptions = {
  headless: process.env.TEST_PAGINATION === 'true' ? false : 'new',
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-web-security',
    '--disable-features=IsolateOrigins,site-per-process',
    '--disable-blink-features=AutomationControlled',
    '--disable-gpu',
    '--window-size=1920,1080',
    '--disable-features=site-per-process', 
    '--disable-web-security',
    '--single-process',
    '--disable-extensions',
    '--disable-translate',
    '--ignore-certificate-errors',
    '--no-first-run',
    '--mute-audio',
    '--disable-sync',
    '--metrics-recording-only',
    '--hide-scrollbars',
    '--user-data-dir=/tmp/chrome-data'
  ],
  userDataDir: '/tmp/chrome-user-data',
  timeout: 300000, // 5 minutes for browser launch
  ignoreDefaultArgs: ['--enable-automation'],
  ignoreHTTPSErrors: true,
  protocolTimeout: 300000
};

// If proxies are enabled, add the necessary args
if (USE_PROXIES && process.env.PROXY_SERVER) {
  launchOptions.args.push(`--proxy-server=${process.env.PROXY_SERVER}`);
  console.log(`Using proxy server: ${process.env.PROXY_SERVER}`);
}

// Add any additional args from environment
if (process.env.PUPPETEER_ARGS) {
  const extraArgs = process.env.PUPPETEER_ARGS.split(' ');
  launchOptions.args = [...new Set([...launchOptions.args, ...extraArgs])];
}

if (process.env.PUPPETEER_EXECUTABLE_PATH) {
  launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
}

console.log(`Launching browser with options: ${JSON.stringify(launchOptions)}`);
console.log(`Running in mode: ${process.env.MODE || 'default'}`);
// Try multiple times to launch the browser
let attempts = 0;
const maxAttempts = 3;

while (attempts < maxAttempts) {
  try {
    browser = await puppeteer.launch(launchOptions);
    break; // Browser launched successfully
  } catch (launchError) {
    attempts++;
    console.error(`Browser launch attempt ${attempts} failed: ${launchError.message}`);
    if (attempts >= maxAttempts) {
      throw new Error(`Failed to launch browser after ${maxAttempts} attempts: ${launchError.message}`);
    }
    // Wait before retrying
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
}

async function scrapeWebsite(browser, site) {
  const results = [];
  
  try {
    console.log(`Trying site: ${site.url}`);
    console.log(`Processing site: ${site.name}`);
    
    const page = await browser.newPage();
    await page.setDefaultNavigationTimeout(180000); // 3 minutes
    await page.setDefaultTimeout(120000); // 2 minutes for other operations
    
    // Randomize viewport size slightly to avoid detection
    const width = 1920 + Math.floor(Math.random() * 100);
    const height = 1080 + Math.floor(Math.random() * 100);
    await page.setViewport({ width, height });
    
    // Set user agent
    await page.setUserAgent(getRandomUserAgent());
    
    // Emulate browser features and add evasion
    await page.evaluateOnNewDocument(() => {
      // Overwrite the 'webdriver' property to make it undefined
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined
      });
      
      // Create a fake navigator.plugins
      const makePluginsLookNatural = () => {
        Object.defineProperty(navigator, 'plugins', {
          get: () => Array(3).fill().map(() => ({
            name: Math.random().toString(36).substring(7),
            description: Math.random().toString(36).substring(7),
            filename: Math.random().toString(36).substring(7),
            length: Math.floor(Math.random() * 5) + 1
          }))
        });
      };
      
      makePluginsLookNatural();
    });
    
    console.log(`Loading page 1: ${site.url}`);
    
    try {
      console.log(`Attempting to navigate to: ${site.url}`);
      // Use waitUntil: 'networkidle2' for more reliable page load
      await page.goto(site.url, { 
        waitUntil: ['domcontentloaded', 'networkidle2'],
        timeout: 180000 // 3 minutes
      });
      
      console.log('Page DOM loaded');
      
      // Add extra wait time to ensure JavaScript loads
      await page.waitForTimeout(5000);
      console.log('Extra wait completed');
      
      // Wait for listings to appear - use site-specific selectors based on domain
      let ITEM_SELECTOR = 'article, .card, [class*="Card"], [class*="card"], .property-card, .property-list-item, .listing-item, [class*="PropertyCard"], [class*="property-card"], [data-testid="card"], [data-testid="listing"]';
      
      // Add site-specific selectors
      if (site.name.includes('propertyfinder')) {
        ITEM_SELECTOR = '[data-qs="serp-card"], [data-cy="listing-card"], [data-testid="listing-card"], article, .card';
      } else if (site.name.includes('bayut')) {
        ITEM_SELECTOR = '[aria-label*="Listing"], [class*="listingCard"], .card, article[class*="ListItem"]';
      } else if (site.name.includes('dubizzle')) {
        ITEM_SELECTOR = '[data-testid="listing-card"], .listing, [class*="ListingItem"], article';
      }
      
      console.log(`Using site-specific selector for ${site.name}: ${ITEM_SELECTOR}`);
      
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
        console.log(`Found ${elementsCount} listing elements on page 1`);
        
        if (elementsCount > 0) {
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
                  try {
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
                  } catch (innerErr) {
                    console.error(`Error scraping detail page: ${innerErr.message}`);
                    item.description = 'Failed to load details';
                  } finally {
                    try {
                      await detailPage.close();
                    } catch (closeErr) {
                      console.error(`Error closing detail page: ${closeErr.message}`);
                    }
                  }
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
        }
      } catch (siteError) {
        console.error(`Error processing site ${site.name}: ${siteError.message}`);
      }
    } catch (navigationError) {
      console.error(`Navigation error: ${navigationError.message}`);
    }
  } catch (error) {
    console.error(`Error processing site ${site.name}: ${error.message}`);
  } finally {
    await page.close();
    return results;
  }
}

async function runScraper(initial = false) {
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
        '--disable-blink-features=AutomationControlled',
        '--disable-gpu',
        '--window-size=1920,1080',
        '--disable-features=site-per-process', 
        '--disable-web-security',
        '--single-process',
        '--disable-extensions',
        '--disable-translate',
        '--ignore-certificate-errors',
        '--no-first-run',
        '--mute-audio',
        '--disable-sync',
        '--metrics-recording-only',
        '--hide-scrollbars',
        '--user-data-dir=/tmp/chrome-data'
      ],
      userDataDir: '/tmp/chrome-user-data',
      timeout: 300000, // 5 minutes for browser launch
      ignoreDefaultArgs: ['--enable-automation'],
      ignoreHTTPSErrors: true,
      protocolTimeout: 300000
    };
    
    // Add any additional args from environment
    if (process.env.PUPPETEER_ARGS) {
      const extraArgs = process.env.PUPPETEER_ARGS.split(' ');
      launchOptions.args = [...new Set([...launchOptions.args, ...extraArgs])];
    }
    
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
      launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    }
    
    console.log(`Launching browser with options: ${JSON.stringify(launchOptions)}`);
    console.log(`Running in mode: ${process.env.MODE || 'default'}`);
    // Try multiple times to launch the browser
    let attempts = 0;
    const maxAttempts = 3;
    
    while (attempts < maxAttempts) {
      try {
        browser = await puppeteer.launch(launchOptions);
        break; // Browser launched successfully
      } catch (launchError) {
        attempts++;
        console.error(`Browser launch attempt ${attempts} failed: ${launchError.message}`);
        if (attempts >= maxAttempts) {
          throw new Error(`Failed to launch browser after ${maxAttempts} attempts: ${launchError.message}`);
        }
        // Wait before retrying
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
    
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
      
      // Set up page with enhanced anti-detection
      await setupPageForStealth(page);
      
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
          
          // Limit initial scrape to 15 pages
          if (initial && currentPage > 15) {
            console.log('Reached initial scrape page limit (15), stopping.');
            break;
          }
          
          // Navigate to the appropriate page URL
          const url = currentPage === 1 
            ? START_URL 
            : `${START_URL}${START_URL.includes('?') ? '&' : '?'}page=${currentPage}`;
          
          console.log(`Loading page ${currentPage}: ${url}`);
          
          // Use our enhanced navigation function
          const navigationSuccess = await safeNavigate(page, url);
          
          if (!navigationSuccess) {
            console.log(`Failed to navigate to page ${currentPage}, stopping.`);
            break;
          }
          
          console.log('Page successfully loaded');
          
          // Simulate scrolling like a human would
          await simulateHumanScrolling(page);
          
          // Wait for listings to appear - use site-specific selectors based on domain
          let ITEM_SELECTOR = getItemSelector(siteDomain);
          
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
                  try {
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
                  } catch (innerErr) {
                    console.error(`Error scraping detail page: ${innerErr.message}`);
                    item.description = 'Failed to load details';
                  } finally {
                    try {
                      await detailPage.close();
                    } catch (closeErr) {
                      console.error(`Error closing detail page: ${closeErr.message}`);
                    }
                  }
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

// Create HTTP server to handle Cloud Run invocations
const server = http.createServer(async (req, res) => {
  console.log(`Received request: ${req.method} ${req.url}`);
  
  // Only accept POST requests
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method Not Allowed' }));
    return;
  }
  
  // Collect request body
  let body = '';
  req.on('data', chunk => {
    body += chunk.toString();
  });
  
  req.on('end', async () => {
    try {
      // Parse the request body
      let mode = 'daily';
      if (body) {
        try {
          const data = JSON.parse(body);
          if (data.mode) {
            mode = data.mode;
          }
        } catch (e) {
          console.error('Error parsing request body:', e);
        }
      }
      
      // Override with environment variable if set
      if (process.env.MODE) {
        mode = process.env.MODE;
      }
      
      console.log(`Starting scraper in ${mode} mode`);
      
      // Start the scraper
      await runScraper(mode === 'initial');
      
      // Return success
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        status: 'success', 
        message: `Completed scraping in ${mode} mode` 
      }));
    } catch (error) {
      console.error('Error running scraper:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        status: 'error', 
        message: error.message 
      }));
    }
  });
});

// Add proper shutdown handling
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
  });
});

// Start server if not being imported
if (require.main === module) {
  const PORT = process.env.PORT || 8080;
  server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
  });
} else {
  // Export for testing
  module.exports = { runScraper }; 
} 

// Helper function to get the right selector for each site
function getItemSelector(domain) {
  let selector = 'article, .card, [class*="Card"], [class*="card"], .property-card, .property-list-item, .listing-item, [class*="PropertyCard"], [class*="property-card"], [data-testid="card"], [data-testid="listing"]';
  
  if (domain.includes('propertyfinder')) {
    selector = '[data-qs="serp-card"], [data-cy="listing-card"], [data-testid="listing-card"], article, .card';
  } else if (domain.includes('bayut')) {
    selector = '[aria-label*="Listing"], [class*="listingCard"], .card, article[class*="ListItem"]';
  } else if (domain.includes('dubizzle')) {
    selector = '[data-testid="listing-card"], .listing, [class*="ListingItem"], article';
  }
  
  return selector;
}

// Simulate human-like scrolling behavior
async function simulateHumanScrolling(page) {
  try {
    await randomDelay(1000, 3000);
    
    // Execute scrolling in page context
    await page.evaluate(() => {
      return new Promise((resolve) => {
        const totalHeight = document.body.scrollHeight;
        let scrollPosition = 0;
        
        // Random scroll speed and pause duration
        const scrollStep = Math.floor(Math.random() * 100) + 300;
        
        const scrollInterval = setInterval(() => {
          // Random jitter in scroll amount
          const jitter = Math.floor(Math.random() * 50) - 25;
          window.scrollBy(0, scrollStep + jitter);
          scrollPosition += scrollStep + jitter;
          
          // Occasionally pause scrolling to simulate reading
          if (Math.random() < 0.2) {
            clearInterval(scrollInterval);
            setTimeout(() => {
              const newInterval = setInterval(() => {
                const newJitter = Math.floor(Math.random() * 50) - 25;
                window.scrollBy(0, scrollStep + newJitter);
                scrollPosition += scrollStep + newJitter;
                
                if (scrollPosition >= totalHeight || Math.random() < 0.05) {
                  clearInterval(newInterval);
                  resolve();
                }
              }, 100 + Math.floor(Math.random() * 100));
            }, 500 + Math.floor(Math.random() * 1000));
          }
          
          if (scrollPosition >= totalHeight) {
            clearInterval(scrollInterval);
            resolve();
          }
        }, 100 + Math.floor(Math.random() * 100));
        
        // Safety timeout
        setTimeout(resolve, 5000);
      });
    });
    
    // Additional random delay after scrolling
    await randomDelay(1000, 2000);
    
  } catch (error) {
    console.error('Error during scrolling simulation:', error.message);
  }
}

// Setup page with advanced stealth techniques
async function setupPageForStealth(page) {
  // Set a randomized viewport with slight variations
  const width = 1920 + Math.floor(Math.random() * 100);
  const height = 1080 + Math.floor(Math.random() * 100);
  await page.setViewport({ width, height });
  
  // Set user agent
  await page.setUserAgent(getRandomUserAgent());
  
  // Add extra headers to appear more like a normal browser
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Referer': 'https://www.google.com/',
    'Cache-Control': 'max-age=0',
    'Connection': 'keep-alive',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1'
  });
  
  // Advanced fingerprint spoofing
  await page.evaluateOnNewDocument(() => {
    // Override the navigator permissions
    const originalQuery = window.navigator.permissions?.query;
    if (originalQuery) {
      window.navigator.permissions.query = (parameters) => (
        parameters.name === 'notifications' ?
          Promise.resolve({ state: Notification.permission }) :
          originalQuery(parameters)
      );
    }
    
    // Pass WebDriver test
    Object.defineProperty(navigator, 'webdriver', {
      get: () => false,
    });
    
    // Set navigator properties consistent with real browsers
    Object.defineProperty(navigator, 'maxTouchPoints', {
      get: () => 0,
    });
    
    // Pass Chrome test
    window.navigator.chrome = {
      runtime: {},
      app: {},
    };
    
    // Pass plugins length test
    Object.defineProperty(navigator, 'plugins', {
      get: () => {
        const plugins = [
          {
            name: 'Chrome PDF Plugin',
            description: 'Portable Document Format',
            filename: 'internal-pdf-viewer',
            length: 1
          },
          {
            name: 'Chrome PDF Viewer',
            description: 'Chrome PDF Viewer',
            filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai',
            length: 1
          },
          {
            name: 'Native Client',
            description: '',
            filename: 'internal-nacl-plugin',
            length: 2
          }
        ];
        
        // Add some randomization in number of plugins
        if (Math.random() > 0.5) {
          plugins.push({
            name: Math.random().toString(36).substring(7),
            description: Math.random().toString(36).substring(7),
            filename: Math.random().toString(36).substring(7),
            length: Math.floor(Math.random() * 3) + 1
          });
        }
        
        return Object.setPrototypeOf(plugins, PluginArray.prototype);
      },
    });
    
    // Pass languages test
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en', 'ar'],
    });
    
    // Spoof screen resolution with slight variations
    const screenHeight = 1080 + Math.floor(Math.random() * 10);
    const screenWidth = 1920 + Math.floor(Math.random() * 10);
    
    // Modify the screen object
    Object.defineProperties(window.screen, {
      'width': { get: () => screenWidth },
      'height': { get: () => screenHeight },
      'availWidth': { get: () => screenWidth },
      'availHeight': { get: () => screenHeight - 40 },
      'colorDepth': { get: () => 24 },
      'pixelDepth': { get: () => 24 }
    });
    
    // Modify the window dimensions
    Object.defineProperties(window, {
      'innerWidth': { get: () => screenWidth - Math.floor(Math.random() * 20) },
      'innerHeight': { get: () => screenHeight - 40 - Math.floor(Math.random() * 20) },
      'outerWidth': { get: () => screenWidth },
      'outerHeight': { get: () => screenHeight }
    });
    
    // WebGL fingerprint spoofing
    try {
      const getParameter = WebGLRenderingContext.prototype.getParameter;
      WebGLRenderingContext.prototype.getParameter = function(parameter) {
        // Modify UNMASKED_RENDERER_WEBGL and UNMASKED_VENDOR_WEBGL
        if (parameter === 37446) {
          return 'Intel Inc.';
        }
        if (parameter === 37445) {
          return 'Intel Iris OpenGL Engine';
        }
        return getParameter.apply(this, arguments);
      };
    } catch (e) {
      console.warn('WebGL fingerprint spoofing failed:', e);
    }
  });
} 